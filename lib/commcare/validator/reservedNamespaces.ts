/**
 * The reserved hashtag namespaces, in ONE place so the two consumers that
 * encode "what is reserved" — the case-ref validity check
 * (`xpathValidator.ts::checkCaseHashtag`) and the case-type-name guard
 * (`rules/app.ts::reservedCaseTypeName`) — can't silently drift apart. The two
 * need related-but-different sets, both derived from the same base below.
 */

/**
 * Namespaces the wire's flat hashtag resolver handles directly, before any
 * per-case-type lookup. A `#<one-of-these>/<...>` ref always resolves to its built-in
 * namespace, never to a project case type of the same name — so the validator
 * must NOT reject one as an "unknown case type" (it would be stricter than the
 * wire, which resolves it).
 */
export const RESOLVED_REFERENCE_NAMESPACES: ReadonlySet<string> = new Set([
	"form",
	"user",
	"search",
]);

/**
 * Case-type names a project may NOT take, because each collides with a reserved
 * reference namespace. A superset of the resolvable namespaces plus `parent`:
 * `#parent/` is a reserved case-index segment, not a resolvable top-level
 * namespace, so it blocks a case-type NAME without belonging in the resolution
 * skip-set above.
 */
export const RESERVED_CASE_TYPE_NAMES: ReadonlySet<string> = new Set([
	...RESOLVED_REFERENCE_NAMESPACES,
	"case",
	"parent",
]);
