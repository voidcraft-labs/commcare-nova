import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { projectFormExpression } from "@/lib/doc/expressionText";
import {
	type Expression,
	expressionSchema,
} from "@/lib/domain/expression/types";
import { parseFormExpression } from "../expressionAst";

const FORM = testUuid("parse-form");
const AGE = testUuid("parse-age");
const GROUP = testUuid("parse-group");
const INNER = testUuid("parse-inner");
function makeDoc() {
	return buildDoc({
		modules: [
			{
				name: "People",
				caseType: "person",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							{ uuid: AGE, id: "age", kind: "int" },
							{
								uuid: GROUP,
								id: "group",
								kind: "group",
								children: [{ uuid: INNER, id: "inner", kind: "int" }],
							},
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "person",
				properties: [{ name: "age", data_type: "int", label: "Age" }],
			},
		],
	});
}
const slot = { entity: "field", uuid: INNER, slot: "relevant" } as const;
function parse(source: string, doc = makeDoc(), current?: Expression) {
	const result = parseFormExpression(source, {
		doc,
		slot,
		lookup: new Map(),
		current,
	});
	if (!result.ok)
		throw new Error(
			result.issues
				.map((issue) => `${issue.code}: ${issue.message}`)
				.join("; "),
		);
	if (result.expression === undefined)
		throw new Error("Expected an expression");
	expect(expressionSchema.safeParse(result.expression).success, source).toBe(
		true,
	);
	return result.expression;
}

describe("form expression binding", () => {
	it("binds operators and current names to identities, retaining reference spelling", () => {
		expect(parse("#form/age + 2 * 3")).toMatchObject({
			kind: "arith",
			op: "+",
			left: { kind: "term", term: { kind: "field", uuid: AGE } },
			right: { kind: "arith", op: "*" },
		});
		expect(parse("/data/group/inner")).toMatchObject({
			kind: "term",
			term: { kind: "field", uuid: INNER, spelling: "absolute" },
		});
	});
	it("binds relative and current paths from the actual slot", () => {
		expect(parse("../../age")).toMatchObject({
			kind: "term",
			term: { kind: "field", uuid: AGE, spelling: "relative" },
		});
		expect(parse("current()/../../age")).toMatchObject({
			kind: "term",
			term: { kind: "field", uuid: AGE, spelling: "current" },
		});
		for (const source of ["parent::node()/../age", "self::node()/../../age"])
			expect(parse(source)).toEqual(parse("../../age"));
		expect(parse("current()/parent::node()/../age")).toEqual(
			parse("current()/../../age"),
		);
	});
	it("retains nested logical and right arithmetic topology through text", () => {
		for (const source of [
			"(#form/age > 1 and #form/age < 8) and #form/age != 4",
			"#form/age - (#form/inner - 1)",
			"-(#form/age + 1)",
			"if(#form/age > 1, 2, 3)",
		]) {
			const doc = makeDoc();
			const authored = source.replaceAll("#form/inner", "#form/group/inner");
			const value = parse(authored, doc);
			const printed = projectFormExpression(doc, slot, value, new Map());
			expect(printed.unresolved, authored).toEqual([]);
			expect(parse(printed.text, doc, value), authored).toEqual(value);
		}
	});
	it("binds here() to its arm and prints it back unchanged", () => {
		const doc = makeDoc();
		const value = parse("here()", doc);
		expect(value).toEqual({ kind: "here" });
		const printed = projectFormExpression(doc, slot, value, new Map());
		expect(printed.text).toBe("here()");
		expect(parse(printed.text, doc, value)).toEqual(value);
		expect(
			parseFormExpression("here(1)", { doc, slot, lookup: new Map() }),
		).toMatchObject({ ok: false, issues: [{ code: "arity" }] });
	});
	it("keeps selected-record identity separate from a query row", () => {
		const doc = makeDoc();
		const alias = parseFormExpression("#case/age", {
			doc,
			slot,
			lookup: new Map(),
		});
		expect(alias).toMatchObject({
			ok: false,
			issues: [{ code: "case-alias-unbound" }],
		});
		expect(
			parseFormExpression("#case/age", {
				doc,
				slot,
				lookup: new Map(),
				authoring: {
					selectedCaseType: "person",
					resolveFormShortName: () => undefined,
				},
			}),
		).toMatchObject({
			ok: true,
			expression: {
				kind: "term",
				term: { kind: "form-case", caseType: "person", property: "age" },
			},
		});
		expect(parse("#person/age")).toMatchObject({
			kind: "term",
			term: { kind: "form-case", caseType: "person", property: "age" },
		});
		expect(
			parse("instance('casedb')/casedb/case[@case_type = 'person']/age"),
		).toMatchObject({
			kind: "project",
			of: { kind: "cases" },
			value: { kind: "prop", caseType: "person", property: "age" },
		});
	});
	it("binds record queries before unrelated pending case writers are admitted", () => {
		const doc = makeDoc();
		const field = doc.fields[AGE];
		if (field?.kind !== "int") throw new Error("Missing age question");
		doc.fields[AGE] = {
			...field,
			caseWrite: { caseType: "not_yet_declared", property: "score" },
		};
		expect(parse("instance('casedb')/casedb/case/@case_id", doc)).toMatchObject(
			{
				kind: "project",
				of: { kind: "cases", source: "casedb" },
				value: { kind: "prop", property: "case_id" },
			},
		);
	});
	it("reports bounded refusals and never persists unsupported source", () => {
		for (const source of [
			"#form/missing",
			"//age",
			"unknown-function(1)",
			"if(#form/age",
		]) {
			const result = parseFormExpression(source, {
				doc: makeDoc(),
				slot,
				lookup: new Map(),
			});
			expect(result.ok, source).toBe(false);
			if (!result.ok)
				for (const issue of result.issues) {
					expect(issue.from).toBeGreaterThanOrEqual(0);
					expect(issue.to).toBeLessThanOrEqual(source.length);
				}
		}
		expect(
			parseFormExpression(" ", { doc: makeDoc(), slot, lookup: new Map() }),
		).toEqual({ ok: true, expression: undefined, spans: new Map() });
	});
	it("projects a rename from identity without rewriting the expression", () => {
		const doc = makeDoc();
		const value = parse("../../age + /data/age", doc);
		const renamed = {
			...doc,
			fields: { ...doc.fields, [AGE]: { ...doc.fields[AGE], id: "years" } },
		};
		expect(projectFormExpression(renamed, slot, value, new Map()).text).toBe(
			"../../years + /data/years",
		);
	});
});
