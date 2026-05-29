/**
 * `nova.upload_app_to_hq` — upload an owned app's blueprint to CommCare
 * HQ as a new app in a project space the user's API key can reach.
 *
 * Scope: `nova.hq.write` (per-tool, in addition to the route-layer
 * `nova.read` + `nova.write` floor). HQ access is orthogonal to
 * Nova-internal read/write — see `lib/mcp/scopes.ts` for the full
 * enforcement model.
 *
 * HQ has no atomic update API, so every call produces a brand-new app
 * in the target project — the returned `hq_app_id` is always fresh.
 *
 * Target space — the optional `domain` argument:
 *   An HQ API key can reach several project spaces (an unscoped key reaches
 *   every space its owner belongs to). Omitting `domain` works only when the
 *   key reaches exactly one space — that sole space is used. A multi-space key
 *   must pass `domain` explicitly: there is no stored default, so a multi-space
 *   key with no `domain` is `domain_ambiguous` (see below) — the tool refuses
 *   to guess. Use `get_hq_connection` to list the reachable spaces
 *   (`available_domains`) and ask the user which one.
 *
 * Actionable `error_type` values, in the order their gates fire — each
 * producing a distinct envelope so MCP clients can branch cleanly:
 *
 *   1. `scope_missing`          — the access token lacks `nova.hq.write`.
 *                                 Pre-gate 0; cuts off ownership probing
 *                                 before any Firestore read.
 *   2. `hq_not_configured`      — the user has not stored CommCare HQ
 *                                 credentials in Settings.
 *   3. `domain_not_authorized`  — `domain` was supplied but the key can't
 *                                 reach it; the message names the reachable
 *                                 set.
 *   4. `domain_ambiguous`       — multi-space key with no `domain` supplied;
 *                                 the tool names the spaces and asks the
 *                                 caller to choose rather than guessing.
 *   5. `hq_upload_failed`       — `importApp` returned a non-success
 *                                 response (HQ rejected the upload, network
 *                                 fault, or 5xx from HQ).
 *
 * (`not_found` from the ownership pre-gate is also possible but not
 * actionable — it collapses cross-tenant probes to the same shape as
 * a missing app.)
 *
 * The hardcoded `COMMCARE_HQ_URL` inside `lib/commcare/client.ts` is the
 * one SSRF boundary; the resolved domain is always one the stored key
 * already reached (probed at save/refresh and re-checked here against the
 * reachable set), so it cannot smuggle path components into the URL
 * `importApp` constructs.
 *
 * Pre-gate ordering — scope → ownership → settings/domain — is defensive:
 * each gate leaks strictly less information than the one after it, so
 * the earliest-applicable rejection always closes more probe channels
 * than it opens.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { importApp } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { initMcpCall } from "../context";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
	type UploadErrorType,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { deriveRunId, timestampToMillis } from "../runId";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

/**
 * Canonical `error_type` strings for each upload-gate failure mode.
 * `satisfies Record<UploadErrorType, UploadErrorType>` forces every
 * variant of `UploadErrorType` to appear as a key — adding a new
 * variant to the union without a matching entry here is a compile
 * error, so the wire taxonomy cannot silently drift.
 *
 * Exported as a frozen record so tests can reference the literals the
 * handler emits without hardcoding raw strings.
 *
 * These tags are part of the MCP wire contract: any client branching
 * on an upload error expects exactly these values. Treat them as public API.
 */
export const UPLOAD_ERROR_TAGS = {
	/** The user has no stored HQ credentials. */
	hq_not_configured: "hq_not_configured",
	/** HQ rejected the upload (HQ-side failure, post-validation). */
	hq_upload_failed: "hq_upload_failed",
	/** Supplied `domain` is outside the key's reachable set. */
	domain_not_authorized: "domain_not_authorized",
	/** Multi-space key with no `domain` supplied — caller must choose. */
	domain_ambiguous: "domain_ambiguous",
} as const satisfies Record<UploadErrorType, UploadErrorType>;

/**
 * Build an MCP error envelope for a failed upload gate.
 *
 * Gates return a structured envelope directly (rather than throwing a
 * tagged error to be caught and discriminated elsewhere) so every
 * gate's exit path has the same shape: `makeGateError` builds the full
 * MCP result in one place.
 *
 * The JSON content carries both the machine-readable `error_type` (for
 * model branching) and the user-actionable `message` (for display).
 */
function makeGateError(
	errorType: UploadErrorType,
	message: string,
	appId: string,
): McpToolErrorResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type: errorType,
					message,
					app_id: appId,
				}),
			},
		],
	};
}

/**
 * Register the `upload_app_to_hq` tool on an `McpServer`.
 *
 * The handler allocates its `LogWriter` + `McpContext` AFTER the
 * pre-network gates pass. A missing-creds / ambiguous-domain call therefore
 * never allocates a log writer it has nothing to flush. The blueprint load
 * + expand + `importApp` sit inside a `try`/`finally` so the writer drains
 * whether the HQ call succeeds, returns a non-success envelope, or throws.
 */
export function registerUploadAppToHq(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"upload_app_to_hq",
		{
			description:
				"Upload an owned app to CommCare HQ as a new app. Pass `domain` to choose the target project space; you can omit it only when the key reaches exactly one space. Call `get_hq_connection` first to list reachable spaces (`available_domains`); when there are several, ask the user which one — a multi-space key with no `domain` returns `domain_ambiguous` (it won't guess). HQ has no atomic update API, so each call creates a fresh HQ app; returns the HQ app id and URL on success.",
			inputSchema: {
				app_id: z
					.string()
					.describe(
						"Firestore app id to upload. Must be an app the authenticated user owns.",
					),
				app_name: z
					.string()
					.optional()
					.describe(
						"Optional app name to use on HQ. Defaults to the blueprint's own name when omitted or blank.",
					),
				domain: z
					.string()
					.optional()
					.describe(
						"Optional target project space (domain slug). Must be one the user's API key can reach — see `get_hq_connection`'s `available_domains`. Omit only when the key reaches a single space; a multi-space key requires it.",
					),
			},
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;

			try {
				/* Pre-gate 0: scope. Runs BEFORE ownership so a token without
				 * `nova.hq.write` cannot probe whether an app id exists or
				 * is owned by the caller — scope failure leaks nothing about
				 * the user's data, ownership failure does (collapsed at the
				 * wire to `not_found`, but still a probe channel that's
				 * cheaper to cut off entirely). Throws `McpScopeError`;
				 * the surrounding catch stamps `app_id` from `ctx`. */
				assertScope(ctx, SCOPES.hqWrite, "upload_app_to_hq");

				/* Pre-gate 1: ownership + blueprint load in one Firestore
				 * read. `loadAppBlueprint` throws `McpAccessError` on
				 * cross-tenant probe or vanished row — both collapse to
				 * `not_found` on the wire so a probing client cannot
				 * surface settings-level failure reasons for an app the
				 * caller doesn't own. */
				const { doc, app } = await loadAppBlueprint(appId, ctx.userId);

				/* Gate 2 — credentials + target-space resolution in one read.
				 * The optional `domain` arg picks the target (required for a
				 * multi-space key); the decrypted key is only attached when a
				 * target resolves. The three failure shapes map 1:1 to distinct
				 * wire error types so a client can branch (configure, pick a
				 * valid space, or disambiguate). */
				const requested = args.domain?.trim() || undefined;
				const credResult = await getCredentialsForUpload(ctx.userId, requested);
				if (!credResult.ok) {
					if (credResult.error === "not_configured") {
						return makeGateError(
							UPLOAD_ERROR_TAGS.hq_not_configured,
							"CommCare HQ is not configured. Add your HQ credentials in Settings before uploading.",
							appId,
						);
					}
					const reachable = credResult.available.map((d) => d.name).join(", ");
					if (credResult.error === "not_authorized") {
						return makeGateError(
							UPLOAD_ERROR_TAGS.domain_not_authorized,
							`Your stored CommCare HQ API key can't reach the "${requested}" project space. It reaches: ${reachable}. Pass one of those as \`domain\`, or update your key in Settings.`,
							appId,
						);
					}
					return makeGateError(
						UPLOAD_ERROR_TAGS.domain_ambiguous,
						`Your CommCare HQ API key reaches ${credResult.available.length} project spaces (${reachable}). Pass \`domain\` to choose which one to upload to.`,
						appId,
					);
				}
				const targetDomain = credResult.domain.name;

				/* Derive the run id from the app's own state (see
				 * `lib/mcp/runId.ts`). The upload typically comes at the
				 * end of a generation run, so the sliding-window lookup
				 * reuses the same id that the preceding mutations
				 * grouped under. */
				const runId = deriveRunId({
					currentRunId: app.run_id,
					lastActiveMs: timestampToMillis(app.updated_at),
					now: new Date(),
				});

				/* `initMcpCall` packages the per-call collaborators
				 * (LogWriter, progress emitter, McpContext) and binds them
				 * to the derived `runId`. */
				const { mcpCtx, logWriter, progress } = initMcpCall(
					server,
					ctx,
					appId,
					runId,
					extra,
				);

				try {
					progress.notify("upload_started", `Uploading to ${targetDomain}`, {
						app_id: appId,
					});

					/* Gate 3 — the only network call. The SSRF boundary
					 * lives inside `importApp` via the hardcoded
					 * `COMMCARE_HQ_URL`. `expandDoc` materializes the
					 * `HqApplication` JSON HQ's `/api/import_app/`
					 * endpoint expects. */
					const hqJson = expandDoc(doc);
					/* App name defaulting: `?.trim() || app.app_name` maps
					 * both omitted and whitespace-only inputs to the
					 * blueprint's denormalized name — which is non-empty
					 * by `denormalize`'s invariant (falls back to
					 * `UNTITLED_APP_NAME`). Mirrors the chat-surface
					 * behavior in `app/api/commcare/upload/route.ts`. */
					const appName = args.app_name?.trim() || app.app_name;
					const result = await importApp(
						credResult.creds,
						targetDomain,
						appName,
						hqJson,
					);

					if (!result.success) {
						return makeGateError(
							UPLOAD_ERROR_TAGS.hq_upload_failed,
							`CommCare HQ rejected the upload (status ${result.status}).`,
							appId,
						);
					}

					progress.notify(
						"upload_complete",
						`Uploaded — HQ app id ${result.appId}`,
						{ app_id: appId, hq_app_id: result.appId },
					);

					/* Record the upload success on the event log as a
					 * `tool-result` conversation event. `toolCallId` is
					 * a fresh uuid (not `runId`) to preserve the
					 * `tool-call` ↔ `tool-result` pairing contract in
					 * `lib/log/types.ts`. */
					mcpCtx.recordConversation({
						type: "tool-result",
						toolCallId: crypto.randomUUID(),
						toolName: "upload_app_to_hq",
						output: {
							hq_app_id: result.appId,
							url: result.appUrl,
							warnings: result.warnings,
						},
					});

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									stage: "upload_complete",
									app_id: appId,
									hq_app_id: result.appId,
									url: result.appUrl,
									warnings: result.warnings,
								}),
							},
						],
					};
				} finally {
					/* Drain the event-log buffer before returning OR
					 * throwing. `LogWriter.flush` never throws; it resolves
					 * once every inflight Firestore batch has acknowledged.
					 * A missed flush silently drops any events that hadn't
					 * triggered the batch-size flush threshold yet. */
					await logWriter.flush();
				}
			} catch (err) {
				/* Ownership failures, missing-blueprint races, and any
				 * throw from `importApp` (network fault, etc.) all land
				 * here. `toMcpErrorResult` classifies via the shared
				 * taxonomy. Gate 2-3 failures never reach this block —
				 * they return structured envelopes directly. */
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
