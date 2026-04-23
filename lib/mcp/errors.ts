/**
 * Classify + serialize adapter errors to the MCP-shaped tool result.
 *
 * MCP tool errors are a successful JSON-RPC response whose payload has
 * `isError: true`. Nova's existing `classifyError` produces the shared
 * taxonomy used by both the chat surface and this one; this module is
 * the bridge from that classification to the MCP result envelope.
 *
 * Two thrown-error classes short-circuit the classifier because their
 * failure shapes are deterministic and don't benefit from
 * `classifyError`'s status-code + substring heuristics:
 *
 * - `McpAccessError` (from `./ownership`) — ownership-gate rejection.
 *   Carries an internal reason code (`"not_found"` vs `"not_owner"`)
 *   for the audit log; the wire collapses both to `"not_found"` (see
 *   IDOR hardening below).
 * - `McpInvalidInputError` (declared below) — argument validation a
 *   raw-shape Zod schema can't express (e.g. conditional-required
 *   fields). The thrown `message` rides through to the wire `text`
 *   verbatim so the client sees the precise failure reason.
 *
 * **IDOR hardening.** `McpAccessError.reason` carries two distinct
 * internal reasons (`"not_found"`, `"not_owner"`) so admins can
 * distinguish accidental typos from cross-tenant probes in server-side
 * logs. The wire envelope collapses both to `"not_found"` + the same
 * user-facing text so a probing client cannot enumerate existing app ids
 * by watching for the `"not_owner"` signal. The internal distinction
 * stays on the error class for logging; the wire never exposes it.
 *
 * Every tool's success + error envelope threads `_meta.run_id` through
 * so admin surfaces grouping by run id see a consistent story across
 * every MCP tool call. The open `[extra: string]: unknown` index on
 * `_meta` lets tool-specific keys (`stage`, `format`, `encoding`) layer
 * on top of the shared `{ app_id?, run_id? }` base.
 */

import type { ErrorType as AgentErrorType } from "@/lib/agent/errorClassifier";
import { classifyError } from "@/lib/agent/errorClassifier";
import { log } from "@/lib/logger";
import { McpAccessError } from "./ownership";

/**
 * Thrown when an MCP tool's input arguments fail a contract check the
 * Zod input schema cannot express on its own — typically a
 * conditional-required field (e.g. `app_id` is required iff
 * `mode === "edit"`). Mirrors the `McpAccessError` shape so the error
 * serializer can short-circuit `classifyError` and surface a
 * deterministic `error_type: "invalid_input"` envelope rather than the
 * generic `"internal"` bucket a plain `Error` would land in.
 *
 * The thrown `message` is propagated to the wire `text` content so the
 * client can show a precise failure reason (e.g. "edit mode requires
 * app_id"). Conditional-required validation in raw-shape Zod is
 * awkward enough that the cleaner pattern is a typed throw at the top
 * of the handler — sibling tools follow the same model.
 */
export class McpInvalidInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpInvalidInputError";
	}
}

/**
 * Errors produced by `upload_app_to_hq`'s four-gate validation chain.
 * Exported so the tool's `UPLOAD_ERROR_TAGS` record can `satisfies`-
 * check against the union — a new bucket without a corresponding entry
 * here becomes a compile error rather than a silent wire drift.
 */
export type UploadErrorType =
	| "invalid_domain"
	| "hq_not_configured"
	| "domain_mismatch"
	| "hq_upload_failed";

/**
 * Closed union of every `error_type` string an MCP tool envelope can
 * emit ON THE WIRE. Spans four independent failure sources:
 *
 *   - `"not_found"` — the single access-failure bucket the wire exposes.
 *     The internal `AccessErrorReason` union (`"not_found"` vs
 *     `"not_owner"`) from `./ownership` collapses to this one value at
 *     the envelope boundary so a probing client cannot enumerate
 *     existing app ids by watching the response. The ownership-failure
 *     audit trail lives in server-side logs via `log.warn`.
 *   - `"invalid_input"` — conditional-required argument validation that
 *     a raw-shape Zod schema can't express on its own (e.g. `app_id`
 *     required only in edit mode). Surfaces via `McpInvalidInputError`
 *     and short-circuits the classifier the same way `McpAccessError`
 *     does.
 *   - `UploadErrorType` — upload-tool-specific gate rejections.
 *   - `AgentErrorType` — the shared `classifyError` taxonomy used by
 *     every generic throw (network, provider, internal).
 *
 * Exhaustively switching on this union catches a new error bucket at
 * compile time wherever it's consumed.
 */
export type McpErrorType =
	| "not_found"
	| "invalid_input"
	| UploadErrorType
	| AgentErrorType;

/**
 * MCP tool-error result envelope. Matches the MCP SDK's
 * `CallToolResult` with `isError: true`. `_meta` carries the
 * machine-readable classification so clients can branch on
 * `error_type` rather than parsing `content[0].text`.
 *
 * The open `[extra: string]: unknown` index signature on both the
 * outer result and the `_meta` block satisfies the SDK's open-shape
 * `CallToolResult` target AND lets tool-specific meta keys (e.g.
 * `format` on compile errors, `stage` on upload errors) layer on top
 * of the shared `app_id` + `run_id` base without widening the
 * strict-typed keys.
 */
export interface McpToolErrorResult {
	isError: true;
	content: Array<{ type: "text"; text: string }>;
	_meta: {
		error_type: McpErrorType;
		app_id?: string;
		run_id?: string;
		[extra: string]: unknown;
	};
	[extra: string]: unknown;
}

/**
 * Shared success-result shape for every MCP tool envelope. The shared
 * base is `_meta.run_id` (always present — every tool mints or threads
 * one) + optional `app_id` (omitted on `list_apps`, which has no single
 * target app). Tool-specific meta (`stage`, `format`, `encoding`)
 * slots in through the open index signature.
 *
 * Exporting this lets individual tool handlers return
 * `Promise<McpToolSuccessResult | McpToolErrorResult>` for uniform
 * callsite types — the return type is load-bearing for MCP SDK
 * overload resolution.
 */
export interface McpToolSuccessResult {
	content: Array<{ type: "text"; text: string }>;
	_meta: {
		run_id: string;
		app_id?: string;
		stage?: string;
		format?: "json" | "ccz";
		encoding?: "base64";
		[extra: string]: unknown;
	};
	[extra: string]: unknown;
}

/**
 * Context the error serializer stamps onto `_meta` + uses for server-
 * side audit logging. Every key is optional: `appId` is unset when the
 * failure predates app resolution (e.g. a schema validation error on
 * arguments); `runId` is unset in exotic paths where a handler fails
 * before minting a run id — every regular handler resolves `runId` at
 * the top and threads it here.
 */
export interface McpErrorContext {
	appId?: string;
	runId?: string;
	/**
	 * Authenticated user id. Handlers thread this unconditionally on
	 * every error — it's only read by the `McpAccessError` branch's
	 * cross-tenant audit log, but passing it every time keeps call
	 * sites uniform and ready for future audit expansions. Absent
	 * `userId` still produces the same wire envelope, just with a
	 * looser log record.
	 */
	userId?: string;
}

/**
 * Render any thrown value as an MCP tool-error result.
 *
 * Thread `ctx.appId` and `ctx.runId` onto `_meta` when the caller
 * knows them — this lets the MCP client correlate errors back to
 * specific apps and to the run-id-grouping used by admin surfaces
 * without re-deriving either from the original tool arguments.
 */
export function toMcpErrorResult(
	err: unknown,
	ctx?: McpErrorContext,
): McpToolErrorResult {
	/* Build `_meta` additions as a mutable partial we spread at the end.
	 * Reads cleaner than a ternary that creates a fresh object twice and
	 * makes it obvious where future metadata fields would attach. */
	const base: { app_id?: string; run_id?: string } = {};
	if (ctx?.appId !== undefined) base.app_id = ctx.appId;
	if (ctx?.runId !== undefined) base.run_id = ctx.runId;

	if (err instanceof McpInvalidInputError) {
		/* Argument-validation failures short-circuit the classifier
		 * because the failure shape is deterministic — the thrown
		 * `message` is the precise reason (e.g. "edit mode requires
		 * app_id") and routing it through `classifyError`'s status-code
		 * + substring heuristics would only succeed in losing that
		 * precision. The wire surfaces both the `error_type` tag for
		 * machine branching and the message text for human display. */
		return {
			isError: true,
			content: [{ type: "text", text: err.message }],
			_meta: { error_type: "invalid_input", ...base },
		};
	}

	if (err instanceof McpAccessError) {
		/* IDOR hardening: the wire sees exactly one access-failure shape
		 * regardless of whether the row is missing (`"not_found"`) or
		 * owned by another user (`"not_owner"`). A probing caller must
		 * not be able to distinguish "doesn't exist" from "exists but not
		 * yours" by watching the response — collapsing both paths to the
		 * same text + `error_type` closes that enumeration channel.
		 *
		 * The internal `reason` stays on the `McpAccessError` instance so
		 * the ownership-probe audit log below can still distinguish the
		 * two server-side: admins watch for `"not_owner"` to catch
		 * cross-tenant scans that a pure "row not here" bucket would
		 * otherwise drown out. */
		if (err.reason === "not_owner") {
			log.warn("[mcp] cross-tenant access attempt", {
				userId: ctx?.userId ?? null,
				appId: ctx?.appId ?? null,
				runId: ctx?.runId ?? null,
			});
		}
		return {
			isError: true,
			content: [{ type: "text", text: "App not found." }],
			_meta: { error_type: "not_found", ...base },
		};
	}

	const classified = classifyError(err);
	return {
		isError: true,
		content: [{ type: "text", text: classified.message }],
		_meta: { error_type: classified.type, ...base },
	};
}
