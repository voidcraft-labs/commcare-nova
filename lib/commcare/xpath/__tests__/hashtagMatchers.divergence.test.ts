/**
 * Divergence corpus — holds the THREE hashtag matchers in lockstep:
 *
 *   1. `BARE_HASHTAG_PATTERN` (prose location: emitter + deep validator),
 *   2. `HASHTAG_REF_PATTERN` (editor surfaces: chips, TipTap, preview),
 *   3. the Lezer grammar's `HashtagRef` (XPath surfaces: wire emitter,
 *      rewriters, linter).
 *
 * Both regexes are built from `lib/domain/hashtagSegments.ts`; the grammar
 * cannot import TS, so THIS corpus is the only thing keeping its
 * `HashtagType` / `HashtagSegment` tokens in agreement. Every entry is run
 * through all three and asserted to agree on match/no-match and captured
 * extent:
 *
 *   - Regex legs: global scans of the raw entry must produce exactly the
 *     expected spans — both patterns identically.
 *   - Grammar leg (a): each expected span, parsed STANDALONE, must be one
 *     clean (error-free) `HashtagRef` covering the whole span. This mirrors
 *     the real prose pipeline — prose is NEVER parsed as XPath wholesale
 *     (markdown around a ref parses as XPath operators and swallows the
 *     `#`); the regex locates each ref, then the located ref is parsed
 *     per-hashtag. Standalone agreement is exactly the contract that
 *     pipeline needs.
 *   - Grammar leg (b): when the whole entry parses as VALID XPath (no
 *     error nodes anywhere), the clean `HashtagRef` spans inside the
 *     expression must equal the expected spans — the expression-surface
 *     agreement the rewriters and the emitter rely on.
 *   - Non-ref entries must produce zero spans from the regexes and zero
 *     clean `HashtagRef` nodes from a whole-entry parse.
 */
import { describe, expect, it } from "vitest";
import { BARE_HASHTAG_PATTERN } from "@/lib/commcare/proseHashtags";
import { parser } from "@/lib/commcare/xpath";
import { HASHTAG_REF_PATTERN } from "@/lib/references/config";

interface Span {
	from: number;
	to: number;
}

/** All matches of `pattern` (fresh global instance) in `text`. */
function regexSpans(pattern: RegExp, text: string): Span[] {
	const spans: Span[] = [];
	for (const m of text.matchAll(new RegExp(pattern.source, "g"))) {
		spans.push({ from: m.index, to: m.index + m[0].length });
	}
	return spans;
}

/** True when the tree under `text`'s parse contains any error node. */
function parseHasErrors(text: string): boolean {
	let hasError = false;
	parser.parse(text).iterate({
		enter(node) {
			if (node.type.isError) hasError = true;
		},
	});
	return hasError;
}

/** Spans of HashtagRef nodes that contain NO error nodes (i.e. were parsed
 *  by the real grammar rule, not stitched together by error recovery). */
function cleanHashtagSpans(text: string): Span[] {
	const spans: Span[] = [];
	parser.parse(text).iterate({
		enter(node) {
			if (node.type.name !== "HashtagRef") return;
			let clean = true;
			node.node.toTree().iterate({
				enter(inner) {
					if (inner.type.isError) clean = false;
				},
			});
			if (clean) spans.push({ from: node.from, to: node.to });
			return false;
		},
	});
	return spans;
}

/** One corpus entry: the text plus the substrings every matcher must
 *  agree are the hashtag refs in it (in order). */
interface CorpusEntry {
	text: string;
	refs: string[];
}

const CORPUS: CorpusEntry[] = [
	// Plain refs across the namespaces.
	{ text: "#form/age", refs: ["#form/age"] },
	{ text: "#user/username", refs: ["#user/username"] },
	// Per-case-type ref — the namespace is ANY identifier.
	{ text: "#mother/age", refs: ["#mother/age"] },
	// Segments with `-`, digits, leading underscore.
	{ text: "#form/my-field", refs: ["#form/my-field"] },
	{ text: "#form/q1", refs: ["#form/q1"] },
	{ text: "#form/_private", refs: ["#form/_private"] },
	// Multi-segment (nested groups) — both directions of the re-anchor.
	{ text: "#form/group/sub/field", refs: ["#form/group/sub/field"] },
	{ text: "#case/parent/age", refs: ["#case/parent/age"] },
	// Segments must NOT capture `.` — neither mid-ref nor as trailing
	// sentence punctuation.
	{ text: "#form/age.", refs: ["#form/age"] },
	{ text: "see #form/age.", refs: ["#form/age"] },
	{ text: "#form/a.b", refs: ["#form/a"] },
	// Parenthesized / markdown-adjacent / inside an expression.
	{ text: "(#form/age)", refs: ["#form/age"] },
	{ text: "**#form/age**", refs: ["#form/age"] },
	{ text: "#form/q1 + 1", refs: ["#form/q1"] },
	{ text: "concat(#form/a, #form/b)", refs: ["#form/a", "#form/b"] },
	// A `//` after a ref is a descendant step, never a ref segment.
	{ text: "#form/a//b", refs: ["#form/a"] },
	// Non-refs that must NOT match anywhere.
	{ text: "#1tag", refs: [] },
	{ text: "#", refs: [] },
	{ text: "# form/x", refs: [] },
	{ text: "#form /x", refs: [] },
	{ text: "#form/ x", refs: [] },
	{ text: "plain prose, no refs", refs: [] },
];

/** Resolve an entry's expected ref substrings to spans (in order). */
function expectedSpans(entry: CorpusEntry): Span[] {
	const spans: Span[] = [];
	let searchFrom = 0;
	for (const ref of entry.refs) {
		const idx = entry.text.indexOf(ref, searchFrom);
		if (idx < 0) throw new Error(`corpus bug: "${ref}" not in "${entry.text}"`);
		spans.push({ from: idx, to: idx + ref.length });
		searchFrom = idx + ref.length;
	}
	return spans;
}

describe("hashtag matcher divergence corpus", () => {
	for (const entry of CORPUS) {
		describe(JSON.stringify(entry.text), () => {
			const expected = expectedSpans(entry);

			it("BARE_HASHTAG_PATTERN matches exactly the expected spans", () => {
				expect(regexSpans(BARE_HASHTAG_PATTERN, entry.text)).toEqual(expected);
			});

			it("HASHTAG_REF_PATTERN matches exactly the expected spans", () => {
				expect(regexSpans(HASHTAG_REF_PATTERN, entry.text)).toEqual(expected);
			});

			it("grammar agrees on each located ref's structure and extent", () => {
				// The prose pipeline: the regex locates a ref, then the located
				// ref is parsed per-hashtag. Each located span must parse
				// standalone as ONE clean HashtagRef covering the whole span.
				for (const span of expected) {
					const ref = entry.text.slice(span.from, span.to);
					expect(cleanHashtagSpans(ref), ref).toEqual([
						{ from: 0, to: ref.length },
					]);
				}
			});

			it("grammar finds the same spans on the expression surface", () => {
				if (parseHasErrors(entry.text)) {
					// Not a valid XPath expression — prose-shaped. The grammar
					// must still produce NO clean ref the regexes don't see
					// (clean spans ⊆ expected), and the located-ref leg above
					// covers the rest.
					const clean = cleanHashtagSpans(entry.text);
					for (const span of clean) {
						expect(expected).toContainEqual(span);
					}
				} else {
					expect(cleanHashtagSpans(entry.text)).toEqual(expected);
				}
			});
		});
	}
});
