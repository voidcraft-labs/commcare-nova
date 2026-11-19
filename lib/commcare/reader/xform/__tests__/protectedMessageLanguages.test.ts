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
 * language missing one of its forms, which falls back to the text itself. The branch of a
 * language HQ removed stays in the expression, and no language a device shows reads it, so it is
 * rebuilt from the expression alone, whether the source keeps that language's translation, keeps
 * it without its pieces, or lost it to a save in HQ's form builder.
 *
 * Plausible failures: a language HQ added after the publish refused because the stored
 * composition has no branch for it; a renamed or reordered language refused because the
 * composition was rebuilt in the document's order and codes; a language whose own text differs
 * read as that text though a device shows the default's; a removed language's branch refused
 * once its translation or its words are gone, or where the message names one reference twice.
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

/** Spanish's own message: the fixture's references, with words of its own. */
const SPANISH_MESSAGE: ProseTemplate = {
	parts: [
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is what makes a message protected
		{ kind: "text", text: "Literal en español ${0}; " },
		{ kind: "field-ref", uuid: CONSTRAINT_VALUE },
		{ kind: "text", text: " / " },
		{ kind: "field-ref", uuid: CONSTRAINT_CHECKED },
	],
};

/** `doc` with the checked question's message replaced by `message`. */
function withMessage(doc: BlueprintDoc, message: ProseTemplate): BlueprintDoc {
	return produce(doc, (draft) => {
		(
			draft.fields[CONSTRAINT_CHECKED] as { validate_msg: ProseTemplate }
		).validate_msg = message;
	});
}

/** The app in English and Spanish, Spanish with a message of its own. */
function spanishTranslated(
	english: BlueprintDoc = englishApp(),
	spanish: ProseTemplate = SPANISH_MESSAGE,
): BlueprintDoc {
	const doc = withLanguage(english, "spa", "es");
	const source = (
		doc.fields[CONSTRAINT_CHECKED] as { validate_msg: ProseTemplate }
	).validate_msg;
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

/** `lang`'s translation removed, as a save in HQ's form builder of an app that no longer lists
 *  it leaves the form (`javaRosa/plugin.js::loadXML` reads no language the app does not list),
 *  `markDefault` then marked the default, as the save marks the app's first language. */
const translationDropped = (lang: string, markDefault: string) =>
	editMessage((root) => {
		const translation = translationOf(root, lang);
		const itext = translation?.parent;
		if (
			translation === null ||
			itext === null ||
			itext === undefined ||
			!isTag(itext)
		)
			throw new Error(`No translation of ${lang}.`);
		itext.children = itext.children.filter((child) => child !== translation);
		const kept = translationOf(root, markDefault);
		if (kept === null) throw new Error(`No translation of ${markDefault}.`);
		kept.attribs.default = "";
	});

/** `lang`'s `__nova_piece_` forms of the message removed. */
const piecesDropped = (lang: string) =>
	editMessage((root) => {
		const text = messageText(root, lang);
		if (text === null) throw new Error(`No text of the message in ${lang}.`);
		text.children = text.children.filter(
			(child) =>
				!isTag(child) ||
				!(child.attribs.form ?? "").startsWith("__nova_piece_"),
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

	// `edit_app_langs` changes `langs` alone: the removed language's branch stays in the stored
	// expression, which no language a device shows reads (HQ's build drops the translation,
	// `XForm.exclude_languages`), and its translation stays in the form until a save in HQ's form
	// builder drops it. The branch is rebuilt from the expression alone, whatever the source keeps
	// of the translation, and the first publish writes the composition over the languages left,
	// with no translation of the removed one.
	for (const [name, edit] of [
		["keeps its translation", undefined],
		[
			"a save in HQ's form builder dropped its translation",
			() => translationDropped("es", "en"),
		],
		["its translation lacks its pieces", () => piecesDropped("es")],
	] as const)
		it(`reads a message whose stored composition keeps the branch of a language CommCare HQ removed, the last, where ${name}`, async () => {
			const counted = edit?.();
			// One document, so both readings hold one menu (the fixture mints its menu's UUID).
			const english = englishApp();
			const edited = await reading(
				spanishTranslated(english),
				["en"],
				counted?.xml,
			);
			if (counted !== undefined) expect(counted.edits()).toBeGreaterThan(0);
			expect(questionFindings(edited)).toEqual([]);
			expect(edited.defects).toEqual([]);
			expect(readDoc(edited)).toEqual(readDoc(await reading(english, ["en"])));
			expect(exportedLocales(readDoc(edited), ["en", "es"])).toEqual({
				en: "en",
			});
		});

	for (const [name, edit] of [
		["keeps its translation", undefined],
		[
			"a save in HQ's form builder dropped its translation",
			() => translationDropped("en", "es"),
		],
		["its translation lacks its pieces", () => piecesDropped("en")],
	] as const)
		it(`reads a message whose stored composition keeps the branch of a language CommCare HQ removed, one it tests first, where ${name}`, async () => {
			const counted = edit?.();
			const edited = await reading(spanishTranslated(), ["es"], counted?.xml);
			if (counted !== undefined) expect(counted.edits()).toBeGreaterThan(0);
			expect(questionFindings(edited)).toEqual([]);
			expect(edited.defects).toEqual([]);
			const message = Object.values(readDoc(edited).fields)
				.map(
					(field) => (field as { validate_msg?: ProseTemplate }).validate_msg,
				)
				.find((template) => template !== undefined);
			// The reading mints its fields' UUIDs: the words, and a reference at each place.
			const shape = (template: ProseTemplate | undefined) =>
				template?.parts.map((part) =>
					part.kind === "text" ? part : part.kind,
				);
			expect(shape(message)).toEqual(shape(SPANISH_MESSAGE));
			expect(exportedLocales(readDoc(edited), ["en", "es"])).toEqual({
				es: "es",
			});
		});

	it("reads a message whose removed language alone wrote the words that protect it", async () => {
		const english = withMessage(englishApp(), {
			parts: [{ kind: "text", text: "Check the value" }],
		});
		const both = spanishTranslated(english, {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is what makes a message protected
			parts: [{ kind: "text", text: "Revise ${0}" }],
		});
		const edit = translationDropped("es", "en");
		const edited = await reading(both, ["en"], edit.xml);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(questionFindings(edited)).toEqual([]);
		expect(edited.defects).toEqual([]);
		expect(readDoc(edited)).toEqual(readDoc(await reading(english, ["en"])));
	});

	it("reads a message that names one reference twice, beside the branch of a language CommCare HQ removed", async () => {
		const repeated: ProseTemplate = {
			parts: [
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is what makes a message protected
				{ kind: "text", text: "Literal ${0}; " },
				{ kind: "field-ref", uuid: CONSTRAINT_VALUE },
				{ kind: "text", text: " / " },
				{ kind: "field-ref", uuid: CONSTRAINT_CHECKED },
				{ kind: "text", text: " / " },
				{ kind: "field-ref", uuid: CONSTRAINT_VALUE },
			],
		};
		const english = withMessage(englishApp(), repeated);
		const both = spanishTranslated(english, {
			parts: [...SPANISH_MESSAGE.parts, ...repeated.parts.slice(-2)],
		});
		const whole = await reading(both, ["en", "es"]);
		expect(questionFindings(whole)).toEqual([]);
		expect(whole.defects).toEqual([]);
		const edit = translationDropped("es", "en");
		const edited = await reading(both, ["en"], edit.xml);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(questionFindings(edited)).toEqual([]);
		expect(edited.defects).toEqual([]);
		expect(readDoc(edited)).toEqual(readDoc(await reading(english, ["en"])));
	});

	it("leaves the message unclaimed where a language's own text is not the message it shows", async () => {
		const edit = spanishTypedInFormBuilder();
		const findings = questionFindings(
			await reading(englishApp(), ["en", "es"], edit.xml),
		);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(findings).toContain("unrecognized xform:bind@jr:constraintMsg");
	});

	// Each stored form is compared by its text, so it is held only where it is the value the
	// composition writes for that text whole: `form` its only attribute, its text its content.
	it.each([
		[
			"an attribute Nova does not write",
			(value: Element) => {
				value.attribs.note = "kept";
			},
		],
		[
			"an element inside it",
			(value: Element) => {
				const output = parseXml(
					'<output value="/data/value"/>',
				).children.filter(isTag)[0] as Element;
				output.parent = value;
				value.children = [...value.children, output];
			},
		],
	])(
		"leaves the message unclaimed where a form of it holds %s",
		async (_, change) => {
			const edit = editMessage((root) => {
				const text = messageText(root, "en");
				if (text === null) throw new Error("No English text of the message.");
				const locale = findAll(
					(value) => value.attribs.form === "__nova_locale",
					[text],
				)[0];
				if (locale === undefined) throw new Error("No __nova_locale form.");
				change(locale);
			});
			const findings = questionFindings(
				await reading(englishApp(), ["en"], edit.xml),
			);
			expect(edit.edits()).toBeGreaterThan(0);
			expect(findings).toContain("unrecognized xform:bind@jr:constraintMsg");
		},
	);

	it("leaves the message unclaimed where the default language lacks one of its forms", async () => {
		const edit = englishLocaleRemoved();
		const findings = questionFindings(
			await reading(englishApp(), ["en", "es"], edit.xml),
		);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(findings).toContain("unrecognized xform:bind@jr:constraintMsg");
	});
});
