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

import type { IconifyIcon } from "@iconify/react/offline";
import type { FieldPath } from "@/lib/doc/fieldPath";
import { HASHTAG_REF_PATTERN } from "./config";
import { ReferenceProvider } from "./provider";
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
 * Resolve a parsed expression string to a Reference. When a provider is
 * available, delegates to it for rich resolution (field label, type icon).
 * Returns null if the provider can't resolve — unresolvable refs render as
 * plain text on the canvas to avoid misleading chips for typos or stale refs.
 *
 * When no provider is passed (null), falls back to pattern-based parsing that
 * produces a basic Reference with the path as the label — used by surfaces
 * outside the ReferenceProvider context (e.g. structure sidebar). Optional
 * `iconOverrides` enriches form refs with field-kind icons in this mode.
 */
export function resolveRefFromExpr(
	expr: string,
	provider: ReferenceProvider | null,
	iconOverrides?: Map<string, IconifyIcon>,
): Reference | null {
	if (provider) return provider.resolve(expr);
	const parsed = ReferenceProvider.parse(expr);
	if (!parsed) return null;
	return parsed.type === "form"
		? {
				type: "form",
				path: parsed.path as FieldPath,
				label: parsed.path,
				raw: expr,
				icon: iconOverrides?.get(parsed.path),
			}
		: { type: parsed.type, path: parsed.path, label: parsed.path, raw: expr };
}
