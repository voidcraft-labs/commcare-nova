/**
 * Domain-native test fixture builders.
 *
 * Tests should construct `BlueprintDoc` shapes directly — no wire-format
 * round-trip. `buildDoc` accepts a concise nested spec that mirrors the
 * shape most tests want to express (modules → forms → fields) and emits a
 * fully normalized `BlueprintDoc` ready to feed to the validator.
 *
 * `f()` builds a single `Field` with an auto-assigned uuid and sensible
 * default label; override any property by passing it in the patch. The
 * shape is union-wide on purpose — callers pick the `kind` and provide
 * whatever keys that variant supports.
 */

import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import {
	asUuid,
	type BlueprintDoc,
	type CaseType,
	type ConnectType,
	type Field,
	type FieldKind,
	type Form,
	type FormLink,
	type Module,
	type Uuid,
} from "@/lib/domain";

/** Monotonic counter keeps auto-assigned uuids stable + readable per test run. */
let counter = 0;
function nextUuid(prefix: string): Uuid {
	counter++;
	return asUuid(`${prefix}-${counter.toString().padStart(4, "0")}`);
}

/**
 * Build a single domain `Field` spec with an auto-assigned uuid.
 *
 * The default `label` mirrors `id` so text/int/etc. fixtures work without
 * callers having to spell the label every time. Container kinds (group,
 * repeat) accept a `children` spec that this helper converts into nested
 * `Field[]` by recursion.
 *
 * Intentionally permissive: tests often need to construct shapes that
 * violate the discriminated union to exercise error paths (e.g. setting
 * `validate_msg` on a label). The helper accepts arbitrary keys so those
 * fixtures can be expressed directly.
 */
export function f(spec: FieldSpec): FieldSpec {
	return spec;
}

/** A spec for a single field (possibly with nested children). */
export type FieldSpec = {
	kind: FieldKind;
	id: string;
	uuid?: string;
	label?: string;
	children?: FieldSpec[];
	[key: string]: unknown;
};

/** A spec for a single form. Fields are given as a nested list. */
export interface FormSpec {
	uuid?: string;
	id?: string;
	name: string;
	type: Form["type"];
	purpose?: string;
	closeCondition?: Form["closeCondition"];
	connect?: Form["connect"];
	postSubmit?: Form["postSubmit"];
	formLinks?: FormLink[];
	fields?: FieldSpec[];
}

/** A spec for a single module. Forms are nested; case-list columns are optional. */
export interface ModuleSpec {
	uuid?: string;
	id?: string;
	name: string;
	caseType?: string;
	caseListOnly?: boolean;
	purpose?: string;
	caseListColumns?: Module["caseListColumns"];
	caseDetailColumns?: Module["caseDetailColumns"];
	forms?: FormSpec[];
}

/** Top-level spec. Mirrors the `BlueprintDoc` shape minus ordering/entity maps. */
export interface DocSpec {
	appId?: string;
	appName?: string;
	connectType?: ConnectType | null;
	caseTypes?: CaseType[] | null;
	modules?: ModuleSpec[];
}

/**
 * Build a fully normalized `BlueprintDoc` from a concise nested spec.
 *
 * Every uuid is auto-assigned unless the spec provides one. The resulting
 * doc has a populated `fieldParent` reverse index so tests that read that
 * field work without a separate bootstrap step.
 *
 * Field specs are flattened into the doc's `fields` map and their parent/
 * child relationships are captured in `fieldOrder`. Container kinds carry
 * a (possibly empty) `fieldOrder` entry; leaves do not.
 */
export function buildDoc(spec: DocSpec = {}): BlueprintDoc {
	const modules: BlueprintDoc["modules"] = {};
	const forms: BlueprintDoc["forms"] = {};
	const fields: BlueprintDoc["fields"] = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: BlueprintDoc["formOrder"] = {};
	const fieldOrder: BlueprintDoc["fieldOrder"] = {};

	for (const modSpec of spec.modules ?? []) {
		const moduleUuid = asUuid(modSpec.uuid ?? nextUuid("mod"));
		moduleOrder.push(moduleUuid);
		formOrder[moduleUuid] = [];

		modules[moduleUuid] = {
			uuid: moduleUuid,
			id: modSpec.id ?? modSpec.name.toLowerCase().replace(/\s+/g, "_"),
			name: modSpec.name,
			...(modSpec.caseType !== undefined && { caseType: modSpec.caseType }),
			...(modSpec.caseListOnly !== undefined && {
				caseListOnly: modSpec.caseListOnly,
			}),
			...(modSpec.purpose !== undefined && { purpose: modSpec.purpose }),
			...(modSpec.caseListColumns !== undefined && {
				caseListColumns: modSpec.caseListColumns,
			}),
			...(modSpec.caseDetailColumns !== undefined && {
				caseDetailColumns: modSpec.caseDetailColumns,
			}),
		};

		for (const formSpec of modSpec.forms ?? []) {
			const formUuid = asUuid(formSpec.uuid ?? nextUuid("frm"));
			formOrder[moduleUuid].push(formUuid);
			fieldOrder[formUuid] = [];

			forms[formUuid] = {
				uuid: formUuid,
				id: formSpec.id ?? formSpec.name.toLowerCase().replace(/\s+/g, "_"),
				name: formSpec.name,
				type: formSpec.type,
				...(formSpec.purpose !== undefined && { purpose: formSpec.purpose }),
				...(formSpec.closeCondition !== undefined && {
					closeCondition: formSpec.closeCondition,
				}),
				...(formSpec.connect !== undefined && { connect: formSpec.connect }),
				...(formSpec.postSubmit !== undefined && {
					postSubmit: formSpec.postSubmit,
				}),
				...(formSpec.formLinks !== undefined && {
					formLinks: formSpec.formLinks,
				}),
			};

			installFields(formSpec.fields ?? [], formUuid, fields, fieldOrder);
		}
	}

	const doc: BlueprintDoc = {
		appId: spec.appId ?? "test-app",
		appName: spec.appName ?? "Test",
		connectType: spec.connectType ?? null,
		caseTypes: spec.caseTypes ?? null,
		modules,
		forms,
		fields,
		moduleOrder,
		formOrder,
		fieldOrder,
		fieldParent: {},
	};
	rebuildFieldParent(doc);
	return doc;
}

/**
 * Install a flat field list under `parentUuid` in the entity maps,
 * recursing through container children. Each field is given an
 * auto-assigned uuid unless the spec provided one. Structural kinds
 * (group, repeat) receive their own `fieldOrder` entry — leaves do not.
 */
function installFields(
	specs: FieldSpec[],
	parentUuid: Uuid,
	fields: BlueprintDoc["fields"],
	fieldOrder: BlueprintDoc["fieldOrder"],
): void {
	for (const spec of specs) {
		const { children, uuid: rawUuid, kind, id, label, ...rest } = spec;
		const uuid = asUuid(rawUuid ?? nextUuid("fld"));
		fieldOrder[parentUuid].push(uuid);

		const base: Record<string, unknown> = {
			uuid,
			kind,
			id,
			...rest,
		};
		// `label` is required on every non-hidden variant; default to id
		// so callers that don't care about labels get a sensible fixture.
		// Hidden has no `label` — omit it when the caller does too.
		if (label !== undefined) {
			base.label = label;
		} else if (kind !== "hidden") {
			base.label = id;
		}
		fields[uuid] = base as unknown as Field;

		// Container kinds carry a fieldOrder entry; without one, the walkers
		// treat the field as a leaf.
		if (kind === "group" || kind === "repeat") {
			fieldOrder[uuid] = [];
			if (children?.length) installFields(children, uuid, fields, fieldOrder);
		}
	}
}
