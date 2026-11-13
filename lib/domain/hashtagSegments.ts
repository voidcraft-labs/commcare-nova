/**
 * The ONE hashtag-segment definition every Nova hashtag matcher is built
 * from. A hashtag reference (`#form/group/field`, `#mother/age`, `#user/x`)
 * is a `#`, a namespace segment, then one or more `/`-joined path segments —
 * and "segment" must mean exactly the same thing to the two parsers that
 * locate friendly refs:
 *
 *   1. `lib/references/config.ts::HASHTAG_REF_PATTERN` — locates printed
 *      references in prose for chips (expression chips come from parse spans).
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
 * A segment is a run of ASCII letters, digits, `_` and `-`, the case type
 * grammar exactly (matching the grammar's dedicated `hashtagName` token,
 * ASCII-only, unlike the full-Unicode `localName` XPath element names ride
 * on), and deliberately NOT `.` — so a ref at the end of a sentence
 * ("see #form/age.") never captures the trailing punctuation. The pattern
 * stays namespace-agnostic: any segment is a namespace (per-case-type refs
 * like `#mother/age` included); the typed resolve gate decides whether a match
 * becomes a stored identity or stays literal text.
 *
 * Reference text names a record type two ways: `#<type>/<property>` where the
 * type is not one of `HASHTAG_FIXED_NAMESPACES`, and `#record/<type>/<property>`
 * for any type. `caseReferenceText` is the one printer and `readCaseReference`
 * the one reader every surface uses.
 *
 * This lives in `lib/domain` (not `lib/commcare`) because `lib/references`
 * is not an allowlisted consumer of the `@/lib/commcare` boundary
 * (`biome.json::noRestrictedImports`), while both `lib/commcare` and
 * `lib/references` legitimately import the domain layer.
 */

/** Regex source for ONE hashtag segment (namespace or path segment). */
export const HASHTAG_SEGMENT_SOURCE = "[A-Za-z0-9_-]+";

/** The namespaces reference text fixes, which no case type's short form can take. */
export const HASHTAG_FIXED_NAMESPACES = [
	"form",
	"user",
	"search",
	"case",
	"record",
	"row",
] as const;

function isFixedNamespace(name: string): boolean {
	return (HASHTAG_FIXED_NAMESPACES as readonly string[]).includes(name);
}

/** The text before the property: `#record/<type>/` or `#<type>/`. What a completion
 * offers and inserts for a record type. */
export function caseReferencePrefix(caseType: string): string {
	return isFixedNamespace(caseType) ? `#record/${caseType}/` : `#${caseType}/`;
}

/** The record type a completion namespace names: the text between `#` and the
 * property's `/` in `caseReferencePrefix`'s spelling (`record/<type>`, or a
 * type's short form), or `undefined` for a fixed namespace. */
export function caseReferenceNamespaceType(
	namespace: string,
): string | undefined {
	if (namespace.startsWith("record/")) return namespace.slice("record/".length);
	return isFixedNamespace(namespace) ? undefined : namespace;
}

/** `#record/<type>/<property>` where the type is a fixed namespace, else `#<type>/<property>`. */
export function caseReferenceText(caseType: string, property: string): string {
	return caseReferencePrefix(caseType) + property;
}

/** The record type and property a hashtag names, or `undefined` when it names neither:
 * `record` with two segments, or any other unfixed namespace with one. */
export function readCaseReference(
	namespace: string,
	segments: readonly string[],
): { caseType: string; property: string } | undefined {
	const [first, second, ...rest] = segments;
	if (namespace === "record")
		return first !== undefined && second !== undefined && rest.length === 0
			? { caseType: first, property: second }
			: undefined;
	if (isFixedNamespace(namespace)) return undefined;
	return first !== undefined && second === undefined
		? { caseType: namespace, property: first }
		: undefined;
}

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
