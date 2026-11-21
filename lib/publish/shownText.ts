/**
 * A text an app supplies, cut to what one line a person reads may hold.
 *
 * Client-safe: no server module, no Node API.
 */

/** The bounds of a shown text: what a person reads (grapheme clusters) and
 *  what it costs to send and hold (UTF-16 code units, which JSON's length
 *  and every page limit count). */
export interface ShownTextBounds {
	readonly graphemes: number;
	readonly units: number;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The mark that ends a text that was cut. */
const CUT = "…";

/**
 * `text` whole where it holds at most `bounds.graphemes` grapheme clusters in
 * at most `bounds.units` code units; otherwise its longest beginning that, with
 * `…` after it, holds no more of either. A cluster (a letter with its
 * combining marks, an emoji sequence joined by a zero-width joiner) is what a
 * person reads as one character, so a cut never splits one, nor a surrogate
 * pair.
 *
 * The work is bounded by `bounds.units`, never by the text: only its first
 * `units + 2` code units are segmented, enough to hold every whole code point
 * up to the bound, so the boundary at `units` is decided as the whole text
 * decides it.
 */
export function cutShown(text: string, bounds: ShownTextBounds): string {
	const { graphemes, units } = bounds;
	const window = text.length > units + 2 ? text.slice(0, units + 2) : text;
	let count = 0;
	/* The end of the longest beginning that leaves room for the mark. */
	let kept = 0;
	for (const part of GRAPHEMES.segment(window)) {
		const end = part.index + part.segment.length;
		count += 1;
		if (count > graphemes || end > units) return `${text.slice(0, kept)}${CUT}`;
		if (count < graphemes && end < units) kept = end;
	}
	return text;
}
