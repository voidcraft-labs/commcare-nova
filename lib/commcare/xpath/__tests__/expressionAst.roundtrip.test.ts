import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { expressionSchema } from "@/lib/domain/expression/types";
import { parseFormExpression } from "../expressionAst";

const form = testUuid("roundtrip-form");
const age = testUuid("roundtrip-age");
const inner = testUuid("roundtrip-inner");
const doc = buildDoc({
	modules: [
		{
			name: "People",
			caseType: "person",
			forms: [
				{
					uuid: form,
					name: "Visit",
					type: "followup",
					fields: [
						{ uuid: age, id: "age", kind: "int" },
						{ id: "name", kind: "text" },
						{
							id: "group",
							kind: "group",
							children: [{ uuid: inner, id: "inner", kind: "int" }],
						},
					],
				},
			],
		},
	],
	caseTypes: [
		{
			name: "person",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		},
	],
});
const slot = { entity: "field", uuid: inner, slot: "relevant" } as const;
function roundTrip(source: string) {
	const first = parseFormExpression(source, { doc, slot, lookup: new Map() });
	expect(first.ok, source).toBe(true);
	if (!first.ok || first.expression === undefined)
		throw new Error(`Expected a parsed expression: ${source}`);
	expect(expressionSchema.safeParse(first.expression).success, source).toBe(
		true,
	);
	const printed = projectFormExpression(doc, slot, first.expression, new Map());
	expect(printed.unresolved, source).toEqual([]);
	const second = parseFormExpression(printed.text, {
		doc,
		slot,
		lookup: new Map(),
		current: first.expression,
	});
	expect(second.ok, printed.text).toBe(true);
	if (second.ok) expect(second.expression, source).toEqual(first.expression);
}

describe("structured form expression canonicality", () => {
	it("round-trips every supported path root and structural operator family", () => {
		for (const source of [
			"#form/age",
			"/data/age",
			"../../age",
			"current()/../../age",
			".",
			"..",
			"#person/age",
			"#user/username",
			"instance('commcaresession')/session/context/deviceid",
			"instance('casedb')/casedb/case[@case_type = 'person'][age > 1]/age",
			"/data/group[../age > 1]/inner",
			"#form/group[../age > 1]/inner",
			"count(/data/group)",
			"sum(/data/group/inner)",
			"#form/age div 3",
			"#form/age - (#form/group/inner - 2)",
			"-(#form/age + 1)",
			"(#form/age > 1 and #form/age < 8) and #form/name != ''",
			"#form/age > 1 and (#form/age < 8 and #form/name != '')",
			"not(#form/age = 1)",
			"if(#form/age > 1, 'yes', 'no')",
			"concat('a', #form/name, 'b')",
			"format-date(today(), '%Y-%m-%d')",
			"selected(#form/name, 'a')",
			"starts-with(#form/name, 'a')",
			"true()",
			"false()",
		])
			roundTrip(source);
	});
	it("round-trips the case list's search text and the session context fields", () => {
		for (const source of [
			"instance('commcaresession')/session/data/stringquery",
			"instance('commcaresession')/session/data/stringquery = ''",
			"instance('commcaresession')/session/context/drift",
			"instance('commcaresession')/session/context/applanguage",
			"instance('commcaresession')/session/context/window_width",
		])
			roundTrip(source);
		const text = parseFormExpression(
			"instance('commcaresession')/session/data/stringquery",
			{ doc, slot, lookup: new Map() },
		);
		expect(text.ok && text.expression).toEqual({
			kind: "case-list-search-text",
		});
	});
	it("preserves literal bytes and arithmetic topology across generated source", async () => {
		const atom = fc.constantFrom(
			"#form/age",
			"/data/age",
			"../../age",
			"1",
			"2.5",
			"-7",
		);
		const source = fc
			.tuple(
				atom,
				fc.constantFrom("+", "-", "*", "div", "mod"),
				atom,
				fc.constantFrom("+", "-", "*", "div", "mod"),
				atom,
			)
			.map(([a, op, b, right, c]) => `${a} ${op} (${b} ${right} ${c})`);
		await fc.assert(fc.property(source, roundTrip), {
			numRuns: 160,
			seed: 68420,
		});
	});
	it("refuses unsupported input without throwing or producing an opaque tree", async () => {
		await fc.assert(
			fc.property(fc.string({ maxLength: 90 }), (source) => {
				const parsed = parseFormExpression(source, {
					doc,
					slot,
					lookup: new Map(),
				});
				if (parsed.ok) {
					if (parsed.expression !== undefined)
						expect(expressionSchema.safeParse(parsed.expression).success).toBe(
							true,
						);
				} else {
					expect(parsed.issues.length).toBeGreaterThan(0);
					for (const issue of parsed.issues) {
						expect(issue.from).toBeGreaterThanOrEqual(0);
						expect(issue.to).toBeLessThanOrEqual(source.length);
					}
				}
			}),
			{ numRuns: 200, seed: 68421 },
		);
	});
});
