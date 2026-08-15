import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import { type CaseType, fieldKinds, proseTemplateText } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	applyDefaults,
	flatFieldToField,
	type PreparedFlatField,
	prepareToolOptionsSource,
	stripEmpty,
} from "../contentProcessing";
import { projectedOptionsSourceSchema } from "../toolSchemaGenerator";

// Fixture: case types model the record catalog. `applyDefaults` may reuse its
// intrinsic type, canonical label, and choices, but form-context behavior is
// deliberately authored on each field.
const testCaseType: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: proseText("Full Name") },
		{
			name: "age",
			label: proseText("Patient Age"),
			data_type: "int",
			required: xp("true()"),
			validation: xp(". > 0 and . < 150"),
			validation_msg: proseText("Age must be between 1 and 149"),
		},
		{
			name: "gender",
			label: proseText("Gender"),
			data_type: "single_select",
			options: [
				{ value: "male", label: proseText("Male") },
				{ value: "female", label: proseText("Female") },
			],
		},
		{
			name: "phone",
			label: proseText("Phone Number"),
			data_type: "text",
			hint: proseText("Include country code"),
		},
	],
};

describe("prepareToolOptionsSource", () => {
	it("maps the machine option projection once, preserving declared identity and source order", () => {
		const preserved = testUuid("prepared-option-preserved");
		const result = prepareToolOptionsSource({
			kind: "inline",
			options: [
				{
					optionUuid: preserved,
					value: "yes",
					label: proseText("Yes"),
				},
				{ value: "no", label: proseText("No") },
			],
		});
		expect(result.kind).toBe("inline");
		if (result.kind !== "inline") throw new Error("expected inline source");
		expect(result.options.map((option) => option.value)).toEqual(["yes", "no"]);
		expect(result.options[0]?.uuid).toBe(preserved);
		expect(result.options[1]?.uuid).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(result.options.every((option) => !("optionUuid" in option))).toBe(
			true,
		);
	});

	it("passes the canonical lookup arm through without aliases or remapping", () => {
		const source = projectedOptionsSourceSchema.parse({
			kind: "lookup",
			tableId: "018f0000-0000-7000-8000-000000000001",
			valueColumnId: "018f0000-0000-7000-8000-000000000002",
			labelColumnId: "018f0000-0000-7000-8000-000000000003",
		});
		expect(prepareToolOptionsSource(source)).toBe(source);
	});
});

describe("applyDefaults", () => {
	it("fills in label from case type for sparse field", () => {
		const result = applyDefaults(
			{
				id: "full_name",
				kind: "text",
				caseWrite: { caseType: "patient", property: "case_name" },
			},
			[testCaseType],
		);
		expect(result.label && proseTemplateText(result.label)).toBe("Full Name");
	});

	it("applies intrinsic catalog metadata without contextual hint text", () => {
		const result = applyDefaults(
			{
				id: "enrollment_number",
				caseWrite: { caseType: "patient", property: "external_id" },
			},
			[
				{
					name: "patient",
					properties: [
						{
							name: "external_id",
							label: proseText("Enrollment number"),
							hint: proseText("Printed on the card"),
						},
					],
				},
			],
		);

		expect(result.kind).toBe("text");
		expect(result.label && proseTemplateText(result.label)).toBe(
			"Enrollment number",
		);
		expect(result.hint).toBeUndefined();
	});

	it("preserves explicit label when provided", () => {
		const result = applyDefaults(
			{
				id: "case_name",
				kind: "text",
				label: proseText("Custom Label"),
				caseWrite: { caseType: "patient", property: "case_name" },
			},
			[testCaseType],
		);
		expect(result.label && proseTemplateText(result.label)).toBe(
			"Custom Label",
		);
	});

	it("does not leak record-level validation or requiredness into a form", () => {
		const result = applyDefaults(
			{
				id: "reported_age",
				kind: "int",
				caseWrite: { caseType: "patient", property: "age" },
			},
			[testCaseType],
		);
		expect(result.required).toBeUndefined();
		expect(result.validate).toBeUndefined();
	});

	it("preserves explicitly authored form-context behavior", () => {
		const result = applyDefaults(
			{
				id: "reported_age",
				kind: "int",
				caseWrite: { caseType: "patient", property: "age" },
				hint: proseText("Enter the age measured today."),
				required: xp("true()"),
				validate: {
					expr: xp(". >= 0"),
					msg: proseText("Age cannot be negative."),
				},
			},
			[testCaseType],
		);
		expect(result.hint && proseTemplateText(result.hint)).toBe(
			"Enter the age measured today.",
		);
		expect(result.required).toEqual(xp("true()"));
		expect(result.validate).toEqual({
			expr: xp(". >= 0"),
			msg: proseText("Age cannot be negative."),
		});
	});

	it("fills in options for select properties", () => {
		const result = applyDefaults(
			{
				id: "gender",
				kind: "single_select",
				caseWrite: { caseType: "patient", property: "gender" },
			},
			[testCaseType],
		);
		expect(result.optionsSource?.kind).toBe("inline");
		expect(
			result.optionsSource?.kind === "inline"
				? result.optionsSource.options.map((option) => ({
						value: option.value,
						label: proseTemplateText(option.label),
					}))
				: [],
		).toEqual([
			{ value: "male", label: "Male" },
			{ value: "female", label: "Female" },
		]);
	});

	// Kind-aware seeding: a catalog default is applied only when the resolved
	// kind's schema DECLARES the slot. Without this gate, writing a computed
	// field to a property declared as a select would inherit the select's
	// `options` (or `label`), and the strict per-kind schema would then reject
	// the whole field in `flatFieldToField`.
	it("does NOT seed select-only options/label onto a hidden field", () => {
		const result = applyDefaults(
			// A hidden computed field writing to the select-typed `gender`.
			{
				id: "gender_code",
				kind: "hidden",
				caseWrite: { caseType: "patient", property: "gender" },
			},
			[testCaseType],
		);
		expect(result.optionsSource).toBeUndefined();
		expect(result.label).toBeUndefined();
		expect(result.kind).toBe("hidden");
	});

	it("does not seed contextual behavior onto a different field kind", () => {
		const result = applyDefaults(
			// Neither record-level validation nor requiredness belongs to this
			// form question, even if its field kind could carry requiredness.
			{
				id: "location",
				kind: "geopoint",
				caseWrite: { caseType: "patient", property: "age" },
			},
			[testCaseType],
		);
		expect(result.validate).toBeUndefined();
		expect(result.required).toBeUndefined();
	});

	it("treats an explicit empty-string label as unset and seeds from the catalog", () => {
		// The single-add path doesn't run `stripEmpty`, so an explicit `""`
		// must still be treated as unset here for single/batch parity.
		const result = applyDefaults(
			{
				id: "case_name",
				kind: "text",
				label: proseText(""),
				caseWrite: { caseType: "patient", property: "case_name" },
			},
			[testCaseType],
		);
		expect(result.label && proseTemplateText(result.label)).toBe("Full Name");
	});

	it("does not fill in hint from the record catalog", () => {
		const result = applyDefaults(
			{
				id: "contact_number",
				kind: "text",
				caseWrite: { caseType: "patient", property: "phone" },
			},
			[testCaseType],
		);
		expect(result.hint).toBeUndefined();
	});

	it("derives kind from case type data_type", () => {
		const result = applyDefaults(
			{
				id: "reported_age",
				caseWrite: { caseType: "patient", property: "age" },
			},
			[testCaseType],
		);
		expect(result.kind).toBe("int");
	});

	it("returns field unchanged when it has no caseWrite destination", () => {
		const result = applyDefaults(
			{ id: "notes", kind: "text", label: proseText("Notes") },
			[testCaseType],
		);
		expect(result.label && proseTemplateText(result.label)).toBe("Notes");
		expect(result.hint).toBeUndefined();
	});

	it("returns field unchanged when case types is null", () => {
		const result = applyDefaults(
			{
				id: "full_name",
				kind: "text",
				caseWrite: { caseType: "patient", property: "case_name" },
			},
			null,
		);
		expect(result.label).toBeUndefined();
	});

	it("returns field unchanged when property not found in case type", () => {
		const result = applyDefaults(
			{
				id: "missing_value",
				kind: "text",
				caseWrite: { caseType: "patient", property: "nonexistent" },
			},
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
			{ id: "x", kind: "text", relevant: xp(". > 0 && . < 10") },
			null,
		);
		expect(result.relevant).toEqual(xp(". > 0 && . < 10"));
	});

	it("looks up the exact case type and property from caseWrite", () => {
		const otherCaseType: CaseType = {
			name: "household",
			properties: [{ name: "case_name", label: proseText("Household ID") }],
		};
		const result = applyDefaults(
			{
				id: "household_name",
				kind: "text",
				caseWrite: { caseType: "household", property: "case_name" },
			},
			[testCaseType, otherCaseType],
		);
		expect(result.label && proseTemplateText(result.label)).toBe(
			"Household ID",
		);
	});

	// ── Case preload is structural, not a default_value autoset ──────────
	//
	// `applyDefaults` no longer seeds a case-preload `default_value` on
	// case-loading-form primary fields. Preload is emitted at the wire layer
	// (`xform/caseBlocks.ts` lowers the derived `case_preload` action to
	// casedb `<setvalue>` reads), so the agent layer leaves `default_value`
	// untouched.

	it("does not seed default_value for a primary case property", () => {
		const result = applyDefaults(
			{
				id: "reported_age",
				kind: "int",
				caseWrite: { caseType: "patient", property: "age" },
			},
			[testCaseType],
		);
		expect(result.default_value).toBeUndefined();
	});

	it("preserves an explicitly authored default_value", () => {
		const result = applyDefaults(
			{
				id: "age",
				kind: "int",
				caseWrite: { caseType: "patient", property: "age" },
				default_value: xp("today()"),
			},
			[testCaseType],
		);
		expect(result.default_value).toEqual(xp("today()"));
	});
});

// A valid SA-authoring payload per kind — the kind the per-kind tool union
// would accept. `hidden` carries a value but no label; containers take an
// optional label; selects need ≥2 options; repeat needs a mode.
function validFlatPayload(kind: string): PreparedFlatField {
	const p: Record<string, unknown> = { id: `f_${kind}`, kind };
	if (kind === "hidden") p.calculate = xp("today()");
	else if (kind === "repeat") {
		p.label = proseText("Items");
		p.repeat = { mode: "user_controlled" };
	} else if (kind === "group") p.label = proseText("Section");
	else p.label = proseText("Label");
	if (kind === "single_select" || kind === "multi_select") {
		p.optionsSource = {
			kind: "inline",
			options: [
				{
					uuid: testUuid(`option-${kind}-a`),
					value: "a",
					label: proseText("A"),
				},
				{
					uuid: testUuid(`option-${kind}-b`),
					value: "b",
					label: proseText("B"),
				},
			],
		};
	}
	return p as PreparedFlatField;
}

const TEST_UUID = testUuid("00000000-0000-4000-8000-000000000000");

describe("flatFieldToField — totality + failure reasons", () => {
	// The totality proof: after the per-kind tool inputs + kind-aware
	// `applyDefaults`, a valid payload for EVERY kind assembles into a Field.
	// A failure here means the generator and the domain schema have drifted.
	it("assembles a valid Field for every kind", () => {
		for (const kind of fieldKinds) {
			const processed = applyDefaults(stripEmpty(validFlatPayload(kind)), null);
			const result = flatFieldToField(processed, TEST_UUID);
			expect(result.ok, `kind ${kind} did not assemble`).toBe(true);
		}
	});

	it("assembles the nested validate + each repeat mode", () => {
		const cases: PreparedFlatField[] = [
			{
				id: "t",
				kind: "text",
				label: proseText("T"),
				validate: {
					expr: xp(". != ''"),
					msg: proseText("Required"),
				},
			} as unknown as PreparedFlatField,
			{
				id: "r1",
				kind: "repeat",
				label: proseText("R"),
				repeat: { mode: "count_bound", count: xp("#form/n") },
			} as unknown as PreparedFlatField,
			{
				id: "r2",
				kind: "repeat",
				label: proseText("R"),
				repeat: { mode: "query_bound", ids_query: xp("#form/ids") },
			} as unknown as PreparedFlatField,
		];
		for (const c of cases) {
			const result = flatFieldToField(
				applyDefaults(stripEmpty(c), null),
				TEST_UUID,
			);
			expect(result.ok, `${c.id} did not assemble`).toBe(true);
		}
	});

	it("drops a stray undeclared key rather than failing the whole field", () => {
		// A `calculate` on a `text` field (the boundary normally rejects this,
		// but a non-tool path could carry it) is filtered out — the field
		// survives as a plain text field, not dropped wholesale.
		const result = flatFieldToField(
			{
				id: "t",
				kind: "text",
				label: proseText("T"),
				calculate: xp("today()"),
			} as unknown as PreparedFlatField,
			TEST_UUID,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect("calculate" in result.field).toBe(false);
		}
	});

	it("returns the specific reason — not union noise — when a payload can't assemble", () => {
		// A single_select with one option fails the domain schema's min(2).
		const result = flatFieldToField(
			{
				id: "s",
				kind: "single_select",
				label: proseText("S"),
				optionsSource: {
					kind: "inline",
					options: [
						{
							uuid: testUuid("one-option"),
							value: "a",
							label: proseText("A"),
						},
					],
				},
			} as unknown as PreparedFlatField,
			TEST_UUID,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("options");
			expect(result.reason.toLowerCase()).not.toContain(
				"no matching discriminator",
			);
		}
	});
});
