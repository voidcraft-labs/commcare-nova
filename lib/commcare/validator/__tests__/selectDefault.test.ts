import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import {
	formFixture,
	ids,
} from "@/lib/domain/expression/__tests__/formFixture";
import type { Expression } from "@/lib/domain/expression/types";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import type { LookupRevision } from "@/lib/lookup/types";
import { runValidation } from "../runner";

function candidate(
	kind: "single_select" | "multi_select",
	value: string | number | Expression,
	options = ["a", "b"],
) {
	const doc = formFixture();
	const field = doc.fields[ids.choice];
	if (field.kind !== "single_select")
		throw new Error("The choice fixture is missing.");
	doc.fields[ids.choice] = {
		...field,
		kind,
		optionsSource: {
			kind: "inline",
			options: options.map((value) => ({
				uuid: testUuid(`default-option-${value}`),
				value,
				label: proseText(value),
			})),
		},
		default_value:
			typeof value === "object"
				? value
				: { kind: "term", term: { kind: "literal", value } },
	};
	return doc;
}

describe("select defaults at the validator boundary", () => {
	it.each([
		{ kind: "single_select" as const, value: "z" },
		{ kind: "multi_select" as const, value: "a z" },
		{ kind: "single_select" as const, value: 1 },
	])(
		"locates an unavailable $kind starting value $value",
		({ kind, value }) => {
			const errors = runValidation(
				candidate(kind, value),
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({
				code: "SELECT_DEFAULT_NOT_AN_OPTION",
				location: { fieldUuid: ids.choice, field: "default_value" },
				details: { value: String(value), options: "a, b" },
			});
			expect(errors[0].message).toContain(`"choice" starts on "${value}"`);
		},
	);
	it.each([
		{ kind: "single_select" as const, value: "a", options: ["a", "b"] },
		{ kind: "multi_select" as const, value: "a b", options: ["a", "b"] },
		{ kind: "single_select" as const, value: "", options: ["a", "b"] },
		{ kind: "multi_select" as const, value: "", options: ["a", "b"] },
		{ kind: "single_select" as const, value: 1, options: ["1", "2"] },
	])("admits $kind starting value $value", ({ kind, value, options }) => {
		expect(
			runValidation(
				candidate(kind, value, options),
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual([]);
	});
	// Core Recalculate.wrapData chooses IntegerData/LongData within 1e-9 of
	// the saturated Java long; other results retain DecimalData. SetValueAction
	// then casts that native answer text to the select. These expected strings
	// cover those branches and OpenJDK 17's distinct decimal spelling.
	it.each([
		{ value: 0.0001, answer: "1.0E-4" },
		{ value: 1e23, answer: "9.999999999999999E22" },
		{ value: 1.0000000005, answer: "1" },
		{ value: -1.0000000005, answer: "-1" },
		{ value: 1e-9, answer: "1.0E-9" },
		{ value: Number.MIN_VALUE, answer: "0" },
		{ value: 1_000_000_000_000_000_100, answer: "1000000000000000128" },
		{ value: 2 ** 63, answer: "9223372036854775807" },
		{ value: 2 ** 63 + 2048, answer: "9.223372036854778E18" },
		{ value: -(2 ** 63), answer: "-9223372036854775808" },
		{ value: -(2 ** 63) - 2048, answer: "-9.223372036854778E18" },
		{ value: -0, answer: "0" },
	])(
		"uses native answer text $answer for numeric default $value",
		({ value, answer }) => {
			for (const kind of ["single_select", "multi_select"] as const) {
				expect(
					runValidation(
						candidate(kind, value, [answer, "other"]),
						LOOKUP_CONTEXT_UNAVAILABLE,
					),
				).toEqual([]);
				const numberText = String(value);
				if (numberText === answer) continue;
				const errors = runValidation(
					candidate(kind, value, [numberText, "other"]),
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				expect(errors).toHaveLength(1);
				expect(errors[0]).toMatchObject({
					code: "SELECT_DEFAULT_NOT_AN_OPTION",
					location: { fieldUuid: ids.choice, field: "default_value" },
					details: { value: answer, options: `${numberText}, other` },
				});
				expect(errors[0].message).toContain(`"choice" starts on "${answer}"`);
			}
		},
	);
	it("keeps a computed starting value", () => {
		expect(
			runValidation(
				candidate("single_select", {
					kind: "term",
					term: { kind: "field", uuid: ids.text },
				}),
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual([]);
	});
	it("leaves a lookup-backed starting value to its data table", () => {
		const tableId = lookupTableIdSchema.parse(
			"018f3e8a-7b2c-7def-8abc-1234567890ab",
		);
		const columnId = lookupColumnIdSchema.parse(
			"018f3e8a-7b2c-7def-8abc-1234567890ad",
		);
		const revision = "1" as LookupRevision;
		const context: LookupValidationContext = {
			kind: "available",
			projectId: "default-project",
			projectRevision: revision,
			definitions: [
				{
					id: tableId,
					name: "Choices",
					tag: "choices",
					definitionRevision: revision,
					columns: [
						{
							id: columnId,
							wireName: "value",
							label: "Value",
							dataType: "text",
						},
					],
				},
			],
		};
		const doc = candidate("single_select", "z");
		const field = doc.fields[ids.choice];
		if (field.kind !== "single_select")
			throw new Error("The choice fixture is missing.");
		field.optionsSource = {
			kind: "lookup",
			tableId,
			valueColumnId: columnId,
			labelColumnId: columnId,
		};
		expect(runValidation(doc, context)).toEqual([]);
	});
});
