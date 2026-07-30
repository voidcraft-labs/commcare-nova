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

describe("authored case-property names are exact at every domain carrier", () => {
	it.each(RETIRED)("rejects %s in catalogs", (name) => {
		expect(
			casePropertySchema.safeParse({
				name,
				label: proseText("Value"),
				data_type: "text",
			}).success,
		).toBe(false);
	});

	it.each(RETIRED)("rejects %s in Predicate references", (property) => {
		expect(
			predicateSchema.safeParse({
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "prop", caseType: "patient", property },
				},
				right: term(literal("value")),
			}).success,
		).toBe(false);
	});

	it.each(RETIRED)("rejects %s in XPath references", (property) => {
		expect(
			xpathExpressionSchema.safeParse({
				parts: [{ kind: "case-ref", caseType: "patient", property }],
			}).success,
		).toBe(false);
	});

	it.each(RETIRED)("rejects %s in prose references", (property) => {
		expect(
			proseTemplateSchema.safeParse({
				parts: [{ kind: "case-ref", caseType: "patient", property }],
			}).success,
		).toBe(false);
	});

	it.each(RETIRED)("rejects %s in case-operation writes", (property) => {
		expect(
			caseOperationWriteSchema.safeParse({
				property,
				value: term(literal("value")),
			}).success,
		).toBe(false);
	});

	it.each(RETIRED)("rejects %s in case-list columns", (field) => {
		expect(
			columnSchema.safeParse({
				uuid: testUuid(`column-${field}`),
				kind: "plain",
				field,
				header: "Value",
			}).success,
		).toBe(false);
	});

	it.each(RETIRED)("rejects %s in simple Search targets", (property) => {
		expect(
			searchInputDefSchema.safeParse({
				uuid: testUuid(`search-${property}`),
				kind: "simple",
				name: "query",
				label: "Query",
				type: "text",
				property,
			}).success,
		).toBe(false);
	});

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

	it.each(RETIRED)(
		"rejects a field whose explicit caseWrite property is %s",
		(property) => {
			expect(
				fieldSchema.safeParse({
					uuid: testUuid(`case-bound-${property}`),
					kind: "text",
					id: "friendly_question_id",
					label: proseText("Value"),
					caseWrite: { caseType: "patient", property },
				}).success,
			).toBe(false);
		},
	);

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
