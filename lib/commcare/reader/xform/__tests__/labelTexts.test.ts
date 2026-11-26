/**
 * A question label's other texts, read from CommCare HQ's source and written back.
 *
 * Contract: a label's `long`, `qrcode` and `tts` forms read into the question's extended text,
 * QR code and spoken text (`lib/domain/labelForms.ts`), each with its own translation, a
 * reference in one bound at the question; Nova's own export of such a document reads back to the
 * same document. A form the form's default language lacks is refused (Core's
 * `Localizer.getLocaleData` raises `NoLocalizedTextException` for it as that language loads); a
 * blank in the default language beside another language's text is refused, as a label's is; a
 * blank everywhere is held blank. Group labels, hints, help and validation messages and
 * choice labels keep their own extended prose. Only a question label holds QR and spoken text.
 *
 * Plausible failures: a form read only in the source language, or not read; a translation lost
 * or read as the source; a reference read as text; a form only another language holds read
 * as held; a blank form dropped; a `long` form on another text dropped, so the next publish
 * loses the text workers see; a QR code on another text refused.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	f,
	parseFixtureExpression,
} from "@/lib/__tests__/docHelpers";
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

	it("reads a blank label beside its extended text as shown as typed, so its export adds no markdown form", async () => {
		// Android shows a present markdown form in place of the extended text, a blank one too
		// (`QuestionWidget.setTextFromPrompt`): a blank label holding a `long` form and no
		// `markdown` form must come back without one.
		const doc = buildDoc({
			appName: "Blank label",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "label",
									id: "card",
									uuid: CARD,
									label: proseText(""),
									plainLabel: true,
									extended_text: proseText("Foo"),
								}),
							],
						},
					],
				},
			],
		});
		const cardEntry = (xml: string) =>
			/<text id="card-label">[\s\S]*?<\/text>/u.exec(xml)?.[0] ?? "";
		const exported = Object.values(
			exportedBody(doc)._attachments as Record<string, string>,
		).join("");
		expect(cardEntry(exported)).toContain('<value form="long">Foo</value>');
		expect(cardEntry(exported)).not.toContain('form="markdown"');

		const outcome = await read(doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const card = fieldById(outcome.draft.doc, "card");
		expect(card.plainLabel).toBe(true);
		const again = Object.values(
			exportedBody(outcome.draft.doc)._attachments as Record<string, string>,
		).join("");
		expect(cardEntry(again)).toContain('<value form="long">Foo</value>');
		expect(cardEntry(again)).not.toContain('form="markdown"');
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

	it("keeps extended hint, help and choice text from the same form without claiming a hint QR code", async () => {
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
									help: proseText("Some help"),
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
		const result = await read(doc, (xml) =>
			xml
				.replace(
					/(<value>A hint<\/value>)/u,
					'$1<value form="long">Longer hint</value><value form="qrcode">An inert code</value>',
				)
				.replace(
					/(<value>Some help<\/value>)/u,
					'$1<value form="long">Extended help</value>',
				)
				.replace(
					/(<value>Yes<\/value>)/u,
					'$1<value form="long">Yes, the child was seen today</value>',
				),
		);
		expect(result.defects).toEqual([]);
		if (result.kind !== "read")
			throw new Error(JSON.stringify(result.findings));
		const { doc: imported } = result.draft;
		const answer = fieldById(imported, "answer");
		expect(answer).toMatchObject({
			hint: proseText("A hint"),
			extended_hint: proseText("Longer hint"),
			help: proseText("Some help"),
			extended_help: proseText("Extended help"),
		});
		expect(answer.qr_code).toBeUndefined();
		expect(fieldById(imported, "seen").optionsSource).toMatchObject({
			options: [
				{
					value: "yes",
					label: proseText("Yes"),
					extended_text: proseText("Yes, the child was seen today"),
				},
				{ value: "no", label: proseText("No") },
			],
		});
		const reexported = await read(imported);
		expect(reexported.defects).toEqual([]);
		if (reexported.kind !== "read")
			throw new Error(JSON.stringify(reexported.findings));
		expect(fieldById(reexported.draft.doc, "answer")).toMatchObject({
			extended_hint: proseText("Longer hint"),
			extended_help: proseText("Extended help"),
		});
		expect(fieldById(reexported.draft.doc, "seen").optionsSource).toMatchObject(
			{
				options: [
					{ extended_text: proseText("Yes, the child was seen today") },
					{ value: "no" },
				],
			},
		);
	});

	it("round trips a protected validation message and its translated extended reference", async () => {
		const original = labelTexts();
		const answer = original.fields[NAME];
		if (answer?.kind !== "text") throw new Error("Expected a text question.");
		original.fields[NAME] = {
			...answer,
			validate: parseFixtureExpression(
				original,
				{ entity: "field", uuid: NAME, slot: "validate" },
				". != 'x'",
			),
			validate_msg: proseText("Check the name"),
			extended_validate_msg: withName("Please check "),
		};
		const locale = original.localization?.translations.spa;
		if (locale === undefined)
			throw new Error("Expected a Spanish translation.");
		locale[makeTranslationUnitId("field", NAME, "extended_validate_msg")] =
			translation(withName("Please check "), withName("Compruebe "));
		expect(runValidation(original, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const written = Object.values(
			exportedBody(original)._attachments as Record<string, string>,
		).join("");
		expect(written).toContain('form="long">Please check');
		expect(written).toContain("constraint=");
		const result = await read(original);
		expect(result.defects).toEqual([]);
		if (result.kind !== "read")
			throw new Error(JSON.stringify(result.findings));
		const answerRead = fieldById(result.draft.doc, "name");
		const uuid = answerRead.uuid as Uuid;
		expect(answerRead).toMatchObject({
			validate_msg: proseText("Check the name"),
			extended_validate_msg: {
				parts: [
					{ kind: "text", text: "Please check " },
					{ kind: "field-ref", uuid },
				],
			},
		});
		expect(
			result.draft.doc.localization?.translations.spa?.[
				makeTranslationUnitId("field", uuid, "extended_validate_msg")
			]?.value,
		).toMatchObject({
			parts: [
				{ kind: "text", text: "Compruebe " },
				{ kind: "field-ref", uuid },
			],
		});
	});

	it("keeps an empty Android help affordance out of the unshown-video cleanup", async () => {
		const original = labelTexts();
		const question = original.fields[NAME];
		if (question?.kind !== "text") throw new Error("Expected a text question.");
		original.fields[NAME] = { ...question, help: proseText("Ordinary help") };
		const insertVideo = (xml: string, defaultText: string) =>
			xml.replaceAll(
				'<value>Ordinary help</value><value form="markdown">Ordinary help</value>',
				`<value>${defaultText}</value><value form="video-inline">jr://file/commcare/explanation.mp4</value>`,
			);
		const held = await read(original, (xml) => insertVideo(xml, ""));
		expect(held.kind).toBe("account");
		if (held.kind !== "account")
			throw new Error("Expected a help affordance finding.");
		expect(JSON.stringify(held.findings)).toContain(
			"video-inline-as-the-only-content-of-a-help-text",
		);
		const ordinary = await read(original, (xml) =>
			insertVideo(xml, "Ordinary help"),
		);
		expect(
			JSON.stringify(ordinary.kind === "account" ? ordinary.findings : []),
		).not.toContain("video-inline-as-the-only-content-of-a-help-text");
	});

	it("keeps a group's default and long forms as separately editable text", async () => {
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
		expect(headed.defects).toEqual([]);
		if (headed.kind !== "read")
			throw new Error(JSON.stringify(headed.findings));
		expect(fieldById(headed.draft.doc, "household")).toMatchObject({
			label: proseText("Household"),
			extended_text: proseText("The household"),
		});
	});
});
