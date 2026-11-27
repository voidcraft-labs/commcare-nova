import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { serializeXmlValue } from "@/lib/commcare/serializeXml";
import { literal, term } from "@/lib/domain/expression";
import { evaluateAsync } from "@/lib/preview/xpath/asyncEvaluator";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../caseManagement/__tests__/heldReading";

function calculationFixture() {
	const doc = buildDoc({
		modules: [
			{
				name: "Checks",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "code",
								label: { parts: [{ kind: "text", text: "Code" }] },
							}),
							f({
								kind: "hidden",
								id: "result",
								calculate: term(literal(424242)),
							}),
						],
					},
				],
			},
		],
	});
	return doc;
}

it.each([
	["m", ["late", "late", "late", "late", "late"]],
	["20", ["late", "early", "late", "early", "early"]],
	["1970-01-02", ["late", "late", "late", "early", "late"]],
])(
	"reads a hidden calculation with exact numeric ordering against %s",
	async (literalText, expected) => {
		const doc = calculationFixture();
		const implicit = `if(/data/code < '${literalText}', 'early', 'late')`;
		const explicit = `if(number(/data/code) < number('${literalText}'), 'early', 'late')`;
		const body = exportedBody(doc, {
			xml: (xml) =>
				xml.replace(
					'calculate="424242"',
					() => `calculate="${serializeXmlValue(implicit, true)}"`,
				),
		});
		const answer = readHqApp(await inputFor(body), { claims: "full" });
		if (answer.kind !== "read") throw Error(JSON.stringify(answer.findings));
		const fields = Object.values(answer.draft.doc.fields);
		const code = fields.find(({ id }) => id === "code");
		const result = fields.find(({ id }) => id === "result");
		if (code === undefined || result?.kind !== "hidden")
			throw Error("Expected the typed code and hidden value");
		expect(result.calculate).toMatchObject({
			kind: "if",
			cond: {
				kind: "lt",
				left: {
					kind: "call",
					fn: "number",
					args: [{ kind: "term", term: { kind: "field", uuid: code.uuid } }],
				},
				right: {
					kind: "call",
					fn: "number",
					args: [term(literal(literalText))],
				},
			},
		});
		const republished = exportedBody(answer.draft.doc);
		const exported = republished._attachments as Record<string, string>;
		expect(Object.values(exported)[0]).toContain(
			`number(/data/code) &lt; number(&apos;${literalText}&apos;)`,
		);
		const reread = readHqApp(await inputFor(republished), { claims: "full" });
		if (reread.kind !== "read") throw Error(JSON.stringify(reread.findings));
		const rereadResult = Object.values(reread.draft.doc.fields).find(
			(field) => field.id === "result",
		);
		expect(rereadResult).toMatchObject({
			calculate: {
				kind: "if",
				cond: {
					kind: "lt",
					right: {
						kind: "call",
						fn: "number",
						args: [term(literal(literalText))],
					},
				},
			},
		});
		for (const [index, value] of [
			"",
			" 2 ",
			"23",
			"1970-01-01",
			"1970-01-03",
		].entries()) {
			const ctx = {
				getValue: (path: string) => (path === "/data/code" ? value : undefined),
				resolveInstance: () => ({ kind: "unsupported" as const }),
				contextPath: "/data/result",
				position: 1,
			};
			expect(evaluate(implicit, ctx)).toBe(expected[index]);
			expect(evaluate(explicit, ctx)).toBe(expected[index]);
			expect(await evaluateAsync(explicit, ctx)).toBe(expected[index]);
		}
	},
);

it("keeps three concatenated parts in a root calculation", async () => {
	const implicit =
		"if(concat(/data/code, '-', /data/code) < 'm', 'early', 'late')";
	const body = exportedBody(calculationFixture(), {
		xml: (xml) =>
			xml.replace(
				'calculate="424242"',
				() => `calculate="${serializeXmlValue(implicit, true)}"`,
			),
	});
	const result = readHqApp(await inputFor(body), { claims: "full" });
	if (result.kind !== "read") throw Error(JSON.stringify(result.findings));
	const hidden = Object.values(result.draft.doc.fields).find(
		({ id }) => id === "result",
	);
	expect(hidden).toMatchObject({
		calculate: {
			cond: {
				left: {
					fn: "number",
					args: [
						{
							kind: "concat",
							parts: [
								{ kind: "term", term: { kind: "field" } },
								term(literal("-")),
								{ kind: "term", term: { kind: "field" } },
							],
						},
					],
				},
			},
		},
	});
});

it.each([
	[
		"if(/data/code < '15:00', 'early', 'late')",
		"expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string",
	],
	[
		"if(concat('prefix', /data/code) < 'm', 'early', 'late')",
		"expressions-and-data/a-form-expression-outside-what-nova-types",
	],
])("keeps the existing refusal for %s", async (calculate, entry) => {
	const body = exportedBody(calculationFixture(), {
		xml: (xml) =>
			xml.replace(
				'calculate="424242"',
				() => `calculate="${serializeXmlValue(calculate, true)}"`,
			),
	});
	const read = readHqApp(await inputFor(body), { claims: "full" });
	if (read.kind !== "account")
		throw Error("Expected an existing placed refusal");
	expect(read.findings.map(({ code }) => code)).toEqual([entry]);
});
