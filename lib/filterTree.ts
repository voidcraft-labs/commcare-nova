/**
 * Tree-filter utilities for the sidebar search UI.
 *
 * Only `highlightSegments` + `MatchIndices` remain — the sidebar computes
 * its own match set directly from the normalized doc store
 * (`components/builder/AppTree.tsx#useSearchFilter`). The old
 * `filterTree()` returned a deep copy of a legacy `TreeData` structure
 * that no consumer still reads, so it was removed along with the
 * `TreeData` type and the `useDocTreeData` hook that produced it.
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
