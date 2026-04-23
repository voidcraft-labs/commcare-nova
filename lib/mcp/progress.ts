/**
 * MCP progress emitter.
 *
 * Adapters emit fine-grained progress through this interface so clients
 * with a `_meta.progressToken` on their tool call can observe stage
 * transitions in real time. The stage taxonomy aligns with
 * `deriveReplayChapters` so UIs consuming the replay vocabulary share
 * one parser across the live and replay paths.
 *
 * When the client did not opt into progress (no `progressToken`),
 * `notify()` is a no-op — adapters can call it unconditionally without
 * branching on whether the caller is interested.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Stage vocabulary for MCP progress notifications. Mirrors the chapter
 * tags emitted on `MutationEvent.stage` and derived by
 * `deriveReplayChapters`. Additive — new stages should be added here
 * AND to the replay chapter deriver together.
 */
export type ProgressStage =
	| "app_created"
	| "schema_generated"
	| "scaffold_generated"
	| "module_added"
	| "form_added"
	| "validation_started"
	| "validation_fix_applied"
	| "validation_passed"
	| "upload_started"
	| "upload_complete";

export interface ProgressEmitter {
	notify(
		stage: ProgressStage,
		message: string,
		extra?: Record<string, unknown>,
	): void;
}

/**
 * Build a per-request progress emitter bound to the client's progress
 * token. Each `notify` call issues a `notifications/progress` message
 * via the underlying `Server` instance's low-level notification API.
 *
 * The MCP spec requires `progress` to be a monotonically increasing
 * number so the client can order events and estimate throughput. The
 * counter is owned by this closure; callers express intent through the
 * stage + message arguments.
 *
 * When `progressToken` is `undefined`, the returned emitter is a no-op.
 * That keeps adapter bodies branch-free.
 */
export function createProgressEmitter(
	server: McpServer,
	progressToken: string | number | undefined,
): ProgressEmitter {
	/* Counter owned by this closure. `progress += 1` runs BEFORE each
	 * dispatch so the first `notify` sends `progress: 1` (MCP spec
	 * requires a monotonically-increasing number — compliant clients
	 * reject params missing it). */
	let progress = 0;
	return {
		notify(stage, message, extra) {
			if (progressToken === undefined) return;
			progress += 1;
			void server.server.notification({
				method: "notifications/progress",
				params: {
					progressToken,
					progress,
					message,
					_meta: { stage, ...extra },
				},
			});
		},
	};
}
