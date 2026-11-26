import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, effectiveAppLocalization } from "@/lib/domain";

/** Put English after Hindi. The runtime starts in French. English remains
 * the source of the saved original text in the translated visit form. */
export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const { languageOrder, wireCodes } = effectiveAppLocalization(
		doc.localization,
	);
	const first = languageOrder.find((language) => wireCodes[language] === "en");
	const preceding = languageOrder.find(
		(language) => wireCodes[language] === "hin",
	);
	if (first === undefined || preceding === undefined)
		throw new Error(
			"The village visit fixture must hold both English and Hindi.",
		);
	return [{ kind: "moveLanguage", code: first, after: preceding }];
}
