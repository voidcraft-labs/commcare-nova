// lib/domain/languageRegistry/search.ts
//
// The picker's search corpus and ranking over every individual living
// language. This module statically imports the full name catalog, so client
// code loads it only through ./load; server code may import it directly.

import { LIVING_INDIVIDUAL_LANGUAGE_CODES_PACKED } from "./codes.catalog";
import { ENDONYM_BY_KEY } from "./displayLabels.catalog";
import { altEnglishLanguageName, englishLanguageName } from "./names";

export interface LanguageSearchRow {
	readonly code: string;
	readonly englishName: string;
	readonly endonym?: string;
	/** A secondary English name (the SIL reference name) where it differs. */
	readonly altName?: string;
}

interface IndexedRow extends LanguageSearchRow {
	readonly foldedNames: readonly string[];
}

/** Case- and diacritic-insensitive comparison form. */
function fold(value: string): string {
	return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

let corpus: readonly IndexedRow[] | undefined;

function buildCorpus(): readonly IndexedRow[] {
	const rows: IndexedRow[] = [];
	for (
		let index = 0;
		index < LIVING_INDIVIDUAL_LANGUAGE_CODES_PACKED.length;
		index += 3
	) {
		const code = LIVING_INDIVIDUAL_LANGUAGE_CODES_PACKED.slice(
			index,
			index + 3,
		);
		const englishName = englishLanguageName(code);
		if (englishName === undefined) continue;
		const endonym = ENDONYM_BY_KEY[code];
		const altName = altEnglishLanguageName(code);
		rows.push({
			code,
			englishName,
			...(endonym !== undefined && { endonym }),
			...(altName !== undefined && { altName }),
			foldedNames: [
				fold(englishName),
				...(endonym !== undefined ? [fold(endonym)] : []),
				...(altName !== undefined ? [fold(altName)] : []),
			],
		});
	}
	rows.sort((a, b) => a.englishName.localeCompare(b.englishName));
	return rows;
}

/** Every selectable language, alphabetical by English name. */
export function allLanguageSearchRows(): readonly LanguageSearchRow[] {
	corpus ??= buildCorpus();
	return corpus;
}

export interface LanguageSearchResult {
	readonly rows: readonly LanguageSearchRow[];
	readonly totalMatches: number;
}

/**
 * Rank matches for a picker query: exact Set 3 code (the expert path — the
 * code is a match key, never rendered), exact name, prefix, word boundary,
 * then substring; names fold diacritics; ties stay alphabetical by English
 * name. An empty query returns the full alphabetical list.
 */
export function searchLanguages(
	query: string,
	limit = Number.POSITIVE_INFINITY,
): LanguageSearchResult {
	corpus ??= buildCorpus();
	const trimmed = query.trim();
	if (trimmed === "") {
		return {
			rows:
				limit === Number.POSITIVE_INFINITY ? corpus : corpus.slice(0, limit),
			totalMatches: corpus.length,
		};
	}
	const folded = fold(trimmed);
	const tiers: IndexedRow[][] = [[], [], [], [], []];
	for (const row of corpus) {
		if (row.code === folded) {
			tiers[0]?.push(row);
			continue;
		}
		let best: number | undefined;
		for (const name of row.foldedNames) {
			if (name === folded) best = Math.min(best ?? 4, 1);
			else if (name.startsWith(folded)) best = Math.min(best ?? 4, 2);
			else if (name.includes(` ${folded}`) || name.includes(`-${folded}`)) {
				best = Math.min(best ?? 4, 3);
			} else if (name.includes(folded)) best = Math.min(best ?? 4, 4);
		}
		if (best !== undefined) tiers[best]?.push(row);
	}
	const matches = tiers.flat();
	return {
		rows: matches.length > limit ? matches.slice(0, limit) : matches,
		totalMatches: matches.length,
	};
}

export {
	altEnglishLanguageName,
	englishLanguageName,
	languageDescriptor,
	resolvedLanguageDisplayLabel,
	resolvedLanguageEnglishName,
} from "./names";
