/**
 * `nova.upload_app_to_hq` — upload an owned app's blueprint to CommCare
 * HQ as a new app in the authorized project space.
 *
 * Scope: `nova.hq.write` (per-tool, in addition to the route-layer
 * `nova.read` + `nova.write` floor). HQ access is orthogonal to
 * Nova-internal read/write — see `lib/mcp/scopes.ts` for the full
 * enforcement model.
 *
 * HQ has no atomic update API, so every call produces a brand-new app
 * in the target project — the returned `hq_app_id` is always fresh.
 *
 * The upload is media-ON and two-phase: import the media-bearing HQ JSON
 * first (forms carry `jr://file/commcare/...` itext references), then
 * upload each asset's bytes against the new app so HQ maps them by path.
 * A media failure leaves the created app intact and surfaces as a
 * warning — it never fails the upload.
 *
 * The handler does NOT accept a `domain` argument. HQ API keys are
 * scoped to exactly one project space per user, so the domain is a
 * property of the user's stored credentials, not a client-supplied
 * input. Callers that want to preview the target domain before
 * confirming the upload should call `get_hq_connection` first. This
 * closes three classes of failure that the prior (domain-argumented)
 * tool had to gate for — invalid slug, unauthorized slug, missing
 * arg — by the simple expedient of not accepting the arg.
 *
 * Three actionable `error_type` values can surface from this tool, in
 * the order their gates fire — each producing a distinct envelope so
 * MCP clients can branch cleanly:
 *
 *   1. `scope_missing`     — the access token lacks `nova.hq.write`.
 *                            Pre-gate 0; cuts off ownership probing
 *                            before any Firestore read.
 *   2. `hq_not_configured` — the user has not stored CommCare HQ
 *                            credentials in Settings; there is nothing
 *                            to upload with.
 *   3. `hq_upload_failed`  — `importApp` returned a non-success
 *                            response (HQ rejected the upload, network
 *                            fault, or 5xx from HQ).
 *
 * (`not_found` from the ownership pre-gate is also possible but not
 * actionable — it collapses cross-tenant probes to the same shape as
 * a missing app.)
 *
 * The hardcoded `COMMCARE_HQ_URL` inside `lib/commcare/client.ts` is
 * the one SSRF boundary; since the domain now comes from the user's
 * KMS-encrypted settings (written through a validated save path), it
 * cannot smuggle path components into the URL `importApp` constructs.
 *
 * Pre-gate ordering — scope → ownership → settings — is defensive:
 * each gate leaks strictly less information than the one after it, so
 * the earliest-applicable rejection always closes more probe channels
 * than it opens.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	importApp,
	mediaUploadAssetsFromManifest,
	uploadAppMedia,
} from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { getDecryptedCredentialsWithDomain } from "@/lib/db/settings";
import { resolveMediaManifest } from "@/lib/media/manifest";
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
 * on an upload error expects exactly these two values. Treat them as
 * public API.
 */
export const UPLOAD_ERROR_TAGS = {
	/** Gate 1 — the user has no stored HQ credentials. */
	hq_not_configured: "hq_not_configured",
	/** Gate 2 — HQ rejected the upload (HQ-side failure, post-validation). */
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
 * The handler allocates its `LogWriter` + `McpContext` AFTER the
 * pre-network gate passes. A missing-creds call therefore never
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
				"Upload an owned app to CommCare HQ as a new app in the user's authorized project space. The target domain is read from the user's stored HQ credentials — callers don't supply it. Use `get_hq_connection` first if you need to preview the domain for a user confirmation. Returns the HQ app id and URL on success. HQ has no atomic update API — each call creates a fresh HQ app.",
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

				/* Gate 1 — KMS credentials present. `null` means the user
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

				/* The stored domain is the single source of truth for
				 * which project space this upload targets. The settings-
				 * save flow only persists a domain that `testDomainAccess`
				 * confirmed via HQ — and `testDomainAccess` itself rejects
				 * domains failing `isValidDomainSlug`. `importApp`
				 * re-validates as belt-and-suspenders, so the value
				 * reaching it is trusted by construction. */
				const targetDomain = settings.domain.name;

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

					/* Media manifest, resolved once with bytes. The upload
					 * path is media-ON: the expanded forms carry the
					 * `jr://file/commcare/<hash><ext>` itext references and
					 * the bytes follow via the multimedia upload below. One
					 * resolution pass feeds both the expander (references +
					 * `multimedia_map`) and the byte upload, so the
					 * references emitted and the files sent come from the
					 * same source. An empty manifest (media-free app) makes
					 * the upload step a no-op. */
					const manifest = await resolveMediaManifest(doc, ctx.userId, {
						withBytes: true,
					});

					/* Gate 2 — import the app first. The SSRF boundary
					 * lives inside `importApp` via the hardcoded
					 * `COMMCARE_HQ_URL`. `expandDoc` materializes the
					 * media-ON `HqApplication` JSON HQ's `/api/import_app/`
					 * endpoint expects; the app id it returns goes in the
					 * media upload URL. */
					const hqJson = expandDoc(doc, { assets: manifest });
					/* App name defaulting: `?.trim() || app.app_name` maps
					 * both omitted and whitespace-only inputs to the
					 * blueprint's denormalized name — which is non-empty
					 * by `denormalize`'s invariant (falls back to
					 * `UNTITLED_APP_NAME`). Mirrors the chat-surface
					 * behavior in `app/api/commcare/upload/route.ts`. */
					const appName = args.app_name?.trim() || app.app_name;
					const result = await importApp(
						settings.creds,
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

					/* App is created; upload each asset's bytes against it.
					 * HQ's `create_mapping` overwrites the placeholder
					 * `multimedia_map` ids with the couch-assigned ones so
					 * the references resolve on the device. A media failure
					 * never invalidates the (already-created) app — per-asset
					 * failures surface as warnings. */
					const warnings = [...result.warnings];
					const mediaResult = await uploadAppMedia(
						settings.creds,
						targetDomain,
						result.appId,
						mediaUploadAssetsFromManifest(manifest),
					);
					if ("success" in mediaResult) {
						warnings.push(
							"Media upload could not be completed; the app was created but its media may not display.",
						);
					} else if (mediaResult.failures.length > 0) {
						const n = mediaResult.failures.length;
						warnings.push(
							`${n} media ${n === 1 ? "file" : "files"} could not be uploaded — the app was created, but ${
								n === 1 ? "that file" : "those files"
							} won't display until re-uploaded.`,
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
							warnings,
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
									warnings,
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
				 * taxonomy. Gate 1-2 failures never reach this block —
				 * they return structured envelopes directly. */
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
