// lib/db/__tests__/classifyCaseTypeChanges.test.ts
//
// Unit coverage for the schema-affecting-change classifier the
// saga (`applyBlueprintChange`) consumes. Pins the four contracts
// the classifier enforces:
//
//   1. Pure non-case-type mutations yield an empty array — the
//      saga skips Postgres entirely.
//   2. Case-type additions emit one schema-sync-only entry per
//      added case type so `case_type_schemas` materializes before
//      the first row insert.
//   3. Property-surface diffs (add, remove, type shift, option
//      changes) emit one schema-sync-only entry per affected
//      case type.
//   4. Renames are SYNTHESIZED from the snapshots via field-uuid
//      evidence and emit the matching `rename` change entry; the
//      covered case type is NOT re-emitted by the structural diff
//      loop (one `applySchemaChange` call covers both the schema
//      regen and the per-row migration). A departed property with
//      no surviving writer stays a plain removal.

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseType } from "@/lib/domain";
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
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
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
						{ name: "name", label: "Name", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
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
		expect(result).toEqual([{ caseType: "patient" }]);
	});

	it("emits one entry per added case type when multiple land at once", () => {
		const visit: CaseType = {
			name: "visit",
			properties: [{ name: "date", label: "Date", data_type: "date" }],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc(null),
			prospective: makeDoc([PATIENT, visit]),
		});
		expect(result).toHaveLength(2);
		const names = new Set(result.map((e) => e.caseType));
		expect(names).toEqual(new Set(["patient", "visit"]));
		// Schema-sync-only — no `property` / `change` slots populated.
		for (const entry of result) {
			expect(entry.property).toBeUndefined();
			expect(entry.change).toBeUndefined();
		}
	});
});

describe("classifyCaseTypeChanges — case-type removals", () => {
	it("does NOT emit an entry when a case type is removed", () => {
		// Removed case types leave their `case_type_schemas` row
		// orphaned — the runtime never reads a schema for a missing
		// case type, so the saga has no Postgres work to do for the
		// removal.
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([]),
		});
		expect(result).toEqual([]);
	});
});

describe("classifyCaseTypeChanges — property-surface diffs", () => {
	it("emits one schema-sync-only entry when a property is added", () => {
		const extended: CaseType = {
			name: "patient",
			properties: [
				...PATIENT.properties,
				{ name: "phone", label: "Phone", data_type: "text" },
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([extended]),
		});
		expect(result).toEqual([{ caseType: "patient" }]);
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
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([reduced]),
		});
		expect(result).toEqual([{ caseType: "patient" }]);
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
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "decimal" },
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([retyped]),
		});
		expect(result).toEqual([{ caseType: "patient" }]);
	});

	it("emits one schema-sync-only entry when option set narrows", () => {
		const withOptions: CaseType = {
			name: "patient",
			properties: [
				{
					name: "color",
					label: "Color",
					data_type: "single_select",
					options: [
						{ value: "red", label: "Red" },
						{ value: "blue", label: "Blue" },
					],
				},
			],
		};
		const narrowed: CaseType = {
			name: "patient",
			properties: [
				{
					name: "color",
					label: "Color",
					data_type: "single_select",
					options: [{ value: "blue", label: "Blue" }],
				},
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([withOptions]),
			prospective: makeDoc([narrowed]),
		});
		expect(result).toEqual([{ caseType: "patient" }]);
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

describe("classifyCaseTypeChanges — synthesized renames", () => {
	// The classifier proves a rename from the two snapshots alone:
	// a property left the case type's materializable view AND the
	// same-uuid field that wrote it still writes the type under a
	// new name the prospective view declares. These fixtures build
	// real docs (catalog + writer field) so the evidence rule runs
	// against the same materializable view production uses.
	function patientDoc(args: {
		fieldId: string;
		catalog: readonly { name: string; label: string }[];
	}): BlueprintDoc {
		return buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: args.catalog.map((p) => ({ ...p })),
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
									uuid: "field-age",
									id: args.fieldId,
									kind: "int",
									label: "Age",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
	}

	it("emits a `rename` change entry when a same-uuid writer's id moves", () => {
		// A same-batch rename CHAIN (age → middle → years) produces the
		// identical snapshot pair — only the endpoints exist — so this
		// case also pins chain collapse.
		const result = classifyCaseTypeChanges({
			prior: patientDoc({
				fieldId: "age",
				catalog: [{ name: "age", label: "Age" }],
			}),
			prospective: patientDoc({
				fieldId: "years",
				catalog: [{ name: "years", label: "Years" }],
			}),
		});
		// One entry — the rename covers the case type, so the
		// structural diff loop is suppressed for `patient`.
		expect(result).toEqual([
			{
				caseType: "patient",
				property: "years",
				change: { kind: "rename", from: "age", to: "years" },
			},
		]);
	});

	it("proves a MERGE-rename (destination already declared) the same way", () => {
		const result = classifyCaseTypeChanges({
			prior: patientDoc({
				fieldId: "age",
				catalog: [
					{ name: "age", label: "Age" },
					{ name: "years", label: "Years" },
				],
			}),
			// The cascade's merge drops the old entry and keeps the
			// surviving declaration.
			prospective: patientDoc({
				fieldId: "years",
				catalog: [{ name: "years", label: "Years" }],
			}),
		});
		expect(result).toEqual([
			{
				caseType: "patient",
				property: "years",
				change: { kind: "rename", from: "age", to: "years" },
			},
		]);
	});

	it("proves a bare-writer DERIVED property rename with no catalog entry", () => {
		// The property exists in the view only through the writer's
		// id — a catalog-diff or cascade-meta approach would miss it.
		const result = classifyCaseTypeChanges({
			prior: patientDoc({ fieldId: "age", catalog: [] }),
			prospective: patientDoc({ fieldId: "years", catalog: [] }),
		});
		expect(result).toEqual([
			{
				caseType: "patient",
				property: "years",
				change: { kind: "rename", from: "age", to: "years" },
			},
		]);
	});

	it("treats a departed property with no surviving writer as a removal", () => {
		// Same snapshots as a rename except the field is GONE in the
		// prospective — no uuid evidence, so no per-row migration;
		// the schema-sync entry stands alone and the store sheds the
		// orphaned row values on each row's next write.
		const prior = patientDoc({
			fieldId: "age",
			catalog: [{ name: "age", label: "Age" }],
		});
		const prospective = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const result = classifyCaseTypeChanges({ prior, prospective });
		expect(result).toEqual([{ caseType: "patient" }]);
	});

	it("does not prove a rename when the writer stopped writing the case type", () => {
		// The field survives under its uuid with a new id, but its
		// `case_property_on` no longer targets the case type — the new
		// id is not the departed property's new home.
		const prior = patientDoc({ fieldId: "age", catalog: [] });
		const prospective = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
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
									uuid: "field-age",
									id: "years",
									kind: "int",
									label: "Age",
								}),
							],
						},
					],
				},
			],
		});
		const result = classifyCaseTypeChanges({ prior, prospective });
		expect(result).toEqual([{ caseType: "patient" }]);
	});

	it("pairs a rename entry with an unrelated case type's sync entry", () => {
		const visit: CaseType = {
			name: "visit",
			properties: [{ name: "date", label: "Date", data_type: "date" }],
		};
		const visitV2: CaseType = {
			name: "visit",
			properties: [
				{ name: "date", label: "Date", data_type: "date" },
				{ name: "outcome", label: "Outcome", data_type: "text" },
			],
		};
		const prior = patientDoc({
			fieldId: "age",
			catalog: [{ name: "age", label: "Age" }],
		});
		const prospective = patientDoc({
			fieldId: "years",
			catalog: [{ name: "years", label: "Years" }],
		});
		prior.caseTypes = [...(prior.caseTypes ?? []), visit];
		prospective.caseTypes = [...(prospective.caseTypes ?? []), visitV2];
		const result = classifyCaseTypeChanges({ prior, prospective });
		expect(result).toHaveLength(2);
		expect(result[0]?.caseType).toBe("patient");
		expect(result[0]?.change?.kind).toBe("rename");
		expect(result[1]).toEqual({ caseType: "visit" });
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
						{ name: "case_name", label: "Name" },
						{ name: "facility", label: "Facility" },
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
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									id: "facility",
									kind,
									label: "Facility",
									case_property_on: "patient",
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
		expect(result).toEqual([{ caseType: "patient" }]);
	});

	it("an untouched writer surface emits nothing", () => {
		const result = classifyCaseTypeChanges({
			prior: docWithWriterKind("text"),
			prospective: docWithWriterKind("text"),
		});
		expect(result).toEqual([]);
	});
});
