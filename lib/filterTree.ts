/**
 * Shared types + rendering helper for sidebar search highlighting.
 *
 * `MatchIndices` carries inclusive `[start, end]` ranges pointing at
 * substrings inside a piece of display text. `highlightSegments` slices
 * the text along those ranges, merging adjacent/overlapping spans so
 * the renderer never emits an empty non-highlight gap between two hits
 * that touch.
 *
 * The sidebar search hook
 * (`components/builder/appTree/useSearchFilter.ts`) produces the
 * indices by walking the normalized doc store; the shared
 * `HighlightedText` renderer in `components/builder/appTree/shared.tsx`
 * consumes them to render `<mark>` segments. Keeping the types + slicer
 * here lets both sides agree on one range format without either
 * importing from the other.
 */

/** Match indices as [start, end] pairs for highlighting. */
export type MatchIndices = ReadonlyArray<readonly [number, number]>;

/** Split text into highlighted and non-highlighted segments using match indices. */
export function highlightSegments(
	text: string,
	indices: MatchIndices,
): Array<{ text: string; highlight: boolean }> {
	if (!indices.length) return [{ text, highlight: false }];

	// Merge overlapping/adjacent ranges — callers may pass unsorted or
	// touching ranges (common when several search hits land inside a
	// single word). Merging up front avoids emitting a no-op "non-
	// highlight" segment between two adjacent hits.
	const merged: Array<[number, number]> = [];
	const sorted = [...indices].sort((a, b) => a[0] - b[0]);
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1] + 1) {
			last[1] = Math.max(last[1], end);
		} else {
			merged.push([start, end]);
		}
	}

	const segments: Array<{ text: string; highlight: boolean }> = [];
	let cursor = 0;

	for (const [start, end] of merged) {
		if (cursor < start) {
			segments.push({ text: text.slice(cursor, start), highlight: false });
		}
		segments.push({ text: text.slice(start, end + 1), highlight: true });
		cursor = end + 1;
	}

	if (cursor < text.length) {
		segments.push({ text: text.slice(cursor), highlight: false });
	}

	return segments;
}
