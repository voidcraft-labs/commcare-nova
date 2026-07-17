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
//      case type. The classifier doesn't synthesize per-row
//      migrations from the diff alone.
//   4. Explicit `hint`s (rename / retype / narrow-options) emit
//      the matching discriminated `change` entry, and the case
//      type covered by the hint is NOT re-emitted by the
//      structural diff loop (one `applySchemaChange` call covers
//      both the schema regen and the per-row migration).

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

	it("an external-marking-only change is schema-inert — no entry", () => {
		// `external` is a design fact for the no-writer advisory; nothing
		// about the materialized JSON Schema or the index set reads it, so
		// marking/clearing must never enqueue schema work.
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([
				{
					name: "patient",
					properties: [
						{
							name: "name",
							label: "Name",
							data_type: "text",
							external: { note: "set by the registry app" },
						},
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

describe("classifyCaseTypeChanges — property-surface diffs (no hint)", () => {
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
		// until the next write of the row, then drop. The schema-
		// sync entry regenerates the JSON Schema (no longer
		// references the property) and emits the index DDL diff
		// (drops the removed property's expression index).
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

	it("emits one schema-sync-only entry when a data_type shifts and no hint is supplied", () => {
		// The classifier doesn't synthesize a `retype` migration
		// from the diff alone — the typed-AST tools thread the
		// `change` shape through the `hint` slot when they want
		// per-row migration semantics. Without a hint, the diff
		// is treated as a schema-sync-only event; the case-store
		// regenerates the JSON Schema and rows that already fail
		// the new schema land in `cases_quarantine` on next write.
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

describe("classifyCaseTypeChanges — explicit hints", () => {
	it("emits a `rename` change entry for a rename hint", () => {
		const renamed: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "years", label: "Years", data_type: "int" },
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT]),
			prospective: makeDoc([renamed]),
			hint: { kind: "rename", caseType: "patient", from: "age", to: "years" },
		});
		// One entry — the hint covers the case type, so the
		// structural diff loop is suppressed for `patient`.
		expect(result).toEqual([
			{
				caseType: "patient",
				property: "years",
				change: { kind: "rename", from: "age", to: "years" },
			},
		]);
	});

	it("emits a `retype` change entry for a retype hint", () => {
		const retyped: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "int" },
			],
		};
		const initialTextAge: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "text" },
			],
		};
		const result = classifyCaseTypeChanges({
			prior: makeDoc([initialTextAge]),
			prospective: makeDoc([retyped]),
			hint: {
				kind: "retype",
				caseType: "patient",
				property: "age",
				fromType: "text",
				toType: "int",
			},
		});
		expect(result).toEqual([
			{
				caseType: "patient",
				property: "age",
				change: { kind: "retype", fromType: "text", toType: "int" },
			},
		]);
	});

	it("emits a `narrow-options` change entry for a narrow-options hint", () => {
		const initial: CaseType = {
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
			prior: makeDoc([initial]),
			prospective: makeDoc([narrowed]),
			hint: {
				kind: "narrow-options",
				caseType: "patient",
				property: "color",
				removedOptions: ["red"],
			},
		});
		expect(result).toEqual([
			{
				caseType: "patient",
				property: "color",
				change: { kind: "narrow-options", removedOptions: ["red"] },
			},
		]);
	});

	it("emits the hint entry plus structural entries for OTHER affected case types", () => {
		// Hint targets `patient`; an unrelated case-type (`visit`)
		// also shifts. Expectation: one hint entry for `patient`,
		// one schema-sync-only entry for `visit`.
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
		const result = classifyCaseTypeChanges({
			prior: makeDoc([PATIENT, visit]),
			prospective: makeDoc([PATIENT, visitV2]),
			hint: { kind: "rename", caseType: "patient", from: "age", to: "years" },
		});
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
