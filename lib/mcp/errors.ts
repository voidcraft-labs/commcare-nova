/**
 * Classify + serialize adapter errors to the MCP-shaped tool result.
 *
 * MCP tool errors are a successful JSON-RPC response whose payload has
 * `isError: true`. Nova's existing `classifyError` produces the shared
 * taxonomy used by both the chat surface and this one; this module is
 * the bridge from that classification to the MCP result envelope.
 *
 * Several thrown-error classes short-circuit the classifier because
 * their failure shapes are deterministic and don't benefit from
 * `classifyError`'s status-code + substring heuristics:
 *
 * - `McpAccessError` (from `./ownership`) — app/Project access-gate
 *   rejection. Carries an internal reason code (`"not_found"` vs
 *   `"not_owner"`) for the audit log; the wire collapses both to
 *   `"not_found"` (see IDOR hardening below), with the resource kind
 *   picking the text ("App not found." / "Project not found.").
 * - `McpInvalidInputError` (declared below) — a handler-level argument
 *   contract that a particular tool has not encoded in its registered
 *   schema. The thrown `message` rides through to the wire `text`
 *   verbatim so the client sees the precise failure reason.
 * - `McpScopeError` (from `./scopes`) — per-tool scope gate rejection
 *   (the HQ and Projects scope pairs). Carries the missing scope so
 *   the wire envelope can echo it back as `required_scope` for a
 *   precise re-authorization prompt.
 * - `ProjectManagementError` / `ProjectPermissionError` (from
 *   `lib/projects/manage`) — Project-write policy rejections and
 *   member-but-under-privileged denials; both pass their
 *   person-readable message through verbatim.
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
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
} from "@/lib/db/commitGuard";
import { DeploymentError } from "@/lib/deployment/errors";
import { log } from "@/lib/logger";
import {
	ProjectManagementError,
	ProjectPermissionError,
} from "@/lib/projects/manage";
import { McpAccessError } from "./ownership";
import { McpScopeError } from "./scopes";

/**
 * Thrown when an MCP tool's input arguments fail a handler-level contract
 * that tool has not encoded in its registered Zod schema. Mirrors the
 * `McpAccessError` shape so the error
 * serializer can short-circuit `classifyError` and surface a
 * deterministic `error_type: "invalid_input"` envelope rather than the
 * generic `"internal"` bucket a plain `Error` would land in.
 *
 * The thrown `message` is propagated to the wire `text` content so the
 * client can show a precise failure reason. Shared SA/MCP tools register
 * their exact refined Zod objects, so relational checks on those schemas
 * run before their handlers; this class remains for hand-written MCP-only
 * tools whose contract is intentionally handler-owned.
 */
export class McpInvalidInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpInvalidInputError";
	}
}

/**
 * Errors produced by CommCare HQ connection/target gates and upload. Exported
 * so `upload_app_to_hq`'s `UPLOAD_ERROR_TAGS` record can `satisfies`-check
 * against the complete union. `check_project_space_compatibility` reuses the
 * applicable read-only subset (`hq_not_configured` and
 * `domain_not_authorized`) rather than inventing a second taxonomy.
 *
 * Four buckets:
 *   - `hq_not_configured` — the user has no stored HQ credentials.
 *   - `hq_upload_failed` — HQ rejected the upload (post-validation failure).
 *   - `domain_not_authorized` — the caller passed a `domain` the key can't
 *     reach. The reachable set is named in the message.
 *   - `domain_ambiguous` — the key reaches multiple spaces and the caller
 *     passed no `domain`. The tool refuses to guess (a silent pick is exactly
 *     the bug this whole surface exists to prevent) and names the spaces so the
 *     caller can ask the user and pass one.
 */
export type HqToolErrorType =
	| "hq_not_configured"
	| "hq_upload_failed"
	| "domain_not_authorized"
	| "domain_ambiguous";

/**
 * What an UPLOAD gate can emit: every bucket above, plus target-specific
 * refusals produced by the shared publish lifecycle.
 *
 *   - `remote_app_missing` — the publish asked CommCare HQ to update the
 *     app the deployment ledger maps for this target, and HQ answered that
 *     it is gone (deleted there). Nothing was changed; calling again
 *     creates a fresh app and supersedes the dead mapping.
 *   - `hq_resource_conflict` — the project space already holds a lookup
 *     table or a place with a name this app's data would land on, and Nova
 *     did not make it. Nothing was sent. A name match is never evidence of
 *     ownership, so the caller either changes the name in Nova or names
 *     the exact resources in `adopt_resources` to take them over.
 *   - `hq_organization_mismatch` — the app's organization does not fit the
 *     levels the project space defines, so CommCare HQ would refuse its
 *     places. Nothing was sent. Distinct from a conflict because no
 *     ownership decision resolves it: the tree changes in Nova, or the
 *     levels change on CommCare HQ.
 *   - `project_space_incompatible` — required support is missing or could not
 *     be verified for the selected target. No remote write began; the error
 *     payload carries the semantic compatibility report.
 *   - `hq_app_state_unknown` — an in-place update could not safely read the
 *     target app's current source immediately before import, so Nova refused
 *     to replace its profile state.
 */
export type UploadErrorType =
	| HqToolErrorType
	| "remote_app_missing"
	| "hq_resource_conflict"
	| "hq_organization_mismatch"
	| "project_space_incompatible"
	| "hq_app_state_unknown";

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
 *   - `"invalid_input"` — handler-owned argument validation not encoded in
 *     a particular tool's registered schema. Surfaces via `McpInvalidInputError`
 *     and short-circuits the classifier the same way `McpAccessError`
 *     does.
 *   - `"scope_missing"` — the caller's access token lacks an OAuth
 *     scope a specific tool requires (orthogonal to the route-layer
 *     `nova.read` + `nova.write` floor). The HQ tools
 *     (`get_hq_connection`, `upload_app_to_hq`,
 *     `check_project_space_compatibility`) and the Project-management tools gate
 *     this way; see `assertScope` / `McpScopeError` in `./scopes`.
 *     Distinct from `HqToolErrorType` because scope failure is a
 *     token-shape problem, not a per-tool gate, and surfaces across
 *     multiple tools.
 *   - `"permission_denied"` — the caller IS a member of the target
 *     Project but their role can't perform the write (a viewer creating
 *     an app, an editor inviting a member). Deliberately NOT collapsed
 *     to `"not_found"`: a member legitimately knows the Project exists,
 *     so the honest answer is what's missing and who can fix it.
 *     Surfaces via `ProjectPermissionError` (`lib/projects/manage`).
 *   - `UploadErrorType` — HQ connection, compatibility, target-state, and
 *     upload rejections.
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
	| "permission_denied"
	| UploadErrorType
	| AgentErrorType;

/**
 * Structured error payload the tool packs into `content[0].text` as
 * JSON. Clients that want to branch on the error category parse
 * `content[0].text` and read `error_type`; those that only render to a
 * human read `message`.
 *
 * `app_id` rides through when the handler knows the target app, and
 * `project_id` when it knows the target Project. Absent otherwise
 * (pre-resolution failures).
 *
 * `required_scope` rides through when `error_type === "scope_missing"`
 * so a client can show the user which scope was missing — letting it
 * point the user at whichever surface they fix scopes on (the OAuth
 * consent screen for browser-mediated grants, the API keys card in
 * Nova settings for static bearers). The raw scope literal travels
 * here for programmatic consumers; the human-readable `message`
 * already names the friendly label and the right remediation surface
 * for the caller's auth path. Absent on every other error type — the
 * field is meaningless outside the scope-gate path.
 */
export interface McpErrorPayload {
	error_type: McpErrorType;
	message: string;
	app_id?: string;
	project_id?: string;
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
 * server-side audit logging. `appId` / `projectId` ride into the JSON
 * content so the model can correlate an error to its target. `userId`
 * is read by the `McpAccessError` branch's cross-tenant audit log;
 * passing it unconditionally keeps call sites uniform and ready for
 * future audit expansions.
 */
export interface McpErrorContext {
	appId?: string;
	projectId?: string;
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
	/* Assemble the payload with conditional `app_id` / `project_id` —
	 * present only when the handler knows the target at the failure
	 * site. `undefined` spreads into an absent key cleanly via
	 * `...(cond && { ... })` below. */
	const payload = (
		errorType: McpErrorType,
		message: string,
	): McpErrorPayload => ({
		error_type: errorType,
		message,
		...(ctx?.appId !== undefined && { app_id: ctx.appId }),
		...(ctx?.projectId !== undefined && { project_id: ctx.projectId }),
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

	if (err instanceof ProjectManagementError) {
		/* A Project-management policy rejection (personal Project, already a
		 * member, duplicate invite, the pending cap) — the request was
		 * understood and refused with a person-readable reason, so the
		 * message rides through verbatim as `invalid_input`. Logged at
		 * `warn` like every other expected client mistake, so a spike
		 * against one userId stays visible without opening Sentry issues. */
		log.warn("[mcp] project management rejected", {
			userId: ctx?.userId ?? null,
			projectId: ctx?.projectId ?? null,
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

	if (err instanceof ProjectPermissionError) {
		/* The caller IS a member of the target Project but their role can't
		 * do this. Deliberately NOT the not-found collapse: a member
		 * legitimately knows the Project exists, so the honest envelope
		 * names what's missing and who can fix it. `warn`, not `error` — an
		 * under-privileged member trying a write is an expected outcome. */
		log.warn("[mcp] project permission denied", {
			userId: ctx?.userId ?? null,
			projectId: ctx?.projectId ?? null,
			message: err.message,
		});
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify(payload("permission_denied", err.message)),
				},
			],
		};
	}

	if (err instanceof DeploymentError) {
		/* Every arm of this class is an EXPECTED rejection a caller can act
		 * on: a project space their key cannot reach, a CommCare HQ app id
		 * that is not there. Without this branch they fell through to the
		 * generic classifier, which discarded the written message AND logged
		 * at `error` — so an ordinary "you have not connected CommCare HQ"
		 * became a Sentry issue and reached the client as an unrelated
		 * internal message.
		 *
		 * The tags match what `upload_app_to_hq` already emits for the same
		 * conditions, so a client branching on the documented taxonomy gets
		 * the same answer whichever tool it called. */
		const errorType: McpErrorType =
			err.code === "hq_not_connected"
				? "hq_not_configured"
				: err.code === "domain_not_authorized"
					? "domain_not_authorized"
					: err.code === "not_found"
						? "not_found"
						: "invalid_input";
		log.warn("[mcp] deployment rejected", {
			userId: ctx?.userId ?? null,
			appId: ctx?.appId ?? null,
			code: err.code,
		});
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify(payload(errorType, err.message)),
				},
			],
		};
	}

	if (err instanceof MutationBatchIdCollisionError) {
		/* A batch id is server-minted, so reusing one for different content is a
		 * Nova protocol failure, never a client mistake. It must not read as
		 * `invalid_input` (which says "fix your arguments") and must not read as a
		 * reloadable conflict (which says "re-read and retry") — both would send a
		 * client back around a loop it cannot win. `internal` is the honest
		 * category, and `isError` matters most of all: without this branch the
		 * collision fell through to a plain success envelope and told the caller
		 * its edit had landed when nothing was written.
		 *
		 * Logged at `error`: unlike an invalid input, this one is our bug. The
		 * stored payloads stay out of the message. */
		log.error("[mcp] mutation batch id collision", {
			userId: ctx?.userId ?? null,
			appId: ctx?.appId ?? null,
		});
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify(
						payload(
							"internal",
							"This edit could not be saved: Nova reused a save id for different content. Nothing was written. This is a fault on our side, not something to correct in the request. Repeating it will not help.",
						),
					),
				},
			],
		};
	}

	if (err instanceof AppProjectChangedError) {
		log.warn("[mcp] app Project changed during the call", {
			userId: ctx?.userId ?? null,
			appId: ctx?.appId ?? null,
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

	if (err instanceof BlueprintCommitRejectedError) {
		/* The transactional commit's fresh-doc re-verdict rejected the batch
		 * (a concurrent write landed between the optimistic gate and the
		 * commit transaction, and the batch introduces a finding against
		 * the doc as it now stands). Nothing was written. This is the same
		 * validity-rejection shape the optimistic gate produces inside a
		 * tool body, so it gets the same envelope: `invalid_input` with the
		 * verdict's person-to-person findings as the message — never the
		 * generic internal bucket, which would read as a server fault the
		 * caller can't act on. */
		log.warn("[mcp] guarded commit rejected against the fresh blueprint", {
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

	if (err instanceof CommitReauthError) {
		/* The actor lost edit access mid-commit (removed from the app's Project,
		 * or not the owner of a personal app) — a race against the boundary authz
		 * gate. Terminal; nothing was written. Collapse to the SAME `not_found`
		 * shape the ownership gate produces (IDOR hardening — a probing client
		 * can't distinguish "removed" from "never had access"), logged at `warn`
		 * as an expected authz outcome rather than the generic branch's `error`
		 * (which would read it as a server fault). */
		log.warn("[mcp] guarded commit reauth denied", {
			userId: ctx?.userId ?? null,
			appId: ctx?.appId ?? null,
			message: err.message,
		});
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

	if (err instanceof McpScopeError) {
		/* Scope-gate failure short-circuits the classifier the same way
		 * `McpInvalidInputError` does: the failure shape is deterministic
		 * (we know exactly which scope was missing on which tool) and
		 * routing through the status-code heuristic would only succeed
		 * in losing that precision. The wire payload carries
		 * `required_scope` alongside the standard fields so a
		 * programmatic MCP client can show a precise re-authorization
		 * prompt without parsing the message. */
		const scopePayload: McpErrorPayload = {
			error_type: "scope_missing",
			message: err.message,
			required_scope: err.requiredScope,
			...(ctx?.appId !== undefined && { app_id: ctx.appId }),
			...(ctx?.projectId !== undefined && { project_id: ctx.projectId }),
		};
		return {
			isError: true,
			content: [{ type: "text", text: JSON.stringify(scopePayload) }],
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
				projectId: ctx?.projectId ?? null,
				resource: err.resource,
			});
		}
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify(
						payload(
							"not_found",
							err.resource === "project"
								? "Project not found."
								: "App not found.",
						),
					),
				},
			],
		};
	}

	/* Generic branch — anything that isn't one of the three short-circuit
	 * error classes lands here. Almost always a server bug (a database
	 * exception, missing index, null deref, etc.) and almost always
	 * something we want in Cloud Logging with the full stack. `log.error`
	 * with the raw `err` lets the logger extract `stack_trace` for GCP
	 * Error Reporting grouping; the classified bucket + user/app context
	 * give enough labels to filter in the Cloud Logging Explorer. */
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
