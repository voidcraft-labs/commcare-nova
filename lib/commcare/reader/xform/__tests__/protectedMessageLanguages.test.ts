/**
 * A protected validation message read as Core shows it in each language. The stored
 * `jr:constraintMsg` is the composition over the languages the app held when Nova wrote the form,
 * and CommCare HQ rewrites neither it nor the `__nova_` forms when it adds a language, renames
 * one (`rename_language` changes only the translation's `lang`) or reorders them; a save in HQ's
 * form builder fills a language that lacks a form with the default's (`javaRosa/plugin.js`,
 * `getValueOrDefault`). Core reads each language's text over the default's
 * (`Localizer.getLocaleData`), so a language with no forms of its own, or the default's copy,
 * shows the default's message through the default's branch. Each such source reads as the
 * document whose language holds the default's message, and the publish writes the composition
 * over every language with each language's own forms. A language whose own text says something
 * else than the message it shows is a real difference and stays a finding, and so does a default
 * language missing one of its forms, which falls back to the text itself.
 *
 * Plausible failures: a language HQ added after the publish refused because the stored
 * composition has no branch for it; a renamed or reordered language refused because the
 * composition was rebuilt in the document's order and codes; a language whose own text differs
 * read as that text though a device shows the default's.
 */

import { cloneNode, type Element, isTag, isText } from "domhandler";
import { findAll, findOne } from "domutils";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, LanguageTag, ProseTemplate } from "@/lib/domain";
import {
	makeTranslationUnitId,
	translationSourceFingerprint,
} from "@/lib/domain/localization";
import {
	CONSTRAINT_CHECKED,
	CONSTRAINT_VALUE,
	constraintMessageFixture,
} from "../../../__tests__/constraintMessageFixture";
import { serializeXml } from "../../../serializeXml";
import { parseXml } from "../../../xmlParse";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

/** The fixture's message with a reference to each of two answers, in English alone. */
function englishApp(): BlueprintDoc {
	return constraintMessageFixture("references").doc;
}

/** `doc` with one more language. */
function withLanguage(
	doc: BlueprintDoc,
	language: string,
	wireCode: string,
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, [
			{
				kind: "addLanguage",
				language: { language: language as LanguageTag },
				wireCode,
			},
		]);
	});
}

/** The app in English and Spanish, Spanish with a message of its own. */
function spanishTranslated(): BlueprintDoc {
	const doc = withLanguage(englishApp(), "spa", "es");
	const source = (
		doc.fields[CONSTRAINT_CHECKED] as { validate_msg: ProseTemplate }
	).validate_msg;
	const spanish: ProseTemplate = {
		parts: [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is what makes a message protected
			{ kind: "text", text: "Literal en español ${0}; " },
			{ kind: "field-ref", uuid: CONSTRAINT_VALUE },
			{ kind: "text", text: " / " },
			{ kind: "field-ref", uuid: CONSTRAINT_CHECKED },
		],
	};
	return produce(doc, (draft) => {
		const translations = draft.localization?.translations as Record<
			string,
			Record<string, unknown>
		>;
		translations.spa = {
			...translations.spa,
			[makeTranslationUnitId("field", CONSTRAINT_CHECKED, "validate_msg")]: {
				value: spanish,
				sourceFingerprint: translationSourceFingerprint("prose", source),
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			},
		};
	});
}

const NOVA_FORM = (value: Element) =>
	(value.attribs.form ?? "").startsWith("__nova_");

function translationOf(root: Element[], lang: string): Element | null {
	return findOne(
		(element) =>
			element.name === "translation" && element.attribs.lang === lang,
		root,
		true,
	);
}

/** The `text` of `lang`'s translation that holds the message's `__nova_` forms. */
function messageText(root: Element[], lang: string): Element | null {
	const translation = translationOf(root, lang);
	if (translation === null) return null;
	return findOne(
		(element) =>
			element.name === "text" &&
			element.children.some((value) => isTag(value) && NOVA_FORM(value)),
		[translation],
		true,
	);
}

/** An edit of the one form source that holds a protected message, counted. */
function editMessage(edit: (root: Element[]) => void): {
	readonly xml: (xml: string) => string;
	readonly edits: () => number;
} {
	let edits = 0;
	return {
		xml: (xml) => {
			const document = parseXml(xml);
			const root = document.children.filter(isTag);
			if (messageText(root, "en") === null) return xml;
			edit(root);
			edits += 1;
			return serializeXml(document);
		},
		edits: () => edits,
	};
}

/** A save in HQ's form builder of a form whose translations lack `lang`: every text of the
 *  default's copied into a translation of `lang` (`getValueOrDefault`). */
function filledInFormBuilder(root: Element[], lang: string): Element {
	const english = translationOf(root, "en");
	const itext = english?.parent;
	if (
		english === null ||
		itext === null ||
		itext === undefined ||
		!isTag(itext)
	)
		throw new Error("No English translation.");
	const copy = cloneNode(english, true);
	delete copy.attribs.default;
	copy.attribs.lang = lang;
	copy.parent = itext;
	itext.children = [...itext.children, copy];
	return copy;
}

const spanishFilledInFormBuilder = () =>
	editMessage((root) => {
		filledInFormBuilder(root, "es");
	});

/** Spanish filled in the form builder, then its message's text typed in Spanish: the value
 *  Spanish's own message writes, beside the default's forms. */
function spanishTypedInFormBuilder() {
	const spanishSource = Object.values(
		exportedBody(spanishTranslated())._attachments as Record<string, string>,
	)
		.map((xml) => parseXml(xml).children.filter(isTag))
		.map((root) => messageText(root, "es"))
		.find((text) => text !== null);
	if (spanishSource === undefined || spanishSource === null)
		throw new Error("No Spanish text of the message.");
	const typed = spanishSource.children.filter(
		(child) => isTag(child) && child.name === "value" && !NOVA_FORM(child),
	);
	return editMessage((root) => {
		filledInFormBuilder(root, "es");
		const text = messageText(root, "es");
		if (text === null) throw new Error("No Spanish text of the message.");
		text.children = [
			...typed.map((child) => {
				const copy = cloneNode(child, true);
				copy.parent = text;
				return copy;
			}),
			...text.children.filter((child) => isTag(child) && NOVA_FORM(child)),
		];
	});
}

/** A language's `__nova_locale` forms holding `from`, as a language CommCare HQ renamed from
 *  `from` keeps them. */
const localeWrittenAs = (lang: string, from: string) =>
	editMessage((root) => {
		const text = messageText(root, lang);
		if (text === null) throw new Error(`No text of the message in ${lang}.`);
		for (const value of findAll(
			(element) => (element.attribs.form ?? "").startsWith("__nova_locale"),
			[text],
		))
			for (const child of value.children) if (isText(child)) child.data = from;
	});

/** English's `__nova_locale` form removed: the default language falls back to its text. */
const englishLocaleRemoved = () =>
	editMessage((root) => {
		const text = messageText(root, "en");
		if (text === null) throw new Error("No English text of the message.");
		text.children = text.children.filter(
			(child) => !isTag(child) || child.attribs.form !== "__nova_locale",
		);
	});

async function reading(
	doc: BlueprintDoc,
	langs: readonly string[],
	xml?: (xml: string) => string,
) {
	return readHqApp(
		await inputFor(
			exportedBody(doc, {
				...(xml === undefined ? {} : { xml }),
				root: { langs },
			}),
		),
	);
}

function questionFindings(outcome: Awaited<ReturnType<typeof reading>>) {
	return (outcome.kind === "account" ? outcome.findings : [])
		.filter((finding) => finding.place.kind === "question")
		.map((finding) => `${finding.code} ${finding.detail.name ?? ""}`);
}

function readDoc(outcome: Awaited<ReturnType<typeof reading>>): BlueprintDoc {
	if (outcome.kind !== "read") throw new Error("The source did not read.");
	return outcome.draft.doc;
}

/** The `__nova_locale` value each language's text of the message holds in `doc`'s export. */
function exportedLocales(
	doc: BlueprintDoc,
	langs: readonly string[],
): Record<string, string> {
	const attachments = exportedBody(doc)._attachments as Record<string, string>;
	const locales: Record<string, string> = {};
	for (const xml of Object.values(attachments)) {
		const root = parseXml(xml).children.filter(isTag);
		for (const lang of langs) {
			const text = messageText(root, lang);
			const locale =
				text === null
					? undefined
					: findAll(
							(value) => value.attribs.form === "__nova_locale",
							[text],
						)[0];
			if (locale !== undefined)
				locales[lang] = locale.children
					.map((child) => ("data" in child ? child.data : ""))
					.join("");
		}
	}
	return locales;
}

describe("a protected validation message in each language Core shows it in", () => {
	it("reads Nova's export of both languages with no finding", async () => {
		const outcome = await reading(withLanguage(englishApp(), "spa", "es"), [
			"en",
			"es",
		]);
		expect(questionFindings(outcome)).toEqual([]);
		expect(outcome.defects).toEqual([]);
	});

	for (const [name, edit] of [
		["holds no translation of the form", undefined],
		[
			"holds the default's copy a save in HQ's form builder writes",
			spanishFilledInFormBuilder,
		],
	] as const)
		it(`reads the default's message in a language CommCare HQ added after the publish that ${name}`, async () => {
			const counted = edit?.();
			// One document, so both readings hold one menu (the fixture mints its menu's UUID).
			const english = englishApp();
			const edited = await reading(english, ["en", "es"], counted?.xml);
			if (counted !== undefined) expect(counted.edits()).toBeGreaterThan(0);
			expect(questionFindings(edited)).toEqual([]);
			expect(edited.defects).toEqual([]);
			const both = await reading(withLanguage(english, "spa", "es"), [
				"en",
				"es",
			]);
			expect(readDoc(edited)).toEqual(readDoc(both));
			// The first publish writes the composition over both languages and Spanish's own forms.
			expect(exportedLocales(readDoc(edited), ["en", "es"])).toEqual({
				en: "en",
				es: "es",
			});
		});

	it("reads a language CommCare HQ renamed, whose forms keep its old code", async () => {
		const edit = localeWrittenAs("fr", "es");
		const french = withLanguage(englishApp(), "fra", "fr");
		const edited = await reading(french, ["en", "fr"], edit.xml);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(questionFindings(edited)).toEqual([]);
		expect(edited.defects).toEqual([]);
		expect(readDoc(edited)).toEqual(
			readDoc(await reading(french, ["en", "fr"])),
		);
	});

	it("reads languages CommCare HQ reordered, the composition keeping the order it was written in", async () => {
		const outcome = await reading(withLanguage(englishApp(), "spa", "es"), [
			"es",
			"en",
		]);
		expect(questionFindings(outcome)).toEqual([]);
		expect(outcome.defects).toEqual([]);
	});

	it("leaves the message unclaimed where a language's own text is not the message it shows", async () => {
		const edit = spanishTypedInFormBuilder();
		const findings = questionFindings(
			await reading(englishApp(), ["en", "es"], edit.xml),
		);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(findings).toContain("unrecognized xform:bind@jr:constraintMsg");
	});

	it("leaves the message unclaimed where the default language lacks one of its forms", async () => {
		const edit = englishLocaleRemoved();
		const findings = questionFindings(
			await reading(englishApp(), ["en", "es"], edit.xml),
		);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(findings).toContain("unrecognized xform:bind@jr:constraintMsg");
	});
});
