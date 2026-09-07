import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	caseOperationWriteSchema,
	casePropertySchema,
	columnSchema,
	fieldSchema,
	proseTemplateSchema,
	searchInputDefSchema,
	xpathExpressionSchema,
} from "@/lib/domain";
import { predicateSchema } from "@/lib/domain/predicate";
import { literal, term } from "@/lib/domain/predicate/builders";
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
		name: "Predicate",
		schema: predicateSchema,
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
		name: "XPath",
		schema: xpathExpressionSchema,
		input: (property: string) => ({
			parts: [{ kind: "case-ref", caseType: "patient", property }],
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
		name: "field write",
		schema: fieldSchema,
		input: (property: string) => ({
			uuid: testUuid("property-field"),
			kind: "text",
			id: "friendly_question_id",
			label: proseText("Value"),
			caseWrite: { caseType: "patient", property },
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

	it("allows a friendly field id that differs from its canonical case property", () => {
		expect(
			fieldSchema.safeParse({
				uuid: testUuid("independent-field-case-identities"),
				kind: "text",
				id: "name",
				label: proseText("Name"),
				caseWrite: { caseType: "patient", property: "case_name" },
			}).success,
		).toBe(true);
	});

	it("admits only a complete strict caseWrite pair on eligible fields", () => {
		const base = {
			uuid: testUuid("strict-case-write"),
			kind: "text",
			id: "friendly_id",
			label: proseText("Value"),
		} as const;
		expect(
			fieldSchema.safeParse({
				...base,
				caseWrite: { caseType: "patient", property: "value" },
			}).success,
		).toBe(true);
		expect(
			fieldSchema.safeParse({
				...base,
				caseWrite: { caseType: "patient" },
			}).success,
		).toBe(false);
		expect(
			fieldSchema.safeParse({
				...base,
				caseWrite: {
					caseType: "patient",
					property: "value",
					legacyProperty: "value",
				},
			}).success,
		).toBe(false);
	});
});
