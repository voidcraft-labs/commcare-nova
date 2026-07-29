/**
 * The ONE hashtag-segment definition every Nova hashtag matcher is built
 * from. A hashtag reference (`#form/group/field`, `#mother/age`, `#user/x`)
 * is a `#`, a namespace segment, then one or more `/`-joined path segments —
 * and "segment" must mean exactly the same thing to the two parsers that
 * locate friendly refs:
 *
 *   1. `lib/references/config.ts::HASHTAG_REF_PATTERN` — locates printed
 *      references for editor chips.
 *   2. The Lezer XPath grammar's `HashtagType` / `HashtagSegment` tokens
 *      (`lib/commcare/xpath/grammar.lezer.grammar::localName`) — defines a
 *      ref's structure inside human-authored XPath.
 *
 * If they disagree on a segment's extent, a friendly ref the editor chips is
 * not the ref the parser stores. The regex is built from this source; the
 * grammar can't import TS, so lockstep with it is enforced by the
 * divergence-corpus test
 * (`lib/commcare/xpath/__tests__/hashtagMatchers.divergence.test.ts`).
 *
 * A segment is an ASCII identifier that may carry digits, `_`, and `-`
 * (matching the grammar's dedicated `hashtagName` token — ASCII-only,
 * unlike the full-Unicode `localName` XPath element names ride on), and
 * deliberately NOT `.` — so a ref at the end of a sentence
 * ("see #form/age.") never captures the trailing punctuation. The pattern
 * stays namespace-agnostic: any identifier is a namespace (per-case-type refs
 * like `#mother/age` included); the typed resolve gate decides whether a match
 * becomes a stored identity or stays literal text.
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
const HASHTAG_REF_SOURCE = `#(${HASHTAG_SEGMENT_SOURCE})(?:\\/${HASHTAG_SEGMENT_SOURCE})+`;

/**
 * Build a fresh hashtag-reference RegExp. Returned WITHOUT the `g` flag by
 * default: a shared global regex carries mutable `lastIndex` state, so each
 * consumer that scans builds its own global instance
 * (`new RegExp(pattern, "g")` or `buildHashtagRefRegex("g")`).
 */
export function buildHashtagRefRegex(flags = ""): RegExp {
	return new RegExp(HASHTAG_REF_SOURCE, flags);
}
