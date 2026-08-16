/** CommCare Classic language discovery, kept out of core localization state. */

import rawClassicLanguages from "@/config/commcare-classic-languages.json";
import {
	type AppLanguage,
	type LanguageCode,
	languageCodeSchema,
	normalizeLanguageCode,
} from "./localization";

interface RawClassicLanguage {
	readonly names: readonly string[];
	readonly two: string;
	readonly three: string;
}

const classicLanguages = rawClassicLanguages as readonly RawClassicLanguage[];
const CLASSIC_GRANDFATHERED_TWO_LETTER_CODES = new Set([
	"en",
	"sw",
	"es",
	"af",
]);

export interface ClassicLanguageOption {
	/** The code Classic presents by default in its app-language picker. */
	readonly code: LanguageCode;
	readonly englishName: string;
	readonly iso6391?: LanguageCode;
	readonly iso6392: LanguageCode;
}

/**
 * The exact ISO catalog behind CommCare Classic's app-language search. Classic
 * presents four historical two-letter codes and otherwise its ISO 639-2 code;
 * Nova accepts every wire-valid alias as custom input as well.
 */
export const CLASSIC_LANGUAGE_OPTIONS: readonly ClassicLanguageOption[] =
	classicLanguages.map((language) => {
		const code = CLASSIC_GRANDFATHERED_TWO_LETTER_CODES.has(language.two)
			? language.two
			: language.three;
		return {
			code: languageCodeSchema.parse(code),
			englishName: language.names[0] ?? code,
			...(language.two.length > 0 && {
				iso6391: languageCodeSchema.parse(language.two),
			}),
			iso6392: languageCodeSchema.parse(language.three),
		};
	});

const classicLanguageByAlias = new Map<LanguageCode, ClassicLanguageOption>();
for (const option of CLASSIC_LANGUAGE_OPTIONS) {
	classicLanguageByAlias.set(option.code, option);
	classicLanguageByAlias.set(option.iso6392, option);
	if (option.iso6391 !== undefined) {
		classicLanguageByAlias.set(option.iso6391, option);
	}
}

export function classicLanguageOption(
	code: LanguageCode,
): ClassicLanguageOption | undefined {
	const base = code.split("-", 1)[0] as LanguageCode;
	return classicLanguageByAlias.get(base);
}

function localeForDisplay(code: LanguageCode): Intl.Locale | undefined {
	try {
		return new Intl.Locale(code);
	} catch {
		return undefined;
	}
}

/** Seed editable worker-facing language metadata without narrowing support. */
export function suggestedAppLanguage(codeInput: string): AppLanguage {
	const code = normalizeLanguageCode(codeInput);
	const locale = localeForDisplay(code);
	const known = classicLanguageOption(code);
	let name = known?.englishName ?? code;
	if (locale !== undefined) {
		try {
			const endonym = new Intl.DisplayNames([locale.toString()], {
				type: "language",
			}).of(locale.toString());
			if (endonym !== undefined && endonym !== locale.language) name = endonym;
		} catch {
			// The editable English/catalog fallback remains honest for a valid
			// Classic code that this JavaScript runtime does not recognize.
		}
	}
	return {
		code,
		name,
		direction:
			(
				locale as
					| (Intl.Locale & {
							readonly textInfo?: { readonly direction?: string };
					  })
					| undefined
			)?.textInfo?.direction === "rtl"
				? "rtl"
				: "ltr",
	};
}
