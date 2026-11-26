import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	makeTranslationUnitId,
	proseText,
	type TranslationEntry,
	translationUnitsById,
} from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const id = "targeted-repeat-invitations";
const uuid = (name: string) => targetedUuid(id, name);

export function repeatInvitationsApp() {
	const form = uuid("form");
	const repeat = uuid("visit");
	const doc = buildDoc({
		appId: id,
		appName: "Visit notes",
		modules: [
			{
				uuid: uuid("menu"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Record visits",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("worker"),
								id: "worker",
								label: proseText("Worker name"),
							}),
							f({
								kind: "repeat",
								uuid: repeat,
								id: "visit",
								label: proseText("Visit"),
								repeat_mode: "user_controlled",
								addFirstLabel: proseText("Record the first visit"),
								addLabel: proseText("Record another visit"),
								children: [
									f({
										kind: "text",
										uuid: uuid("place"),
										id: "place",
										label: proseText("Place visited"),
									}),
								],
							}),
							f({
								kind: "text",
								uuid: uuid("summary"),
								id: "summary",
								label: proseText("Visit summary"),
							}),
						],
					},
				],
			},
		],
	});
	const units = translationUnitsById(doc);
	const spanish: Record<string, TranslationEntry> = {};
	for (const [slot, text] of [
		["addFirstLabel", "Registrar la primera visita"],
		["addLabel", "Registrar otra visita"],
	] as const) {
		const key = makeTranslationUnitId("field", repeat, slot);
		const unit = units.get(key);
		if (!unit) throw new Error(`Missing repeat invitation ${key}`);
		spanish[key] = {
			value: proseText(text),
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: { spa: spanish },
	};
	return doc;
}

export function repeatInvitations() {
	const form = uuid("form");
	const doc = repeatInvitationsApp();
	return targetedDocument({
		id,
		doc,
		rows: ["First and subsequent repeat invitations in the worker's language"],
		expected: {
			intent: [answerHeld("visit-summary", form, "/data/summary", "Visited")],
		},
	});
}
