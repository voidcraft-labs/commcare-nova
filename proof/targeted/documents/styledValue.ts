/**
 * A value that holds formatting, shown in a label (`targeted-styled-value`).
 *
 * The survey menu "Styles" holds the form "Styled label", which asks one
 * text question, `seen`, labelled `Styled ` then the value of the Hidden
 * Value `styled`, calculated as `'**x**'`: an
 * `<output>` in the label's text and in its markdown form
 * (`lib/commcare/xform/builder.ts::buildLabelNodes`). Core splices each
 * output's text into the label as written
 * (`FormEntryCaption.getSpecialFormQuestionText`, `FormDef.fillTemplateString`),
 * and a runtime formats the label after that: so the text Core gives is
 * `Styled **x**`, a device draws `Styled x` with `x` in bold
 * (`proof/android/test_form_reads.py`), and Web Apps is handed
 * `Styled **x**` as the question's `caption_markdown`, which its client
 * renders with `x` in bold (`proof/webapps/test_label_values.py`). Preview
 * plays the same order (`lib/preview/engine/labelRefs.ts`): the value
 * substituted, then the label formatted.
 *
 * The document declares both platforms, as a new app does.
 *
 * Fixed values: the answer the worker gives `seen` is the value the form
 * holds there, and the label Core shows is the label above.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	makeTranslationUnitId,
	NEW_APP_SETTINGS,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";

const ID = "targeted-styled-value";
const uuid = (name: string) => targetedUuid(ID, name);

/** The Hidden Value's text, which holds formatting. */
export const STYLED_VALUE = "**x**";
/** The label's text before the value. */
export const STYLED_LABEL_LEAD = "Styled ";

/** Core's reading of the label on `exportName`: the value spliced in as written, and the answer held. */
function labelShown(
	id: string,
	form: Uuid,
	exportName: Expectation["export"],
	locale: "en" | "fr" = "en",
): Expectation {
	return {
		id,
		export: exportName,
		form,
		request: {
			locale,
			answers: [{ path: "/data/seen", value: "yes" }],
			expressions: ["/data/seen", "/data/styled"],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{
				pointer: "/answers/0/label",
				value:
					locale === "en"
						? `${STYLED_LABEL_LEAD}${STYLED_VALUE}`
						: "Zone nord, secteur nord",
			},
			{ pointer: "/values/0/value", value: "yes" },
			{ pointer: "/values/1/value", value: STYLED_VALUE },
		],
	};
}

export function styledValue() {
	const form = uuid("form");
	const styled = uuid("styled");
	const doc = buildDoc({
		appId: ID,
		appName: "Styled values",
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				uuid: uuid("module"),
				name: "Styles",
				forms: [
					{
						uuid: form,
						name: "Styled label",
						type: "survey",
						fields: [
							f({
								kind: "hidden",
								uuid: styled,
								id: "styled",
								calculate: `'${STYLED_VALUE}'`,
							}),
							f({
								kind: "hidden",
								uuid: uuid("area"),
								id: "area",
								calculate: "'nord'",
							}),
							f({
								kind: "text",
								uuid: uuid("seen"),
								id: "seen",
								label: {
									parts: [
										{ kind: "text", text: STYLED_LABEL_LEAD },
										{ kind: "field-ref", uuid: styled },
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	const labelId = makeTranslationUnitId("field", uuid("seen"), "label");
	const source = translationUnitsById(doc).get(labelId);
	if (source === undefined)
		throw new Error("Styled label has no translation unit.");
	const area = { kind: "field-ref" as const, uuid: uuid("area") };
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: {
			fra: {
				[labelId]: {
					value: {
						parts: [
							{ kind: "text", text: "Zone " },
							area,
							{ kind: "text", text: ", secteur " },
							area,
						],
					},
					valueMode: "independent-values",
					sourceFingerprint: source.sourceFingerprint,
					translatedFrom: "eng",
					origin: "human",
					review: "reviewed",
				},
			},
		},
	};
	return targetedDocument({
		id: ID,
		rows: [
			"a label whose value holds formatting: the value substituted, then the label formatted",
		],
		doc,
		expected: {
			intent: [
				labelShown("styled-label-local", form, "local"),
				labelShown("styled-label-a", form, "A"),
				labelShown("french-label-local", form, "local", "fr"),
				labelShown("french-label-a", form, "A", "fr"),
			],
		},
	});
}
