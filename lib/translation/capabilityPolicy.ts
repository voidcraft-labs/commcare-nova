import rawLaunchLanguages from "@/config/automatic-translation-launch-languages.json";
import { type AppLanguageIdentity, languageTag } from "@/lib/domain";

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
	readonly sourceLanguage: AppLanguageIdentity;
	readonly targetLanguage: AppLanguageIdentity;
	readonly status: AutomaticTranslationStatus;
	readonly explanation: string;
}

export interface AutomaticTranslationLaunchLanguage {
	/** An ISO 639:2023 Set 3 individual living-language code. */
	readonly code: string;
	readonly name: string;
}

const LAUNCH_CODE_PATTERN = /^[a-z]{3}$/;

/**
 * Product-owned launch coverage, adopted as an explicit 57-language set. It is
 * not represented as 3,192 pair rows and does not claim a provider-published
 * language list or completed bilingual evaluation for every direction. Every
 * machine-authored value remains Needs review.
 */
export const AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES: readonly AutomaticTranslationLaunchLanguage[] =
	rawLaunchLanguages.map((language) => {
		if (!LAUNCH_CODE_PATTERN.test(language.code)) {
			throw new Error(
				`The automatic-translation launch manifest entry ${language.code} is not a three-letter Set 3 code.`,
			);
		}
		return { code: language.code, name: language.name };
	});

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
 * Availability is decided by the language axis alone: script and regional
 * conventions never affect it, so two branches of one language (Simplified ↔
 * Traditional Mandarin) resolve to the same launch language and stay
 * withheld — converting a writing system is not translation.
 */
export function automaticTranslationLaunchLanguage(
	identity: AppLanguageIdentity,
): string | undefined {
	return launchCodes.has(identity.language) ? identity.language : undefined;
}

export function automaticTranslationCapability(
	sourceLanguage: AppLanguageIdentity,
	targetLanguage: AppLanguageIdentity,
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
				languageTag(sourceLanguage) === languageTag(targetLanguage)
					? "The source and target are the same language, so translation would not change languages."
					: "The source and target are two forms of one language. Converting between writing systems or regional conventions is not translation, so automatic translation stays off for this pair.",
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
	sourceLanguage: AppLanguageIdentity,
	targetLanguage: AppLanguageIdentity,
): boolean {
	return (
		automaticTranslationCapability(sourceLanguage, targetLanguage).status ===
		"available"
	);
}
