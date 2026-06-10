/**
 * The ONE hashtag-segment definition every Nova hashtag matcher is built
 * from. A hashtag reference (`#form/group/field`, `#mother/age`, `#user/x`)
 * is a `#`, a namespace segment, then one or more `/`-joined path segments —
 * and "segment" must mean exactly the same thing to all three matchers that
 * locate refs:
 *
 *   1. `lib/commcare/proseHashtags.ts::BARE_HASHTAG_PATTERN` — locates refs
 *      embedded in PROSE (labels/hints) for the emitter + deep validator.
 *   2. `lib/references/config.ts::HASHTAG_REF_PATTERN` — locates refs for
 *      the editor surfaces (chips, TipTap, preview label resolution).
 *   3. The Lezer XPath grammar's `HashtagType` / `HashtagSegment` tokens
 *      (`lib/commcare/xpath/grammar.lezer.grammar::localName`) — defines a
 *      ref's structure inside an XPath expression for the wire emitter,
 *      rewriters, and linter.
 *
 * If the three disagree on a segment's extent, a ref one layer rewrites is a
 * ref another layer can't find — rename/move rewriting, chip rendering, and
 * wire emission silently diverge. Both regexes are built from this source;
 * the grammar can't import TS, so lockstep with it is enforced by the
 * divergence-corpus test
 * (`lib/commcare/xpath/__tests__/hashtagMatchers.divergence.test.ts`).
 *
 * A segment is an ASCII identifier that may carry digits, `_`, and `-`
 * (matching the grammar's dedicated `hashtagName` token — ASCII-only,
 * unlike the full-Unicode `localName` XPath element names ride on), and
 * deliberately NOT `.` — so a ref at the end of a sentence
 * ("see #form/age.") never captures the trailing punctuation. The pattern stays namespace-agnostic: any identifier is a
 * namespace (per-case-type refs like `#mother/age` included); deciding which
 * matches actually RESOLVE is the resolve gate's / emitter's / validator's
 * job, never the pattern's.
 *
 * This lives in `lib/domain` (not `lib/commcare`) because `lib/references`
 * is not an allowlisted consumer of the `@/lib/commcare` boundary
 * (`biome.json::noRestrictedImports`), while both `lib/commcare` and
 * `lib/references` legitimately import the domain layer.
 */

/** Regex source for ONE hashtag segment (namespace or path segment). */
export const HASHTAG_SEGMENT_SOURCE = "[A-Za-z_][A-Za-z0-9_-]*";

/**
 * Regex source for a full hashtag reference: `#<namespace>(/<segment>)+`.
 * Group 1 captures the namespace (the token between `#` and the first `/`).
 */
export const HASHTAG_REF_SOURCE = `#(${HASHTAG_SEGMENT_SOURCE})(?:\\/${HASHTAG_SEGMENT_SOURCE})+`;

/**
 * Build a fresh hashtag-reference RegExp. Returned WITHOUT the `g` flag by
 * default: a shared global regex carries mutable `lastIndex` state, so each
 * consumer that scans builds its own global instance
 * (`new RegExp(pattern, "g")` or `buildHashtagRefRegex("g")`).
 */
export function buildHashtagRefRegex(flags = ""): RegExp {
	return new RegExp(HASHTAG_REF_SOURCE, flags);
}
