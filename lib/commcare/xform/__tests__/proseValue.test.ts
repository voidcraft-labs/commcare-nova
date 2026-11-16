/**
 * A calculated value in a text, on the wire.
 *
 * Each value is an `<output value>` whose expression lowers in the text's
 * prose slot, with the Vellum shadow a reference's output carries. Core reads
 * each output as an expression of its own (`XFormParser.java::parseOutput`)
 * and prints its result (`FormDef.java::fillTemplateString`). The instances a
 * value reads are declared from the printed tree, like any attribute's. A
 * validation message that holds a value is composed in `jr:constraintMsg`,
 * where a value enters as it is: the guard against several answers,
 * `count(x) > 1`, wraps a reference only, since Core's `count` refuses
 * anything but a node-set (`XPathCountFunc.java::evalBody`).
 *
 * The emitted source passes the XForm oracle and is read back through
 * `parseXml`, so a value written without its instance, a value outside the
 * composed message, a `count()` around a value or none around a reference,
 * and a label's literal `instance(` written joined fails here.
 */

import type { Element } from "domhandler";
import { isTag, isText } from "domhandler";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { expandDoc } from "../../expander";
import { instanceScanCuts } from "../../hqInstanceScan";
import { validateXForm } from "../../validator/xformOracle";
import { parseXml } from "../../xmlParse";

function elements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (element: Element) => {
		out.push(element);
		for (const child of element.children.filter(isTag)) walk(child);
	};
	walk(root);
	return out;
}

const FORMATTED_VISIT = "format-date(date(#form/visit), '%e %b %Y')";
/** Literal text CommCare HQ's build would read as an instance, were it joined. */
const WORDS = "This text reads instance('casedb') as words.";

function visitSource(): { xml: string; all: Element[] } {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: "Name" }],
			},
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						uuid: testUuid("prose-value-form"),
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "date", id: "visit", label: proseText("Visit date") }),
							f({
								kind: "text",
								id: "summary",
								label: {
									parts: [
										{ kind: "text", text: "Visit on " },
										{ kind: "value", expression: FORMATTED_VISIT },
										{ kind: "text", text: " at " },
										{
											kind: "value",
											expression: "concat(#household/case_name, '!')",
										},
									],
								},
							}),
							f({
								kind: "int",
								id: "age",
								label: proseText("Age"),
								validate: ". > 0",
								validate_msg: {
									parts: [
										{ kind: "text", text: "Seen " },
										{
											kind: "field-ref",
											uuid: testUuid("prose-value-name"),
										},
										{ kind: "text", text: " on " },
										{ kind: "value", expression: FORMATTED_VISIT },
									],
								},
							}),
							f({
								kind: "text",
								uuid: testUuid("prose-value-name"),
								id: "name",
								label: proseText("Name"),
							}),
							f({
								kind: "label",
								id: "words",
								label: proseText(WORDS),
							}),
						],
					},
				],
			},
		],
	});
	const sources = Object.values(expandDoc(doc)._attachments).filter(
		(value): value is string => typeof value === "string",
	);
	expect(sources).toHaveLength(1);
	const xml = sources[0];
	return {
		xml,
		all: parseXml(xml).children.filter(isTag).flatMap(elements),
	};
}

describe("a calculated value in a text", () => {
	it("passes the XForm oracle", () => {
		expect(validateXForm(visitSource().xml, "Visit", "Households")).toEqual([]);
	});

	it("writes each value as an output, a date chip's shadow included", () => {
		const { all } = visitSource();
		const outputs = all
			.filter((element) => element.name === "output")
			.map((element) => [
				element.attribs.value,
				element.attribs["vellum:value"],
			]);
		expect(outputs).toContainEqual([
			"format-date(date(/data/visit), '%e %b %Y')",
			"format-date(date(#form/visit), '%e %b %Y')",
		]);
		expect(
			outputs.some(
				([value]) =>
					value?.startsWith("concat(instance('casedb')") &&
					value.endsWith(", '!')"),
			),
		).toBe(true);
	});

	it("declares the instances a value reads", () => {
		const { all } = visitSource();
		const declared = all
			.filter((element) => element.name === "instance" && element.attribs.id)
			.map((element) => element.attribs.id);
		expect(declared).toEqual(
			expect.arrayContaining(["casedb", "commcaresession"]),
		);
	});

	it("composes a validation message's value as it is and guards only its reference", () => {
		const { all } = visitSource();
		const bind = all.find(
			(element) =>
				element.name === "bind" && element.attribs.nodeset === "/data/age",
		);
		const message = bind?.attribs["jr:constraintMsg"] ?? "";
		expect(message).toContain("count(/data/name) > 1");
		expect(message).toContain("format-date(date(/data/visit), '%e %b %Y')");
		expect(message).not.toContain("count(format-date");
	});

	it("writes a label's literal instance( with its bracket as an output, so no text node joins it", () => {
		const { all } = visitSource();
		const words = all.filter(
			(element) =>
				element.name === "value" &&
				element.attribs.form === undefined &&
				element.children.some(
					(child) => isText(child) && child.data.includes("as words."),
				),
		);
		expect(
			words.map((element) =>
				element.children.map((child) =>
					isText(child)
						? child.data
						: isTag(child) && child.name === "output"
							? `<output value=${child.attribs.value}>`
							: "?",
				),
			),
		).toEqual([
			["This text reads instance", "<output value='('>", "'casedb') as words."],
		]);
		const texts = all.flatMap((element) =>
			element.children.flatMap((child) => (isText(child) ? [child.data] : [])),
		);
		expect(texts.filter((data) => instanceScanCuts(data).length > 0)).toEqual(
			[],
		);
	});
});
