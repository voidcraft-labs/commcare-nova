/**
 * Label and expression parsing utilities for the chip reference system.
 *
 * Provides segment parsing (splitting text into plain text + reference matches)
 * and reference resolution for building React component trees with ReferenceChip
 * nodes. Used by ExpressionContent, RefLabelInput, LabelContent, and AppTree.
 *
 * All internal label text uses bare `#type/path` hashtags as the canonical
 * format.
 */

import { HASHTAG_REF_PATTERN } from "./config";
import type { ReferenceProvider } from "./provider";
import type { Reference } from "./types";

/** A segment from splitting text on a reference-matching pattern.
 *  Each segment gets a unique `key` at creation time via `crypto.randomUUID()`.
 *  `parseLabelSegments` caches results by input string, so the same text always
 *  returns the same segment objects with the same keys. */
export type LabelSegment =
	| { kind: "text"; text: string; key: string }
	| { kind: "ref"; value: string; key: string };

/**
 * Split text into alternating text and reference segments based on a regex.
 * The pattern must not have the `g` flag — a global copy is created internally
 * to avoid shared mutable `lastIndex` state. `extractValue` maps each regex
 * match to the string stored in the ref segment.
 */
function splitOnPattern(
	text: string,
	pattern: RegExp,
	extractValue: (match: RegExpExecArray) => string,
): LabelSegment[] {
	const segments: LabelSegment[] = [];
	const globalPattern = new RegExp(pattern, "g");
	let lastIndex = 0;
	let match: RegExpExecArray | null = globalPattern.exec(text);

	while (match !== null) {
		if (match.index > lastIndex) {
			segments.push({
				kind: "text",
				text: text.slice(lastIndex, match.index),
				key: crypto.randomUUID(),
			});
		}
		segments.push({
			kind: "ref",
			value: extractValue(match),
			key: crypto.randomUUID(),
		});
		lastIndex = globalPattern.lastIndex;
		match = globalPattern.exec(text);
	}

	if (lastIndex < text.length) {
		segments.push({
			kind: "text",
			text: text.slice(lastIndex),
			key: crypto.randomUUID(),
		});
	}

	return segments;
}

/**
 * Parse text into segments of plain text and `#type/path` hashtag references.
 * Used by RefLabelInput (TipTap hydration), LabelContent (markdown chip rule),
 * ExpressionContent (calculate/default chips), and AppTree (sidebar chips).
 *
 * Results are cached by input string — same text always returns the same
 * segment objects with the same `key` values, so callers don't need to
 * memoize. Cache invalidates naturally when label text changes (different key).
 */
/** Bounded cache — evicts all entries when full to avoid unbounded memory growth
 *  in long editing sessions with many label variations. 512 entries covers a
 *  large form's worth of unique label strings with room to spare. */
const SEGMENT_CACHE_MAX = 512;
const segmentCache = new Map<string, LabelSegment[]>();

export function parseLabelSegments(text: string): LabelSegment[] {
	const cached = segmentCache.get(text);
	if (cached) return cached;
	if (segmentCache.size >= SEGMENT_CACHE_MAX) segmentCache.clear();
	const segments = splitOnPattern(text, HASHTAG_REF_PATTERN, (m) => m[0]);
	segmentCache.set(text, segments);
	return segments;
}

/**
 * Resolve an expression string to a Reference, scoped to `formUuid`. Delegates
 * entirely to the provider — there is no syntactic fallback: per the locked
 * decision we never render a chip that doesn't resolve, so an unresolvable ref
 * (typo, stale path, unreachable case type, or no provider yet) returns null
 * and the caller renders plain text. `formUuid` scopes form/case resolution to
 * the form the ref belongs to (the active form in-editor; the field's owning
 * form in the sidebar).
 */
export function resolveRefFromExpr(
	expr: string,
	provider: ReferenceProvider | null,
	formUuid?: string,
): Reference | null {
	if (!provider) return null;
	return provider.resolve(expr, formUuid);
}
