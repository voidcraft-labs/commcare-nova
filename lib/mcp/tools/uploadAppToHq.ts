/**
 * `nova.upload_app_to_hq` — upload an owned app's blueprint to CommCare
 * HQ as a new app in a specified project space.
 *
 * Scope: `nova.write`.
 *
 * HQ has no atomic update API, so every call produces a brand-new app
 * in the target project — the returned `hq_app_id` is always fresh.
 *
 * The handler enforces an explicit four-gate validation sequence BEFORE
 * any network call leaves the server. Each gate produces a distinct
 * `error_type` in the returned content so MCP clients can surface
 * actionable guidance:
 *
 *   1. `invalid_domain`    — the `domain` arg fails `isValidDomainSlug`.
 *                            Prevents path-traversal / SSRF via the
 *                            URL construction in `importApp`.
 *   2. `hq_not_configured` — the user has not stored CommCare HQ
 *                            credentials in Settings; there is nothing
 *                            to upload with.
 *   3. `domain_mismatch`   — the user's KMS-encrypted credentials
 *                            authorize a different project space than
 *                            the `domain` argument. A user with creds
 *                            for domain A cannot upload to domain B.
 *   4. `hq_upload_failed`  — `importApp` returned a non-success
 *                            response (HQ rejected the upload, network
 *                            fault, or 5xx from HQ).
 *
 * The hardcoded `COMMCARE_HQ_URL` inside `lib/commcare/client.ts` is
 * the one SSRF boundary; all four gates must pass before the client's
 * `fetch` is reached.
 *
 * Ownership is checked BEFORE the four upload gates so a cross-tenant
 * upload probe can never surface a settings-level failure reason for
 * an app the caller doesn't own.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { importApp, isValidDomainSlug } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { getDecryptedCredentialsWithDomain } from "@/lib/db/settings";
import { initMcpCall } from "../context";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
	type UploadErrorType,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { McpAccessError, requireOwnedApp } from "../ownership";
import { deriveRunId, timestampToMillis } from "../runId";
import type { ToolContext } from "../types";

/**
 * Canonical `error_type` strings for each upload-gate failure mode.
 * `satisfies Record<UploadErrorType, UploadErrorType>` forces
 * every variant of `UploadErrorType` to appear as a key — adding a
 * new variant to the union without a matching entry here is a
 * compile error, so the wire taxonomy cannot silently drift.
 *
 * Exported as a frozen record so tests can reference the literals the
 * handler emits without hardcoding raw strings.
 *
 * These tags are part of the MCP wire contract: any client branching
 * on an upload error expects exactly these four values. Treat them as
 * public API.
 */
export const UPLOAD_ERROR_TAGS = {
	/** Gate 1 — `args.domain` failed the HQ domain-slug regex. */
	invalid_domain: "invalid_domain",
	/** Gate 2 — the user has no stored HQ credentials. */
	hq_not_configured: "hq_not_configured",
	/** Gate 3 — stored credentials authorize a different project space. */
	domain_mismatch: "domain_mismatch",
	/** Gate 4 — HQ rejected the upload (HQ-side failure, post-validation). */
	hq_upload_failed: "hq_upload_failed",
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
 * The handler allocates its `LogWriter` + `McpContext` AFTER all four
 * pre-network gates pass. Gate failures (1-3) therefore short-circuit
 * before any writer is constructed — a missing-creds call never
 * allocates a log writer it has nothing to flush. The blueprint load
 * + expand + `importApp` sit inside a `try`/`finally` so the writer
 * drains whether the HQ call succeeds, returns a non-success envelope,
 * or throws.
 */
export function registerUploadAppToHq(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"upload_app_to_hq",
		{
			description:
				"Upload an owned app to CommCare HQ as a new app in the specified project space. Returns the HQ app id and URL on success. HQ has no atomic update API — each call creates a fresh HQ app.",
			inputSchema: {
				app_id: z
					.string()
					.describe(
						"Firestore app id to upload. Must be an app the authenticated user owns.",
					),
				domain: z
					.string()
					.describe(
						"CommCare HQ project space slug. Must match the project space authorized on your stored credentials.",
					),
				app_name: z
					.string()
					.optional()
					.describe(
						"Optional app name to use on HQ. Defaults to the blueprint's own name when omitted or blank.",
					),
			},
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;

			try {
				/* Pre-gate: ownership. Runs BEFORE the four upload gates so
				 * a cross-tenant upload probe never surfaces settings-level
				 * failure reasons for an app the caller doesn't own. */
				await requireOwnedApp(ctx.userId, appId);

				/* Gate 1 — domain-slug regex. Validates the project slug
				 * against HQ's own `legacy_domain_re`, which rules out
				 * anything outside `[\w.:-]+`. This prevents a caller from
				 * injecting path components into the URL `importApp`
				 * constructs against the hardcoded HQ base. */
				if (!isValidDomainSlug(args.domain)) {
					return makeGateError(
						UPLOAD_ERROR_TAGS.invalid_domain,
						"Invalid CommCare HQ project slug. Use the project's URL slug (letters, numbers, dots, hyphens, underscores only).",
						appId,
					);
				}

				/* Gate 2 — KMS credentials present. `null` means the user
				 * hasn't configured CommCare HQ yet. User-actionable: they
				 * need to visit Settings before the upload can proceed. */
				const settings = await getDecryptedCredentialsWithDomain(ctx.userId);
				if (!settings) {
					return makeGateError(
						UPLOAD_ERROR_TAGS.hq_not_configured,
						"CommCare HQ is not configured. Add your HQ credentials in Settings before uploading.",
						appId,
					);
				}

				/* Gate 3 — domain authorization match. Stored credentials
				 * carry the single project space they authorize; cross-
				 * domain uploads are forbidden even when the caller owns
				 * the Nova app and the slug is structurally valid. */
				if (settings.domain.name !== args.domain) {
					return makeGateError(
						UPLOAD_ERROR_TAGS.domain_mismatch,
						`You can only upload to the project space authorized on your credentials (${settings.domain.name}).`,
						appId,
					);
				}

				/* All pre-network gates passed — load the blueprint and
				 * proceed with the upload pipeline. The load runs AFTER
				 * ownership: a concurrent hard-delete between the two
				 * reads surfaces here as `null`, which we collapse to the
				 * same `not_found` a missing-id probe would hit. */
				const loaded = await loadAppBlueprint(appId);
				if (!loaded) throw new McpAccessError("not_found");
				const { doc, app } = loaded;

				/* Derive the run id from the app's own state (see
				 * `lib/mcp/runId.ts`). The upload typically comes at the
				 * end of a generation run, so the sliding-window lookup
				 * reuses the same id that the preceding mutations
				 * grouped under. */
				const runId = deriveRunId({
					currentRunId: loaded.app.run_id,
					lastActiveMs: timestampToMillis(loaded.app.updated_at),
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
					progress.notify("upload_started", `Uploading to ${args.domain}`, {
						app_id: appId,
					});

					/* Gate 4 — the only network call. The SSRF boundary
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
						settings.creds,
						args.domain,
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
				 * taxonomy. Gate 1-4 failures never reach this block —
				 * they return structured envelopes directly. */
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
