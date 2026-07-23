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

import { parseXPathExpression } from "@/lib/commcare/xpath";
import { resolveCloseFieldRef } from "@/lib/doc/expressionText";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import {
	asUuid,
	type BlueprintDoc,
	type CaseType,
	type ConnectType,
	type Field,
	type FieldKind,
	FORM_REFERENCE_SLOTS,
	type Form,
	type FormLink,
	fieldPathResolver,
	type Module,
	plainColumn,
	rewriteSlotValues,
	type Uuid,
	type XPathExpression,
} from "@/lib/domain";

/**
 * Parse expression text to its stored AST with NO form resolution —
 * form-namespace refs stay raw leaves (case/user refs classify fine;
 * they need no doc). For fixtures whose form refs must resolve to
 * identity leaves, use `xpIn` or author the slot as a string in a
 * `buildDoc` spec (converted against the complete doc).
 */
export function xp(text: string): XPathExpression {
	return parseXPathExpression(text, () => undefined);
}

/** Parse expression text against a built doc, scoped to a form — the
 *  same resolution every live commit surface performs. */
export function xpIn(
	doc: BlueprintDoc,
	formUuid: Uuid,
	text: string,
): XPathExpression {
	return parseXPathExpression(text, fieldPathResolver(doc, formUuid));
}

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
	displayCondition?: Form["displayCondition"];
	/** Authored with a field ID (the concise spec shape); `buildDoc`
	 *  resolves it to the field's uuid against the assembled form. */
	closeCondition?: {
		field: string;
		answer: string;
		operator?: "=" | "selected";
	};
	connect?: Form["connect"];
	postSubmit?: Form["postSubmit"];
	/** Authored with string conditions/datum XPaths (the concise spec
	 *  shape); `buildDoc` parses them against the assembled form. */
	formLinks?: Array<{
		condition?: string;
		target: FormLink["target"];
		datums?: Array<{ name: string; xpath: string }>;
	}>;
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
	displayCondition?: Module["displayCondition"];
	caseListConfig?: Module["caseListConfig"];
	caseSearchConfig?: Module["caseSearchConfig"];
	forms?: FormSpec[];
}

/**
 * Build a `CaseListConfig` snapshot from a flat `{field, header}[]`
 * column list. Tests construct columns this way overwhelmingly often
 * (every fixture builds the simplest case-list shape), so the helper
 * keeps fixtures concise without forcing each test to spell the
 * empty `searchInputs` array itself.
 *
 * Each entry becomes a `kind: "plain"` column with an auto-assigned
 * `uuid`. The helper short-circuits the schema's identity slot so
 * fixtures that don't care about column identity stay compact —
 * fixtures that DO care (drag-reorder tests, sort-on-column lookups)
 * pass `plainColumn(uuid, field, header)` directly.
 */
export function caseListConfig(
	columns: ReadonlyArray<{ field: string; header: string }>,
): NonNullable<Module["caseListConfig"]> {
	return {
		columns: columns.map((c) =>
			plainColumn(nextUuid("col"), c.field, c.header),
		),
		searchInputs: [],
	};
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
			...(modSpec.displayCondition !== undefined && {
				displayCondition: modSpec.displayCondition,
			}),
			...(modSpec.caseListConfig !== undefined && {
				caseListConfig: modSpec.caseListConfig,
			}),
			...(modSpec.caseSearchConfig !== undefined && {
				caseSearchConfig: modSpec.caseSearchConfig,
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
				...(formSpec.displayCondition !== undefined && {
					displayCondition: formSpec.displayCondition,
				}),
				...(formSpec.closeCondition !== undefined && {
					closeCondition: formSpec.closeCondition as Form["closeCondition"],
				}),
				...(formSpec.connect !== undefined && { connect: formSpec.connect }),
				...(formSpec.postSubmit !== undefined && {
					postSubmit: formSpec.postSubmit,
				}),
				...(formSpec.formLinks !== undefined && {
					formLinks: formSpec.formLinks as unknown as FormLink[],
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
	resolveDocExpressions(doc);
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		if (form.closeCondition && form.closeCondition.field.length > 0) {
			form.closeCondition.field = asUuid(
				resolveCloseFieldRef(doc, formUuid, form.closeCondition.field),
			);
		}
	}
	return doc;
}

/**
 * Fixtures author expression slots as XPath TEXT (the concise spec
 * shape); the canonical stored form is the expression AST. Convert
 * after assembly so references resolve against the COMPLETE built doc
 * — exactly the contract every live commit surface follows. Exported
 * for tests that hand-assemble docs instead of using `buildDoc`;
 * mutates in place and returns the doc for inline wrapping.
 */
export function resolveDocExpressions(doc: BlueprintDoc): BlueprintDoc {
	const AST_SLOTS = [
		"relevant",
		"validate",
		"calculate",
		"default_value",
		"required",
		"repeat_count",
	] as const;
	for (const [formUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
		if (doc.forms[formUuid] === undefined) continue;
		const resolve = fieldPathResolver(doc, formUuid);
		const stack = [...fieldUuids];
		while (stack.length > 0) {
			const uuid = stack.pop();
			if (uuid === undefined) continue;
			const field = doc.fields[uuid] as unknown as Record<string, unknown>;
			if (!field) continue;
			for (const slot of AST_SLOTS) {
				const value = field[slot];
				if (typeof value === "string") {
					field[slot] = parseXPathExpression(value, resolve);
				}
			}
			const dataSource = field.data_source as
				| { ids_query?: unknown }
				| undefined;
			if (dataSource && typeof dataSource.ids_query === "string") {
				dataSource.ids_query = parseXPathExpression(
					dataSource.ids_query,
					resolve,
				);
			}
			for (const child of doc.fieldOrder[uuid] ?? []) stack.push(child);
		}
	}
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		const resolve = fieldPathResolver(doc, formUuid);
		for (const entry of FORM_REFERENCE_SLOTS) {
			if ((entry.kind as string) !== "xpath-ast") continue;
			rewriteSlotValues(form, entry.path, (value) =>
				typeof value === "string"
					? parseXPathExpression(value, resolve)
					: value,
			);
		}
	}
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
		// `repeat` is a discriminated union on `repeat_mode`; default to
		// `user_controlled` so fixtures that don't care about the mode
		// stay valid against `fieldSchema`. Tests that need count_bound
		// or query_bound pass the mode explicitly via `...rest`.
		if (kind === "repeat" && base.repeat_mode === undefined) {
			base.repeat_mode = "user_controlled";
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
