/**
 * Which texts of a form write a formatted copy, `<value form="markdown">`.
 *
 * Contract: a hint and a validation message write none, in every form,
 * because no runtime reads either's (Android `QuestionWidget.java::addHintText`
 * reads `getHintText()`, `FormEntryPrompt.java::getConstraintText` asks for no
 * form, and Web Apps formats a hint's default text whatever the form holds). A
 * help text writes one unless its question holds `plainHelp`. A form holding
 * `plainText` writes none on any text, its label, choice and help text
 * included, whatever their own settings say, and carries
 * `vellum:ignore="markdown"` on `h:html`, the form builder's Disable Text
 * Formatting (Vellum `writer.js::write_html_tag_boilerplate`). A form without
 * it carries no `vellum:ignore`.
 *
 * Plausible failures: a hint or a validation message still writing its copy;
 * a help text holding `plainHelp` writing one, or one without it losing its
 * copy; a text in a form holding `plainText` writing one; the attribute
 * missing, or written on a form without the switch. Every emitted form passes
 * the XForm oracle and is read back through `parseXml`.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { validateXForm } from "../../validator/xformOracle";
import { parseXml } from "../../xmlParse";
import { buildXForm } from "../builder";

const FORM = testUuid("markdown-forms-form");
const LANGUAGES = ["en", "es"] as const;
const FORMATTED = "**bold** and a [link](https://example.org)";

/** One survey form: two questions with the same help text, one holding
 *  `plainHelp`, beside a hint and a validation message typed with the same
 *  symbols, and a choice question. `plainText` turns the form's switch on. */
function markdownDoc(plainText: boolean): BlueprintDoc {
	const doc = buildDoc({
		appName: "Markdown",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						uuid: FORM,
						name: "Intake",
						type: "survey",
						fields: [
							f({
								kind: "int",
								id: "plain_help",
								label: proseText("**Plain** help"),
								help: proseText(FORMATTED),
								plainHelp: true,
								hint: proseText(FORMATTED),
								validate: ". < 120",
								validate_msg: proseText(FORMATTED),
							}),
							f({
								kind: "text",
								id: "formatted_help",
								label: proseText("**Formatted** help"),
								help: proseText(FORMATTED),
							}),
							f({
								kind: "single_select",
								id: "pick",
								label: proseText("Pick"),
								options: [
									{ value: "a", label: "**A**", uuid: "markdown-forms-a" },
									{ value: "b", label: "**B**", uuid: "markdown-forms-b" },
								],
							}),
						],
					},
				],
			},
		],
	});
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: { spa: {} },
	};
	if (plainText) doc.forms[FORM] = { ...doc.forms[FORM], plainText: true };
	return doc;
}

function elements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (element: Element) => {
		out.push(element);
		for (const child of element.children.filter(isTag)) walk(child);
	};
	walk(root);
	return out;
}

function built(plainText: boolean): { xml: string; all: Element[] } {
	const xml = buildXForm(markdownDoc(plainText), FORM, {
		xmlns: "urn:markdown-forms",
	});
	return { xml, all: parseXml(xml).children.filter(isTag).flatMap(elements) };
}

/** The `form` of each `<value>` of one language's `<text id>`. */
function forms(
	all: Element[],
	lang: string,
	id: string,
): (string | undefined)[] {
	const translation = all.find(
		(node) => node.name === "translation" && node.attribs.lang === lang,
	);
	if (translation === undefined) throw new Error(`No ${lang} translation.`);
	const texts = elements(translation).filter(
		(node) => node.name === "text" && node.attribs.id === id,
	);
	if (texts.length !== 1) throw new Error(`Expected one ${lang} ${id}.`);
	return (texts[0] as Element).children
		.filter(isTag)
		.filter((node) => node.name === "value")
		.map((value) => value.attribs.form);
}

function htmlRoot(all: Element[]): Element {
	const html = all.find((node) => node.name === "h:html");
	if (html === undefined) throw new Error("No h:html.");
	return html;
}

describe("formatted copies in a form whose text formatting is on", () => {
	const { xml, all } = built(false);

	it("passes the XForm oracle", () => {
		expect(validateXForm(xml, "Intake", "Survey")).toEqual([]);
	});

	it("writes no formatted copy of a hint or a validation message", () => {
		for (const lang of LANGUAGES) {
			expect(forms(all, lang, "plain_help-hint")).toEqual([undefined]);
			expect(forms(all, lang, "plain_help-constraintMsg")).toEqual([undefined]);
		}
	});

	it("writes a help text's copy only where its question lacks plainHelp", () => {
		for (const lang of LANGUAGES) {
			expect(forms(all, lang, "plain_help-help")).toEqual([undefined]);
			expect(forms(all, lang, "formatted_help-help")).toEqual([
				undefined,
				"markdown",
			]);
		}
	});

	it("keeps the label's and the choice's copies", () => {
		for (const lang of LANGUAGES) {
			for (const id of ["plain_help-label", "pick-opt0-label"])
				expect(forms(all, lang, id)).toEqual([undefined, "markdown"]);
		}
	});

	it("carries no vellum:ignore", () => {
		expect(htmlRoot(all).attribs["vellum:ignore"]).toBeUndefined();
	});
});

describe("formatted copies in a form whose text formatting is off", () => {
	const { xml, all } = built(true);

	it("passes the XForm oracle", () => {
		expect(validateXForm(xml, "Intake", "Survey")).toEqual([]);
	});

	it("writes no formatted copy of any text", () => {
		const copies = all.filter(
			(node) => node.name === "value" && node.attribs.form === "markdown",
		);
		expect(copies).toEqual([]);
	});

	it("still writes every text's plain value", () => {
		for (const lang of LANGUAGES) {
			for (const id of [
				"plain_help-label",
				"plain_help-help",
				"formatted_help-help",
				"pick-opt0-label",
				"pick-opt1-label",
			])
				expect(forms(all, lang, id)).toEqual([undefined]);
		}
	});

	it("carries the form builder's Disable Text Formatting on h:html", () => {
		expect(htmlRoot(all).attribs["vellum:ignore"]).toBe("markdown");
	});
});
