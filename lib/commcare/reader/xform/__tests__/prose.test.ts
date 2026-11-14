/**
 * Prose (12.3): the literal-output reader is the inverse of the emitter's
 * whitespace and bracket outputs. Text of every character class (whitespace
 * runs, NBSP and other Unicode space, text CommCare HQ's build would read as
 * an instance, markup and entity look-alikes, quotes) is emitted through a
 * one-label document by the production emitter, its source parsed, and its
 * label's value read back to the same template: no character lost or added. An
 * output that is no literal spelling stays the value it is.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { buildXForm } from "../../../xform/builder";
import { namespaceScopes, splitName } from "../../../xmlNamespaces";
import { tryParseXml } from "../../../xmlParse";
import {
	literalOutputText,
	placeholderTemplate,
	valueChildren,
	valueParts,
} from "../prose";

/** The pieces a label is drawn from: one of each character class the emitter spells apart. */
const PIECES = [
	"a",
	"Hello",
	" ",
	"  ",
	"\n",
	"\n\n",
	"\t",
	" ",
	" ",
	"　",
	"instance(",
	"instance('casedb')",
	'instance("x")',
	"(",
	"'",
	'"',
	"<",
	">",
	"&",
	"&amp;",
	"<output value='x'/>",
	"#form/q",
	"**bold**",
] as const;

/** The default value of the question's label in the first translation of an emitted source. */
function labelValue(source: string): {
	value: Element;
	scope: ReturnType<typeof namespaceScopes>;
} {
	const parsed = tryParseXml(source);
	if ("issue" in parsed)
		throw new Error(`The emitted source did not parse: ${parsed.issue}`);
	const scope = namespaceScopes(parsed.doc);
	let found: Element | undefined;
	const walk = (element: Element) => {
		if (
			found === undefined &&
			splitName(element.name).local === "text" &&
			element.attribs.id?.endsWith("-label") === true
		)
			found = element.children
				.filter(isTag)
				.find(
					(child) =>
						splitName(child.name).local === "value" &&
						child.attribs.form === undefined,
				);
		for (const child of element.children) if (isTag(child)) walk(child);
	};
	for (const child of parsed.doc.children) if (isTag(child)) walk(child);
	if (found === undefined)
		throw new Error("The emitted source holds no label text.");
	return { value: found, scope };
}

/** The template the reader reads back from a one-label document the emitter writes for `text`. */
function readBack(text: string) {
	const doc = buildDoc({
		modules: [
			{
				name: "Menu",
				forms: [
					{
						name: "Form",
						type: "survey",
						fields: [f({ kind: "text", id: "q", label: proseText(text) })],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0] as string]?.[0] as string;
	const source = buildXForm(doc, formUuid as never, {
		xmlns: "http://openrosa.org/formdesigner/prose",
	});
	const { value, scope } = labelValue(source);
	return valueChildren(value, scope).parts;
}

describe("the literal-output inverse", () => {
	it("reads every emitted label back to its own text, every literal output as text", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 8 }),
				(pieces) => {
					const text = pieces.join("");
					const parts = readBack(text);
					expect(parts.every((part) => part.kind !== "output")).toBe(true);
					expect(placeholderTemplate(parts)).toEqual(proseText(text));
				},
			),
			{ numRuns: 150 },
		);
	});

	it("reads the two literal spellings and no other expression", () => {
		expect(literalOutputText("' '")).toBe(" ");
		expect(literalOutputText("'('")).toBe("(");
		expect(literalOutputText(`json-property('{"v":"\\u00a0"}', 'v')`)).toBe(
			" ",
		);
		expect(
			literalOutputText(`json-property('{"v":"x","w":"y"}', 'v')`),
		).toBeUndefined();
		expect(literalOutputText(`json-property('{"v":1}', 'v')`)).toBeUndefined();
		expect(
			literalOutputText(`json-property('{"v":"x"}', 'w')`),
		).toBeUndefined();
		expect(literalOutputText("/data/q")).toBeUndefined();
		expect(literalOutputText("concat('a', 'b')")).toBeUndefined();
	});

	it("keeps an output as a value where the emitter would write its text another way", () => {
		const output = (text: string) => ({
			kind: "output" as const,
			output: { element: {} as Element, attribute: "value" as const, text },
		});
		// A bracket alone is written as plain text, so its output is the value it is.
		expect(valueParts([output("'('")]).map((part) => part.kind)).toEqual([
			"output",
		]);
		// After `instance` and before a quote, it is the emitter's spelling of the bracket.
		expect(
			valueParts([
				{ kind: "text", text: "instance" },
				output("'('"),
				{ kind: "text", text: "'x')" },
			]).map((part) => part.kind),
		).toEqual(["text", "literal", "text"]);
		// A string that is not a run the emitter protects stays a value.
		expect(valueParts([output("'abc'")]).map((part) => part.kind)).toEqual([
			"output",
		]);
		expect(valueParts([output("/data/q")]).map((part) => part.kind)).toEqual([
			"output",
		]);
	});
});
