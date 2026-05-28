import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { applyDefaults } from "../contentProcessing";

// Fixture: case types model the CommCare case data layer, so their
// property metadata uses CommCare-flavored `validation` / `validation_msg`.
// `applyDefaults` is the one place in the agent where the case-type
// vocabulary meets the field vocabulary: the output field uses domain
// names (`validate`, `kind`, `case_property_on`).
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
			{ id: "case_name", kind: "text", case_property_on: "patient" },
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
				case_property_on: "patient",
			},
			[testCaseType],
		);
		expect(result.label).toBe("Custom Label");
	});

	it("fills in validate (nested), required, and msg from case-type vocab", () => {
		// SA tool surface uses a nested `validate: { expr, msg? }` object
		// (so the 8-optional batch ceiling stays at 8). `applyDefaults`
		// translates the case-type's flat `validation` / `validation_msg`
		// into that nested shape — only when the SA didn't provide its
		// own validate object.
		const result = applyDefaults(
			{ id: "age", kind: "int", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.required).toBe("true()");
		expect(result.validate).toEqual({
			expr: ". > 0 and . < 150",
			msg: "Age must be between 1 and 149",
		});
	});

	it("fills in options for select properties", () => {
		const result = applyDefaults(
			{ id: "gender", kind: "single_select", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.options).toEqual([
			{ value: "male", label: "Male" },
			{ value: "female", label: "Female" },
		]);
	});

	it("fills in hint from case type", () => {
		const result = applyDefaults(
			{ id: "phone", kind: "text", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.hint).toBe("Include country code");
	});

	it("derives kind from case type data_type", () => {
		const result = applyDefaults({ id: "age", case_property_on: "patient" }, [
			testCaseType,
		]);
		expect(result.kind).toBe("int");
	});

	it("returns field unchanged when no case_property_on", () => {
		const result = applyDefaults(
			{ id: "notes", kind: "text", label: "Notes" },
			[testCaseType],
		);
		expect(result.label).toBe("Notes");
		expect(result.hint).toBeUndefined();
	});

	it("returns field unchanged when case types is null", () => {
		const result = applyDefaults(
			{ id: "case_name", kind: "text", case_property_on: "patient" },
			null,
		);
		expect(result.label).toBeUndefined();
	});

	it("returns field unchanged when property not found in case type", () => {
		const result = applyDefaults(
			{ id: "nonexistent", kind: "text", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.label).toBeUndefined();
	});

	it("unescapes HTML entities in top-level XPath fields", () => {
		// `applyDefaults` iterates the top-level XPATH_FIELDS list
		// (`relevant`, `calculate`, `default_value`, `required`).
		// Validate's expression now lives nested under `validate.expr`
		// and is unescaped in `flatFieldToField` instead — see the
		// nested-config tests below.
		const result = applyDefaults(
			{ id: "x", kind: "text", relevant: ". &gt; 0 &amp;&amp; . &lt; 10" },
			null,
		);
		expect(result.relevant).toBe(". > 0 && . < 10");
	});

	it("looks up the correct case type from array by case_property_on", () => {
		const otherCaseType: CaseType = {
			name: "household",
			properties: [{ name: "case_name", label: "Household ID" }],
		};
		const result = applyDefaults(
			{ id: "case_name", kind: "text", case_property_on: "household" },
			[testCaseType, otherCaseType],
		);
		expect(result.label).toBe("Household ID");
	});

	// ── Case preload is structural, not a default_value autoset ──────────
	//
	// `applyDefaults` no longer seeds `default_value = "#case/{id}"` on
	// case-loading-form primary fields. Preload is emitted at the wire layer
	// (`xform/caseBlocks.ts` lowers the derived `case_preload` action to
	// casedb `<setvalue>` reads), so the agent layer leaves `default_value`
	// untouched.

	it("does not seed default_value for a primary case property", () => {
		const result = applyDefaults(
			{ id: "age", kind: "int", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.default_value).toBeUndefined();
	});

	it("preserves an explicitly authored default_value", () => {
		const result = applyDefaults(
			{
				id: "age",
				kind: "int",
				case_property_on: "patient",
				default_value: "today()",
			},
			[testCaseType],
		);
		expect(result.default_value).toBe("today()");
	});
});
