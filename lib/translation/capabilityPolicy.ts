import type { LanguageCode } from "@/lib/domain";

/**
 * Automatic text translation is an exact-direction capability, independent
 * from CommCare's app-language catalog. Manual authoring, copy, Preview, and
 * emission never consult this policy.
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

/**
 * Only human-reviewed evaluation results belong here. The broad Classic
 * catalog is deliberately not copied into this manifest, and a benchmark run
 * never enables a direction by editing policy automatically.
 *
 * No direction is enabled until the paid evaluation harness and bilingual
 * human review have accepted it. This conservative empty manifest is a real
 * product state: every direction remains manually authorable while automatic
 * translation is honestly unavailable.
 */
const REVIEWED_DIRECTIONS = new Map<
	string,
	Omit<AutomaticTranslationCapability, "sourceLanguage" | "targetLanguage">
>();

export function availableAutomaticTranslationDirections(): readonly AutomaticTranslationCapability[] {
	return [...REVIEWED_DIRECTIONS.entries()].flatMap(([key, capability]) => {
		if (capability.status !== "available") return [];
		const [sourceLanguage, targetLanguage] = key.split("\u0000") as [
			LanguageCode,
			LanguageCode,
		];
		return [{ sourceLanguage, targetLanguage, ...capability }];
	});
}

function directionKey(source: LanguageCode, target: LanguageCode): string {
	return `${source}\u0000${target}`;
}

export function automaticTranslationCapability(
	sourceLanguage: LanguageCode,
	targetLanguage: LanguageCode,
): AutomaticTranslationCapability {
	const reviewed = REVIEWED_DIRECTIONS.get(
		directionKey(sourceLanguage, targetLanguage),
	);
	if (reviewed !== undefined) {
		return { sourceLanguage, targetLanguage, ...reviewed };
	}
	return {
		sourceLanguage,
		targetLanguage,
		status: "not-evaluated",
		explanation:
			"Nova has not completed its paid quality evaluation and bilingual human review for this exact translation direction.",
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
