import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	makeTranslationUnitId,
	NEW_APP_SETTINGS,
	proseText,
	translationUnitsById,
} from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function savedFormDescriptor() {
	const id = "targeted-saved-form-descriptor";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("visit");
	const record = uuid("record");
	const carrier = uuid("descriptor");
	const answer = { kind: "field-ref" as const, uuid: record };
	const doc = buildDoc({
		appId: id,
		appName: "Visit archive",
		appSettings: {
			...NEW_APP_SETTINGS,
			showIncompleteForms: true,
			showSavedForms: true,
		},
		modules: [
			{
				uuid: uuid("visits"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: record,
								id: "record",
								kind: "text",
								label: proseText("Record"),
								default_value: "'Open'",
							}),
							f({
								uuid: carrier,
								id: "descriptor",
								kind: "label",
								label: { parts: [{ kind: "text", text: "Visit " }, answer] },
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[form].savedFormDescriptorText = {
		carrier: { role: "field-label", field: carrier },
	};
	const label = makeTranslationUnitId("field", carrier, "label");
	const source = translationUnitsById(doc).get(label);
	if (source === undefined) throw new Error("The saved form label is missing.");
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: {
			fra: {
				[label]: {
					value: { parts: [{ kind: "text", text: "Visite " }, answer] },
					sourceFingerprint: source.sourceFingerprint,
					translatedFrom: "eng",
					origin: "human",
					review: "reviewed",
				},
			},
		},
	};
	return targetedDocument({
		id,
		rows: [
			"A saved incomplete form carries a translated descriptor rendered with its answer and keeps the answer when reopened.",
		],
		doc,
		expected: {
			intent: [
				answerHeld(
					"record-opens-with-its-starting-value",
					form,
					"/data/record",
					"Open",
				),
			],
		},
	});
}
