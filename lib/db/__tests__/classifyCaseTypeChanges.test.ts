// lib/db/__tests__/classifyCaseTypeChanges.test.ts
//
// Unit coverage for the schema-affecting-change classifier
// `applyBlueprintChange` consumes. Pins the three contracts
// the classifier enforces:
//
//   1. Pure non-case-type mutations yield an empty array, so no
//      case-schema materialization is needed.
//   2. Case-type additions emit one schema-sync entry per
//      added case type so `case_type_schemas` materializes before
//      the first row insert.
//   3. Case-type removals emit an explicit retirement entry.
//   4. Property-surface diffs (add, remove, type shift, option
//      changes) emit one schema-sync entry per affected
//      case type.
//
// Explicit case-property renames never originate here: the batch-exclusive
// command carries its admitted relation directly into the guarded transaction.

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseType } from "@/lib/domain";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { classifyCaseTypeChanges } from "../classifyCaseTypeChanges";

// Minimal `BlueprintDoc` fixture — the classifier reads `caseTypes`
// only, so every other field stays empty / zero-valued. The cast
// to `BlueprintDoc` papers over the `fieldParent` index that the
// in-memory shape carries; the classifier never touches it.
function makeDoc(caseTypes: CaseType[] | null): BlueprintDoc {
	return {
		appId: "test-app",
		appName: "Test",
		connectType: null,
		caseTypes,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: proseText("Name"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
	],
};

describe("classifyCaseTypeChanges — pure non-case-type mutations", () => {
	it("returns no entries when both blueprints have null caseTypes", () => {
		const result = classifyCaseTypeChanges({
			prior: makeDoc(null),
			prospective: makeDoc(null),
		});
		expect(result).toEqual([]);
	});

	it("returns no entries when caseTypes are identical by value", () => {
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			// Independent object literal — same shape.
			prospective: makeDoc([
				{
					name: "patient",
					properties: [
						{ name: "name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			]),
		});
		expect(result).toEqual([]);
	});
});

describe("classifyCaseTypeChanges — case-type additions", () => {
	it("emits one schema-sync-only entry per added case type", () => {
		const result = classifyCaseTypeChanges({
			prior: makeDoc(null),
			prospective: makeDoc([PATIENT]),
		});
		expect(result).toEqual([{ kind: "sync", caseType: "patient" }]);
	});

	it("emits one entry per added case type when multiple land at once", () => {
		const visit: CaseType = {
			name: "visit",
			properties: [
				{ name: "date", label: proseText("Date"), data_type: "date" },
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc(null),
			prospective: makeDoc([PATIENT, visit]),
		});
		expect(result).toHaveLength(2);
		const names = new Set(result.map((e) => e.caseType));
		expect(names).toEqual(new Set(["patient", "visit"]));
	});
});

describe("classifyCaseTypeChanges — case-type removals", () => {
	it("emits one retirement entry when a case type is removed", () => {
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([]),
		});
		expect(result).toEqual([{ kind: "retire", caseType: "patient" }]);
	});
});

describe("classifyCaseTypeChanges — property-surface diffs", () => {
	it("emits one schema-sync-only entry when a property is added", () => {
		const extended: CaseType = {
			name: "patient",
			properties: [
				...PATIENT.properties,
				{ name: "phone", label: proseText("Phone"), data_type: "text" },
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([extended]),
		});
		expect(result).toEqual([{ kind: "sync", caseType: "patient" }]);
	});

	it("emits one schema-sync-only entry when a property is removed", () => {
		// Existing values for the removed property remain in JSONB
		// until each row's next properties write, where the store's
		// merged-update strip sheds them. The schema-sync entry
		// regenerates the JSON Schema (no longer references the
		// property) and emits the index DDL diff (drops the removed
		// property's expression index). No writer field exists in
		// this fixture, so no rename is proven.
		const reduced: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([reduced]),
		});
		expect(result).toEqual([{ kind: "sync", caseType: "patient" }]);
	});

	it("emits one schema-sync-only entry when a data_type shifts", () => {
		// The classifier doesn't synthesize a `retype` migration —
		// unlike a rename, a type shift carries no identity evidence
		// to prove which rows-level rewrite the author intended. The
		// diff is a schema-sync-only event; the store's own
		// string↔array reshape rewrites flipped select shapes inside
		// the sync, and every other stale-typed value is the
		// derived-type-flip reconciliation feature's territory.
		const retyped: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "decimal" },
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([retyped]),
		});
		expect(result).toEqual([{ kind: "sync", caseType: "patient" }]);
	});

	it("emits one schema-sync-only entry when option set narrows", () => {
		const withOptions: CaseType = {
			name: "patient",
			properties: [
				{
					name: "color",
					label: proseText("Color"),
					data_type: "single_select",
					options: [
						{ value: "red", label: proseText("Red") },
						{ value: "blue", label: proseText("Blue") },
					],
				},
			],
		};
		const narrowed: CaseType = {
			name: "patient",
			properties: [
				{
					name: "color",
					label: proseText("Color"),
					data_type: "single_select",
					options: [{ value: "blue", label: proseText("Blue") }],
				},
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([withOptions]),
			prospective: makeDoc([narrowed]),
		});
		expect(result).toEqual([{ kind: "sync", caseType: "patient" }]);
	});

	it("does NOT emit an entry when only modules / forms / fields differ", () => {
		const docA = makeDoc([PATIENT]);
		const docB = makeDoc([PATIENT]);
		// Add a stub module to docB — case_types unchanged. The
		// branded `Uuid` type checks at the slot; the cast through
		// `unknown` papers over the brand for this fixture, where
		// the classifier reads `caseTypes` only and never inspects
		// modules.
		const modUuid =
			"00000000-0000-7000-8000-000000000001" as unknown as import("@/lib/domain").Uuid;
		docB.modules = {
			[modUuid]: { uuid: modUuid, id: "patients", name: "Patients" },
		};
		const result = classifyCaseTypeChanges({
			prior: docA,
			prospective: docB,
		});
		expect(result).toEqual([]);
	});
});

describe("classifyCaseTypeChanges — writer-derived type flips", () => {
	// The classifier diffs the MATERIALIZABLE views, so a property whose
	// `data_type` is never authored in the catalog still re-syncs when a
	// kind conversion flips what its WRITER derives — a raw-catalog diff
	// would see two identical (typeless) declarations and leave
	// `case_type_schemas` stale against the compiler's view. The catalog
	// entry itself is UNTYPED (the declaration chokepoint's bare record
	// shape); only the writer's kind pins the type.
	function docWithWriterKind(kind: "text" | "single_select"): BlueprintDoc {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "facility", label: proseText("Facility") },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									id: "facility",
									kind,
									label: "Facility",
									caseWrite: {
										caseType: "patient",
										property: "facility",
									},
									...(kind === "single_select" && {
										options: [
											{ value: "clinic_a", label: "Clinic A" },
											{ value: "clinic_b", label: "Clinic B" },
										],
									}),
								}),
							],
						},
					],
				},
			],
		});
		return doc;
	}

	it("a text → single_select conversion of a writer emits one schema-sync entry", () => {
		const result = classifyCaseTypeChanges({
			prior: docWithWriterKind("text"),
			prospective: docWithWriterKind("single_select"),
		});
		expect(result).toEqual([{ kind: "sync", caseType: "patient" }]);
	});

	it("an untouched writer surface emits nothing", () => {
		const result = classifyCaseTypeChanges({
			prior: docWithWriterKind("text"),
			prospective: docWithWriterKind("text"),
		});
		expect(result).toEqual([]);
	});
});

// ── The worker's own case ──────────────────────────────────────────

/** `makeDoc` plus a worker-property catalog. */
function withWorkerProperties(
	caseTypes: CaseType[] | null,
	properties: ReadonlyArray<{ uuid: string; slug: string; label: string }>,
): BlueprintDoc {
	return {
		...makeDoc(caseTypes),
		userProperties: Object.fromEntries(
			properties.map((property) => [property.uuid, property]),
		),
	} as unknown as BlueprintDoc;
}

describe("classifyCaseTypeChanges — commcare-user", () => {
	const CADRE = { uuid: "u-1", slug: "cadre", label: "Cadre" };

	it("syncs the worker's case when a worker property is added", () => {
		// The gap this closes: `commcare-user` is derived from the worker
		// catalog rather than declared, so it is deliberately absent from
		// `materializableCaseTypes` and the loops above cannot see it. Without
		// its own comparison an author adds a worker property, no schema sync
		// runs, and the next usercase write is refused by a stale case type —
		// the failure looking like a bug in the write rather than in the sync
		// that never happened.
		const result = classifyCaseTypeChanges({
			prior: withWorkerProperties([PATIENT], []),
			prospective: withWorkerProperties([PATIENT], [CADRE]),
		});
		expect(result).toEqual([{ kind: "sync", caseType: USERCASE_CASE_TYPE }]);
	});

	it("syncs when a worker property is removed", () => {
		const result = classifyCaseTypeChanges({
			prior: withWorkerProperties([PATIENT], [CADRE]),
			prospective: withWorkerProperties([PATIENT], []),
		});
		expect(result).toEqual([{ kind: "sync", caseType: USERCASE_CASE_TYPE }]);
	});

	it("syncs when a worker property is renamed", () => {
		// A slug rename changes the case type's property surface, because the
		// slug IS the property name on the worker's case.
		const result = classifyCaseTypeChanges({
			prior: withWorkerProperties([PATIENT], [CADRE]),
			prospective: withWorkerProperties(
				[PATIENT],
				[{ ...CADRE, slug: "role" }],
			),
		});
		expect(result).toEqual([{ kind: "sync", caseType: USERCASE_CASE_TYPE }]);
	});

	it("stays silent when the worker catalog did not change", () => {
		// The cost control. Emitting an entry on every commit would put a
		// schema sync on the autosave path for every keystroke-sized save.
		const result = classifyCaseTypeChanges({
			prior: withWorkerProperties([PATIENT], [CADRE]),
			prospective: withWorkerProperties([PATIENT], [{ ...CADRE }]),
		});
		expect(result).toEqual([]);
	});

	it("never retires the worker's case", () => {
		// Every app has one, so it is added and re-synced but never removed —
		// a retire entry would drop the schema out from under a live persona.
		const result = classifyCaseTypeChanges({
			prior: withWorkerProperties([PATIENT], [CADRE]),
			prospective: withWorkerProperties(null, []),
		});
		expect(
			result.filter((entry) => entry.caseType === USERCASE_CASE_TYPE),
		).toEqual([{ kind: "sync", caseType: USERCASE_CASE_TYPE }]);
	});
});
