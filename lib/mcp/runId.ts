/**
 * Resolve the `run_id` for an MCP tool call — client-supplied via
 * `_meta.run_id` or freshly minted when absent.
 *
 * MCP clients bundle multi-call subagent builds under one run id so
 * admin surfaces can group the full run's events together. Without
 * `_meta.run_id`, a standalone tool call still gets its own id so the
 * grouping invariant holds uniformly.
 *
 * The MCP SDK types `_meta` as `$loose` (open object), so `run_id`
 * isn't on the typed shape — the narrow defensive cast keeps the check
 * string-typed without depending on the SDK's loose-shape internals.
 *
 * Shared by every MCP tool adapter: `sharedToolAdapter`, `createApp`,
 * `deleteApp`, `getApp`, `listApps`, `compileApp`, `uploadAppToHq`.
 * Keeping one resolver means a future change to run-id sourcing
 * (e.g., honoring an `Idempotency-Key` header as a secondary source)
 * lands in exactly one place.
 */

export function resolveRunId(extra: { _meta?: unknown } | undefined): string {
	const metaRunId = (extra?._meta as { run_id?: unknown } | undefined)?.run_id;
	return typeof metaRunId === "string" ? metaRunId : crypto.randomUUID();
}
