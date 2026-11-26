/**
 * A label's other texts on the wire (`lib/domain/labelForms.ts`).
 *
 * Contract: a question's extended text, QR code and spoken text are written
 * as the `long`, `qrcode` and `tts` forms of the label's own itext entry, in
 * every language, each language's translation where it has one and the
 * source's where it has none (Core lays the default locale's keys under every
 * locale, `Localizer.getLocaleData`, so a form only one language held would
 * break the others; CommCare HQ's form builder fills each from the default,
 * `ItextForm.getValueOrDefault`). A reference in one is printed as an
 * `<output>` at the question. A blank form is written blank, since Core reads
 * a present form as it stands (a blank `long` is a blank caption). A label
 * blank in every language still writes its entry for its other texts, and
 * the body points at it.
 *
 * Plausible failures: a form written only in the source language; a
 * translation ignored; a reference printed as text; a blank form dropped
 * (the runtime then reads the label in its place); the entry, or its body
 * reference, dropped for a blank label. Every emitted form
 * passes the XForm oracle and is read back through `parseXml`.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	type ProseTemplate,
	proseText,
	translationSourceFingerprint,
	type Uuid,
} from "@/lib/domain";
import { validateXForm } from "../../validator/xformOracle";
import { parseXml } from "../../xmlParse";
import { buildXForm } from "../builder";

const FORM = testUuid("label-text-forms-form");
const NAME = testUuid("label-text-forms-name");
const CARD = testUuid("label-text-forms-card");
const BLANK = testUuid("label-text-forms-blank");

function withName(text: string): ProseTemplate {
	return {
		parts: [
			{ kind: "text", text },
			{ kind: "field-ref", uuid: NAME },
		],
	};
}

function labelTextDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Label texts",
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
								kind: "text",
								id: "name",
								uuid: NAME,
								label: proseText("Name"),
							}),
							f({
								kind: "label",
								id: "card",
								uuid: CARD,
								label: proseText("Show the card"),
								plainLabel: true,
								extended_text: withName("Show the card to "),
								qr_code: withName("ID-"),
								spoken_text: proseText("Show the card"),
							}),
							f({
								kind: "text",
								id: "blank",
								uuid: BLANK,
								label: proseText(""),
								extended_text: proseText(""),
								qr_code: proseText("CODE"),
							}),
						],
					},
				],
			},
		],
	});
	const spanish = (
		uuid: Uuid,
		slot: string,
		source: ProseTemplate,
		value: ProseTemplate,
	) => ({
		[makeTranslationUnitId("field", uuid, slot)]: {
			value,
			sourceFingerprint: translationSourceFingerprint("prose", source),
			origin: "human" as const,
			review: "reviewed" as const,
			translatedFrom: "eng",
		},
	});
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: {
			spa: {
				...spanish(
					CARD,
					"extended_text",
					withName("Show the card to "),
					withName("Muestre la tarjeta a "),
				),
				...spanish(
					CARD,
					"spoken_text",
					proseText("Show the card"),
					proseText("Muestre la tarjeta"),
				),
			},
		},
	};
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

function textEntry(all: Element[], lang: string, id: string): Element {
	const translation = all.find(
		(node) => node.name === "translation" && node.attribs.lang === lang,
	);
	if (translation === undefined) throw new Error(`No ${lang} translation.`);
	const text = elements(translation).find(
		(node) => node.name === "text" && node.attribs.id === id,
	);
	if (text === undefined) throw new Error(`No ${lang} text ${id}.`);
	return text;
}

/** Each `<value>` of a text entry, as `form: content`, an output as `{value}`. */
function values(text: Element): string[] {
	return text.children.filter(isTag).map((value) => {
		const content = value.children
			.map((child) =>
				isTag(child)
					? `{${child.attribs.value}}`
					: "data" in child
						? String(child.data)
						: "",
			)
			.join("");
		return `${value.attribs.form ?? "default"}: ${content}`;
	});
}

describe("a label's other texts", () => {
	const xml = buildXForm(labelTextDoc(), FORM, {
		xmlns: "urn:label-text-forms",
	});
	const all = parseXml(xml).children.filter(isTag).flatMap(elements);

	it("passes the XForm oracle", () => {
		expect(validateXForm(xml, "Intake", "Survey")).toEqual([]);
	});

	it("writes each as a form of the label's entry in every language, translated where it is", () => {
		expect(values(textEntry(all, "en", "card-label"))).toEqual([
			"default: Show the card",
			"long: Show the card to {/data/name}",
			"qrcode: ID-{/data/name}",
			"tts: Show the card",
		]);
		expect(values(textEntry(all, "es", "card-label"))).toEqual([
			"default: Show the card",
			"long: Muestre la tarjeta a {/data/name}",
			"qrcode: ID-{/data/name}",
			"tts: Muestre la tarjeta",
		]);
	});

	it("writes a blank form blank, and keeps a blank label's entry for its other texts", () => {
		for (const lang of ["en", "es"])
			expect(values(textEntry(all, lang, "blank-label"))).toEqual([
				"default: ",
				"markdown: ",
				"long: ",
				"qrcode: CODE",
			]);
		const control = all.find(
			(node) => node.name === "input" && node.attribs.ref === "/data/blank",
		);
		const label = control?.children
			.filter(isTag)
			.find((child) => child.name === "label");
		expect(label?.attribs.ref).toBe("jr:itext('blank-label')");
	});
});
