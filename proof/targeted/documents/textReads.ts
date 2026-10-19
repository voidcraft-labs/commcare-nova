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
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { term } from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";

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
					answers: [{ path: "/data/color", value: "blue" }],
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
