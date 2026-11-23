import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	makeTranslationUnitId,
	proseTemplateText,
	proseText,
} from "@/lib/domain";

/** Change the project language's wording and make it the first language workers see. */
export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const localization = effectiveAppLocalization(doc.localization);
	const language = "project:qaa";
	const landmark = Object.values(doc.fields).find(
		(field) => field.id === "landmark",
	);
	if (landmark === undefined || localization.wireCodes[language] !== "qaa")
		throw new Error(
			"The site visit must hold its landmark question and its project language.",
		);
	const unitId = makeTranslationUnitId("field", landmark.uuid, "label");
	const entry = localization.translations[language]?.[unitId];
	if (
		entry === undefined ||
		typeof entry.value === "string" ||
		proseTemplateText(entry.value) !== "Meeting place"
	)
		throw new Error(
			"The site visit's project wording must be present before editing it.",
		);
	return [
		{ kind: "moveLanguage", code: language, after: null },
		{
			kind: "setTranslation",
			language,
			unitId,
			entry: {
				...entry,
				value: proseText("Meeting point"),
				origin: "human",
				review: "reviewed",
			},
		},
	];
}
