// components/builder/shared/matchModeVocabulary.ts
//
// The friendly vocabulary for the forgiving match behaviors (`match`'s
// `MatchMode`), shared by both surfaces that name them: the search-input
// Match picker (`case-list-config/searchInputResolution`) and the
// condition verb menu (`cards/PredicateVerbMenu`). Each entry holds ONE
// behavioral description plus the two grammatical framings of the
// behavior's name, so the two surfaces can never describe the same
// behavior differently.
//
// The descriptions are exact behavioral claims, not vibes — each states
// what CommCare's search actually does with the typed value (mirrored by
// the case store's Postgres compiler and CommCare HQ's Elasticsearch
// layer):
//   - fuzzy: per-word — a word matches if it equals a word of the value
//     (ignoring case), or sits within 1 edit (words of 3–5 letters) /
//     2 edits (6+) of one sharing its first two letters. It does NOT
//     match partial words: "bo" never finds "bob".
//   - starts-with: prefix of the whole value, case-sensitive.
//   - phonetic: Soundex per word — same spoken shape, any spelling.
//   - fuzzy-date: the typed date plus its digit-permutation set
//     (swapped day/month, reversed digit pairs).

import type { MatchMode } from "@/lib/domain/predicate";

export interface MatchModeVocabularyEntry {
	/** Standalone choice name, sentence case — the Match picker's label. */
	readonly pickerLabel: string;
	/** Mid-sentence verb framing — reads as "subject verb value" in the
	 *  condition verb menu. `starts-with` deliberately uses a different
	 *  stem per framing: the standalone choice is named "Begins with"
	 *  while the sentence verb reads "starts with" (the same verb the
	 *  predicate summaries print). */
	readonly verbLabel: string;
	/** The one behavioral claim shown beside either label. */
	readonly description: string;
}

export const MATCH_MODE_VOCABULARY: Record<
	MatchMode,
	MatchModeVocabularyEntry
> = {
	fuzzy: {
		pickerLabel: "Similar spelling",
		verbLabel: "Similar spelling",
		description: "Forgives a typo or two per word and ignores capitalization",
	},
	"starts-with": {
		pickerLabel: "Begins with",
		verbLabel: "starts with",
		description: "Begins with the text and keeps capitalization exact",
	},
	phonetic: {
		pickerLabel: "Sounds like",
		verbLabel: "sounds like",
		description: "Matches words that sound alike, such as Smith and Smyth",
	},
	"fuzzy-date": {
		pickerLabel: "Flexible date",
		verbLabel: "Flexible date",
		description: "Forgives a swapped day and month or mistyped digits",
	},
};
