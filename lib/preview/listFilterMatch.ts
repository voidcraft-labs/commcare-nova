// lib/preview/listFilterMatch.ts
//
// Core's case list filter, ported: the rule a device and Formplayer both run
// when a worker types into a list's filter box. Pure, and exact to the Java it
// ports, so Preview finds the rows a runtime finds.
//
//   - `normalizeForFilter` is commcare-core
//     `cases/util/StringUtils.java::normalize`: NFD, the combining marks of
//     `\p{InCombiningDiacriticalMarks}` (the block U+0300 to U+036F) removed,
//     then lower case.
//   - `fuzzyMatch` is `StringUtils.fuzzyMatch(source, target)` at its threshold
//     of 2, with its Levenshtein distance over UTF-16 code units, as Java's
//     `String.charAt` reads them.
//   - `rowFilterScore` is the loop of `util/EntitySortUtil.java::sortEntities`
//     for one entity, the fuzzy pieces of a field read as
//     `cases/entity/Entity.java::getSortFieldPieces` reads them.
//   - `filterTerms` is what each runtime makes of the typed text before it
//     calls that loop: Formplayer's `searchText.split(" ")`
//     (`util/screen/EntityScreenHelper.java::filterEntities`) and Android's
//     `filterRaw.split("\\s+")` (`adapters/EntityListAdapter.java::filterByString`),
//     each with Java's `String.split` rules, each term normalized.

/** The edit distance `StringUtils.fuzzyMatch(source, target)` allows. */
const FUZZY_DISTANCE_THRESHOLD = 2;

/** The source length a fuzzy match needs to exceed (`source.length() > 3`). */
const FUZZY_MINIMUM_SOURCE_LENGTH = 3;

/** `\p{InCombiningDiacriticalMarks}+`: Java's block property, not a category. */
const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]+/g;

/** Java's `\s`, which is ASCII whitespace alone: space, tab, line feed, vertical
 *  tab, form feed and carriage return. JavaScript's `\s` reaches further. */
const JAVA_WHITESPACE_RUN = /[ \t\n\v\f\r]+/g;
const SINGLE_SPACE = / /g;

/** Core's `StringUtils.normalize`: NFD, combining marks U+0300 to U+036F removed, lower case. */
export function normalizeForFilter(text: string): string {
	return text
		.normalize("NFD")
		.replace(COMBINING_DIACRITICAL_MARKS, "")
		.toLowerCase();
}

/** Core's `StringUtils.fuzzyMatch(source, target)` at its threshold of 2.
 *
 *  A `source` of three code units or fewer never matches. A longer one is
 *  compared with `target` cut to `source.length + 2` code units, and matches
 *  where their Levenshtein distance is at most 2. `distance` is that distance
 *  for a match and `-1` otherwise, as Core's pair holds it. */
export function fuzzyMatch(
	source: string,
	target: string,
): { matches: boolean; distance: number } {
	if (source.length <= FUZZY_MINIMUM_SOURCE_LENGTH)
		return { matches: false, distance: -1 };
	const cut =
		target.length > source.length + FUZZY_DISTANCE_THRESHOLD
			? target.substring(0, source.length + FUZZY_DISTANCE_THRESHOLD)
			: target;
	const distance = levenshteinDistance(source, cut);
	return distance <= FUZZY_DISTANCE_THRESHOLD
		? { matches: true, distance }
		: { matches: false, distance: -1 };
}

/** `StringUtils.LevenshteinDistance`: two rolling rows over UTF-16 code units. */
function levenshteinDistance(s0: string, s1: string): number {
	const len0 = s0.length + 1;
	const len1 = s1.length + 1;
	let cost = Array.from({ length: len0 }, (_, i) => i);
	let newcost = new Array<number>(len0).fill(0);
	for (let j = 1; j < len1; j++) {
		newcost[0] = j;
		for (let i = 1; i < len0; i++) {
			const match = s0.charCodeAt(i - 1) === s1.charCodeAt(j - 1) ? 0 : 1;
			newcost[i] = Math.min(
				cost[i] + 1,
				newcost[i - 1] + 1,
				cost[i - 1] + match,
			);
		}
		[cost, newcost] = [newcost, cost];
	}
	return cost[len0 - 1];
}

/**
 * Java's `String.split(regex)` with no limit, for a separator that never
 * matches the empty string: no match gives the text itself, a separator at
 * the start gives an empty first piece, an empty piece between two
 * separators is kept, and every empty piece at the end is dropped.
 */
function javaSplit(text: string, separator: RegExp): string[] {
	const pieces: string[] = [];
	let index = 0;
	let matched = false;
	for (const match of text.matchAll(separator)) {
		matched = true;
		pieces.push(text.substring(index, match.index));
		index = match.index + match[0].length;
	}
	if (!matched) return [text];
	pieces.push(text.substring(index));
	while (pieces.length > 0 && pieces[pieces.length - 1] === "") pieces.pop();
	return pieces;
}

/** The terms a runtime makes of what a worker typed, each normalized. */
export function filterTerms(
	text: string,
	split: "whitespace-runs" | "single-spaces",
): readonly string[] {
	return javaSplit(
		text,
		split === "whitespace-runs" ? JAVA_WHITESPACE_RUN : SINGLE_SPACE,
	).map(normalizeForFilter);
}

/** One row's verdict: whether every term matched, and the summed distance of its fuzzy matches.
 *
 *  For each term in order, each field in order: the field matches where its
 *  normalized text is not empty and contains the term; otherwise, with
 *  `fuzzy` on, where the term fuzzily matches a whitespace-separated piece of
 *  the field's normalized `sortText`, whose distance the score adds. A field
 *  that keeps no sort text (`null`) has no pieces. The first field that
 *  matches a term decides it, and a term no field matches fails the row. No
 *  terms pass every row. */
export function rowFilterScore(
	terms: readonly string[],
	fields: readonly {
		readonly text: string;
		readonly sortText: string | null;
	}[],
	fuzzy: boolean,
): { readonly matches: boolean; readonly score: number } {
	let score = 0;
	const normalized = fields.map((field) => ({
		text: normalizeForFilter(field.text),
		pieces:
			field.sortText === null
				? []
				: javaSplit(normalizeForFilter(field.sortText), JAVA_WHITESPACE_RUN),
	}));
	for (const rawTerm of terms) {
		const term = normalizeForFilter(rawTerm);
		const distance = termDistance(term, normalized, fuzzy);
		if (distance === undefined) return { matches: false, score: 0 };
		score += distance;
	}
	return { matches: true, score };
}

/** How one term matches a row: 0 for a field holding it, a fuzzy match's
 *  distance, or `undefined` where no field matches it. */
function termDistance(
	term: string,
	fields: readonly {
		readonly text: string;
		readonly pieces: readonly string[];
	}[],
	fuzzy: boolean,
): number | undefined {
	for (const field of fields) {
		if (field.text !== "" && field.text.includes(term)) return 0;
		if (!fuzzy) continue;
		for (const piece of field.pieces) {
			const match = fuzzyMatch(term, piece);
			if (match.matches) return match.distance;
		}
	}
	return undefined;
}
