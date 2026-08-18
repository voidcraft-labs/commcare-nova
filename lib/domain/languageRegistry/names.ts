// lib/domain/languageRegistry/names.ts
//
// Display resolution over the FULL English-name catalog — total for every
// individual living language, including the long tail outside CLDR's
// display-name coverage. Statically importing this module pulls the ~100 KB
// name catalog into the chunk, so it is for server-side consumers (tools,
// the design contract, translation, emission, scripts); client surfaces
// reach the same data through the lazy ./load seam.

import {
	type AppLanguageIdentity,
	type LanguageTag,
	parseLanguageTag,
} from "../localization";
import { languageDisplayLabel, languageQualifierLabels } from "./index";
import {
	LANGUAGE_ALT_ENGLISH_NAMES_PACKED,
	LANGUAGE_ENGLISH_NAMES_PACKED,
} from "./names.catalog";

function unpackNames(packed: string): ReadonlyMap<string, string> {
	const names = new Map<string, string>();
	if (packed === "") return names;
	for (const line of packed.split("\n")) {
		names.set(line.slice(0, 3), line.slice(3));
	}
	return names;
}

const englishNames = unpackNames(LANGUAGE_ENGLISH_NAMES_PACKED);
const altEnglishNames = unpackNames(LANGUAGE_ALT_ENGLISH_NAMES_PACKED);

/** The English name of one living-individual code, from the full catalog. */
export function englishLanguageName(code: string): string | undefined {
	return englishNames.get(code);
}

/** A secondary English name (the SIL reference name) where it differs. */
export function altEnglishLanguageName(code: string): string | undefined {
	return altEnglishNames.get(code);
}

function toIdentity(
	value: AppLanguageIdentity | LanguageTag,
): AppLanguageIdentity {
	return typeof value === "string" ? parseLanguageTag(value) : value;
}

/**
 * The English qualified name, total over the full catalog. Undefined only
 * for a code outside the registry, which validated identities cannot hold.
 */
export function resolvedLanguageEnglishName(
	value: AppLanguageIdentity | LanguageTag,
): string | undefined {
	const identity = toIdentity(value);
	const base = englishNames.get(identity.language);
	if (base === undefined) return undefined;
	const qualifiers = languageQualifierLabels(identity);
	return qualifiers.length === 0 ? base : `${base} (${qualifiers.join(", ")})`;
}

/**
 * The worker-facing display label, total over the full catalog: the baked
 * endonym where CLDR knows one, else the English name.
 */
export function resolvedLanguageDisplayLabel(
	value: AppLanguageIdentity | LanguageTag,
): string | undefined {
	const identity = toIdentity(value);
	return (
		languageDisplayLabel(identity) ?? resolvedLanguageEnglishName(identity)
	);
}

/**
 * The prose form a translation prompt names its languages with:
 * "Mandarin Chinese (Simplified script, Singapore conventions)". Derived
 * entirely from the registry, so identical on every machine — translation
 * batch digests depend on that stability.
 */
export function languageDescriptor(identity: AppLanguageIdentity): string {
	const base = englishNames.get(identity.language) ?? identity.language;
	const qualifiers = languageQualifierLabels(identity);
	const parts: string[] = [];
	let nextQualifier = 0;
	if (identity.script !== undefined) {
		parts.push(`${qualifiers[nextQualifier] ?? identity.script} script`);
		nextQualifier += 1;
	}
	if (identity.region !== undefined) {
		parts.push(`${qualifiers[nextQualifier] ?? identity.region} conventions`);
	}
	return parts.length === 0 ? base : `${base} (${parts.join(", ")})`;
}
