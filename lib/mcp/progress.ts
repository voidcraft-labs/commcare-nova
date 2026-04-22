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
 * Build a per-request `ProgressEmitter` bound to the client's progress
 * token. The returned closure sends `notifications/progress` via the
 * underlying `Server` instance, which is the low-level transport the
 * high-level `McpServer` wraps.
 *
 * If `progressToken` is `undefined`, the emitter returned by this
 * factory is a no-op. That keeps adapters branch-free.
 */
export function createProgressEmitter(
	server: McpServer,
	progressToken: string | number | undefined,
): ProgressEmitter {
	return {
		notify(stage, message, extra) {
			if (progressToken === undefined) return;
			void server.server.notification({
				method: "notifications/progress",
				params: {
					progressToken,
					message,
					_meta: { stage, ...extra },
				},
			});
		},
	};
}
