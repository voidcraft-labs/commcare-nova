/** Host-specific ceiling for reads that can return substantial app content.
 * Bounded reads retain their own completeness contract. Static role guidance
 * uses an ordinary result; downloadable archives may spill to a client file. */
export const MAX_RESULT_SIZE_CHARS = 100_000;

/**
 * The `_meta` block a tool registers to declare {@link
 * MAX_RESULT_SIZE_CHARS}. Shared so the key is spelled once — it is a
 * host-specific string with no compile-time checking behind it, and a
 * typo would fail exactly the way the original bug did: silently, with
 * the result truncated and nothing saying so.
 */
export const LARGE_RESULT_META = {
	"anthropic/maxResultSizeChars": MAX_RESULT_SIZE_CHARS,
} as const;
