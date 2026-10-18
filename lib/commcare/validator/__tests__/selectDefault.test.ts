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
