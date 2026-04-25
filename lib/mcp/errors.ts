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
 * logs. The wire collapses both to the same `"not_found"` + the same
 * user-facing text so a probing client cannot enumerate existing app
 * ids by watching for the `"not_owner"` signal. The internal
 * distinction stays on the error class for logging; the wire never
 * exposes it.
 *
 * **All structured signals ride in `content`, not alongside it.** The
 * wire envelope has no structured metadata — every field the model
 * needs (error_type, app_id, human-readable message) is packed into
 * `content[0].text` as a JSON object.
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
 * Errors produced by `upload_app_to_hq`'s two-gate validation chain.
 * Exported so the tool's `UPLOAD_ERROR_TAGS` record can `satisfies`-
 * check against the union — a new bucket without a corresponding entry
 * here becomes a compile error rather than a silent wire drift.
 *
 * Two buckets, not four: the prior `invalid_domain` + `domain_mismatch`
 * pair disappeared when `upload_app_to_hq` stopped accepting a
 * client-supplied `domain` argument. The domain now comes from the
 * user's stored credentials (validated at save time), so neither gate
 * can fire anymore. Agents previewing the target domain before
 * uploading use `get_hq_connection`.
 */
export type UploadErrorType = "hq_not_configured" | "hq_upload_failed";

/**
 * Closed union of every `error_type` string an MCP tool response can
 * emit. Spans five independent failure sources:
 *
 *   - `"not_found"` — the single access-failure bucket the wire
 *     exposes. The internal `AccessErrorReason` union (`"not_found"`
 *     vs `"not_owner"`) from `./ownership` collapses to this one value
 *     at the envelope boundary so a probing client cannot enumerate
 *     existing app ids by watching the response. The ownership-failure
 *     audit trail lives in server-side logs via `log.warn`.
 *   - `"invalid_input"` — conditional-required argument validation that
 *     a raw-shape Zod schema can't express on its own (e.g. `app_id`
 *     required only in edit mode). Surfaces via `McpInvalidInputError`
 *     and short-circuits the classifier the same way `McpAccessError`
 *     does.
 *   - `"scope_missing"` — the caller's access token lacks an OAuth
 *     scope a specific tool requires (orthogonal to the route-layer
 *     `nova.read` + `nova.write` floor). Today only the HQ tools
 *     (`get_hq_connection`, `upload_app_to_hq`) gate this way; see
 *     `requireScope` in `./scopes` for the helper that produces the
 *     envelope. Distinct from `UploadErrorType` because scope failure
 *     is a token-shape problem, not a per-tool gate, and surfaces
 *     across multiple tools.
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
	| "scope_missing"
	| UploadErrorType
	| AgentErrorType;

/**
 * Structured error payload the tool packs into `content[0].text` as
 * JSON. Clients that want to branch on the error category parse
 * `content[0].text` and read `error_type`; those that only render to a
 * human read `message`.
 *
 * `app_id` rides through when the handler knows the target app. Absent
 * otherwise (pre-app-resolution failures).
 *
 * `required_scope` rides through when `error_type === "scope_missing"`
 * so a client can show the user *which* scope was absent (e.g. so the
 * MCP client UI can prompt "re-authorize to grant CommCare HQ access").
 * Absent on every other error type — the field is meaningless outside
 * the scope-gate path.
 */
export interface McpErrorPayload {
	error_type: McpErrorType;
	message: string;
	app_id?: string;
	required_scope?: string;
}

/**
 * MCP tool-error result envelope. Matches the MCP SDK's
 * `CallToolResult` with `isError: true`. The structured error body is
 * JSON-encoded into `content[0].text` — see `McpErrorPayload` for the
 * shape.
 *
 * The open `[extra: string]: unknown` index signature satisfies the
 * SDK's open-shape `CallToolResult` target without letting any
 * tool-specific keys leak onto the envelope.
 */
export interface McpToolErrorResult {
	isError: true;
	content: Array<{ type: "text"; text: string }>;
	[extra: string]: unknown;
}

/**
 * Shared success-result shape for every MCP tool envelope. Every
 * structured field the model needs lives inside `content[0].text` —
 * each tool owns the text shape (usually JSON, sometimes plain
 * markdown for renderer passthrough).
 *
 * Exporting this lets individual tool handlers return
 * `Promise<McpToolSuccessResult | McpToolErrorResult>` for uniform
 * callsite types — the return type is load-bearing for MCP SDK
 * overload resolution.
 */
export interface McpToolSuccessResult {
	content: Array<{ type: "text"; text: string }>;
	[extra: string]: unknown;
}

/**
 * Context the error serializer stamps onto the response + uses for
 * server-side audit logging. `appId` rides into the JSON content so
 * the model can correlate an error to its target app. `userId` is
 * read by the `McpAccessError` branch's cross-tenant audit log;
 * passing it unconditionally keeps call sites uniform and ready for
 * future audit expansions.
 */
export interface McpErrorContext {
	appId?: string;
	userId?: string;
}

/**
 * Render any thrown value as an MCP tool-error result.
 *
 * The envelope's `content[0].text` is a JSON-encoded `McpErrorPayload`
 * so the model branches on the structured `error_type` while the
 * human-readable `message` stays available for display. `ctx.appId`
 * rides into the payload when known.
 */
export function toMcpErrorResult(
	err: unknown,
	ctx?: McpErrorContext,
): McpToolErrorResult {
	/* Assemble the payload with conditional `app_id` — present only
	 * when the handler knows the target app at the failure site.
	 * `undefined` spreads into an absent key cleanly via
	 * `...(cond && { ... })` below. */
	const payload = (
		errorType: McpErrorType,
		message: string,
	): McpErrorPayload => ({
		error_type: errorType,
		message,
		...(ctx?.appId !== undefined && { app_id: ctx.appId }),
	});

	if (err instanceof McpInvalidInputError) {
		/* Argument-validation failures short-circuit the classifier
		 * because the failure shape is deterministic — the thrown
		 * `message` is the precise reason (e.g. "edit mode requires
		 * app_id") and routing it through `classifyError`'s status-code
		 * + substring heuristics would only succeed in losing that
		 * precision.
		 *
		 * Logged at `warn`, not `error`: these are expected client
		 * mistakes (e.g. missing a conditional-required field), not
		 * server bugs. But they ARE logged so a sudden spike of them
		 * against one userId is visible in Cloud Logging — that's
		 * either a client regression or an attacker probing the
		 * contract. Silent was worse than noisy here. */
		log.warn("[mcp] invalid input", {
			userId: ctx?.userId ?? null,
			appId: ctx?.appId ?? null,
			message: err.message,
		});
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify(payload("invalid_input", err.message)),
				},
			],
		};
	}

	if (err instanceof McpAccessError) {
		/* IDOR hardening: the wire sees exactly one access-failure shape
		 * regardless of whether the row is missing (`"not_found"`) or
		 * owned by another user (`"not_owner"`). A probing caller must
		 * not be able to distinguish "doesn't exist" from "exists but
		 * not yours" by watching the response — collapsing both paths
		 * to the same payload closes that enumeration channel.
		 *
		 * The internal `reason` stays on the `McpAccessError` instance
		 * so the ownership-probe audit log below can still distinguish
		 * the two server-side: admins watch for `"not_owner"` to catch
		 * cross-tenant scans that a pure "row not here" bucket would
		 * otherwise drown out. `"not_found"` stays silent — every
		 * harmless typo against a real app id would flood the logs
		 * otherwise. */
		if (err.reason === "not_owner") {
			log.warn("[mcp] cross-tenant access attempt", {
				userId: ctx?.userId ?? null,
				appId: ctx?.appId ?? null,
			});
		}
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify(payload("not_found", "App not found.")),
				},
			],
		};
	}

	/* Generic branch — anything that isn't an expected
	 * McpInvalidInputError or McpAccessError lands here. Almost always a
	 * server bug (Firestore exception, missing index, null deref, etc.)
	 * and almost always something we want in Cloud Logging with the full
	 * stack. The prior no-log version swallowed every such failure into
	 * an opaque "internal error" wire envelope with zero server-side
	 * trace — a silent-failure trap that made every Firestore surprise
	 * invisible in prod. `log.error` with the raw `err` lets the logger
	 * extract `stack_trace` for GCP Error Reporting grouping; the
	 * classified bucket + user/app context give enough labels to filter
	 * in the Cloud Logging Explorer. */
	const classified = classifyError(err);
	log.error("[mcp] tool handler failed", err, {
		error_type: classified.type,
		userId: ctx?.userId ?? null,
		appId: ctx?.appId ?? null,
	});
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify(payload(classified.type, classified.message)),
			},
		],
	};
}
