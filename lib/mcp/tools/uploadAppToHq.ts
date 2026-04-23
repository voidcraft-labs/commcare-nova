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
 * `_meta.error_type` so MCP clients can surface actionable guidance:
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
import { LogWriter } from "@/lib/log/writer";
import { McpContext } from "../context";
import { type McpToolErrorResult, toMcpErrorResult } from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { McpAccessError, requireOwnedApp } from "../ownership";
import { createProgressEmitter } from "../progress";
import type { ToolContext } from "../types";

/**
 * Canonical `_meta.error_type` strings for each upload-gate failure
 * mode. Exported as a frozen record so tests can reference the same
 * literals the handler emits — a silent rename in the handler would
 * otherwise pass tests that hardcode the old strings.
 *
 * These tags are part of the MCP wire contract: any client branching
 * on an upload error expects exactly these four values. Treat them as
 * public API.
 */
export const UPLOAD_ERROR_TYPES = {
	/** Gate 1 — `args.domain` failed the HQ domain-slug regex. */
	invalidDomain: "invalid_domain",
	/** Gate 2 — the user has no stored HQ credentials. */
	hqNotConfigured: "hq_not_configured",
	/** Gate 3 — stored credentials authorize a different project space. */
	domainMismatch: "domain_mismatch",
	/** Gate 4 — HQ rejected the upload (HQ-side failure, post-validation). */
	hqUploadFailed: "hq_upload_failed",
} as const;

/**
 * Build an MCP error envelope for a failed upload gate.
 *
 * Gates return error envelopes directly rather than throwing tagged
 * errors — this avoids the catch-and-discriminate machinery the plan
 * sketch's `_errorType`-stamped Error subclass would require and
 * keeps every gate's exit path identical in shape.
 *
 * The text message is user-actionable (surfaces to the LLM, which
 * surfaces to the end user); the structured `_meta.error_type` is the
 * machine-readable signal clients branch on.
 */
function makeGateError(
	errorType: (typeof UPLOAD_ERROR_TYPES)[keyof typeof UPLOAD_ERROR_TYPES],
	message: string,
	appId: string,
): McpToolErrorResult {
	return {
		isError: true,
		content: [{ type: "text", text: message }],
		_meta: { error_type: errorType, app_id: appId },
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
	server.tool(
		"upload_app_to_hq",
		"Upload an owned app to CommCare HQ as a new app in the specified project space. Returns the HQ app id and URL on success. HQ has no atomic update API — each call creates a fresh HQ app.",
		{
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
		async (args, extra) => {
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
						UPLOAD_ERROR_TYPES.invalidDomain,
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
						UPLOAD_ERROR_TYPES.hqNotConfigured,
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
						UPLOAD_ERROR_TYPES.domainMismatch,
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

				/* Run id: thread the client-supplied value from
				 * `_meta.run_id` when present and string-typed; otherwise
				 * mint one per call. `RequestMeta` is declared `$loose` in
				 * the SDK so `run_id` isn't on its typed shape — the
				 * narrow defensive cast mirrors `sharedToolAdapter`. */
				const metaRunId = (extra._meta as { run_id?: unknown } | undefined)
					?.run_id;
				const runId =
					typeof metaRunId === "string" ? metaRunId : crypto.randomUUID();
				/* Per-call `LogWriter` stamped `"mcp"` — the writer
				 * re-stamps `source` authoritatively on every event it
				 * persists, so the persisted value can never drift from
				 * the surface that built the writer. */
				const logWriter = new LogWriter(appId, "mcp");
				const progress = createProgressEmitter(
					server,
					extra._meta?.progressToken,
				);
				const mcpCtx = new McpContext({
					appId,
					userId: ctx.userId,
					runId,
					logWriter,
					progress,
				});

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
							UPLOAD_ERROR_TYPES.hqUploadFailed,
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
					 * minted fresh per call — `runId` is intentionally
					 * NOT reused because clients can thread one runId
					 * across multiple tool calls and that would break the
					 * `tool-call` ↔ `tool-result` pairing contract
					 * documented in `lib/log/types.ts`. */
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
									hq_app_id: result.appId,
									url: result.appUrl,
									warnings: result.warnings,
								}),
							},
						],
						_meta: {
							stage: "upload_complete",
							app_id: appId,
							run_id: runId,
						},
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
				return toMcpErrorResult(err, { appId });
			}
		},
	);
}
