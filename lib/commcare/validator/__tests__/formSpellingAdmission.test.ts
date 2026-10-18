import { describe, expect, it } from "vitest";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	formFixture,
	ids,
	requireContext,
} from "@/lib/domain/expression/__tests__/formFixture";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import {
	type Expression,
	expressionSchema,
} from "@/lib/domain/expression/types";
import { evaluateCommit } from "../gate";

const slot = { entity: "field", uuid: ids.hidden, slot: "calculate" } as const;
const scalar = (value: string | number): Expression => ({
	kind: "term",
	term: { kind: "literal", value },
});

describe("the form grammar admission boundary", () => {
	it.each([
		"1",
		"'text'",
		"true()",
		"false()",
		"today()",
		"now()",
		"date('2026-01-02')",
		"double(1)",
		"1 + 2",
		"1 div 2",
		"5 mod 2",
		"-#form/number",
		"concat('a', 'b')",
		"coalesce('', 'b')",
		"if(true(), 1, 2)",
		"format-date(today(), '%Y-%m-%d')",
		"is-blank(#form/text)",
		"starts-with(#form/text, 'a')",
		"starts-with(1, '')",
		"regex(#form/text, '^a')",
		"regex(1, '1')",
		"selected(#form/choice, 'yes')",
		"selected(#form/text, 'yes')",
		"#form/number > 1 and #form/number < 9",
		"not(false()) or true()",
		"count(instance('casedb')/casedb/case[@case_type = 'patient'])",
		"instance('casedb')/casedb/case[@case_type = 'patient']/case_name",
		"#patient/appointment",
		"#user/username",
		"instance('commcaresession')/session/context/deviceid",
		"instance('commcaresession')/session/data/case_id",
		"../text",
		"/data/text",
		"#form/text",
		"count(#form/rows)",
		"abs(-2)",
		"number(#form/number)",
	])("admits and prints the canonical parser expression %s", (source) => {
		const doc = formFixture();
		const scope = { doc, slot, lookup: new Map() };
		const parsed = parseFormExpression(source, scope);
		expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
		if (!parsed.ok || parsed.expression === undefined)
			throw new Error(`Could not parse ${source}`);
		expect(expressionSchema.safeParse(parsed.expression).success).toBe(true);
		expect(
			checkExpression(parsed.expression, requireContext(doc, slot)).errors,
		).toEqual([]);
		const printed = projectFormExpression(
			doc,
			slot,
			parsed.expression,
			new Map(),
		);
		expect(printed.unresolved).toEqual([]);
		const reparsed = parseFormExpression(printed.text, {
			...scope,
			current: parsed.expression,
		});
		expect(reparsed).toMatchObject({ ok: true, expression: parsed.expression });
	});
	it.each<{ name: string; expression: Expression }>([
		{
			name: "date-add",
			expression: {
				kind: "date-add",
				date: { kind: "today" },
				interval: "days",
				quantity: scalar(1),
			},
		},
		{
			name: "datetime-coerce",
			expression: { kind: "datetime-coerce", value: { kind: "now" } },
		},
		{
			name: "switch",
			expression: {
				kind: "switch",
				on: scalar(1),
				cases: [
					// biome-ignore lint/suspicious/noThenProperty: Expression switch cases own this branch name.
					{ when: { kind: "literal", value: 1 }, then: scalar(1) },
				],
				fallback: scalar(2),
			},
		},
		{
			name: "in",
			expression: {
				kind: "in",
				left: scalar(1),
				values: [{ kind: "literal", value: 1 }],
			},
		},
		{
			name: "between",
			expression: {
				kind: "between",
				left: scalar(1),
				lower: scalar(0),
				upper: scalar(2),
				lowerInclusive: true,
				upperInclusive: true,
			},
		},
		{
			name: "within-distance",
			expression: {
				kind: "within-distance",
				property: { kind: "prop", caseType: "patient", property: "location" },
				center: scalar("1 2"),
				distance: 5,
				unit: "kilometers",
			},
		},
		{
			name: "when-input-present",
			expression: {
				kind: "when-input-present",
				input: { kind: "input", searchInputUuid: ids.text },
				clause: { kind: "match-all" },
			},
		},
		{
			name: "exists",
			expression: {
				kind: "exists",
				via: { kind: "ancestor", via: [{ identifier: "parent" }] },
			},
		},
		{
			name: "missing",
			expression: {
				kind: "missing",
				via: { kind: "ancestor", via: [{ identifier: "parent" }] },
			},
		},
		{
			name: "quotient",
			expression: {
				kind: "arith",
				op: "quotient",
				left: scalar(1),
				right: scalar(2),
			},
		},
		{
			name: "relation count",
			expression: {
				kind: "count",
				via: { kind: "ancestor", via: [{ identifier: "parent" }] },
			},
		},
		{
			name: "record match mode",
			expression: {
				kind: "match",
				property: scalar("a"),
				value: scalar("b"),
				mode: "fuzzy",
			},
		},
		{
			name: "selected-all",
			expression: {
				kind: "multi-select-contains",
				property: scalar("a"),
				values: [{ kind: "literal", value: "a" }],
				quantifier: "all",
			},
		},
		{
			name: "selected many values",
			expression: {
				kind: "multi-select-contains",
				property: scalar("a"),
				values: [
					{ kind: "literal", value: "a" },
					{ kind: "literal", value: "b" },
				],
				quantifier: "any",
			},
		},
	])(
		"refuses $name because the form grammar has no spelling",
		({ expression }) => {
			expect(expressionSchema.safeParse(expression).success).toBe(true);
			expect(
				checkExpression(expression, requireContext(formFixture(), slot)).errors,
			).toContainEqual(
				expect.objectContaining({
					code: "arm-unavailable",
					reason: expression.kind,
				}),
			);
		},
	);
	it("refuses a relation-backed row property in form logic and keeps its record meaning", () => {
		const doc = formFixture();
		if (doc.caseTypes === null)
			throw new Error("The record types are missing.");
		doc.caseTypes[0].parent_type = "household";
		doc.caseTypes.push({ name: "household", properties: [] });
		const property = {
			kind: "prop",
			caseType: "patient",
			property: "case_name",
			via: { kind: "ancestor", via: [{ identifier: "parent" }] },
		} satisfies import("@/lib/domain/expression/types").PropertyRef;
		const expression: Expression = {
			kind: "project",
			of: {
				kind: "cases",
				source: "casedb",
				where: [
					{
						kind: "eq",
						left: { kind: "term", term: { kind: "case-row-type" } },
						right: {
							kind: "term",
							term: { kind: "case-type", caseType: "patient" },
						},
					},
				],
			},
			value: property,
		};
		const hidden = doc.fields[ids.hidden];
		if (hidden.kind !== "hidden")
			throw new Error("The calculated question is missing.");
		hidden.calculate = expression;
		expect(
			checkExpression(expression, requireContext(doc, slot)).errors,
		).toContainEqual(
			expect.objectContaining({
				code: "arm-unavailable",
				reason: "prop-relation",
				path: ["project", "value"],
			}),
		);
		expect(
			evaluateCommit({
				nextDoc: doc,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}).ok,
		).toBe(false);
		expect(
			checkExpression(
				{
					kind: "eq",
					left: { kind: "term", term: property },
					right: scalar("A household"),
				},
				requireContext(doc, {
					entity: "module",
					uuid: ids.module,
					slot: "case_list_filter",
				}),
			).errors,
		).toEqual([]);
	});
});
