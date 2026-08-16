/**
 * MCP progress emitter.
 *
 * Adapters emit fine-grained progress through this interface so clients
 * with a progress token on their tool call can observe stage
 * transitions in real time. The stage taxonomy mirrors the chapter tags
 * emitted on `MutationEvent.stage`, so a UI consuming the stage
 * vocabulary shares one parser across the live stream and this surface.
 *
 * When the client did not opt into progress (no progress token),
 * `notify()` is a no-op — adapters can call it unconditionally without
 * branching on whether the caller is interested.
 *
 * Notifications carry the MCP-spec-required fields only: monotonically
 * increasing `progress`, and a human-readable `message` that encodes
 * both the machine-parseable stage tag and optional structured context
 * in a single string (format: `"[<stage>] <message>[ | <key>=<val>...]"`).
 * Clients that want to branch on stage parse the prefix; clients that
 * only render to a human use the whole message.
 */

/**
 * Stage vocabulary for MCP progress notifications. Mirrors the chapter
 * tags emitted on `MutationEvent.stage`. Additive — new stages are added
 * here alongside any new stage tag.
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
 * The request-scoped notification sender a progress emitter dispatches
 * through: the shape of the SDK's `ctx.mcpReq.notify`, narrowed to the
 * one notification this module sends. The SDK's own
 * `(notification: Notification) => Promise<void>` is assignable here
 * (its parameter is wider), so handlers pass `ctx.mcpReq.notify`
 * straight through without this module importing SDK types.
 */
export type ProgressNotifyFn = (notification: {
	method: "notifications/progress";
	params: {
		progressToken: string | number;
		progress: number;
		message: string;
	};
}) => Promise<void>;

/**
 * Format the notification message so both human and machine readers
 * can extract what they need from a single string. Prefix `[<stage>]`
 * lets clients branch on stage without needing structured metadata;
 * `| key=val` pairs append optional context inline.
 */
function formatProgressMessage(
	stage: ProgressStage,
	message: string,
	extra?: Record<string, unknown>,
): string {
	const prefix = `[${stage}]`;
	const extraParts = extra
		? Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`)
		: [];
	const suffix = extraParts.length > 0 ? ` | ${extraParts.join(" ")}` : "";
	return `${prefix} ${message}${suffix}`;
}

/**
 * Build a per-request progress emitter bound to the client's progress
 * token. Each `notify` call sends a `notifications/progress` message
 * through the request-scoped `notify` function, which associates the
 * notification with the request's response stream.
 *
 * The MCP spec requires `progress` to be a monotonically increasing
 * number so the client can order events and estimate throughput. The
 * counter is owned by this closure; callers express intent through the
 * stage + message arguments.
 *
 * When `progressToken` or `notify` is `undefined`, the returned emitter
 * is a no-op. That keeps adapter bodies branch-free.
 */
export function createProgressEmitter(
	notify: ProgressNotifyFn | undefined,
	progressToken: string | number | undefined,
): ProgressEmitter {
	/* Counter owned by this closure. `progress += 1` runs BEFORE each
	 * dispatch so the first `notify` sends `progress: 1` (MCP spec
	 * requires a monotonically-increasing number — compliant clients
	 * reject params missing it). */
	let progress = 0;
	return {
		notify(stage, message, extra) {
			if (progressToken === undefined || notify === undefined) return;
			progress += 1;
			/* Swallow delivery failure: a client that closed its stream
			 * mid-call must not turn a progress ping into an unhandled
			 * rejection inside the tool handler. */
			notify({
				method: "notifications/progress",
				params: {
					progressToken,
					progress,
					message: formatProgressMessage(stage, message, extra),
				},
			}).catch(() => {});
		},
	};
}
