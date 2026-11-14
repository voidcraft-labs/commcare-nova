/**
 * Core's two string functions of the case list filter, one table held on both
 * sides: `listFilterMatch.test.ts` runs each row through Preview's port
 * (`lib/preview/listFilterMatch.ts`), and
 * `proof/native/core/ListFilterMatchRuntimeTest.java` runs the same rows
 * through commcare-core's `org.commcare.cases.util.StringUtils.normalize` and
 * `fuzzyMatch` at the pin (the producer
 * `proof/native/producers/emit-expression-evidence.ts` writes this table as
 * `/expression/list-filter-match.json`). Every expected value is worked from
 * Core's source: `normalize` is NFD, the combining marks U+0300 to U+036F
 * removed, then lower case; `fuzzyMatch` never matches a source of three
 * characters or fewer, cuts a target longer than the source by more than two
 * characters to the source's length plus two, and matches at a Levenshtein
 * distance of two or less over UTF-16 code units, giving `-1` for no match.
 */

export interface NormalizeVector {
	readonly text: string;
	readonly normalized: string;
}

export interface FuzzyMatchVector {
	readonly source: string;
	readonly target: string;
	readonly matches: boolean;
	/** The distance Core's pair holds: `-1` where it does not match. */
	readonly distance: number;
}

export const LIST_FILTER_NORMALIZE_VECTORS: readonly NormalizeVector[] = [
	{ text: "José", normalized: "jose" },
	{ text: "JOSÉ", normalized: "jose" },
	// A precomposed letter and its decomposed spelling normalize alike.
	{ text: "José", normalized: "jose" },
	{ text: "Ñandú", normalized: "nandu" },
	// The dot of the capital I is a combining mark once decomposed, and goes
	// before the lower case is taken.
	{ text: "İstanbul", normalized: "istanbul" },
	// A mark outside U+0300 to U+036F stays (U+1DC4, a supplementary mark).
	{ text: "a᷄", normalized: "a᷄" },
	{ text: "", normalized: "" },
	{ text: "  Ann  Lee ", normalized: "  ann  lee " },
];

export const LIST_FILTER_FUZZY_VECTORS: readonly FuzzyMatchVector[] = [
	{ source: "smith", target: "smyth", matches: true, distance: 1 },
	{ source: "smit", target: "smith", matches: true, distance: 1 },
	// Three characters are too short for a fuzzy match, however close.
	{ source: "smi", target: "smith", matches: false, distance: -1 },
	{ source: "ann", target: "ann", matches: false, distance: -1 },
	// The target is cut to six characters, `johnat`, two from `john`.
	{ source: "john", target: "johnathan", matches: true, distance: 2 },
	{ source: "maria", target: "mark", matches: true, distance: 2 },
	{ source: "maria", target: "peter", matches: false, distance: -1 },
	{ source: "maria", target: "maria", matches: true, distance: 0 },
	{ source: "amina", target: "", matches: false, distance: -1 },
	// Code units, not characters: the face is two of them, so the source is
	// five long and its target one substitution away.
	{
		source: "\u{1f600}abc",
		target: "\u{1f600}abd",
		matches: true,
		distance: 1,
	},
];
