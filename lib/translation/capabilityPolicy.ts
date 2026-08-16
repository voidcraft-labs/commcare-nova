import rawLaunchLanguages from "@/config/automatic-translation-launch-languages.json";
import {
	classicLanguageOption,
	type LanguageCode,
	languageCodeSchema,
} from "@/lib/domain";

/**
 * Automatic text translation is independent from CommCare's app-language
 * catalog. Manual authoring, copy, Preview, and emission never consult this
 * policy.
 */
export const automaticTranslationStatuses = [
	"available",
	"not-evaluated",
	"withheld",
] as const;
export type AutomaticTranslationStatus =
	(typeof automaticTranslationStatuses)[number];

export interface AutomaticTranslationCapability {
	readonly sourceLanguage: LanguageCode;
	readonly targetLanguage: LanguageCode;
	readonly status: AutomaticTranslationStatus;
	readonly explanation: string;
}

export interface AutomaticTranslationLaunchLanguage {
	readonly code: LanguageCode;
	readonly name: string;
}

/**
 * Product-owned launch coverage, adopted as an explicit 57-language set. It is
 * not represented as 3,192 pair rows and does not claim a provider-published
 * language list or completed bilingual evaluation for every direction. Every
 * machine-authored value remains Needs review.
 */
export const AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES: readonly AutomaticTranslationLaunchLanguage[] =
	rawLaunchLanguages.map((language) => ({
		code: languageCodeSchema.parse(language.code),
		name: language.name,
	}));

if (AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES.length !== 57) {
	throw new Error(
		"The automatic-translation launch manifest must contain 57 languages.",
	);
}

const launchCodes = new Set(
	AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES.map((language) => language.code),
);
if (launchCodes.size !== AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES.length) {
	throw new Error(
		"The automatic-translation launch manifest has duplicate codes.",
	);
}

/**
 * The launch source uses ISO 639-3 individual-language identities while
 * Classic's picker uses ISO 639-2 macrolanguage codes for these eight entries.
 * Resolve the picker code to the launch identity workers mean; direct 639-3
 * entries (for example `arz` or `prs`) still win before this crosswalk.
 */
const CLASSIC_TO_LAUNCH_EQUIVALENT = new Map<LanguageCode, LanguageCode>([
	["zho", "cmn"],
	["ara", "arb"],
	["swa", "swh"],
	["fas", "pes"],
	["ori", "ory"],
	["nep", "npi"],
	["msa", "zlm"],
	["uzb", "uzn"],
]);

/**
 * Explicit compound aliases for launch languages that are varieties of a
 * broader two-letter language. They must resolve before regional fallback:
 * `zh-yue` means Yue, while an ordinary region such as `zh-hk` still inherits
 * the Mandarin capability selected by Classic's `zh` alias.
 */
const LAUNCH_VARIETY_ALIASES = new Map<LanguageCode, LanguageCode>([
	["zh-cmn", "cmn"],
	["zh-yue", "yue"],
	["zh-wuu", "wuu"],
	["zh-cjy", "cjy"],
	["zh-nan", "nan"],
	["zh-hak", "hak"],
	["zh-hsn", "hsn"],
	["ar-arb", "arb"],
	["ar-arz", "arz"],
	["ar-apc", "apc"],
	["ar-apd", "apd"],
	["ar-arq", "arq"],
	["ar-ary", "ary"],
	["fa-pes", "pes"],
	["fa-prs", "prs"],
	["pa-pan", "pan"],
	["pa-pnb", "pnb"],
	["ms-zlm", "zlm"],
	["sw-swh", "swh"],
	["or-ory", "ory"],
	["ne-npi", "npi"],
	["uz-uzn", "uzn"],
]);

/** Resolve a CommCare code or regional variant to one launch-language identity. */
export function automaticTranslationLaunchLanguage(
	code: LanguageCode,
): LanguageCode | undefined {
	if (launchCodes.has(code)) return code;
	const variety = LAUNCH_VARIETY_ALIASES.get(code);
	if (variety !== undefined) return variety;
	const base = code.split("-", 1)[0] as LanguageCode;
	if (launchCodes.has(base)) return base;
	const classic = classicLanguageOption(base);
	if (classic === undefined) return undefined;
	if (launchCodes.has(classic.iso6392)) return classic.iso6392;
	return CLASSIC_TO_LAUNCH_EQUIVALENT.get(classic.iso6392);
}

export function automaticTranslationCapability(
	sourceLanguage: LanguageCode,
	targetLanguage: LanguageCode,
): AutomaticTranslationCapability {
	const sourceLaunchLanguage =
		automaticTranslationLaunchLanguage(sourceLanguage);
	const targetLaunchLanguage =
		automaticTranslationLaunchLanguage(targetLanguage);
	if (
		sourceLaunchLanguage !== undefined &&
		targetLaunchLanguage !== undefined &&
		sourceLaunchLanguage !== targetLaunchLanguage
	) {
		return {
			sourceLanguage,
			targetLanguage,
			status: "available",
			explanation:
				"Both languages belong to Nova's 57-language automatic-translation launch set. Machine-authored values still require human review.",
		};
	}
	if (
		sourceLaunchLanguage !== undefined &&
		sourceLaunchLanguage === targetLaunchLanguage
	) {
		return {
			sourceLanguage,
			targetLanguage,
			status: "withheld",
			explanation:
				"The source and target codes resolve to the same launch language, so translation would not change languages.",
		};
	}
	return {
		sourceLanguage,
		targetLanguage,
		status: "not-evaluated",
		explanation:
			"At launch, Nova offers automatic translation only when both languages belong to its checked-in 57-language set.",
	};
}

export function automaticTranslationAvailable(
	sourceLanguage: LanguageCode,
	targetLanguage: LanguageCode,
): boolean {
	return (
		automaticTranslationCapability(sourceLanguage, targetLanguage).status ===
		"available"
	);
}
