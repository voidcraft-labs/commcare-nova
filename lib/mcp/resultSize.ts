/**
 * How large a single MCP tool result may be before the host stops
 * delivering it.
 *
 * Hosts cap tool results. Past the cap, Claude Code replaces the result
 * with a ~2,000-char preview plus a path to the full text on disk. That
 * fallback assumes the reader can open files, and the plugin's
 * autonomous subagent is allowlisted to Nova's MCP tools and nothing
 * else — deliberately, since an app builder has no business reading the
 * user's filesystem. So for that caller a capped result is not a
 * degraded result; it is a lost one, and it has no way to tell.
 *
 * The default cap sits below what several Nova tools legitimately
 * return. `get_agent_prompt` renders a whole system prompt, and the
 * largest app in production renders a 73,534-char summary through
 * `get_app`. Declaring a size per tool via `_meta` at `tools/list` time
 * raises it for that tool.
 *
 * `_meta` is the MCP spec's namespaced passthrough, so a host that
 * doesn't recognize this key ignores it — the intended degradation. The
 * key itself is Claude Code's, not part of the spec, which is why
 * nothing may depend on it silently: a large served prompt is split into
 * snapshot-bound continuation pages that stay below a separate, conservative
 * model-facing transport budget, and the assembled prompt carries
 * `PROMPT_END_MARKER` so a caller can prove delivery instead of assuming it.
 *
 * **This is a ceiling, not a budget to spend.** Bounded tools, such as
 * `search_blueprint`, keep their own explicit completeness contract.
 *
 * Tools whose result is a payload to be saved rather than read —
 * `compile_app`'s base64 archives — deliberately keep the default.
 * Spilling those to a file is the correct outcome, and raising their
 * ceiling would flood a context with megabytes of base64.
 */
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
