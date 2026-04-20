import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { applyDefaults } from "../contentProcessing";

// Fixture: case types model the CommCare case data layer, so their
// property metadata uses CommCare-flavored `validation` / `validation_msg`.
// `applyDefaults` is the one place in the agent where the case-type
// vocabulary meets the field vocabulary: the output field uses domain
// names (`validate`, `kind`, `case_property`).
const testCaseType: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Full Name" },
		{
			name: "age",
			label: "Patient Age",
			data_type: "int",
			required: "true()",
			validation: ". > 0 and . < 150",
			validation_msg: "Age must be between 1 and 149",
		},
		{
			name: "gender",
			label: "Gender",
			data_type: "single_select",
			options: [
				{ value: "male", label: "Male" },
				{ value: "female", label: "Female" },
			],
		},
		{
			name: "phone",
			label: "Phone Number",
			data_type: "text",
			hint: "Include country code",
		},
	],
};

describe("applyDefaults", () => {
	it("fills in label from case type for sparse field", () => {
		const result = applyDefaults(
			{ id: "case_name", kind: "text", case_property: "patient" },
			[testCaseType],
		);
		expect(result.label).toBe("Full Name");
	});

	it("preserves explicit label when provided", () => {
		const result = applyDefaults(
			{
				id: "case_name",
				kind: "text",
				label: "Custom Label",
				case_property: "patient",
			},
			[testCaseType],
		);
		expect(result.label).toBe("Custom Label");
	});

	it("fills in validate, required, and validate_msg (translated from case-type vocab)", () => {
		const result = applyDefaults(
			{ id: "age", kind: "int", case_property: "patient" },
			[testCaseType],
		);
		expect(result.required).toBe("true()");
		expect(result.validate).toBe(". > 0 and . < 150");
		expect(result.validate_msg).toBe("Age must be between 1 and 149");
	});

	it("fills in options for select properties", () => {
		const result = applyDefaults(
			{ id: "gender", kind: "single_select", case_property: "patient" },
			[testCaseType],
		);
		expect(result.options).toEqual([
			{ value: "male", label: "Male" },
			{ value: "female", label: "Female" },
		]);
	});

	it("fills in hint from case type", () => {
		const result = applyDefaults(
			{ id: "phone", kind: "text", case_property: "patient" },
			[testCaseType],
		);
		expect(result.hint).toBe("Include country code");
	});

	it("derives kind from case type data_type", () => {
		const result = applyDefaults({ id: "age", case_property: "patient" }, [
			testCaseType,
		]);
		expect(result.kind).toBe("int");
	});

	it("returns field unchanged when no case_property", () => {
		const result = applyDefaults(
			{ id: "notes", kind: "text", label: "Notes" },
			[testCaseType],
		);
		expect(result.label).toBe("Notes");
		expect(result.hint).toBeUndefined();
	});

	it("returns field unchanged when case types is null", () => {
		const result = applyDefaults(
			{ id: "case_name", kind: "text", case_property: "patient" },
			null,
		);
		expect(result.label).toBeUndefined();
	});

	it("returns field unchanged when property not found in case type", () => {
		const result = applyDefaults(
			{ id: "nonexistent", kind: "text", case_property: "patient" },
			[testCaseType],
		);
		expect(result.label).toBeUndefined();
	});

	it("unescapes HTML entities in XPath fields", () => {
		const result = applyDefaults(
			{ id: "x", kind: "text", validate: ". &gt; 0 &amp;&amp; . &lt; 10" },
			null,
		);
		expect(result.validate).toBe(". > 0 && . < 10");
	});

	it("looks up the correct case type from array by case_property", () => {
		const otherCaseType: CaseType = {
			name: "household",
			properties: [{ name: "case_name", label: "Household ID" }],
		};
		const result = applyDefaults(
			{ id: "case_name", kind: "text", case_property: "household" },
			[testCaseType, otherCaseType],
		);
		expect(result.label).toBe("Household ID");
	});

	// ── Follow-up form auto-default_value ────────────────────────────

	it("auto-sets default_value for primary case properties in follow-up forms", () => {
		const result = applyDefaults(
			{ id: "age", kind: "int", case_property: "patient" },
			[testCaseType],
			"followup",
			"patient",
		);
		expect(result.default_value).toBe("#case/age");
	});

	it("does not auto-set default_value for case_name in follow-up forms", () => {
		const result = applyDefaults(
			{ id: "case_name", kind: "text", case_property: "patient" },
			[testCaseType],
			"followup",
			"patient",
		);
		expect(result.default_value).toBeUndefined();
	});

	it("does not auto-set default_value in registration forms", () => {
		const result = applyDefaults(
			{ id: "age", kind: "int", case_property: "patient" },
			[testCaseType],
			"registration",
			"patient",
		);
		expect(result.default_value).toBeUndefined();
	});

	it("does not auto-set default_value for child case properties", () => {
		const result = applyDefaults(
			{ id: "age", kind: "int", case_property: "patient" },
			[testCaseType],
			"followup",
			"household",
		);
		expect(result.default_value).toBeUndefined();
	});

	it("does not override explicit default_value", () => {
		const result = applyDefaults(
			{
				id: "age",
				kind: "int",
				case_property: "patient",
				default_value: "today()",
			},
			[testCaseType],
			"followup",
			"patient",
		);
		expect(result.default_value).toBe("today()");
	});

	it("does not auto-set default_value when field has calculate", () => {
		const result = applyDefaults(
			{
				id: "age",
				kind: "int",
				case_property: "patient",
				calculate: "#case/age + 1",
			},
			[testCaseType],
			"followup",
			"patient",
		);
		expect(result.default_value).toBeUndefined();
	});

	it("does not auto-set default_value when formType/moduleCaseType not provided", () => {
		const result = applyDefaults(
			{ id: "age", kind: "int", case_property: "patient" },
			[testCaseType],
		);
		expect(result.default_value).toBeUndefined();
	});
});
