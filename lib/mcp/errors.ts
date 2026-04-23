/**
 * Classify + serialize adapter errors to the MCP-shaped tool result.
 *
 * MCP tool errors are a successful JSON-RPC response whose payload has
 * `isError: true`. Nova's existing `classifyError` produces the shared
 * taxonomy used by both the chat surface and this one; this module is
 * the bridge from that classification to the MCP result envelope.
 *
 * `McpAccessError` (from `./ownership`) short-circuits the classifier
 * because access failures are deterministic and carry a known reason
 * code — no need to route them through `classifyError`'s inference
 * heuristics, which key off status codes and message substrings.
 */

import { classifyError } from "@/lib/agent/errorClassifier";
import { McpAccessError } from "./ownership";

/**
 * MCP tool-error result envelope. Matches the MCP SDK's
 * `CallToolResult` with `isError: true`. `_meta` carries the
 * machine-readable classification so clients can branch on
 * `error_type` rather than parsing `content[0].text`.
 *
 * The open `[extra: string]: unknown` index signature is required to
 * satisfy the SDK's `CallToolResult` target when this envelope is
 * returned from an `McpServer.tool` handler — the SDK keeps its
 * result type open-shape so future minor versions can extend it.
 * Without the index signature TypeScript rejects the assignment with
 * an opaque "Index signature for type 'string' is missing" error at
 * every registration site.
 */
export interface McpToolErrorResult {
	isError: true;
	content: Array<{ type: "text"; text: string }>;
	_meta: {
		error_type: string;
		app_id?: string;
	};
	[extra: string]: unknown;
}

/**
 * Render any thrown value as an MCP tool-error result.
 *
 * `ctx.appId` is threaded into `_meta.app_id` when the caller knows the
 * target app — this lets the MCP client correlate the error back to a
 * specific app without having to re-derive it from the original tool
 * arguments. Unset when the failure predates app resolution (e.g. a
 * schema validation error on the arguments themselves).
 */
export function toMcpErrorResult(
	err: unknown,
	ctx?: { appId?: string },
): McpToolErrorResult {
	/* Build `_meta` additions as a mutable partial we spread at the end.
	 * Reads cleaner than a ternary that creates a fresh object twice and
	 * makes it obvious where future metadata fields would attach. */
	const base: { app_id?: string } = {};
	if (ctx?.appId !== undefined) base.app_id = ctx.appId;

	if (err instanceof McpAccessError) {
		/* Per-reason text: a `not_found` is not a forbidden access — the
		 * row genuinely isn't there — while `not_owner` is a cross-tenant
		 * probe and gets the access-denied phrasing. The shared "Forbidden:
		 * reason" text used before was a misnomer for `not_found` and
		 * blurred the distinction admins rely on in logs. */
		const text =
			err.reason === "not_found"
				? "App not found."
				: "Access denied — this app belongs to another user.";
		return {
			isError: true,
			content: [{ type: "text", text }],
			_meta: { error_type: err.reason, ...base },
		};
	}

	const classified = classifyError(err);
	return {
		isError: true,
		content: [{ type: "text", text: classified.message }],
		_meta: { error_type: classified.type, ...base },
	};
}
