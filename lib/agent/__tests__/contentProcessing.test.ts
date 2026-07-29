import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import {
	type CaseType,
	fallbackProseProjection,
	fieldKinds,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	applyDefaults,
	flatFieldToField,
	type PreparedFlatField,
	stripEmpty,
} from "../contentProcessing";

// Fixture: case types model the CommCare case data layer, so their
// property metadata uses CommCare-flavored `validation` / `validation_msg`.
// `applyDefaults` is the one place in the agent where the case-type
// vocabulary meets the field vocabulary: the output field uses domain
// names (`validate`, `kind`, `case_property_on`).
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

describe("applyDefaults", () => {
	it("fills in label from case type for sparse field", () => {
		const result = applyDefaults(
			{ id: "case_name", kind: "text", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.label && fallbackProseProjection(result.label)).toBe(
			"Full Name",
		);
	});

	it("applies legacy alias metadata to a newly canonical field id", () => {
		const result = applyDefaults(
			{ id: "external_id", case_property_on: "patient" },
			[
				{
					name: "patient",
					properties: [
						{
							name: "external-id",
							label: proseText("Enrollment number"),
							hint: proseText("Printed on the card"),
						},
					],
				},
			],
		);

		expect(result.kind).toBe("text");
		expect(result.label && fallbackProseProjection(result.label)).toBe(
			"Enrollment number",
		);
		expect(result.hint && fallbackProseProjection(result.hint)).toBe(
			"Printed on the card",
		);
	});

	it("preserves explicit label when provided", () => {
		const result = applyDefaults(
			{
				id: "case_name",
				kind: "text",
				label: proseText("Custom Label"),
				case_property_on: "patient",
			},
			[testCaseType],
		);
		expect(result.label && fallbackProseProjection(result.label)).toBe(
			"Custom Label",
		);
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
		expect(result.required).toEqual(xp("true()"));
		expect(result.validate).toEqual({
			expr: xp(". > 0 and . < 150"),
			msg: proseText("Age must be between 1 and 149"),
		});
	});

	it("fills in options for select properties", () => {
		const result = applyDefaults(
			{ id: "gender", kind: "single_select", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.optionsSource?.kind).toBe("inline");
		expect(
			result.optionsSource?.kind === "inline"
				? result.optionsSource.options.map((option) => ({
						value: option.value,
						label: fallbackProseProjection(option.label),
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
			{ id: "gender", kind: "hidden", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.optionsSource).toBeUndefined();
		expect(result.label).toBeUndefined();
		expect(result.kind).toBe("hidden");
	});

	it("does NOT seed validate onto a kind that doesn't declare it (geopoint)", () => {
		const result = applyDefaults(
			// geopoint has no `validate` slot, so the `age` property's
			// `validation` must not be seeded — but `required`, which geopoint
			// DOES declare, still is.
			{ id: "age", kind: "geopoint", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.validate).toBeUndefined();
		expect(result.required).toEqual(xp("true()"));
	});

	it("treats an explicit empty-string label as unset and seeds from the catalog", () => {
		// The single-add path doesn't run `stripEmpty`, so an explicit `""`
		// must still be treated as unset here for single/batch parity.
		const result = applyDefaults(
			{
				id: "case_name",
				kind: "text",
				label: proseText(""),
				case_property_on: "patient",
			},
			[testCaseType],
		);
		expect(result.label && fallbackProseProjection(result.label)).toBe(
			"Full Name",
		);
	});

	it("fills in hint from case type", () => {
		const result = applyDefaults(
			{ id: "phone", kind: "text", case_property_on: "patient" },
			[testCaseType],
		);
		expect(result.hint && fallbackProseProjection(result.hint)).toBe(
			"Include country code",
		);
	});

	it("derives kind from case type data_type", () => {
		const result = applyDefaults({ id: "age", case_property_on: "patient" }, [
			testCaseType,
		]);
		expect(result.kind).toBe("int");
	});

	it("returns field unchanged when no case_property_on", () => {
		const result = applyDefaults(
			{ id: "notes", kind: "text", label: proseText("Notes") },
			[testCaseType],
		);
		expect(result.label && fallbackProseProjection(result.label)).toBe("Notes");
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
			{ id: "x", kind: "text", relevant: xp(". > 0 && . < 10") },
			null,
		);
		expect(result.relevant).toEqual(xp(". > 0 && . < 10"));
	});

	it("looks up the correct case type from array by case_property_on", () => {
		const otherCaseType: CaseType = {
			name: "household",
			properties: [{ name: "case_name", label: proseText("Household ID") }],
		};
		const result = applyDefaults(
			{ id: "case_name", kind: "text", case_property_on: "household" },
			[testCaseType, otherCaseType],
		);
		expect(result.label && fallbackProseProjection(result.label)).toBe(
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
