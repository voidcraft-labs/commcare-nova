import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	caseOperationWriteSchema,
	casePropertySchema,
	caseWriteKeySchema,
	columnSchema,
	fieldSchema,
	proseTemplateSchema,
	searchInputDefSchema,
} from "@/lib/domain";
import { expressionSchema } from "@/lib/domain/expression";
import { literal, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";

const RETIRED = ["name", "external-id", "date-opened"] as const;
const carriers = [
	{
		name: "catalog",
		schema: casePropertySchema,
		input: (property: string) => ({
			name: property,
			label: proseText("Value"),
			data_type: "text",
		}),
	},
	{
		name: "record expression",
		schema: expressionSchema,
		input: (property: string) => ({
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "prop", caseType: "patient", property },
			},
			right: term(literal("value")),
		}),
	},
	{
		name: "form expression",
		schema: expressionSchema,
		input: (property: string) => ({
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property },
		}),
	},
	{
		name: "prose",
		schema: proseTemplateSchema,
		input: (property: string) => ({
			parts: [{ kind: "case-ref", caseType: "patient", property }],
		}),
	},
	{
		name: "operation write",
		schema: caseOperationWriteSchema,
		input: (property: string) => ({ property, value: term(literal("value")) }),
	},
	{
		name: "column",
		schema: columnSchema,
		input: (field: string) => ({
			uuid: testUuid("property-column"),
			kind: "plain",
			field,
			header: "Value",
		}),
	},
	{
		name: "Search target",
		schema: searchInputDefSchema,
		input: (property: string) => ({
			uuid: testUuid("property-search"),
			kind: "simple",
			name: "query",
			label: "Query",
			type: "text",
			property,
		}),
	},
	{
		name: "write key",
		schema: caseWriteKeySchema,
		input: (property: string) => ({
			property,
			via: [{ identifier: "parent" }],
		}),
	},
];

describe("authored case-property names across domain carriers", () => {
	it.each(carriers)(
		"isolates retired-name refusal in $name",
		({ schema, input }) => {
			// A paired positive proves every other required slot is present.
			expect(schema.safeParse(input("external_id")).success).toBe(true);
			for (const retired of RETIRED)
				expect(schema.safeParse(input(retired)).success).toBe(false);
		},
	);

	it("allows an ordinary survey field named name", () => {
		expect(
			fieldSchema.safeParse({
				uuid: testUuid("survey-name"),
				kind: "text",
				id: "name",
				label: proseText("Name"),
			}).success,
		).toBe(true);
	});

	it("refuses a case destination on a field, which only a case operation holds", () => {
		// A field schema that still admitted `caseWrite` would let a second
		// spelling of a case write reach the document beside the operations.
		const base = {
			uuid: testUuid("field-without-destination"),
			label: proseText("Value"),
		} as const;
		for (const kind of ["text", "hidden", "image"] as const) {
			const field =
				kind === "hidden"
					? { uuid: base.uuid, kind, id: "friendly_id" }
					: { ...base, kind, id: "friendly_id" };
			expect(fieldSchema.safeParse(field).success).toBe(true);
			expect(
				fieldSchema.safeParse({
					...field,
					caseWrite: { caseType: "patient", property: "value" },
				}).success,
			).toBe(false);
		}
	});
});
