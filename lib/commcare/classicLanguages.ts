// lib/commcare/classicLanguages.ts
//
// CommCare Classic's app-language picker catalog — two-letter-bearing wire
// data, quarantined at the emission boundary. The wire plan
// (`languageWire.ts`) reads it to pick each identity's preferred Classic
// spelling, and the language-identity migration script reads it to interpret
// historical stored codes. Nothing in lib/domain speaks these spellings.

import rawClassicLanguages from "@/config/commcare-classic-languages.json";

interface RawClassicLanguage {
	readonly names: readonly string[];
	readonly two: string;
	readonly three: string;
}

const classicLanguages = rawClassicLanguages as readonly RawClassicLanguage[];

/**
 * The four codes Classic's picker presents by their historical two-letter
 * spelling; every other catalog row presents its ISO 639-2 code.
 */
export const CLASSIC_GRANDFATHERED_TWO_LETTER_CODES: ReadonlySet<string> =
	new Set(["en", "sw", "es", "af"]);

export interface ClassicLanguageRow {
	/** The code Classic presents by default in its app-language picker. */
	readonly code: string;
	readonly englishName: string;
	readonly iso6391?: string;
	readonly iso6392: string;
}

const classicRowsByCode = new Map<string, ClassicLanguageRow>();
for (const language of classicLanguages) {
	const code = CLASSIC_GRANDFATHERED_TWO_LETTER_CODES.has(language.two)
		? language.two
		: language.three;
	const row = {
		code,
		englishName: language.names[0] ?? code,
		...(language.two.length > 0 && { iso6391: language.two }),
		iso6392: language.three,
	} satisfies ClassicLanguageRow;
	// Classic's source catalog contains both Mizo and its historical synonym
	// Lushai under `lus`. The wire identity is the code, so keep one row per
	// identity with the first, current catalog name.
	if (!classicRowsByCode.has(row.code)) {
		classicRowsByCode.set(row.code, row);
	}
}

export const CLASSIC_LANGUAGE_ROWS: readonly ClassicLanguageRow[] = [
	...classicRowsByCode.values(),
];

const classicRowByAlias = new Map<string, ClassicLanguageRow>();
for (const row of CLASSIC_LANGUAGE_ROWS) {
	classicRowByAlias.set(row.code, row);
	classicRowByAlias.set(row.iso6392, row);
	if (row.iso6391 !== undefined) {
		classicRowByAlias.set(row.iso6391, row);
	}
}

/** The Classic catalog row a bare two- or three-letter spelling names. */
export function classicLanguageRow(
	code: string,
): ClassicLanguageRow | undefined {
	return classicRowByAlias.get(code);
}
