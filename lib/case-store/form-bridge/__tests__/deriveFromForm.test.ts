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
import type {
	BlueprintDoc,
	CaseType,
	Field,
	FieldKind,
	Form,
	FormType,
	Uuid,
} from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { type CompletedForm, deriveFromForm } from "../deriveFromForm";

// ---------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------
//
// The fixture builds a minimal `BlueprintDoc` with one form, its
// fields, and a `fieldOrder` adjacency. The shape mirrors the
// pattern in `lib/preview/engine/__tests__/formEngine.test.ts` so
// future maintainers can cross-reference fixture conventions.

interface DField {
	id: string;
	kind: FieldKind;
	label?: string;
	required?: string;
	relevant?: string;
	calculate?: string;
	default_value?: string;
	case_property_on?: string;
	options?: Array<{ value: string; label: string }>;
	children?: DField[];
}

interface BuildBlueprintArgs {
	formType: FormType;
	moduleCaseType?: string;
	caseTypes: ReadonlyArray<CaseType>;
	fields: ReadonlyArray<DField>;
}

interface BuiltBlueprint {
	blueprint: BlueprintDoc;
	formUuid: Uuid;
	formType: FormType;
}

const FORM_UUID = asUuid("test-form-uuid");
const APP_ID = "app-test";

/**
 * Build a single-form `BlueprintDoc` from a nested field-tree
 * fixture. The form, module, and field maps fill from the supplied
 * shape; uuid generation is deterministic per position path so
 * fixture changes produce stable diffs.
 */
function buildBlueprint(args: BuildBlueprintArgs): BuiltBlueprint {
	const moduleUuid = asUuid("test-module-uuid");
	const form: Form = {
		uuid: FORM_UUID,
		id: "test-form",
		name: "Test Form",
		type: args.formType,
	};
	const fields: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};
	const fieldParent: Record<string, Uuid | null> = {};

	const walk = (nodes: ReadonlyArray<DField>, parentUuid: Uuid): Uuid[] => {
		const order: Uuid[] = [];
		for (const node of nodes) {
			// Position-derived uuid: `<parentUuid>.<id>` — stable,
			// readable in failure messages, no clock dependency.
			const uuid = asUuid(`${parentUuid}.${node.id}`);
			order.push(uuid);
			fieldParent[uuid] = parentUuid;
			const { children, ...rest } = node;
			fields[uuid] = { uuid, ...rest } as Field;
			if (node.kind === "group" || node.kind === "repeat") {
				fieldOrder[uuid] = walk(children ?? [], uuid);
			}
		}
		return order;
	};

	fieldOrder[FORM_UUID] = walk(args.fields, FORM_UUID);

	return {
		blueprint: {
			appId: APP_ID,
			appName: "test-app",
			connectType: null,
			caseTypes: [...args.caseTypes],
			modules: {
				[moduleUuid]: {
					uuid: moduleUuid,
					id: "test-module",
					name: "Test Module",
					...(args.moduleCaseType !== undefined
						? { caseType: args.moduleCaseType }
						: {}),
				},
			},
			forms: { [FORM_UUID]: form },
			fields,
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [FORM_UUID] },
			fieldOrder,
			fieldParent,
		},
		formUuid: FORM_UUID,
		formType: args.formType,
	};
}

/**
 * Convenience: build a `CompletedForm` from path → value pairs.
 * Tests construct the snapshot directly to model the engine's
 * `getValueSnapshot().values` output.
 */
function completed(
	values: ReadonlyArray<[string, string]>,
	caseId?: string,
): CompletedForm {
	return {
		values: new Map(values),
		...(caseId !== undefined ? { caseId } : {}),
	};
}

// ---------------------------------------------------------------
// Shared case-type fixtures
// ---------------------------------------------------------------

const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight (kg)", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select",
			options: [
				{ value: "urgent", label: "Urgent" },
				{ value: "stable", label: "Stable" },
			],
		},
	],
};

const VISIT_CASE_TYPE: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [
		{ name: "case_name", label: "Visit", data_type: "text" },
		{ name: "notes", label: "Notes", data_type: "text" },
	],
};

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
		expect(ops.primary.properties).toEqual({
			case_name: "Alice",
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
		expect(ops.primary.properties).toEqual({ case_name: "Alice" });
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
		expect(ops.primary.properties).toEqual({
			case_name: "Alice",
			age: 30,
			weight: 55.5,
			dob: "1995-03-12",
			tags: ["urgent", "stable"],
		});
	});

	it("omits properties whose raw value is empty (Postgres-strict absent semantics)", () => {
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
			completedForm: completed([
				["/data/case_name", "Alice"],
				// The remaining three fields are left blank — the
				// engine seeds them with the empty string on init.
				["/data/age", ""],
				["/data/weight", ""],
				["/data/dob", ""],
			]),
		});

		expect(ops.kind).toBe("registration");
		if (ops.kind !== "registration") return;
		// Empty raw inputs translate to absent JSONB keys — the JSON
		// Schema validator passes (every property is optional), and
		// Postgres-strict null/blank distinguishes absent (`is-null`
		// match) from explicit empty string (`is-blank` match but NOT
		// `is-null`). Storing an empty string under a `format: date`
		// property would also fail ajv-formats validation outright;
		// the omission policy keeps the validator happy AND aligns
		// the wire shape with the intended runtime semantic.
		expect(ops.primary.properties).toEqual({ case_name: "Alice" });
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
		).toThrow(/requires completedForm\.caseId/);
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
		).toThrow(/requires completedForm\.caseId/);
	});
});
