// lib/domain/languageRegistry/classicRuntime.ts
//
// The two locale projections needed while executing CommCare-compatible
// formatting. Keep this leaf free of localization schemas and display
// catalogs: Preview's isolated XPath worker needs the wire maps, not the
// complete language-authoring registry.

import { ISO_639_1_TO_SET3 } from "./codes.catalog";
import { MACROLANGUAGE_OF_MEMBER } from "./macrolanguages.catalog";

const iso6391BySet3 = new Map(
	Object.entries(ISO_639_1_TO_SET3).map(([set1, set3]) => [set3, set1]),
);

/** An individual member's macrolanguage, for the Classic wire-widening path. */
export function classicWideningTarget(language: string): string | undefined {
	return MACROLANGUAGE_OF_MEMBER[language];
}

/** The ISO 639-1 spelling Android uses for a Set 3 resource locale. */
export function iso6391CodeForSet3(language: string): string | undefined {
	return iso6391BySet3.get(language);
}
