/**
 * A question label's other texts, read from CommCare HQ's source and written back.
 *
 * Contract: a label's `long`, `qrcode` and `tts` forms read into the question's extended text,
 * QR code and spoken text (`lib/domain/labelForms.ts`), each with its own translation, a
 * reference in one bound at the question; Nova's own export of such a document reads back to the
 * same document. A form the form's default language lacks is refused (Core's
 * `Localizer.getLocaleData` raises `NoLocalizedTextException` for it as that language loads); a
 * blank in the default language beside another language's text is refused, as a label's is; a
 * blank everywhere is held blank. A `long` form on any other text (a group's label, a hint, a
 * choice) is refused as not yet held, since both runtimes show it in place of that text
 * (`FormEntryPrompt.getSelectItemText`, `FormEntryCaption.getQuestionText`), and a QR code or
 * spoken text on one, which no runtime reads, is dropped.
 *
 * Plausible failures: a form read only in the source language, or not read; a translation lost
 * or read as the source; a reference read as text; a form only another language holds read
 * as held; a blank form dropped; a `long` form on another text dropped, so the next publish
 * loses the text workers see; a QR code on another text refused.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	type ProseTemplate,
	proseText,
	translationSourceFingerprint,
	type Uuid,
} from "@/lib/domain";
import { runValidation } from "../../../validator/runner";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

const NAME = testUuid("label-texts-reader-name");
const CARD = testUuid("label-texts-reader-card");

function withName(text: string): ProseTemplate {
	return {
		parts: [
			{ kind: "text", text },
			{ kind: "field-ref", uuid: NAME },
		],
	};
}

function translation(source: ProseTemplate, value: ProseTemplate) {
	return {
		value,
		sourceFingerprint: translationSourceFingerprint("prose", source),
		origin: "human" as const,
		review: "reviewed" as const,
		translatedFrom: "eng",
	};
}

function labelTexts(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Label texts",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
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
								spoken_text: proseText(""),
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
		translations: {
			spa: {
				[makeTranslationUnitId("field", CARD, "extended_text")]: translation(
					withName("Show the card to "),
					withName("Muestre la tarjeta a "),
				),
			},
		},
	};
	return doc;
}

function fieldById(doc: BlueprintDoc, id: string): Record<string, unknown> {
	const found = Object.values(doc.fields).find((one) => one.id === id);
	if (found === undefined) throw new Error(`No field ${id}.`);
	return found as unknown as Record<string, unknown>;
}

async function read(doc: BlueprintDoc, xml?: (xml: string) => string) {
	return readHqApp(await inputFor(exportedBody(doc, { xml })));
}

describe("a question label's other texts", () => {
	it("read back from Nova's own export as written", async () => {
		const doc = labelTexts();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const outcome = await read(doc);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const card = fieldById(outcome.draft.doc, "card");
		const name = fieldById(outcome.draft.doc, "name");
		const nameRef = { kind: "field-ref", uuid: name.uuid };
		expect(card.extended_text).toEqual({
			parts: [{ kind: "text", text: "Show the card to " }, nameRef],
		});
		expect(card.qr_code).toEqual({
			parts: [{ kind: "text", text: "ID-" }, nameRef],
		});
		expect(card.spoken_text).toEqual({ parts: [] });
		const spanish =
			outcome.draft.doc.localization?.translations.spa?.[
				makeTranslationUnitId("field", card.uuid as Uuid, "extended_text")
			];
		expect(spanish?.value).toEqual({
			parts: [{ kind: "text", text: "Muestre la tarjeta a " }, nameRef],
		});
		expect(
			outcome.draft.doc.localization?.translations.spa?.[
				makeTranslationUnitId("field", card.uuid as Uuid, "qr_code")
			],
		).toBeUndefined();
	});

	it("refuses a form the form's default language lacks", async () => {
		// The English translation comes first: drop its QR code alone.
		const outcome = await read(labelTexts(), (xml) =>
			xml.replace(/<value form="qrcode">[\s\S]*?<\/value>/u, ""),
		);
		expect(outcome.kind).toBe("account");
		const findings = outcome.kind === "account" ? outcome.findings : [];
		expect(
			findings.some((finding) =>
				JSON.stringify(finding).includes(
					"long-qrcode-or-tts-form-missing-in-default-language",
				),
			),
		).toBe(true);
	});

	it("refuses a long form on a hint or a choice as not yet held, and drops a QR code there", async () => {
		const doc = buildDoc({
			appName: "Other texts",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "answer",
									label: proseText("Answer"),
									hint: proseText("A hint"),
								}),
								f({
									kind: "single_select",
									id: "seen",
									label: proseText("Seen"),
									options: [
										{ value: "yes", label: proseText("Yes") },
										{ value: "no", label: proseText("No") },
									],
								}),
							],
						},
					],
				},
			],
		});
		const notYetHeld = (outcome: Awaited<ReturnType<typeof read>>) =>
			JSON.stringify(outcome.kind === "account" ? outcome.findings : []);
		const hinted = await read(doc, (xml) =>
			xml.replace(
				/(<text id="answer-hint">\s*<value>A hint<\/value>)/u,
				'$1<value form="long">Longer</value>',
			),
		);
		expect(hinted.kind).toBe("account");
		expect(notYetHeld(hinted)).toContain(
			"long-form-on-a-hint-help-text-validation-message-or-choice",
		);
		const chosen = await read(doc, (xml) =>
			xml.replace(
				/(<value>Yes<\/value>)/u,
				'$1<value form="long">Yes, the child was seen today</value>',
			),
		);
		expect(chosen.kind).toBe("account");
		expect(notYetHeld(chosen)).toContain(
			"long-form-on-a-hint-help-text-validation-message-or-choice",
		);

		const coded = await read(doc, (xml) =>
			xml.replace(
				/(<text id="answer-hint">\s*<value>A hint<\/value>)/u,
				'$1<value form="qrcode">A code</value><value form="tts">Say it</value>',
			),
		);
		expect(coded.defects).toEqual([]);
		expect(coded.kind === "account" ? coded.findings : []).toEqual([]);
		if (coded.kind !== "read") throw new Error("The QR code was not dropped.");
		expect(fieldById(coded.draft.doc, "answer").qr_code).toBeUndefined();
	});

	it("refuses a group's long form as not yet held", async () => {
		const grouped = buildDoc({
			appName: "Group text",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "household",
									label: proseText("Household"),
									children: [
										f({ kind: "text", id: "head", label: proseText("Head") }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const headed = await read(grouped, (xml) =>
			xml.replace(
				/(<text id="household-label">\s*<value>Household<\/value>)/u,
				'$1<value form="long">The household</value>',
			),
		);
		expect(headed.kind).toBe("account");
		expect(
			JSON.stringify(headed.kind === "account" ? headed.findings : []),
		).toContain("long-form-on-a-group-or-repeat-label");
	});
});
