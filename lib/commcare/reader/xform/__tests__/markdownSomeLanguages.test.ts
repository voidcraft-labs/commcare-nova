/**
 * A markdown copy some languages lack, read as Core shows each language. Core lays a language's
 * own text table over the default language's (`Localizer.getLocaleData`), so a language whose
 * text holds no `markdown` value shows the default's copy wherever a runtime asks for it
 * (`FormEntryCaption.getMarkdownText`), and its own value where a runtime reads the text alone
 * (Android's form hierarchy, `getLongText`). Where that value is the default's copy, every place
 * shows one text, and the source reads as the document Nova's export of it came from; the first
 * publish writes the copy in that language again. A language whose text holds the copy and no
 * value shows the default's value where a runtime reads the text alone (the same merge), so it
 * reads as untranslated where its copy is the default's text. Where the copy and the text a
 * language shows differ, the language shows two texts and the reading keeps the finding.
 *
 * Plausible failures: a copy HQ's bulk translation upload left out of one language refused
 * though the language shows the default's text everywhere, or a copy beside no value of its
 * own refused though the language shows one text; the same source read with no finding though
 * the language shows two texts.
 */

import { type Element, isTag, isText } from "domhandler";
import { findAll } from "domutils";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, LanguageTag } from "@/lib/domain";
import { constraintMessageFixture } from "../../../__tests__/constraintMessageFixture";
import { serializeXml } from "../../../serializeXml";
import { parseXml } from "../../../xmlParse";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

/** An app of labels with markdown on, in English and in French with no translation of its own. */
function twoLanguageApp(): BlueprintDoc {
	return produce(constraintMessageFixture("plain").doc, (draft) => {
		applyMutations(draft, [
			{
				kind: "addLanguage",
				language: { language: "fra" as LanguageTag },
				wireCode: "fr",
			},
		]);
	});
}

/** Each `text` of `lang`'s translation in a form source. */
function textsOf(root: Element[], lang: string): Element[] {
	return findAll(
		(element) =>
			element.name === "text" &&
			isTag(element.parent as Element) &&
			(element.parent as Element).name === "translation" &&
			(element.parent as Element).attribs.lang === lang,
		root,
	);
}

/** An edit of every form source, counted: `edit` changes each French text with a copy and says
 *  whether it did. */
function editFrench(edit: (text: Element) => boolean) {
	let edits = 0;
	return {
		xml: (xml: string) => {
			const document = parseXml(xml);
			for (const text of textsOf(document.children.filter(isTag), "fr"))
				if (edit(text)) edits += 1;
			return serializeXml(document);
		},
		edits: () => edits,
	};
}

const isCopy = (child: unknown) =>
	isTag(child as Element) && (child as Element).attribs.form === "markdown";

/** French's copies removed, as HQ's bulk translation upload leaves a language it adds none to. */
const frenchCopiesRemoved = () =>
	editFrench((text) => {
		if (!text.children.some(isCopy)) return false;
		text.children = text.children.filter((child) => !isCopy(child));
		return true;
	});

/** The same, and French's text then typed as other words. */
const frenchRetyped = () =>
	editFrench((text) => {
		if (!text.children.some(isCopy)) return false;
		text.children = text.children.filter((child) => !isCopy(child));
		for (const value of text.children)
			if (isTag(value) && value.attribs.form === undefined)
				for (const child of value.children)
					if (isText(child)) child.data = "Autre chose";
		return true;
	});

const isValue = (child: unknown) =>
	isTag(child as Element) &&
	(child as Element).name === "value" &&
	(child as Element).attribs.form === undefined;

/** French's own values removed beside its copies: a text holding only its copy. */
const frenchValuesRemoved = () =>
	editFrench((text) => {
		if (!text.children.some(isCopy)) return false;
		text.children = text.children.filter((child) => !isValue(child));
		return true;
	});

/** The same, and French's copy then typed as other words. */
const frenchCopiesRetyped = () =>
	editFrench((text) => {
		if (!text.children.some(isCopy)) return false;
		text.children = text.children.filter((child) => !isValue(child));
		for (const value of text.children)
			if (isCopy(value))
				for (const child of (value as Element).children)
					if (isText(child)) child.data = "Autre chose";
		return true;
	});

async function reading(doc: BlueprintDoc, xml?: (xml: string) => string) {
	return readHqApp(
		await inputFor(exportedBody(doc, xml === undefined ? {} : { xml })),
	);
}

function questionFindings(outcome: Awaited<ReturnType<typeof reading>>) {
	return (outcome.kind === "account" ? outcome.findings : [])
		.filter((finding) => finding.place.kind === "question")
		.map((finding) => finding.code);
}

function readDoc(outcome: Awaited<ReturnType<typeof reading>>): BlueprintDoc {
	if (outcome.kind !== "read") throw new Error("The source did not read.");
	return outcome.draft.doc;
}

/** How many French texts of `doc`'s export hold a copy. */
function frenchCopies(doc: BlueprintDoc): number {
	return Object.values(exportedBody(doc)._attachments as Record<string, string>)
		.flatMap((xml) => textsOf(parseXml(xml).children.filter(isTag), "fr"))
		.filter((text) => text.children.some(isCopy)).length;
}

describe("a markdown copy some languages lack", () => {
	it("reads the document Nova's export came from where the language lacking it shows the default's copy", async () => {
		const doc = twoLanguageApp();
		const edit = frenchCopiesRemoved();
		const edited = await reading(doc, edit.xml);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(questionFindings(edited)).toEqual([]);
		expect(edited.defects).toEqual([]);
		const whole = await reading(doc);
		expect(readDoc(edited)).toEqual(readDoc(whole));
		// The first publish writes each French copy again.
		expect(frenchCopies(readDoc(edited))).toBe(edit.edits());
	});

	it("keeps the finding where the language lacking it holds other text", async () => {
		const edit = frenchRetyped();
		const findings = questionFindings(
			await reading(twoLanguageApp(), edit.xml),
		);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(findings).toContain(
			"questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk",
		);
	});

	it("reads the document Nova's export came from where a language holds the copy beside no text of its own", async () => {
		const doc = twoLanguageApp();
		const edit = frenchValuesRemoved();
		const edited = await reading(doc, edit.xml);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(questionFindings(edited)).toEqual([]);
		expect(edited.defects).toEqual([]);
		expect(readDoc(edited)).toEqual(readDoc(await reading(doc)));
	});

	it("keeps the finding where a copy beside no text of its own is other text than the default's", async () => {
		const edit = frenchCopiesRetyped();
		const findings = questionFindings(
			await reading(twoLanguageApp(), edit.xml),
		);
		expect(edit.edits()).toBeGreaterThan(0);
		expect(findings).toContain(
			"questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk",
		);
	});
});

describe("a markdown copy holding an attribute Nova does not write", () => {
	// The copy is compared with the text by its content alone, so it is held only where it is
	// the copy Nova writes, `form` its only attribute.
	it("is left for the close to report", async () => {
		const marked = editFrench((text) => {
			const copy = text.children.find(isCopy) as Element | undefined;
			if (copy === undefined) return false;
			copy.attribs.note = "kept";
			return true;
		});
		const outcome = await reading(twoLanguageApp(), marked.xml);
		expect(marked.edits()).toBeGreaterThan(0);
		expect(
			(outcome.kind === "account" ? outcome.findings : [])
				.filter((finding) => finding.code === "unrecognized")
				.map((finding) => finding.detail.name),
		).toContain("xform:value@note");
	});
});
