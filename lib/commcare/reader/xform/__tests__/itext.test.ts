/**
 * Text read by reference and the forms of a text, over hand-built
 * sources read through the reader's own stages. A text is found by what
 * references it and never by its id's spelling; each form of the table reads
 * to its row; a pragma key is read by its row; a value blank in a language
 * other than the first beside first-language text reads as no translation and
 * is counted, while a blank first-language value beside another language's
 * text is refused; a text blank everywhere gets no flag. A label written
 * inline is shown as typed, a help text written inline is left for the close
 * (the form builder keeps a help only through its text id), and a choice that
 * shows nothing is refused. Read
 * whole, through every stage: a translation's output takes its source twin's
 * bound part, a blank beside a source output makes no entry and no finding,
 * an output with no twin is a finding at the question, and a Hidden Value's
 * bind type is compared beside another finding of its form.
 */

import { describe, expect, it } from "vitest";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { formBehaviorRoles } from "@/lib/domain/forms";
import { formBehaviorTextIssue } from "../../../xform/behaviorTexts";
import { behaviorWireIds } from "../../../xform/itextIds";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { retainedSourceBody } from "../../__tests__/readerInput";
import { readHqApp } from "../../index";
import type { ReadOutcome } from "../../types";
import { formBlankTranslations } from "../prose";
import {
	type FormReading,
	readFields,
	readForm,
	unrecognizedAt,
	XMLNS,
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
		// A question label's inline video is its label media's: a path with no
		// file is handed off to project data, as another media form's is.
		expect(codes(reading)).toEqual([]);
		expect(unclaimedText(reading)).toEqual([]);
		// A label's `long` form is its extended text.
		expect(field(reading, "q").extended_text).toEqual(proseText("L"));
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

const blankFrenchLabel = {
	blankTranslations: 1,
	blankTranslationSlots: [
		{ fieldPath: ["q"], slot: "label", language: "fra", choiceValue: null },
	],
};

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
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toEqual(
			blankFrenchLabel,
		);
		expect(unclaimedText(reading)).toEqual([]);
	});

	it("counts a label's blank extended text beside the default's as a filled translation", async () => {
		// Core shows French workers the blank `long` form as it stands; the next publish writes
		// the English text there, so the review lists it as the label's own blank is listed.
		const reading = await readForm(
			oneLabel("l", {
				en: `<text id="l"><value>Hello</value><value form="long">Hello there</value></text>`,
				fr: `<text id="l"><value>Bonjour</value><value form="long"/></text>`,
			}),
			{ langs: ["en", "fr"] },
		);
		expect(codes(reading)).toEqual([]);
		expect(field(reading, "q").extended_text).toEqual(proseText("Hello there"));
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toEqual({
			blankTranslations: 1,
			blankTranslationSlots: [
				{
					fieldPath: ["q"],
					slot: "extended_text",
					language: "fra",
					choiceValue: null,
				},
			],
		});
		expect(unclaimedText(reading)).toEqual([]);
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
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toEqual({
			blankTranslations: 0,
		});
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
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toEqual({
			blankTranslations: 0,
		});
	});

	it("reads a language with no translation as untranslated", async () => {
		const reading = await readForm(
			oneLabel("l", { en: `<text id="l"><value>Hello</value></text>` }),
			{ langs: ["en", "fr"] },
		);
		expect(codes(reading)).toEqual([]);
		expect(field(reading, "q").label).toEqual(proseText("Hello"));
		expect(formBlankTranslations(reading.xform ?? ({} as never))).toEqual({
			blankTranslations: 0,
		});
	});
});

describe("more forms of a text", () => {
	// Core shows a language without the copy the default's copy where a runtime asks for it
	// (`Localizer.getLocaleData`) and the language's own text where it reads the text alone
	// (Android's form hierarchy, `getLongText`).
	for (const [name, en, fr] of [
		[
			"a language that lacks it holds other text than the default's copy",
			`<text id="l"><value>A</value><value form="markdown">A</value></text>`,
			`<text id="l"><value>B</value></text>`,
		],
		[
			"the default language lacks it",
			`<text id="l"><value>A</value></text>`,
			`<text id="l"><value>A</value><value form="markdown">A</value></text>`,
		],
		[
			"a language holds it beside no text of its own, other than the default's text",
			`<text id="l"><value>A</value><value form="markdown">A</value></text>`,
			`<text id="l"><value form="markdown">B</value></text>`,
		],
	] as const)
		it(`refuses a markdown copy that some languages hold where ${name}`, async () => {
			const reading = await readForm(oneLabel("l", { en, fr }), {
				langs: ["en", "fr"],
			});
			expect(codes(reading)).toEqual([
				Q("a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk"),
			]);
			expect(unclaimedText(reading)).toEqual([]);
		});

	for (const [name, fr, blanks] of [
		[
			"lacks it holds the default's copy as its text",
			`<text id="l"><value>**A**</value></text>`,
			0,
		],
		[
			"lacks it holds a blank the form builder fills from the default",
			`<text id="l"><value/></text>`,
			1,
		],
		// The language shows the default's text where a runtime reads the text alone
		// (`new Localizer(true, true)` lays the default's keys under its own) and its own copy,
		// the same text, where a runtime asks for the copy: it reads as untranslated.
		[
			"holds no text of its own holds the default's text as its copy",
			`<text id="l"><value form="markdown">**A**</value></text>`,
			0,
		],
	] as const)
		it(`holds a markdown copy the default holds where each language that ${name}`, async () => {
			const reading = await readForm(
				oneLabel("l", {
					en: `<text id="l"><value>**A**</value><value form="markdown">**A**</value></text>`,
					fr,
					es: `<text id="l"><value>**A**</value><value form="markdown">**A**</value></text>`,
				}),
				{ langs: ["en", "fr", "es"] },
			);
			expect(codes(reading)).toEqual([]);
			expect(unclaimedText(reading)).toEqual([]);
			expect(field(reading, "q").label).toEqual(proseText("**A**"));
			// Markdown on: the text shows its copy in every language.
			expect(field(reading, "q").plainLabel).toBeUndefined();
			expect(formBlankTranslations(reading.xform ?? ({} as never))).toEqual(
				blanks ? blankFrenchLabel : { blankTranslations: 0 },
			);
		});

	it("refuses a big image on a label, and holds its QR code and spoken text", async () => {
		const reading = await readForm(
			oneLabel("l", {
				en: `<text id="l"><value>A</value><value form="big-image">jr://file/b.png</value>
					<value form="qrcode">code</value><value form="tts">say</value></text>`,
			}),
		);
		expect(codes(reading)).toEqual([Q("label-big-image")]);
		expect(unclaimedText(reading)).toEqual([]);
		expect(field(reading, "q").qr_code).toEqual(proseText("code"));
		expect(field(reading, "q").spoken_text).toEqual(proseText("say"));
	});

	it("reads a choice's and a help text's forms by their own rows", async () => {
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: `<bind nodeset="/data/q" type="xsd:string"/>${itext({
					en: `<text id="q"><value>Pick</value></text>
						<text id="help"><value>Help</value></text>
						<text id="a"><value>A</value></text>
						<text id="b"><value>**B**</value><value form="markdown">**B**</value></text>
						<text id="c"><value>C</value><value form="big-image">jr://file/c.png</value></text>`,
				})}`,
				body: `<select1 ref="/data/q"><label ref="jr:itext('q')"/><help ref="jr:itext('help')"/>
					<item><label ref="jr:itext('a')"/><value>a</value></item>
					<item><label ref="jr:itext('b')"/><value>b</value></item>
					<item><label ref="jr:itext('c')"/><value>c</value></item></select1>`,
			}),
		);
		expect(codes(reading)).toEqual([Q("choice-big-image")]);
		const options = (
			field(reading, "q").optionsSource as {
				options: { plainLabel?: boolean }[];
			}
		).options;
		expect(options.map((option) => option.plainLabel)).toEqual([
			true,
			undefined,
			true,
		]);
		expect(field(reading, "q").plainHelp).toBe(true);
		expect(unclaimedText(reading)).toEqual([]);
	});

	it("holds a help text's markdown copy equal to its text, and sets no plain flag", async () => {
		const reading = await readForm(
			oneLabel(
				"l",
				{
					en: `<text id="l"><value>A</value></text>
						<text id="h"><value>*H*</value><value form="markdown">*H*</value></text>`,
				},
				`<help ref="jr:itext('h')"/>`,
			),
		);
		expect(codes(reading)).toEqual([]);
		expect(field(reading, "q").plainHelp).toBeUndefined();
		expect(unclaimedText(reading)).toEqual([]);
	});

	it("reads a group's label by the group's row", async () => {
		const reading = await readForm(
			xformSource({
				data: "<g><q/></g><h><r/></h>",
				model: `<bind nodeset="/data/q" type="xsd:string"/><bind nodeset="/data/g/q" type="xsd:string"/>
					<bind nodeset="/data/h/r" type="xsd:string"/>${itext({
						en: `<text id="g"><value>Group</value></text>
							<text id="h"><value>One</value><value form="markdown">Two</value></text>
							<text id="q"><value>Q</value></text>`,
					})}`,
				body: `<group ref="/data/g"><label ref="jr:itext('g')"/>
						<input ref="/data/g/q"><label ref="jr:itext('q')"/></input></group>
					<group ref="/data/h"><label ref="jr:itext('h')"/>
						<input ref="/data/h/r"><label ref="jr:itext('q')"/></input></group>`,
			}),
		);
		expect(codes(reading)).toEqual([
			Q("markdown-form-differing-from-the-default-text"),
		]);
		expect(field(reading, "g").plainLabel).toBe(true);
		expect(field(reading, "h").plainLabel).toBeUndefined();
	});
});

describe("labels written inline and choices that show nothing", () => {
	it("reads a label written inline as shown as typed", async () => {
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: `<bind nodeset="/data/q" type="xsd:string"/>`,
				body: `<input ref="/data/q"><label>Hello</label></input>`,
			}),
		);
		expect(field(reading, "q").label).toEqual(proseText("Hello"));
		expect(field(reading, "q").plainLabel).toBe(true);
		expect(codes(reading)).toEqual([]);
		expect(unclaimedText(reading)).toEqual([]);
	});

	it("claims a label written inline and leaves an output inside it for the close", async () => {
		const reading = await readForm(
			xformSource({
				data: "<n/><q/>",
				model: `<bind nodeset="/data/n" type="xsd:string"/><bind nodeset="/data/q" type="xsd:string"/>`,
				body: `<input ref="/data/n"><label>Name</label></input>
					<input ref="/data/q"><label>Hi <output value="/data/n"/></label></input>`,
			}),
		);
		expect(unrecognizedAt(reading, "q")).toEqual(["xform:output"]);
		expect(field(reading, "q").plainLabel).toBe(true);
	});

	it("leaves a help text written inline for the close, and reads no help from it", async () => {
		const reading = await readForm(
			oneLabel(
				"q",
				{ en: `<text id="q"><value>Q</value></text>` },
				"<help>Ask twice</help>",
			),
		);
		expect(field(reading, "q").help).toBeUndefined();
		expect(
			unrecognizedAt(reading, "q").filter((name) => name.includes("help")),
		).toEqual(["xform:help"]);
	});

	it("refuses an item with no label, and a choice that shows nothing", async () => {
		const reading = await readForm(
			xformSource({
				data: "<q/><r/>",
				model: `<bind nodeset="/data/q" type="xsd:string"/><bind nodeset="/data/r" type="xsd:string"/>${itext(
					{
						en: `<text id="q"><value>Q</value></text>
							<text id="blank"><value/></text>`,
					},
				)}`,
				body: `<select1 ref="/data/q"><label ref="jr:itext('q')"/>
						<item><value>a</value></item></select1>
					<select1 ref="/data/r"><label ref="jr:itext('q')"/>
						<item><label ref="jr:itext('blank')"/><value>b</value></item></select1>`,
			}),
		);
		const missing = Q(
			"item-without-value-or-an-itemset-without-label-or-without-both",
		);
		expect(codes(reading)).toEqual([missing, missing]);
	});
});

describe("a validation message an alert holds", () => {
	/** A text question `q` validated as non-blank, its bind's message `message`, its alert `alert`. */
	function validated(options: {
		readonly constraint?: boolean;
		readonly message?: string;
		readonly alert: string;
	}) {
		const constraint =
			options.constraint === false ? "" : ` constraint=". != ''"`;
		const message =
			options.message === undefined
				? ""
				: ` jr:constraintMsg="${options.message}"`;
		return xformSource({
			data: "<q/>",
			model: `<bind nodeset="/data/q" type="xsd:string"${constraint}${message}/>${itext(
				{
					en: `<text id="q"><value>Q</value></text><text id="m"><value>Say something</value></text>`,
				},
			)}`,
			body: `<input ref="/data/q"><label ref="jr:itext('q')"/>${options.alert}</input>`,
		});
	}

	/** The `unrecognized` names of the question's alert: the stage under test claims nothing
	 *  else of the question's logic, which the expression stage claims. */
	function alertUnclaimed(reading: FormReading): string[] {
		return unrecognizedAt(reading, "q").filter((name) =>
			name.includes("alert"),
		);
	}

	it("reads an alert's itext reference as the message", async () => {
		const reading = await readForm(
			validated({ alert: `<alert ref="jr:itext('m')"/>` }),
		);
		expect(field(reading, "q").validate_msg).toEqual(
			proseText("Say something"),
		);
		expect(codes(reading)).toEqual([]);
		expect(alertUnclaimed(reading)).toEqual([]);
	});

	it("leaves an alert written inline for the close, and reads no message from it", async () => {
		const reading = await readForm(
			validated({ alert: "<alert>Not blank, please</alert>" }),
		);
		expect(field(reading, "q").validate_msg).toBeUndefined();
		expect(alertUnclaimed(reading)).toEqual(["xform:alert"]);
	});

	it("leaves an alert written inline for the close beside the bind's message", async () => {
		const reading = await readForm(
			validated({
				message: "jr:itext('m')",
				alert: "<alert>Not blank, please</alert>",
			}),
		);
		expect(alertUnclaimed(reading)).toEqual(["xform:alert"]);
	});

	it("refuses an alert's message on a bind with no condition", async () => {
		const reading = await readForm(
			validated({ constraint: false, alert: `<alert ref="jr:itext('m')"/>` }),
		);
		expect(codes(reading)).toEqual([
			Q("validation-message-without-a-validation-condition"),
		]);
		expect(field(reading, "q").validate_msg).toBeUndefined();
		expect(alertUnclaimed(reading)).toEqual([]);
	});
});

describe("texts read only by an expression", () => {
	it("refuses a text a repeat's count or an itemset reads through jr:itext, and drops one nothing reads", async () => {
		const reading = await readForm(
			xformSource({
				data: `<q/><r jr:template=""><b/></r>`,
				model: `<bind nodeset="/data/q" type="xsd:string"/><bind nodeset="/data/r/b" type="xsd:string"/>${itext(
					{
						en: `<text id="q"><value>Q</value></text>
							<text id="counted"><value>2</value></text>
							<text id="filtered"><value>x</value></text>
							<text id="orphan"><value>Nobody</value></text>`,
					},
				)}`,
				body: `<select1 ref="/data/q"><label ref="jr:itext('q')"/>
						<itemset nodeset="instance('t')/t/row[name = jr:itext('filtered')]"><label ref="name"/><value ref="id"/></itemset></select1>
					<group><label ref="jr:itext('q')"/><repeat nodeset="/data/r" jr:count="jr:itext('counted')">
						<input ref="/data/r/b"><label ref="jr:itext('q')"/></input></repeat></group>`,
			}),
		);
		const entries = [...reading.closed.claims.records()].map(
			(record) => record.entry,
		);
		const count = (entry: string) =>
			entries.filter((one) => one === entry).length;
		// The texts `counted` and `filtered`, each read only by an expression; `orphan`, by none.
		expect(
			count(Q("itext-entry-referenced-only-from-jr-itext-in-an-expression")),
		).toBe(2);
		expect(
			count(Q("itext-entry-referenced-by-no-question-and-no-expression-other")),
		).toBe(1);
	});
});

describe("pragma rows", () => {
	it("preserves two question labels sharing automatic submission and their translations", async () => {
		const id = "Pragma-Submit-Automatically";
		const source = xformSource({
			data: "<first/><second/>",
			model: `<bind nodeset="/data/first" type="xsd:string"/><bind nodeset="/data/second" type="xsd:string"/>${itext({ en: `<text id="${id}"><value>Visit</value></text>`, fr: `<text id="${id}"><value>Visite</value></text>` })}`,
			body: `<input ref="/data/first"><label ref="jr:itext('${id}')"/></input><input ref="/data/second"><label ref="jr:itext('${id}')"/></input>`,
		});
		const doc = documentOf(await readApp(source, ["en", "fr"]));
		const form = Object.values(doc.forms)[0];
		const [first, second] = doc.fieldOrder[form.uuid];
		expect(form.automaticSubmissionText).toEqual({
			carrier: { field: first, role: "field-label" },
			alsoUsedBy: [{ field: second, role: "field-label" }],
		});
		expect(formBehaviorTextIssue(doc, form.uuid)).toBeUndefined();
		// Nova's export writes the text once under the pragma id with both
		// labels reading it, so reading it back holds the same sharing.
		const again = documentOf(
			await readHqApp(await inputFor(exportedBody(doc))),
		);
		const back = Object.values(again.forms)[0];
		const [firstBack, secondBack] = again.fieldOrder[back.uuid];
		expect(back.automaticSubmissionText).toEqual({
			carrier: { field: firstBack, role: "field-label" },
			alsoUsedBy: [{ field: secondBack, role: "field-label" }],
		});
		const field = doc.fields[second];
		const changed = {
			...doc,
			fields: {
				...doc.fields,
				[second]: { ...field, label: proseText("Different label") },
			},
		};
		expect(formBehaviorTextIssue(changed, form.uuid)).toMatchObject({
			reason: "shared-text-differs",
		});
	});

	it("holds each Web Apps behavior on its own localized question through read, write and read-back", async () => {
		const bindings = Object.entries(behaviorWireIds);
		const ids = bindings.map((_, index) => `q${index}`);
		const xml = xformSource({
			data: ids.map((id) => `<${id}/>`).join(""),
			model:
				ids
					.map((id) => `<bind nodeset="/data/${id}" type="xsd:string"/>`)
					.join("") +
				itext({
					en: bindings
						.map(
							([role, id]) =>
								`<text id="${id}"><value>English ${role}</value></text>`,
						)
						.join(""),
					fr: bindings
						.map(
							([role, id]) =>
								`<text id="${id}"><value>Français ${role}</value></text>`,
						)
						.join(""),
				}),
			body: bindings
				.map(
					([, id], index) =>
						`<input ref="/data/${ids[index]}"><label ref="jr:itext('${id}')"/></input>`,
				)
				.join(""),
		});
		const first = documentOf(await readApp(xml, ["en", "fr"]));
		const second = documentOf(
			await readHqApp(await inputFor(exportedBody(first))),
		);
		for (const doc of [first, second]) {
			const form = Object.values(doc.forms)[0];
			expect(formBehaviorTextIssue(doc, form.uuid)).toBeUndefined();
			for (const [index, role] of formBehaviorRoles.entries())
				expect(form[role]).toEqual({
					carrier: {
						field: doc.fieldOrder[form.uuid][index],
						role: "field-label",
					},
				});
		}
	});
	it("reads a question text HQ's build merges into an earlier equal text as the question's own", async () => {
		const reading = await readForm(
			oneLabel("Pragma-Submit-Automatically", {
				en: `<text id="A-earlier"><value>Same</value></text>
					<text id="Pragma-Submit-Automatically"><value>Same</value></text>`,
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(
			[...reading.closed.claims.records()].map((record) => record.entry),
		).toContain(
			Q("a-question-text-whose-itext-id-is-a-pragma-key-hq-s-build-merges"),
		);
		expect(field(reading, "q").label).toEqual(proseText("Same"));
		expect(unclaimedText(reading)).toEqual([]);
	});

	it("holds suppression, accounts for a title without an active key and refuses the unreferenced key", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a/><b/>",
				model: `<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/>${itext(
					{
						en: `<text id="Pragma-Suppress-Autosync"><value>Sync</value></text>
							<text id="Pragma-Volatility-Entity-Title"><value>Title</value></text>
							<text id="Pragma-Volatility-Key"><value>key</value></text>`,
					},
				)}`,
				body: `<input ref="/data/a"><label ref="jr:itext('Pragma-Suppress-Autosync')"/></input>
					<input ref="/data/b"><label ref="jr:itext('Pragma-Volatility-Entity-Title')"/></input>`,
			}),
		);
		expect(codes(reading)).toEqual([
			Q("itext-pragma-entries-pragma-form-descriptor-pragma-skip-full"),
		]);
	});

	it("holds an activity key and the title beside it", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a/><b/>",
				model: `<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/>${itext(
					{
						en: `<text id="Pragma-Volatility-Key"><value>key</value></text>
							<text id="Pragma-Volatility-Entity-Title"><value>Title</value></text>`,
					},
				)}`,
				body: `<input ref="/data/a"><label ref="jr:itext('Pragma-Volatility-Key')"/></input>
					<input ref="/data/b"><label ref="jr:itext('Pragma-Volatility-Entity-Title')"/></input>`,
			}),
		);
		const activity = Q(
			"a-question-text-label-hint-help-validation-message-repeat-add",
		);
		expect(codes(reading)).toEqual([]);
		expect(
			[...reading.closed.claims.records()].filter(
				(record) => record.entry === activity,
			),
		).toHaveLength(2);
	});
});

/** A whole reading of an app of one form, in each of `langs`. */
async function readApp(
	source: string,
	langs: readonly string[],
): Promise<ReadOutcome> {
	const name = Object.fromEntries(langs.map((lang) => [lang, "Form"]));
	return readHqApp(
		await inputFor({
			...retainedSourceBody("shell/app-source"),
			langs,
			modules: [
				{
					doc_type: "Module",
					unique_id: "m-reader",
					name,
					case_type: "",
					forms: [{ doc_type: "Form", unique_id: "r1", xmlns: XMLNS, name }],
				},
			],
			_attachments: { "r1.xml": source },
		}),
	);
}

/** A form of a text question `n` and a text question `q` whose label is `label` in each language. */
function labelReading(label: Readonly<Record<string, string>>): string {
	return xformSource({
		data: "<n/><q/>",
		model: `<bind nodeset="/data/n" type="xsd:string"/><bind nodeset="/data/q" type="xsd:string"/>${itext(
			Object.fromEntries(
				Object.entries(label).map(([lang, value]) => [
					lang,
					`<text id="n"><value>Name</value></text><text id="q"><value>${value}</value></text>`,
				]),
			),
		)}`,
		body: `<input ref="/data/n"><label ref="jr:itext('n')"/></input>
			<input ref="/data/q"><label ref="jr:itext('q')"/></input>`,
	});
}

/** The read document, where the reading made one. */
function documentOf(outcome: ReadOutcome): BlueprintDoc {
	if (outcome.kind !== "read")
		throw new Error(
			`The reading made an account: ${JSON.stringify(
				outcome.findings.map((finding) => [finding.code, finding.detail]),
			)}`,
		);
	return outcome.draft.doc;
}

/** The translations of the label of question `q`, by language. */
function labelTranslations(doc: BlueprintDoc): Record<string, unknown> {
	const uuid = Object.values(doc.fields).find((one) => one.id === "q")?.uuid;
	const out: Record<string, unknown> = {};
	for (const [language, entries] of Object.entries(
		doc.localization?.translations ?? {},
	))
		for (const [unit, entry] of Object.entries(entries ?? {}))
			if (uuid !== undefined && unit.includes(uuid) && unit.includes("label"))
				out[language] = (entry as { value: unknown }).value;
	return out;
}

describe("translations, read whole", () => {
	it("writes a translation whose output takes its source twin's bound reference", async () => {
		const outcome = await readApp(
			labelReading({
				en: `Hi <output value="/data/n"/>!`,
				fr: `Salut <output value="/data/n"/> !`,
			}),
			["en", "fr"],
		);
		const doc = documentOf(outcome);
		if (outcome.kind === "read") expect(outcome.defects).toEqual([]);
		const q = Object.values(doc.fields).find((one) => one.id === "q") as {
			label: { parts: { kind: string }[] };
		};
		const sourceAtom = q.label.parts.find((part) => part.kind !== "text");
		expect(sourceAtom).toBeDefined();
		const translated = Object.values(labelTranslations(doc)) as {
			parts: { kind: string }[];
		}[];
		expect(translated).toHaveLength(1);
		expect(translated[0]?.parts.map((part) => part.kind)).toEqual([
			"text",
			sourceAtom?.kind,
			"text",
		]);
		expect(translated[0]?.parts.find((part) => part.kind !== "text")).toEqual(
			sourceAtom,
		);
	});

	it("reads a blank beside a source output as no translation, counted and with no finding", async () => {
		const outcome = await readApp(
			labelReading({ en: `Hi <output value="/data/n"/>`, fr: "" }),
			["en", "fr"],
		);
		const doc = documentOf(outcome);
		expect(labelTranslations(doc)).toEqual({});
		if (outcome.kind === "read")
			expect(
				outcome.draft.facts.forms.map((form) => form.blankTranslations),
			).toEqual([1]);
	});

	it.each([
		["Hi", 'Salut <output value="/data/n"/>', 1],
		['Hi <output value="/data/n"/>', "Salut", 0],
		[
			'Hi <output value="/data/n"/>',
			'Salut <output value="/data/n"/> et <output value="/data/n"/>',
			2,
		],
	])(
		"reads independently chosen outputs in the French label %s / %s",
		async (en, fr, count) => {
			const outcome = await readApp(
				labelReading({ en: String(en), fr: String(fr) }),
				["en", "fr"],
			);
			const doc = documentOf(outcome);
			if (outcome.kind === "read") expect(outcome.defects).toEqual([]);
			const translated = Object.values(
				doc.localization?.translations.fra ?? {},
			).find((entry) => entry.valueMode === "independent-values");
			expect(
				translated,
				JSON.stringify(doc.localization?.translations),
			).toBeDefined();
			const target = translated?.value;
			if (typeof target === "string" || target === undefined)
				throw new Error("Missing translated label");
			expect(
				target.parts.filter((part) => part.kind === "field-ref"),
			).toHaveLength(count as number);
		},
	);

	/** The French label's translation entry, where the reading made one. */
	const frenchLabel = (doc: BlueprintDoc) => {
		const uuid = Object.values(doc.fields).find((one) => one.id === "q")?.uuid;
		const entry = Object.entries(doc.localization?.translations.fra ?? {}).find(
			([unit]) =>
				uuid !== undefined && unit.includes(uuid) && unit.includes("label"),
		)?.[1];
		if (entry === undefined || typeof entry.value === "string")
			throw new Error(JSON.stringify(doc.localization?.translations));
		return { entry, parts: entry.value.parts };
	};

	it("reads an output one language alone writes as Nova writes literal text as that text, with no values of its own", async () => {
		// Nova writes the bracket after `instance` as an output (`builder.ts::literalLabelNodes`).
		const outcome = await readApp(
			labelReading({
				en: "Hi",
				fr: `Voir instance<output value="'('"/>'x')`,
			}),
			["en", "fr"],
		);
		const doc = documentOf(outcome);
		if (outcome.kind === "read") expect(outcome.defects).toEqual([]);
		const { entry, parts } = frenchLabel(doc);
		expect(entry).not.toHaveProperty("valueMode");
		expect(parts).toEqual([{ kind: "text", text: "Voir instance('x')" }]);
	});

	it("keeps an output one language alone holds that is only a literal as that literal value", async () => {
		const outcome = await readApp(
			labelReading({ en: "Hi", fr: `Salut<output value="'['"/>ami` }),
			["en", "fr"],
		);
		const doc = documentOf(outcome);
		if (outcome.kind === "read") expect(outcome.defects).toEqual([]);
		const { entry, parts } = frenchLabel(doc);
		expect(entry.valueMode).toBe("independent-values");
		expect(parts).toEqual([
			{ kind: "text", text: "Salut" },
			{
				kind: "value",
				expression: { kind: "term", term: { kind: "literal", value: "[" } },
			},
			{ kind: "text", text: "ami" },
		]);
	});

	it("keeps other findings beside an admitted hidden answer type", async () => {
		const outcome = await readApp(
			xformSource({
				data: "<x/><x/><h/>",
				model: `<bind nodeset="/data/h" type="xsd:dateTime" calculate="'x'"/>`,
			}),
			["en"],
		);
		expect(outcome.kind).toBe("account");
		if (outcome.kind !== "account") return;
		const codesOf = outcome.findings.map((finding) => finding.code);
		expect(codesOf).toContain(Q("two-sibling-data-nodes-with-one-name"));
		expect(codesOf).not.toContain(
			Q("hidden-value-bound-a-type-nova-would-not-write"),
		);
	});

	it("keeps an explicit date and time on a hidden answer that saves nowhere", async () => {
		const outcome = await readApp(
			xformSource({
				data: "<h/>",
				model: `<bind nodeset="/data/h" type="xsd:dateTime" calculate="'x'"/>`,
			}),
			["en"],
		);
		expect(outcome.kind).toBe("read");
		if (outcome.kind !== "read") throw new Error("Expected a readable form");
		expect(
			Object.values(outcome.draft.doc.fields).find((field) => field.id === "h"),
		).toMatchObject({
			kind: "hidden",
			answerType: "datetime",
		});
	});
});
