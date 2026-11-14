/**
 * Text read by reference (12.1) and the forms of a text (12.2), over hand-built
 * sources read through the reader's own stages. A text is found by what
 * references it and never by its id's spelling; each form of the table reads
 * to its row; a pragma key is read by its row; a value blank in a language
 * other than the first beside first-language text reads as no translation and
 * is counted, while a blank first-language value beside another language's
 * text is refused; a text blank everywhere gets no flag.
 */

import { describe, expect, it } from "vitest";
import { proseText } from "@/lib/domain";
import { translationEntryFor } from "../../translations";
import { formBlankTranslations } from "../prose";
import {
	type FormReading,
	readFields,
	readForm,
	xformSource,
} from "./formReading";

const Q = (id: string) => `questions/${id}`;

/** An itext block of one translation per language, the first marked the default. */
function itext(translations: Readonly<Record<string, string>>): string {
	return `<itext>${Object.entries(translations)
		.map(
			([lang, texts], index) =>
				`<translation lang="${lang}"${index === 0 ? ' default=""' : ""}>${texts}</translation>`,
		)
		.join("")}</itext>`;
}

/** A form of one text question `q` whose label references `id`. */
function oneLabel(
	id: string,
	translations: Readonly<Record<string, string>>,
	extra = "",
) {
	return xformSource({
		data: "<q/>",
		model: `<bind nodeset="/data/q" type="xsd:string"/>${itext(translations)}`,
		body: `<input ref="/data/q"><label ref="jr:itext('${id}')"/>${extra}</input>`,
	});
}

/** The codes of the manifest findings a reading holds. */
function codes(reading: FormReading): string[] {
	return reading.closed.findings
		.map((finding) => finding.code)
		.filter((code) => code !== "unrecognized");
}

/** The names of `unrecognized` findings that name text the text reader claims. */
function unclaimedText(reading: FormReading): string[] {
	return reading.closed.findings
		.filter((finding) => finding.code === "unrecognized")
		.map((finding) => finding.detail.name ?? "")
		.filter(
			(name) =>
				name.includes("itext") ||
				name.includes("label") ||
				name.includes("hint"),
		);
}

function field(reading: FormReading, id: string): Record<string, unknown> {
	const found = readFields(reading.xform ?? ({} as never)).find(
		(one) => one.id === id,
	);
	if (found === undefined) throw new Error(`The reading holds no field ${id}.`);
	return found.field;
}

describe("text read by reference", () => {
	it("finds a text by the reference that names it, whatever its id's spelling", async () => {
		const reading = await readForm(
			oneLabel("Any Name/7 at all", {
				en: `<text id="Any Name/7 at all"><value>Hello</value></text>`,
			}),
		);
		expect(field(reading, "q").label).toEqual(proseText("Hello"));
		expect(unclaimedText(reading)).toEqual([]);
		expect(reading.closed.defects).toEqual([]);
	});

	it("reads one id two questions reference as each question's own text, claimed once", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a/><b/>",
				model: `<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/>${itext(
					{ en: `<text id="shared"><value>Same words</value></text>` },
				)}`,
				body: `<input ref="/data/a"><label ref="jr:itext('shared')"/></input>
					<input ref="/data/b"><label ref="jr:itext('shared')"/></input>`,
			}),
		);
		expect(field(reading, "a").label).toEqual(proseText("Same words"));
		expect(field(reading, "b").label).toEqual(proseText("Same words"));
		expect(reading.closed.defects).toEqual([]);
		expect(unclaimedText(reading)).toEqual([]);
	});

	it("refuses a reference written between double quotes", async () => {
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: `<bind nodeset="/data/q" type="xsd:string"/>${itext({
					en: `<text id="q-label"><value>Hello</value></text>`,
				})}`,
				body: `<input ref="/data/q"><label ref='jr:itext("q-label")'/></input>`,
			}),
		);
		expect(codes(reading)).toContain(
			Q("duplicate-text-id-in-one-translation-jr-itext-with-double-quotes"),
		);
	});
});

describe("the forms of a text", () => {
	it("holds a markdown copy equal to the default text, and sets no plain flag", async () => {
		const reading = await readForm(
			oneLabel("l", {
				en: `<text id="l"><value>**Hi**</value><value form="markdown">**Hi**</value></text>`,
			}),
		);
		expect(field(reading, "q").plainLabel).toBeUndefined();
		expect(codes(reading)).toEqual([]);
		expect(unclaimedText(reading)).toEqual([]);
	});

	it("reads a label with no markdown copy as shown as typed", async () => {
		const reading = await readForm(
			oneLabel("l", { en: `<text id="l"><value>Hi</value></text>` }),
		);
		expect(field(reading, "q").plainLabel).toBe(true);
		expect(codes(reading)).toEqual([]);
	});

	it("refuses a label's markdown copy that differs, and drops a hint's", async () => {
		const reading = await readForm(
			oneLabel(
				"l",
				{
					en: `<text id="l"><value>A</value><value form="markdown">B</value></text>
						<text id="h"><value>A</value><value form="markdown">B</value></text>`,
				},
				`<hint ref="jr:itext('h')"/>`,
			),
		);
		expect(codes(reading)).toEqual([
			Q("markdown-form-differing-from-the-default-text"),
		]);
		expect(unclaimedText(reading)).toEqual([]);
	});

	it("refuses a markdown copy in a form whose text formatting is off, and sets no flag", async () => {
		const source = oneLabel("l", {
			en: `<text id="l"><value>A</value><value form="markdown">A</value></text>`,
		}).replace("<h:html ", '<h:html vellum:ignore="markdown" ');
		const reading = await readForm(source);
		expect(codes(reading)).toEqual([
			Q("a-markdown-form-in-a-form-whose-text-formatting-is-off"),
		]);
		expect(field(reading, "q").plainLabel).toBeUndefined();
	});

	it("reads each other form by its row", async () => {
		const reading = await readForm(
			oneLabel("l", {
				en: `<text id="l"><value>A</value><value form="long">L</value><value form="short">S</value>
					<value form="video-inline">jr://file/v.mp4</value><value form="mine">M</value></text>`,
			}),
		);
		expect(codes(reading).sort()).toEqual(
			[Q("label-video-inline"), Q("long-form")].sort(),
		);
		expect(unclaimedText(reading)).toEqual([]);
	});
});

describe("pragma keys", () => {
	it("reads each pragma row and settles every text no slot references", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a/><b/><c/>",
				model: `<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/>
					<bind nodeset="/data/c" calculate="jr:itext('only-expression')"/>${itext(
						{
							en: `<text id="Pragma-Volatility-Entity-Title"><value>Title</value></text>
							<text id="Pragma-Form-Descriptor"><value>Descriptor</value></text>
							<text id="Pragma-Skip-Full-Form-Validation"><value>true</value></text>
							<text id="only-expression"><value>Read</value></text>
							<text id="orphan"><value>Nobody</value></text>`,
						},
					)}`,
				body: `<input ref="/data/a"><label ref="jr:itext('Pragma-Volatility-Entity-Title')"/></input>
					<input ref="/data/b"><label ref="jr:itext('Pragma-Form-Descriptor')"/></input>`,
			}),
		);
		expect(codes(reading).sort()).toEqual(
			[
				Q("a-question-text-whose-itext-id-is-pragma-form-descriptor-where"),
				Q("itext-pragma-entries-pragma-form-descriptor-pragma-skip-full"),
				Q("itext-entry-referenced-only-from-jr-itext-in-an-expression"),
			].sort(),
		);
		expect(field(reading, "a").label).toEqual(proseText("Title"));
	});
});

describe("blank values", () => {
	it("reads a blank second language beside first-language text as no translation, and counts it", async () => {
		const reading = await readForm(
			oneLabel("l", {
				en: `<text id="l"><value>Hello</value></text>`,
				fr: `<text id="l"><value/></text>`,
			}),
			{ langs: ["en", "fr"] },
		);
		expect(codes(reading)).toEqual([]);
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toBe(1);
		expect(unclaimedText(reading)).toEqual([]);
		expect(
			translationEntryFor("prose", proseText("Hello"), { parts: [] }, "eng"),
		).toBeUndefined();
	});

	it("refuses a blank first language beside another language's text", async () => {
		const reading = await readForm(
			oneLabel("l", {
				en: `<text id="l"><value/></text>`,
				fr: `<text id="l"><value>Bonjour</value></text>`,
			}),
			{ langs: ["en", "fr"] },
		);
		expect(codes(reading)).toEqual([
			Q(
				"an-explicitly-blank-value-in-the-first-language-where-another-holds-text",
			),
		]);
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toBe(0);
	});

	it("reads a text blank in every language as a blank text, with no flag", async () => {
		const reading = await readForm(
			oneLabel("l", {
				en: `<text id="l"><value/></text>`,
				fr: `<text id="l"><value/></text>`,
			}),
			{ langs: ["en", "fr"] },
		);
		expect(codes(reading)).toEqual([]);
		expect(field(reading, "q").label).toEqual({ parts: [] });
		expect(field(reading, "q").plainLabel).toBeUndefined();
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toBe(0);
	});

	it("reads a language with no translation as untranslated", async () => {
		const reading = await readForm(
			oneLabel("l", { en: `<text id="l"><value>Hello</value></text>` }),
			{ langs: ["en", "fr"] },
		);
		expect(codes(reading)).toEqual([]);
		expect(field(reading, "q").label).toEqual(proseText("Hello"));
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toBe(0);
	});
});
