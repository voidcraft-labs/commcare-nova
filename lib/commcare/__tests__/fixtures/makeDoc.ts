// Test-only BlueprintDoc builder.
//
// Accepts a nested, human-readable input and produces a normalized
// BlueprintDoc with deterministic uuids. Mirrors the way a test author
// thinks about the domain (modules contain forms contain fields, with
// container fields carrying children); the shape has no relationship to
// the legacy wire format. Lives under __tests__ because it is scaffolding
// for tests, not a shim that production code is ever allowed to import.
//
// Why "deterministic uuids": compile-pipeline tests snapshot HQ JSON +
// XForm XML outputs, and a monotonic global counter would make two test
// files see different uuids for the same fixture based on test-suite run
// order. Every doc gets its own counter, seeded by the `seed` argument,
// so `makeDoc({...})` is reproducible regardless of what ran before it.

import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type FieldKind,
	type Form,
	type Module,
	type Uuid,
} from "@/lib/domain";

// ── Input shapes ────────────────────────────────────────────────────
//
// Minimal, readable input shape. Every field/form/module may optionally
// supply its own uuid; otherwise one is minted from the per-doc counter.
// Arbitrary kind-specific keys flow through via the index signature, so
// the DSL does not have to enumerate every property of every variant.

export interface MakeFieldInput {
	kind: FieldKind;
	id: string;
	label?: string;
	/** Optional pre-assigned uuid; otherwise minted deterministically. */
	uuid?: string;
	/** Container fields (group / repeat) carry children. */
	children?: MakeFieldInput[];
	/**
	 * Any other kind-specific property (required, relevant, case_property,
	 * validate, options, …) is copied verbatim onto the Field record.
	 * Typed as `unknown` so the DSL itself stays kind-agnostic.
	 */
	[key: string]: unknown;
}

export interface MakeFormInput {
	id: string;
	name: string;
	type: Form["type"];
	uuid?: string;
	fields: MakeFieldInput[];
	[key: string]: unknown;
}

export interface MakeModuleInput {
	id: string;
	name: string;
	caseType?: string;
	uuid?: string;
	forms: MakeFormInput[];
	[key: string]: unknown;
}

export interface MakeDocInput {
	appId: string;
	appName: string;
	connectType?: BlueprintDoc["connectType"];
	caseTypes?: BlueprintDoc["caseTypes"];
	modules: MakeModuleInput[];
	/** Deterministic seed for minted uuids. Defaults to 0. */
	seed?: number;
}

// ── Builder ─────────────────────────────────────────────────────────

/**
 * Build a valid BlueprintDoc from a nested, domain-shaped input.
 *
 * Mints deterministic uuids so snapshots and equality checks are stable,
 * populates `moduleOrder` / `formOrder` / `fieldOrder` / `fieldParent`
 * automatically, and recurses through container-field children.
 */
export function makeDoc(input: MakeDocInput): BlueprintDoc {
	/*
	 * Counter is doc-local — a fresh makeDoc() call resets to the seed.
	 * This is what makes two calls with the same seed produce identical
	 * docs regardless of what ran before them.
	 */
	let counter = input.seed ?? 0;
	const nextUuid = (): Uuid => {
		counter += 1;
		/*
		 * Pad to the UUID hex slots. The shape is a valid RFC 4122 v4
		 * template (version nibble = 4, variant nibble = 8), so these
		 * uuids survive any downstream validation that checks the v4
		 * pattern.
		 */
		const hex = counter.toString(16).padStart(12, "0");
		return asUuid(`00000000-0000-4000-8000-${hex}`);
	};

	const modules: Record<Uuid, Module> = {};
	const forms: Record<Uuid, Form> = {};
	const fields: Record<Uuid, Field> = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: Record<Uuid, Uuid[]> = {};
	const fieldOrder: Record<Uuid, Uuid[]> = {};

	/*
	 * Install a field record under `parentUuid` (a form or container) and,
	 * if it has children, recurse. Every parent's `fieldOrder` entry is
	 * pre-initialized to `[]` by the caller (forms at form creation,
	 * containers just below when we recurse), so the push is unconditional.
	 */
	const installField = (f: MakeFieldInput, parentUuid: Uuid): void => {
		const fieldUuid = f.uuid ? asUuid(f.uuid) : nextUuid();
		fieldOrder[parentUuid].push(fieldUuid);

		/*
		 * Strip DSL-only keys (`children`, `uuid`) from the spread — the
		 * children belong on fieldOrder, not on the Field record, and the
		 * raw string `uuid` is replaced by the branded Uuid below.
		 */
		const { children, uuid: _u, ...rest } = f;
		fields[fieldUuid] = { ...rest, uuid: fieldUuid } as Field;

		if (children?.length) {
			fieldOrder[fieldUuid] = [];
			for (const child of children) installField(child, fieldUuid);
		}
	};

	for (const mIn of input.modules) {
		const moduleUuid = mIn.uuid ? asUuid(mIn.uuid) : nextUuid();
		moduleOrder.push(moduleUuid);
		formOrder[moduleUuid] = [];

		const { forms: formInputs, uuid: _mu, ...modRest } = mIn;
		modules[moduleUuid] = { ...modRest, uuid: moduleUuid } as Module;

		for (const fIn of formInputs) {
			const formUuid = fIn.uuid ? asUuid(fIn.uuid) : nextUuid();
			formOrder[moduleUuid].push(formUuid);
			fieldOrder[formUuid] = [];

			const { fields: fieldInputs, uuid: _fu, ...formRest } = fIn;
			forms[formUuid] = { ...formRest, uuid: formUuid } as Form;

			for (const fieldIn of fieldInputs) installField(fieldIn, formUuid);
		}
	}

	const doc: BlueprintDoc = {
		appId: input.appId,
		appName: input.appName,
		connectType: input.connectType ?? null,
		caseTypes: input.caseTypes ?? null,
		modules,
		forms,
		fields,
		moduleOrder,
		formOrder,
		fieldOrder,
		/*
		 * rebuildFieldParent re-derives the reverse index from fieldOrder,
		 * so we hand it an empty map and let it populate. Mirrors what the
		 * real store does on load.
		 */
		fieldParent: {} as Record<Uuid, Uuid | null>,
	};
	rebuildFieldParent(doc);
	return doc;
}

// ── Lookup helpers ──────────────────────────────────────────────────

/**
 * Resolve a form's uuid from its semantic id, scoped to a module id.
 *
 * Tests that exercise pipeline entry points like `buildXForm(doc, formUuid, …)`
 * need to look up the uuid from the readable ids their fixture specified.
 * Throws with a specific message when either lookup fails so test output
 * points at the bad call directly.
 */
export function formUuidByIds(
	doc: BlueprintDoc,
	moduleId: string,
	formId: string,
): Uuid {
	const moduleUuid = doc.moduleOrder.find(
		(u) => doc.modules[u].id === moduleId,
	);
	if (!moduleUuid) throw new Error(`module with id "${moduleId}" not found`);

	const formUuid = (doc.formOrder[moduleUuid] ?? []).find(
		(u) => doc.forms[u].id === formId,
	);
	if (!formUuid) {
		throw new Error(
			`form with id "${formId}" in module "${moduleId}" not found`,
		);
	}

	return formUuid;
}
