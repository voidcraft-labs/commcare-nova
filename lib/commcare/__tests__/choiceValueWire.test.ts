// A choice value may hold one kind of quote mark. The plausible failure is a
// value reaching text outside a literal: an XPath literal opened by the same
// quote mark the value holds, or a value spelled into a key a reader takes
// as a name. Every place a value is written is read back: the XForm's
// `<value>` text and each XPath attribute by the generated parser, the local
// suite by the same parser, and the HQ JSON case list column, whose keys are
// placeholders and whose values are literals in its expression. The whole
// app passes the HQ JSON, XForm, suite and binding oracles first.

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { hqEnumPlaceholder } from "@/lib/commcare/suite/case-list/orderPlanOptions";
import { parser, StringLiteral } from "@/lib/commcare/xpath";
import { proseText, type Uuid } from "@/lib/domain";
import { eq, formField, literal, prop } from "@/lib/domain/expression";
import type { Choice } from "@/lib/domain/expression/types";
import { checkCompilerEvidence } from "./compilerEvidence";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

const ANSWER = testUuid("choice-wire-answer");
const ITS = testUuid("choice-wire-its");
const SAY_HI = testUuid("choice-wire-say-hi");
const BACKTICK = testUuid("choice-wire-backtick");
const PLAIN = testUuid("choice-wire-plain");

const VALUES = ["it's", 'say"hi"', "back`tick", "plain"] as const;
const QUOTED = VALUES.filter((value) => /['"]/.test(value));

const OPTIONS = [
	{ uuid: ITS, value: "it's", label: proseText("It's") },
	{ uuid: SAY_HI, value: 'say"hi"', label: proseText("Say hi") },
	{ uuid: BACKTICK, value: "back`tick", label: proseText("Backtick") },
	{ uuid: PLAIN, value: "plain", label: proseText("Plain") },
];

const choiceOf = (option: Uuid): Choice => ({
	kind: "choice",
	field: ANSWER,
	options: [option],
});

function choiceValuesDoc() {
	const config = caseListConfig([
		{ field: "case_name", header: "Name" },
		{ field: "answer", header: "Answer" },
	]);
	return buildDoc({
		appName: "Choice values",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "answer",
						label: proseText("Answer"),
						data_type: "single_select",
						options: OPTIONS.map(({ value, label }) => ({ value, label })),
					},
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...config,
					filter: eq(prop("patient", "answer"), literal('say"hi"')),
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								uuid: ANSWER,
								kind: "single_select",
								id: "answer",
								label: proseText("Answer"),
								optionsSource: { kind: "inline", options: OPTIONS },
								caseWrite: { caseType: "patient", property: "answer" },
							}),
							f({
								kind: "text",
								id: "its_follow_up",
								label: proseText("Tell us more"),
								relevant: eq(formField(ANSWER), choiceOf(ITS)),
							}),
							f({
								kind: "text",
								id: "say_hi_follow_up",
								label: proseText("Say more"),
								relevant: eq(formField(ANSWER), choiceOf(SAY_HI)),
							}),
						],
					},
				],
			},
		],
	});
}

/** Every element under `node`, in document order. */
function elements(node: XmlEvidence): XmlEvidence[] {
	return node.children.flatMap((child) => [child, ...elements(child)]);
}

/** Each string literal the generated parser reads in `text`, as written,
 *  or `undefined` when the text holds an error node. */
function stringLiterals(text: string): string[] | undefined {
	const literals: string[] = [];
	let clean = true;
	parser.parse(text).iterate({
		enter: (node) => {
			if (node.type.isError) clean = false;
			if (node.type.id === StringLiteral)
				literals.push(text.slice(node.from, node.to));
		},
	});
	return clean ? literals : undefined;
}

/** A literal as written, read as XPath 1.0 reads it: its delimiters off. */
function literalValue(written: string): string {
	const quote = written[0];
	expect(quote === "'" || quote === '"').toBe(true);
	expect(written.at(-1)).toBe(quote);
	const value = written.slice(1, -1);
	expect(value.includes(quote ?? "")).toBe(false);
	return value;
}

/** Every value the XPath attributes of these elements spell as a literal. */
function literalValues(
	nodes: readonly XmlEvidence[],
	attributes: readonly string[],
): string[] {
	return nodes.flatMap((node) =>
		attributes.flatMap((attribute) => {
			const text = node.attributes[attribute];
			if (text === undefined || text === "") return [];
			const literals = stringLiterals(text);
			expect(literals, `${node.name}@${attribute}: ${text}`).toBeDefined();
			return (literals ?? []).map(literalValue);
		}),
	);
}

describe("choice values holding a quote mark on the wire", () => {
	it("passes every oracle", () => {
		checkCompilerEvidence(choiceValuesDoc());
	});

	it("writes each value as the XForm's text and as one string literal in each rule", () => {
		const hq = expandDoc(choiceValuesDoc());
		const source = Object.entries(hq._attachments).find(([path]) =>
			path.endsWith(".xml"),
		)?.[1];
		if (typeof source !== "string") throw new Error("No source for Register.");
		const form = elements(readXmlEvidence(source));
		expect(
			form.filter((node) => node.name === "value").map((node) => node.text),
		).toEqual(expect.arrayContaining([...VALUES]));
		const spelled = literalValues(
			form.filter((node) => node.name === "bind"),
			["relevant", "calculate", "constraint", "vellum:relevant"],
		);
		expect(spelled).toEqual(expect.arrayContaining(["it's", 'say"hi"']));
	});

	it("spells each value of the local suite as one string literal", () => {
		const doc = choiceValuesDoc();
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const suite = elements(
			readXmlEvidence(
				zip.getEntry("suite.xml")?.getData().toString("utf8") ?? "",
			),
		);
		const spelled = literalValues(suite, [
			"function",
			"nodeset",
			"relevant",
			"ref",
			"value",
		]);
		for (const value of QUOTED) expect(spelled).toContain(value);
	});

	it("keys the HQ case list column by placeholders and spells each value inside its expression", () => {
		const hq = expandDoc(choiceValuesDoc());
		const columns = hq.modules[0]?.case_details.short.columns ?? [];
		const answer = columns.find(
			(column) => column.format === "translatable-enum",
		);
		if (answer === undefined)
			throw new Error("No column shows the answer's labels.");
		expect(answer.enum.map((entry) => entry.key)).toEqual(
			VALUES.map((_, index) => hqEnumPlaceholder(index)),
		);
		const literals = stringLiterals(answer.field);
		expect(literals, answer.field).toBeDefined();
		const spelled = (literals ?? []).map(literalValue);
		for (const value of VALUES) expect(spelled).toContain(value);

		const filter = hq.modules[0]?.case_details.short.filter;
		if (typeof filter !== "string") throw new Error("No case list filter.");
		expect((stringLiterals(filter) ?? []).map(literalValue)).toContain(
			'say"hi"',
		);
	});
});
