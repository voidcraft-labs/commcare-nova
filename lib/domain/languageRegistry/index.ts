// lib/domain/languageRegistry/index.ts
//
// The language registry API over the generated ISO 639:2023 / ISO 15924 /
// ISO 3166-1 / CLDR catalogs in this directory. This module and everything it
// imports stay small enough for client bundles; the full English-name catalog
// (names.catalog.ts) is reachable only through ./names and the lazy ./load
// seam. Deliberately NOT exported from the lib/domain barrel — consumers
// import `@/lib/domain/languageRegistry` directly.

import {
	type AppLanguageIdentity,
	type LanguageDirection,
	type LanguageTag,
	parseLanguageTag,
} from "../localization";
import {
	ISO_639_1_TO_SET3,
	LIVING_INDIVIDUAL_LANGUAGE_CODES_PACKED,
	NON_LIVING_LANGUAGE_CODES_PACKED,
} from "./codes.catalog";
import {
	COMMON_ENGLISH_NAME_BY_CODE,
	ENDONYM_BY_KEY,
	RTL_DEFAULT_LANGUAGE_CODES_PACKED,
	RTL_SCRIPTS,
} from "./displayLabels.catalog";
import {
	MACROLANGUAGE_CATALOG,
	MACROLANGUAGE_OF_MEMBER,
} from "./macrolanguages.catalog";
import { LANGUAGE_REGION_CATALOG } from "./regions.catalog";
import { MULTI_SCRIPT_LANGUAGE_CATALOG } from "./scripts.catalog";

function unpackCodes(packed: string): ReadonlySet<string> {
	const codes = new Set<string>();
	for (let index = 0; index < packed.length; index += 3) {
		codes.add(packed.slice(index, index + 3));
	}
	return codes;
}

const livingIndividualCodes = unpackCodes(
	LIVING_INDIVIDUAL_LANGUAGE_CODES_PACKED,
);
const rtlDefaultLanguages = unpackCodes(RTL_DEFAULT_LANGUAGE_CODES_PACKED);
const rtlScriptSet: ReadonlySet<string> = new Set(RTL_SCRIPTS);
const iso6391BySet3 = new Map(
	Object.entries(ISO_639_1_TO_SET3).map(([set1, set3]) => [set3, set1]),
);

const nonLivingTypeByCode = new Map<string, string>();
for (
	let index = 0;
	index < NON_LIVING_LANGUAGE_CODES_PACKED.length;
	index += 4
) {
	nonLivingTypeByCode.set(
		NON_LIVING_LANGUAGE_CODES_PACKED.slice(index, index + 3),
		NON_LIVING_LANGUAGE_CODES_PACKED.slice(index + 3, index + 4),
	);
}

const macrolanguageByCode = new Map(
	MACROLANGUAGE_CATALOG.map((entry) => [entry.code, entry]),
);
const multiScriptByLanguage = new Map(
	MULTI_SCRIPT_LANGUAGE_CATALOG.map((entry) => [entry.language, entry]),
);
const regionChoicesByShape = new Map(
	LANGUAGE_REGION_CATALOG.map((entry) => [
		entry.script === undefined
			? entry.language
			: `${entry.language}-${entry.script}`,
		entry,
	]),
);

const NON_LIVING_TYPE_LABELS: Readonly<Record<string, string>> = {
	E: "an extinct language",
	A: "an ancient language",
	H: "a historical language",
	C: "a constructed language",
	S: "a special ISO 639 code, not a human language",
};

/** Whether a code is a selectable ISO 639:2023 Set 3 individual living language. */
export function isIndividualLivingLanguage(code: string): boolean {
	return livingIndividualCodes.has(code);
}

export interface MacrolanguageMember {
	readonly code: string;
	readonly englishName: string;
	readonly endonym?: string;
}

export interface LanguageCodeVerdict {
	readonly kind:
		| "individual-living"
		| "macrolanguage"
		| "set1-alias"
		| "non-living"
		| "unknown";
	/** The Set 3 identifier the input names, where one exists. */
	readonly resolved?: string;
	/** What a non-living code is (an extinct language, a constructed language, …). */
	readonly typeLabel?: string;
	/** A macrolanguage's individual living members, predominant member first. */
	readonly members?: readonly MacrolanguageMember[];
}

function memberRows(macroCode: string): readonly MacrolanguageMember[] {
	const macro = macrolanguageByCode.get(macroCode);
	return (macro?.members ?? []).map((member) => {
		const endonym = ENDONYM_BY_KEY[member.code];
		return {
			code: member.code,
			englishName: member.name,
			...(endonym !== undefined && { endonym }),
		};
	});
}

/**
 * Classify a candidate language code against the registry. This is the one
 * rejection source: the picker renders its structured result as code-free
 * prose with selectable member rows, and the tools compose Elm-like messages
 * from the same result with the Set 3 codes spelled out.
 */
export function languageCodeVerdict(input: string): LanguageCodeVerdict {
	const classify = (
		code: string,
		resolvedFrom: string | undefined,
	): LanguageCodeVerdict => {
		const resolved =
			resolvedFrom === undefined || resolvedFrom === code ? undefined : code;
		if (livingIndividualCodes.has(code)) {
			return resolved === undefined
				? { kind: "individual-living" }
				: { kind: "set1-alias", resolved };
		}
		if (macrolanguageByCode.has(code)) {
			return {
				kind: "macrolanguage",
				...(resolved !== undefined && { resolved }),
				members: memberRows(code),
			};
		}
		const typeLetter = nonLivingTypeByCode.get(code);
		if (typeLetter !== undefined) {
			return {
				kind: "non-living",
				...(resolved !== undefined && { resolved }),
				typeLabel:
					NON_LIVING_TYPE_LABELS[typeLetter] ?? "not a living language",
			};
		}
		return { kind: "unknown" };
	};

	if (/^[a-z]{3}$/.test(input)) return classify(input, undefined);
	if (/^[a-z]{2}$/.test(input)) {
		const set3 = ISO_639_1_TO_SET3[input];
		if (set3 === undefined) return { kind: "unknown" };
		return classify(set3, input);
	}
	return { kind: "unknown" };
}

export interface ScriptChoice {
	readonly script: string;
	readonly label: string;
	readonly qualifier: string;
	readonly direction: LanguageDirection;
}

/**
 * The writing systems a language branches into. Empty means the language has
 * one customary writing system and its identities never carry a script.
 */
export function scriptChoices(language: string): readonly ScriptChoice[] {
	return multiScriptByLanguage.get(language)?.scripts ?? [];
}

export interface RegionChoice {
	readonly region: string;
	readonly label: string;
}

/**
 * The regional-convention choices for a language (script-specific where the
 * language branches). Empty means region never applies; region is always
 * skippable even when choices exist — a bare identity targets the language's
 * general conventions.
 */
export function regionChoices(
	language: string,
	script?: string,
): readonly RegionChoice[] {
	const key = script === undefined ? language : `${language}-${script}`;
	return regionChoicesByShape.get(key)?.regions ?? [];
}

export function macrolanguageMembers(
	code: string,
): readonly MacrolanguageMember[] {
	return memberRows(code);
}

/** A macrolanguage's English name, for the picker's code-free group notice. */
export function macrolanguageName(code: string): string | undefined {
	return macrolanguageByCode.get(code)?.name;
}

/** An individual member's macrolanguage, for the Classic wire-widening path. */
export function classicWideningTarget(language: string): string | undefined {
	return MACROLANGUAGE_OF_MEMBER[language];
}

/** The ISO 639-1 spelling Android uses for a Set 3 resource locale. */
export function iso6391CodeForSet3(language: string): string | undefined {
	return iso6391BySet3.get(language);
}

function toIdentity(
	value: AppLanguageIdentity | LanguageTag,
): AppLanguageIdentity {
	return typeof value === "string" ? parseLanguageTag(value) : value;
}

/**
 * Problems with an identity's shape against the registry, as person-readable
 * sentences. Empty means the identity is a lawful selection.
 */
export function identityIssues(identity: AppLanguageIdentity): string[] {
	const issues: string[] = [];
	const verdict = languageCodeVerdict(identity.language);
	if (verdict.kind !== "individual-living") {
		issues.push(languageVerdictIssue(identity.language, verdict));
		return issues;
	}
	const scripts = scriptChoices(identity.language);
	if (scripts.length > 0) {
		if (identity.script === undefined) {
			issues.push(
				`This language is written in more than one script, so the writing system must be chosen: ${scripts
					.map((choice) => `${choice.script} (${choice.label})`)
					.join(", ")}.`,
			);
		} else if (!scripts.some((choice) => choice.script === identity.script)) {
			issues.push(
				`${identity.script} is not one of this language's writing systems. Choose one of: ${scripts
					.map((choice) => `${choice.script} (${choice.label})`)
					.join(", ")}.`,
			);
		}
	} else if (identity.script !== undefined) {
		issues.push(
			"This language has one customary writing system, so its identity carries no script — omit it.",
		);
	}
	if (identity.region !== undefined) {
		const scriptForRegions =
			scripts.length > 0 &&
			scripts.some((choice) => choice.script === identity.script)
				? identity.script
				: undefined;
		const regions = regionChoices(identity.language, scriptForRegions);
		if (regions.length === 0) {
			issues.push(
				"This language offers no regional-convention choices — omit the region for its general conventions.",
			);
		} else if (!regions.some((choice) => choice.region === identity.region)) {
			issues.push(
				`${identity.region} is not one of this language's regional conventions. Choose one of: ${regions
					.map((choice) => `${choice.region} (${choice.label})`)
					.join(", ")}, or omit the region for its general conventions.`,
			);
		}
	}
	return issues;
}

/** The shared person-readable sentence for a rejected language code. */
export function languageVerdictIssue(
	input: string,
	verdict: LanguageCodeVerdict,
): string {
	switch (verdict.kind) {
		case "individual-living":
			return "";
		case "set1-alias":
			return `${input} is a two-letter ISO 639-1 code. Nova identifies languages by their ISO 639:2023 Set 3 code — use ${verdict.resolved ?? input}.`;
		case "macrolanguage": {
			const macro = verdict.resolved ?? input;
			const members = (verdict.members ?? [])
				.slice(0, 8)
				.map((member) => `${member.code} (${member.englishName})`)
				.join(", ");
			const suffix = (verdict.members?.length ?? 0) > 8 ? ", among others" : "";
			return `${macro} is a macrolanguage — a group of languages, which cannot identify the one language workers speak. Use one of its individual members: ${members}${suffix}.`;
		}
		case "non-living":
			return `${verdict.resolved ?? input} is ${verdict.typeLabel ?? "not a living language"}, and app languages are living languages workers speak today.`;
		case "unknown":
			return `${input} is not a current ISO 639:2023 Set 3 language identifier. Look the language up by name to find its three-letter code.`;
	}
}

/**
 * The capitalized endonym at the identity's most specific baked key, falling
 * back to the baked English name. Undefined for languages outside CLDR's
 * display-name coverage — resolve those through ./names (server) or the lazy
 * ./load seam (client), never by rendering a code.
 */
export function languageDisplayLabel(
	value: AppLanguageIdentity | LanguageTag,
): string | undefined {
	const identity = toIdentity(value);
	for (const key of displayKeyChain(identity)) {
		const endonym = ENDONYM_BY_KEY[key];
		if (endonym !== undefined) return endonym;
	}
	return languageEnglishName(identity);
}

function displayKeyChain(identity: AppLanguageIdentity): string[] {
	const { language, script, region } = identity;
	const chain: string[] = [];
	if (script !== undefined && region !== undefined) {
		chain.push(`${language}-${script}-${region}`);
	}
	if (script !== undefined) chain.push(`${language}-${script}`);
	if (region !== undefined) chain.push(`${language}-${region}`);
	chain.push(language);
	return chain;
}

/**
 * The English qualified name ("Mandarin Chinese (Simplified, Singapore)")
 * from the baked common-language names. Undefined outside CLDR coverage —
 * same resolution rule as `languageDisplayLabel`.
 */
export function languageEnglishName(
	value: AppLanguageIdentity | LanguageTag,
): string | undefined {
	const identity = toIdentity(value);
	const base = COMMON_ENGLISH_NAME_BY_CODE[identity.language];
	if (base === undefined) return undefined;
	const qualifiers = languageQualifierLabels(identity);
	return qualifiers.length === 0 ? base : `${base} (${qualifiers.join(", ")})`;
}

/** English qualifier words for an identity's script and region, in that order. */
export function languageQualifierLabels(
	identity: AppLanguageIdentity,
): readonly string[] {
	const labels: string[] = [];
	if (identity.script !== undefined) {
		const choice = scriptChoices(identity.language).find(
			(candidate) => candidate.script === identity.script,
		);
		labels.push(choice?.qualifier ?? identity.script);
	}
	if (identity.region !== undefined) {
		const scripts = scriptChoices(identity.language);
		const scriptForRegions = scripts.some(
			(candidate) => candidate.script === identity.script,
		)
			? identity.script
			: undefined;
		const choice = regionChoices(identity.language, scriptForRegions).find(
			(candidate) => candidate.region === identity.region,
		);
		labels.push(choice?.label ?? identity.region);
	}
	return labels;
}

/**
 * Text direction derived from the identity: the explicit script when the
 * identity carries one, else the language's likely default script, else
 * left-to-right.
 */
export function languageDirection(
	value: AppLanguageIdentity | LanguageTag,
): LanguageDirection {
	const identity = toIdentity(value);
	if (identity.script !== undefined) {
		return rtlScriptSet.has(identity.script) ? "rtl" : "ltr";
	}
	return rtlDefaultLanguages.has(identity.language) ? "rtl" : "ltr";
}
