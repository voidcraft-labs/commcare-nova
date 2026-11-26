import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, effectiveAppLocalization } from "@/lib/domain";

/** The native journey installs the manual archive from this saved edit. */
export const editedImportFile = true;

/** Start the visit in French without changing either language's identity. */
export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const { languageOrder, wireCodes } = effectiveAppLocalization(
		doc.localization,
	);
	const french = languageOrder.find(
		(language) => wireCodes[language] === "fra",
	);
	if (french === undefined)
		throw new Error("The clinic visit must include French.");
	return [{ kind: "moveLanguage", code: french, after: null }];
}
