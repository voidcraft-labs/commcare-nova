// lib/case-store/form-bridge/__tests__/deriveFromForm.test.ts
//
// Pure-function tests for `deriveFromForm`. The function consumes a
// `BlueprintDoc` + a `CompletedForm` snapshot and emits a typed
// `DerivedFormOps` discriminated union. No I/O — every test
// constructs the inputs in-process and asserts against the returned
// shape.
//
// Coverage:
//
//   - The four form-type arms (registration / followup / close /
//     survey) emit the correct discriminator.
//   - Primary case properties bucket on `case_property_on ===
//     moduleCaseType`.
//   - Child case properties bucket on any other `case_property_on`,
//     producing one `ChildInsertOp` per (case-type, repeat-instance).
//   - Repeat fan-out: a repeat with N instances produces N child
//     ops, each with the per-instance values plugged in.
//   - Value coercion: per-`data_type` string-to-typed-JSON
//     conversion (int / decimal / multi_select / etc.).
//   - Error paths: registration without `moduleCaseType`; followup /
//     close without `caseId`.

import { describe, expect, it } from "vitest";
import { deriveFromForm } from "../deriveFromForm";
import {
	type BuildBlueprintArgs,
	type BuiltBlueprint,
	buildFormBlueprint,
	completed,
	PATIENT_CASE_TYPE,
	VISIT_CASE_TYPE,
} from "./fixtures";

// ---------------------------------------------------------------
// Per-suite parameters
// ---------------------------------------------------------------
//
// The pure tests pin a generic `appId` because the function never
// reads it (the case-store layer is the only consumer of `appId`,
// and these tests stop at the derivation surface). A wrapper around
// the shared `buildBlueprint` injects the constant so each `it(...)`
// body reads as one call.

const APP_ID = "app-test";

function buildBlueprint(
	args: Omit<BuildBlueprintArgs, "appId">,
): BuiltBlueprint {
	return buildFormBlueprint({ appId: APP_ID, ...args });
}

// ---------------------------------------------------------------
// Survey form
// ---------------------------------------------------------------

describe("deriveFromForm — survey forms", () => {
	it("returns the survey marker without walking the tree", () => {
		const built = buildBlueprint({
			formType: "survey",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				// Even with case-property-bound fields present, a
				// survey form contributes no case-store ops.
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([["/data/case_name", "Alice"]]),
		});

		expect(ops).toEqual({ kind: "survey" });
	});
});

// ---------------------------------------------------------------
// Registration form
// ---------------------------------------------------------------

describe("deriveFromForm — registration forms", () => {
	it("emits a primary insert with case_name and case_property fields", () => {
		const built = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([
				["/data/case_name", "Alice"],
				["/data/age", "30"],
			]),
		});

		expect(ops.kind).toBe("registration");
		if (ops.kind !== "registration") return;
		expect(ops.primary.caseType).toBe("patient");
		// `case_name` routes to the column slot; the JSONB document
		// carries only the user-defined properties.
		expect(ops.primary.caseName).toBe("Alice");
		expect(ops.primary.properties).toEqual({
			// `int` data_type → numeric coercion.
			age: 30,
		});
		expect(ops.children).toEqual([]);
	});

	it("buckets child-case fields into separate ChildInsertOp entries", () => {
		const built = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "notes",
					kind: "text",
					label: "Notes",
					case_property_on: "visit",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([
				["/data/case_name", "Alice"],
				["/data/notes", "First visit"],
			]),
		});

		expect(ops.kind).toBe("registration");
		if (ops.kind !== "registration") return;
		// Patient `case_name` routes to the column slot; the JSONB
		// document is empty because the only patient field was
		// `case_name`.
		expect(ops.primary.caseName).toBe("Alice");
		expect(ops.primary.properties).toEqual({});
		expect(ops.children).toEqual([
			{
				caseType: "visit",
				properties: { notes: "First visit" },
				// Registration: no parentCaseId on the derived op
				// (writeThrough threads the primary's generated id).
			},
		]);
	});

	it("fans out repeat instances into one ChildInsertOp per index", () => {
		const built = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "visits",
					kind: "repeat",
					label: "Visits",
					children: [
						{
							id: "notes",
							kind: "text",
							label: "Notes",
							case_property_on: "visit",
						},
					],
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([
				["/data/case_name", "Alice"],
				["/data/visits[0]/notes", "First note"],
				["/data/visits[1]/notes", "Second note"],
				["/data/visits[2]/notes", "Third note"],
			]),
		});

		expect(ops.kind).toBe("registration");
		if (ops.kind !== "registration") return;
		expect(ops.children).toHaveLength(3);
		expect(ops.children[0]).toEqual({
			caseType: "visit",
			properties: { notes: "First note" },
		});
		expect(ops.children[1]).toEqual({
			caseType: "visit",
			properties: { notes: "Second note" },
		});
		expect(ops.children[2]).toEqual({
			caseType: "visit",
			properties: { notes: "Third note" },
		});
	});

	it("coerces every data_type per the JSON Schema generator's mapping", () => {
		const built = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
				{
					id: "weight",
					kind: "decimal",
					label: "Weight",
					case_property_on: "patient",
				},
				{
					id: "dob",
					kind: "date",
					label: "DOB",
					case_property_on: "patient",
				},
				{
					id: "tags",
					kind: "multi_select",
					label: "Tags",
					case_property_on: "patient",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([
				["/data/case_name", "Alice"],
				["/data/age", "30"],
				["/data/weight", "55.5"],
				["/data/dob", "1995-03-12"],
				// XForm convention: multi-select is space-separated.
				["/data/tags", "urgent stable"],
			]),
		});

		expect(ops.kind).toBe("registration");
		if (ops.kind !== "registration") return;
		// `case_name` lands on the column; every other typed property
		// flows through the JSONB document.
		expect(ops.primary.caseName).toBe("Alice");
		expect(ops.primary.properties).toEqual({
			age: 30,
			weight: 55.5,
			dob: "1995-03-12",
			tags: ["urgent", "stable"],
		});
	});

	it("omits properties whose path is absent from the values map (production shape)", () => {
		// `FormEngine.getValueSnapshot()` filters empty-string
		// entries out of the returned map (`if (state.value)
		// values.set(...)` at `lib/preview/engine/formEngine.ts:644`),
		// so a field the user never touched produces no key in the
		// snapshot. This test pins the production path: only
		// `case_name` carries a non-empty value, every other
		// `case_property_on`-bearing field's path is absent from the
		// `values` map, and the derived JSONB document carries only
		// the populated property.
		const built = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
				{
					id: "weight",
					kind: "decimal",
					label: "Weight",
					case_property_on: "patient",
				},
				{
					id: "dob",
					kind: "date",
					label: "DOB",
					case_property_on: "patient",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			// Only the populated path lives in the map — the engine
			// dropped every empty-string entry on snapshot creation.
			completedForm: completed([["/data/case_name", "Alice"]]),
		});

		expect(ops.kind).toBe("registration");
		if (ops.kind !== "registration") return;
		// Absent paths translate to absent JSONB keys. Postgres-strict
		// null/blank then distinguishes absent (`is-null` match) from
		// explicit empty string (`is-blank` match but NOT `is-null`)
		// at the case-list filter layer. `case_name` routes to the
		// column slot regardless of the JSONB document's shape.
		expect(ops.primary.caseName).toBe("Alice");
		expect(ops.primary.properties).toEqual({});
	});

	it("also omits properties whose value is the empty string (defensive belt-and-suspenders)", () => {
		// The walk's `if (rawValue === "") continue` short-circuit
		// covers any future engine variant that surfaces explicit
		// empty strings instead of dropping them — today's
		// `getValueSnapshot()` filters at line 644, but the same
		// `omit-empty-from-JSONB` policy must hold regardless of
		// what the snapshot carries. Storing an empty string under
		// a `format: date` property would fail ajv-formats outright,
		// so this branch is structurally important even though no
		// production caller hits it.
		const built = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "dob",
					kind: "date",
					label: "DOB",
					case_property_on: "patient",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([
				["/data/case_name", "Alice"],
				// Explicit empty-string entry — not what production
				// produces today, but the policy must hold here too.
				["/data/dob", ""],
			]),
		});

		expect(ops.kind).toBe("registration");
		if (ops.kind !== "registration") return;
		// Same shape as the "absent path" test above — `case_name` on
		// the column, no JSONB writes from the empty-string `dob`.
		expect(ops.primary.caseName).toBe("Alice");
		expect(ops.primary.properties).toEqual({});
	});

	it("throws when moduleCaseType is missing", () => {
		const built = buildBlueprint({
			formType: "registration",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
			],
		});

		expect(() =>
			deriveFromForm({
				blueprint: built.blueprint,
				formUuid: built.formUuid,
				formType: built.formType,
				moduleCaseType: undefined,
				completedForm: completed([["/data/case_name", "Alice"]]),
			}),
		).toThrow(/registration form/);
	});
});

// ---------------------------------------------------------------
// Followup form
// ---------------------------------------------------------------

describe("deriveFromForm — followup forms", () => {
	const FOLLOWUP_CASE_ID = "20000000-0000-0000-0000-000000000001";

	it("emits a primary update with case_property fields", () => {
		const built = buildBlueprint({
			formType: "followup",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([["/data/age", "31"]], FOLLOWUP_CASE_ID),
		});

		expect(ops.kind).toBe("followup");
		if (ops.kind !== "followup") return;
		expect(ops.caseId).toBe(FOLLOWUP_CASE_ID);
		expect(ops.primary.properties).toEqual({ age: 31 });
		expect(ops.children).toEqual([]);
	});

	it("emits children with parentCaseId set to the bound caseId", () => {
		const built = buildBlueprint({
			formType: "followup",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
				{
					id: "notes",
					kind: "text",
					label: "Notes",
					case_property_on: "visit",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed(
				[["/data/notes", "Follow-up note"]],
				FOLLOWUP_CASE_ID,
			),
		});

		expect(ops.kind).toBe("followup");
		if (ops.kind !== "followup") return;
		expect(ops.children).toEqual([
			{
				caseType: "visit",
				properties: { notes: "Follow-up note" },
				parentCaseId: FOLLOWUP_CASE_ID,
			},
		]);
	});

	it("emits an empty primary properties object when no fields write to the module case type", () => {
		// A followup form whose every leaf is a child-case field
		// produces an empty primary patch — the writeThrough layer
		// short-circuits the `update` call in that shape.
		const built = buildBlueprint({
			formType: "followup",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
				{
					id: "notes",
					kind: "text",
					label: "Notes",
					case_property_on: "visit",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([["/data/notes", "x"]], FOLLOWUP_CASE_ID),
		});

		expect(ops.kind).toBe("followup");
		if (ops.kind !== "followup") return;
		expect(ops.primary.properties).toEqual({});
	});

	it("throws when caseId is missing", () => {
		const built = buildBlueprint({
			formType: "followup",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
			],
		});

		expect(() =>
			deriveFromForm({
				blueprint: built.blueprint,
				formUuid: built.formUuid,
				formType: built.formType,
				moduleCaseType: "patient",
				completedForm: completed([["/data/age", "31"]]),
			}),
		).toThrow(/requires `completedForm\.caseId`/);
	});
});

// ---------------------------------------------------------------
// Close form
// ---------------------------------------------------------------

describe("deriveFromForm — close forms", () => {
	const CLOSE_CASE_ID = "20000000-0000-0000-0000-000000000002";

	it("emits a primary update plus the close discriminator", () => {
		const built = buildBlueprint({
			formType: "close",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "age",
					kind: "int",
					label: "Final age",
					case_property_on: "patient",
				},
			],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([["/data/age", "45"]], CLOSE_CASE_ID),
		});

		expect(ops.kind).toBe("close");
		if (ops.kind !== "close") return;
		expect(ops.caseId).toBe(CLOSE_CASE_ID);
		expect(ops.primary.properties).toEqual({ age: 45 });
		expect(ops.children).toEqual([]);
	});

	it("emits empty primary properties for close-only forms", () => {
		const built = buildBlueprint({
			formType: "close",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			// Close form with NO writes — pure closure action.
			fields: [],
		});

		const ops = deriveFromForm({
			blueprint: built.blueprint,
			formUuid: built.formUuid,
			formType: built.formType,
			moduleCaseType: "patient",
			completedForm: completed([], CLOSE_CASE_ID),
		});

		expect(ops.kind).toBe("close");
		if (ops.kind !== "close") return;
		expect(ops.primary.properties).toEqual({});
		expect(ops.children).toEqual([]);
	});

	it("throws when caseId is missing", () => {
		const built = buildBlueprint({
			formType: "close",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [],
		});

		expect(() =>
			deriveFromForm({
				blueprint: built.blueprint,
				formUuid: built.formUuid,
				formType: built.formType,
				moduleCaseType: "patient",
				completedForm: completed([]),
			}),
		).toThrow(/requires `completedForm\.caseId`/);
	});
});
