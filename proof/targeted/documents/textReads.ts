/**
 * A form reading its own translated text (`targeted-text-reads`).
 *
 * "Paint order", in English and French, asks for a colour from written
 * choices and reads, in hidden values, the question's label through
 * `jr:itext`, one choice's label through `jr:itext`, and the chosen choice's
 * label through `jr:choice-name`. Core reads each in the form's current
 * language (`FormDef.java::initEvalContext`: `Localizer.getText` for an itext
 * id, and the matching static choice's text for `choice-name`).
 *
 * Fixed values: with Blue chosen, the form reads Colour, Blue and Blue in
 * English, and Couleur, Bleu and Bleu in French.
 *
 * Labels shown as written (`targeted-plain-labels`): a form whose question,
 * group and choice labels hold `*not bold*`, `# 5`, `1. first` and
 * `<b>tag</b>` twice, once with `plainLabel`, which Nova writes with no
 * markdown form, and once without, which Nova writes with one. A device
 * draws a label's markdown only where its text holds that form
 * (commcare-android `QuestionWidget.java::setTextFromPrompt` and
 * `setChoiceText`), so the plain half shows each text as typed and the other
 * half formatted (`proof/android/test_form_reads.py::test_a_label_without_markdown_renders_its_text_as_written`).
 * HQ's form builder writes a markdown form back only where it read one
 * (Vellum `src/javaRosa/plugin.js`, `item.hasMarkdown`), so proof 4 holds
 * both halves as Nova wrote them.
 *
 * Fixed values: the first plain group's question holds what the worker
 * answers.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	NEW_APP_SETTINGS,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { term } from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { answerHeld } from "./echo";

const ID = "targeted-text-reads";
const uuid = (name: string) => targetedUuid(ID, name);

function entriesFor(
	doc: BlueprintDoc,
	texts: ReadonlyMap<TranslationUnitId, ReturnType<typeof proseText>>,
): Record<TranslationUnitId, TranslationEntry> {
	const units = translationUnitsById(doc);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of texts) {
		const unit = units.get(unitId);
		if (unit === undefined)
			throw new Error(
				`${ID} names the translation unit ${unitId}, which it does not hold.`,
			);
		entries[unitId] = {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	return entries;
}

export function textReads() {
	const form = uuid("form");
	const color = uuid("color");
	const red = uuid("red");
	const blue = uuid("blue");
	const hidden = (
		id: string,
		calculate: Parameters<typeof f>[0]["calculate"],
	) => f({ kind: "hidden", uuid: uuid(id), id, calculate });
	const doc = buildDoc({
		appId: ID,
		appName: "Paint orders",
		modules: [
			{
				uuid: uuid("module"),
				name: "Orders",
				forms: [
					{
						uuid: form,
						name: "Paint order",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								uuid: color,
								id: "color",
								label: proseText("Colour"),
								optionsSource: {
									kind: "inline",
									options: [
										{ uuid: red, value: "red", label: proseText("Red") },
										{ uuid: blue, value: "blue", label: proseText("Blue") },
									],
								},
							}),
							hidden("color_text", {
								kind: "itext",
								unit: { field: color, role: "field-label" },
							}),
							hidden("blue_text", {
								kind: "itext",
								unit: {
									field: color,
									role: "select-option-label",
									option: blue,
								},
							}),
							hidden("color_label", {
								kind: "choice-name",
								field: color,
								value: term({ kind: "field", uuid: color }),
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
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: {
			fra: entriesFor(
				doc,
				new Map([
					[
						makeTranslationUnitId("field", color, "label"),
						proseText("Couleur"),
					],
					[
						makeTranslationUnitId("field", color, "option", red),
						proseText("Rouge"),
					],
					[
						makeTranslationUnitId("field", color, "option", blue),
						proseText("Bleu"),
					],
				]),
			),
		},
	};
	const intent: Expectation[] = (["local", "A"] as const).flatMap(
		(exportName) =>
			(
				[
					["en", "Colour", "Blue"],
					["fr", "Couleur", "Bleu"],
				] as const
			).map(([locale, label, choice]) => ({
				id: `text-${locale}-${exportName}`,
				export: exportName,
				form,
				request: {
					locale,
					/* Web Apps answers a select with the chosen option's place
					 * in its list, counted from one: Blue is the second. */
					answers: [{ path: "/data/color", value: "2" }],
					expressions: [
						"/data/color_text",
						"/data/blue_text",
						"/data/color_label",
					],
				},
				expect: [
					{ pointer: "/answers/0/result", value: "ok" },
					{ pointer: "/values/0/value", value: label },
					{ pointer: "/values/1/value", value: choice },
					{ pointer: "/values/2/value", value: choice },
				],
			})),
	);
	return targetedDocument({
		id: ID,
		rows: ["itext-read", "choice-name-read"],
		doc,
		expected: { intent },
	});
}

/** The texts a markdown form would format, each written twice. */
export const PLAIN_LABEL_TEXTS = [
	"*not bold*",
	"# 5",
	"1. first",
	"<b>tag</b>",
] as const;

export function plainLabels() {
	const id = "targeted-plain-labels";
	const named = (name: string) => targetedUuid(id, name);
	const form = named("form");
	/* One half of the form: each text as a question's label, a choice's label
	 * and a group's label, each group holding one question. */
	const half = (prefix: "plain" | "marked") => {
		const flag = prefix === "plain" ? ({ plainLabel: true } as const) : {};
		return [
			...PLAIN_LABEL_TEXTS.map((text, index) =>
				f({
					kind: "label",
					uuid: named(`${prefix}-label-${index}`),
					id: `${prefix}_label_${index}`,
					label: proseText(text),
					...flag,
				}),
			),
			f({
				kind: "single_select",
				uuid: named(`${prefix}-choices`),
				id: `${prefix}_choices`,
				label: proseText(
					prefix === "plain" ? "Choices as written" : "Choices in markdown",
				),
				optionsSource: {
					kind: "inline",
					options: PLAIN_LABEL_TEXTS.map((text, index) => ({
						uuid: named(`${prefix}-choice-${index}`),
						value: `choice_${index}`,
						label: proseText(text),
						...flag,
					})),
				},
			}),
			...PLAIN_LABEL_TEXTS.map((text, index) =>
				f({
					kind: "group",
					uuid: named(`${prefix}-group-${index}`),
					id: `${prefix}_group_${index}`,
					label: proseText(text),
					fieldList: true,
					...flag,
					children: [
						f({
							kind: "text",
							uuid: named(`${prefix}-note-${index}`),
							id: `${prefix}_note_${index}`,
							label: proseText("Note"),
						}),
					],
				}),
			),
		];
	};
	const doc = buildDoc({
		appId: id,
		appName: "Labels as written",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				uuid: named("module"),
				name: "Labels",
				forms: [
					{
						uuid: form,
						name: "Labels",
						type: "survey",
						fields: [...half("plain"), ...half("marked")],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["labels shown as written: plainLabel writes no markdown form"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"note-held",
					form,
					"/data/plain_group_0/plain_note_0",
					"seen",
				),
				answerHeld(
					"note-held-a",
					form,
					"/data/plain_group_0/plain_note_0",
					"seen",
					"A",
				),
			],
		},
	});
}
