/**
 * A plain label in the built XForm.
 *
 * Contract: a question's label and an inline choice's label holding
 * `plainLabel` write no `<value form="markdown">` in any language, while
 * their `<value>` (references included, as `<output>`) is what it was; a
 * hint, a help text and a validation message keep their markdown form, and a
 * protected validation message's internal forms are unchanged. CommCare
 * renders a label's markdown only where that form exists (Core
 * `FormEntryCaption.getMarkdownText`, Formplayer `PromptToJson.parseCaption`,
 * Android `QuestionWidget.setTextFromPrompt` and `setChoiceText`), and holds
 * markdown per text across every language, so the flag drops the form
 * everywhere at once.
 *
 * Plausible failures: the markdown form kept in one language, dropped from a
 * hint or help text, dropped from every choice when one is plain, or a plain
 * label losing its reference. The built forms are read as elements.
 */

import type { Element } from "domhandler";
import { findAll } from "domutils";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, type ProseTemplate, proseText } from "@/lib/domain";
import { buildXForm } from "../xform/builder";
import { parseXml } from "../xmlParse";

const NAME = testUuid("plain-label-name");
const LANGUAGES = ["en", "es"] as const;

const withName = (text: string): ProseTemplate => ({
	parts: [
		{ kind: "text", text },
		{ kind: "field-ref", uuid: NAME },
	],
});

/** One survey form; `plain` turns `plainLabel` on for the age question and
 * the first choice. */
function labelDoc(plain: boolean): BlueprintDoc {
	const flag = plain ? { plainLabel: true } : {};
	const doc = buildDoc({
		appName: "Labels",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name", uuid: NAME, label: "Name" }),
							f({
								kind: "int",
								id: "age",
								label: withName("Age of "),
								...flag,
								hint: proseText("In **years**"),
								help: proseText("Ask *gently*"),
								validate: ". < 120",
								validate_msg: withName("Too old for "),
							}),
							f({
								kind: "single_select",
								id: "pick",
								label: proseText("Pick"),
								options: [
									{
										value: "a",
										label: "**A**",
										uuid: "plain-label-a",
										...flag,
									},
									{ value: "b", label: "**B**", uuid: "plain-label-b" },
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
	return doc;
}

function builtForm(plain: boolean): Element[] {
	const doc = labelDoc(plain);
	const formUuid = doc.formOrder[doc.moduleOrder[0] ?? ""]?.[0];
	if (formUuid === undefined) throw new Error("The fixture has no form.");
	return findAll(
		() => true,
		parseXml(buildXForm(doc, formUuid, { xmlns: "urn:plain-labels" })).children,
	);
}

/** The itext `<text id>` entry of one language. */
function entry(elements: Element[], lang: string, id: string): Element {
	const translation = elements.find(
		(node) => node.name === "translation" && node.attribs.lang === lang,
	);
	if (translation === undefined) throw new Error(`No ${lang} translation.`);
	const found = findAll(
		(node) => node.name === "text" && node.attribs.id === id,
		translation.children,
	);
	if (found.length !== 1) throw new Error(`Expected one ${lang} ${id}.`);
	return found[0] as Element;
}

const values = (text: Element): Element[] =>
	text.children.filter(
		(node): node is Element => "name" in node && node.name === "value",
	);
const forms = (text: Element): (string | undefined)[] =>
	values(text).map((value) => value.attribs.form);

/** An element as plain data, for comparing two builds. */
function shape(node: Element): unknown {
	return {
		name: node.name,
		attribs: node.attribs,
		children: node.children.map((child) =>
			"name" in child
				? shape(child as Element)
				: "data" in child
					? child.data
					: null,
		),
	};
}

describe("a plain label", () => {
	const plain = builtForm(true);
	const marked = builtForm(false);

	it("writes no markdown form for a question's label in any language", () => {
		for (const lang of LANGUAGES) {
			expect(forms(entry(plain, lang, "age-label"))).toEqual([undefined]);
			expect(forms(entry(marked, lang, "age-label"))).toEqual([
				undefined,
				"markdown",
			]);
		}
	});

	it("keeps a reference in the label as an output", () => {
		for (const lang of LANGUAGES) {
			const [value] = values(entry(plain, lang, "age-label"));
			if (value === undefined) throw new Error("No label value.");
			expect(
				findAll((node) => node.name === "output", value.children),
			).toHaveLength(1);
			expect(shape(value)).toEqual(
				shape(values(entry(marked, lang, "age-label"))[0] as Element),
			);
		}
	});

	it("writes no markdown form for a plain choice, and keeps it for the other", () => {
		for (const lang of LANGUAGES) {
			expect(forms(entry(plain, lang, "pick-opt0-label"))).toEqual([undefined]);
			expect(forms(entry(plain, lang, "pick-opt1-label"))).toEqual([
				undefined,
				"markdown",
			]);
		}
	});

	it("keeps the hint's and the help text's markdown forms", () => {
		for (const lang of LANGUAGES) {
			for (const id of ["age-hint", "age-help"]) {
				expect(forms(entry(plain, lang, id))).toEqual([undefined, "markdown"]);
			}
		}
	});

	it("leaves a protected validation message's forms as they were", () => {
		for (const lang of LANGUAGES) {
			const message = entry(plain, lang, "age-constraintMsg");
			expect(forms(message)).toEqual(
				expect.arrayContaining([
					"markdown",
					"__nova_identity",
					"__nova_mode",
					"__nova_mode;markdown",
				]),
			);
			expect(shape(message)).toEqual(
				shape(entry(marked, lang, "age-constraintMsg")),
			);
		}
	});
});
