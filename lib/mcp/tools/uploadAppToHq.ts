/**
 * `nova.upload_app_to_hq`: upload an owned app's blueprint to CommCare
 * HQ as a new app in a project space the user's API key can reach.
 *
 * Scope: `nova.hq.write` (per-tool, in addition to the route-layer
 * `nova.read` + `nova.write` floor). HQ access is orthogonal to
 * Nova-internal read/write; see `lib/mcp/scopes.ts` for the full
 * enforcement model.
 *
 * HQ has no atomic update API, so every call produces a brand-new app
 * in the target project: the returned `hq_app_id` is always fresh.
 *
 * The upload is media-ON and two-phase: import the media-bearing HQ JSON
 * first (forms carry `jr://file/commcare/...` itext references), then
 * upload each asset's bytes against the new app so HQ maps them by path.
 * A media failure leaves the created app intact and surfaces as a
 * warning; it never fails the upload.
 *
 * Target space (the optional `domain` argument):
 *   An HQ API key can reach several project spaces (an unscoped key reaches
 *   every space its owner belongs to). Omitting `domain` works only when the
 *   key reaches exactly one space: that sole space is used. A multi-space key
 *   must pass `domain` explicitly: there is no stored default, so a multi-space
 *   key with no `domain` is `domain_ambiguous` (see below); the tool refuses
 *   to guess. Use `get_hq_connection` to list the reachable spaces
 *   (`available_domains`) and ask the user which one.
 *
 * Actionable `error_type` values, in the order their gates fire, each
 * producing a distinct envelope so MCP clients can branch cleanly:
 *
 *   1. `scope_missing`:           the access token lacks `nova.hq.write`.
 *                                 Pre-gate 0; cuts off ownership probing
 *                                 before any app-state read.
 *   2. `hq_not_configured`:       the user has not stored CommCare HQ
 *                                 credentials in Settings.
 *   3. `domain_not_authorized`:   `domain` was supplied but the key can't
 *                                 reach it; the message names the reachable
 *                                 set.
 *   4. `domain_ambiguous`:        multi-space key with no `domain` supplied;
 *                                 the tool names the spaces and asks the
 *                                 caller to choose rather than guessing.
 *   5. `invalid_input`:           the zero-tolerance boundary gate found
 *                                 validator issues (a soundness error,
 *                                 unfinished completeness work, or a stale
 *                                 media reference). Fires after domain
 *                                 resolution, before the HQ network call;
 *                                 the message carries each rule's
 *                                 actionable text.
 *   6. `hq_upload_failed`:        `importApp` returned a non-success
 *                                 response (HQ rejected the upload or
 *                                 returned 5xx). A thrown transport fault
 *                                 goes through the shared MCP classifier.
 *
 * (`not_found` from the ownership pre-gate is also possible but not
 * actionable: it collapses cross-tenant probes to the same shape as
 * a missing app.)
 *
 * The closed server catalog (`lib/commcare/servers.ts`, resolved through
 * the stored connection's `server`) is the one SSRF boundary; the resolved
 * domain is always one the stored key already reached (probed at
 * save/refresh and re-checked here against the reachable set), so it
 * cannot smuggle path components into the URL `importApp` constructs.
 *
 * Pre-gate ordering (scope → ownership → settings/domain) is defensive:
 * each gate leaks strictly less information than the one after it, so
 * the earliest-applicable rejection always closes more probe channels
 * than it opens.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveUploadTarget } from "@/lib/db/settings";
import { activeRemoteApp } from "@/lib/deployment/resources";
import { publishAppToHq } from "@/lib/deployment/service";
import { initMcpCall } from "../context";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
	type UploadErrorType,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { deriveRunId, timestampToMillis } from "../runId";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";
import { describeDeployment } from "./deploymentProjection";

/**
 * Canonical `error_type` strings for each upload-gate failure mode.
 * `satisfies Record<UploadErrorType, UploadErrorType>` forces every
 * variant an upload gate can emit to appear as a key: adding a new
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
	/** Multi-space key with no `domain` supplied; caller must choose. */
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
				"Upload an owned app to CommCare HQ as a new app. Call `get_hq_connection` first to list reachable spaces (`available_domains`); when there are several, ask the user which one and never choose for them. Before asking the user to confirm or invoking this tool, call `get_app_hq_feature_flags` with that explicit domain and relay its `feature_flag_requirements`, including confirmed `missing_flags` and any `unverified_flags`; this is informational and must not cause requested app features to be changed or removed. Pass the same `domain` here. You can omit it only when the key reaches exactly one space; a multi-space key with no `domain` returns `domain_ambiguous` (it won't guess). HQ has no atomic update API, so each call creates a fresh HQ app. On success, `feature_flag_requirements` repeats an authoritative post-upload check against the exact target and includes support@dimagi.com guidance. The diagnostic never blocks an otherwise successful upload.",
			inputSchema: z.object({
				app_id: z
					.string()
					.describe(
						"App id to upload. Must be an app the authenticated user owns.",
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
						"Optional target project space (domain slug). Must be one the user's API key can reach. See `get_hq_connection`'s `available_domains`. Omit only when the key reaches a single space; a multi-space key requires it.",
					),
			}),
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;

			try {
				/* Pre-gate 0: scope. Runs BEFORE ownership so a token without
				 * `nova.hq.write` cannot probe whether an app id exists or
				 * is owned by the caller: scope failure leaks nothing about
				 * the user's data, ownership failure does (collapsed at the
				 * wire to `not_found`, but still a probe channel that's
				 * cheaper to cut off entirely). Throws `McpScopeError`;
				 * the surrounding catch stamps `app_id` from `ctx`. */
				assertScope(ctx, SCOPES.hqWrite, "upload_app_to_hq");

				/* Pre-gate 1: ownership + blueprint load in one
				 * read. `loadAppBlueprint` throws `McpAccessError` on
				 * cross-tenant probe or vanished row; both collapse to
				 * `not_found` on the wire so a probing client cannot
				 * surface settings-level failure reasons for an app the
				 * caller doesn't own. */
				const { doc, app, access } = await loadAppBlueprint(
					appId,
					ctx.userId,
					"edit",
				);

				/* Gate 2: credentials + target-space resolution in one read.
				 * The optional `domain` arg picks the target (required for a
				 * multi-space key); the decrypted key is only attached when a
				 * target resolves. The three failure shapes map 1:1 to distinct
				 * wire error types so a client can branch (configure, pick a
				 * valid space, or disambiguate). */
				const requested = args.domain?.trim() || undefined;
				const target = await resolveUploadTarget(ctx.userId, requested);
				if (!target.ok) {
					if (target.error === "not_configured") {
						return makeGateError(
							UPLOAD_ERROR_TAGS.hq_not_configured,
							"CommCare HQ is not configured. Add your HQ credentials in Settings before uploading.",
							appId,
						);
					}
					const reachable = target.available.map((d) => d.name).join(", ");
					if (target.error === "not_authorized") {
						return makeGateError(
							UPLOAD_ERROR_TAGS.domain_not_authorized,
							`Your stored CommCare HQ API key can't reach the "${requested}" project space. It reaches: ${reachable}. Pass one of those as \`domain\`, or update your key in Settings.`,
							appId,
						);
					}
					return makeGateError(
						UPLOAD_ERROR_TAGS.domain_ambiguous,
						`Your CommCare HQ API key reaches ${target.available.length} project spaces (${reachable}). Pass \`domain\` to choose which one to upload to.`,
						appId,
					);
				}
				const targetDomain = target.domain.name;

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

				/* The per-call collaborators (LogWriter, progress emitter,
				 * McpContext) are allocated INSIDE the publish's own
				 * upload-started hook, which fires only after every blocking
				 * preflight edge has passed. A refused upload therefore never
				 * announces "Uploading" for an app that was never sent, and
				 * never allocates a log writer or records a phantom run:
				 * a client retrying an invalid app in a loop must not fill
				 * admin inspect with uploads that never happened. Held in a
				 * ref object because the hook assigns it from inside the
				 * publish call, where a plain `let` stays narrowed to null. */
				const call: { current: ReturnType<typeof initMcpCall> | null } = {
					current: null,
				};

				try {
					/* The one publish lifecycle, shared with the browser's
					 * publish dialog. It preflights the dependency graph, sends
					 * the app, and records the durable deployment, so an MCP
					 * upload and a browser upload produce the same record and
					 * cannot drift apart.
					 *
					 * App name defaulting: `?.trim() || app.app_name` maps both
					 * omitted and whitespace-only inputs to the blueprint's
					 * denormalized name, which the schema keeps non-blank. */
					const outcome = await publishAppToHq({
						scope: {
							appId,
							projectId: access.projectId,
							role: access.role,
							actorUserId: ctx.userId,
						},
						doc,
						compiledAtSeq: app.mutation_seq,
						appName: args.app_name?.trim() || app.app_name,
						server: target.server,
						domain: targetDomain,
						onUploadStarted: () => {
							call.current = initMcpCall(
								ctx,
								appId,
								access.projectId,
								access.role,
								runId,
								extra,
							);
							call.current.progress.notify(
								"upload_started",
								`Uploading to ${targetDomain}`,
								{ app_id: appId },
							);
						},
					});

					/* Branch on whether THIS attempt got the app there, not on
					 * the record's state: a blocked preflight against an app
					 * that is already released leaves the record released,
					 * because it still is, and reading success off that would
					 * report a publish that never happened as a success. The
					 * refusal is the attempt's own report, never read back out
					 * of the record's phase history, where an earlier attempt's
					 * failure would shadow this one's. */
					if (!outcome.landed) {
						const failure = outcome.refusal.failure;
						/* The boundary gate's findings are `invalid_input`
						 * because that is what a client branches on to know the
						 * APP is what needs fixing, not the connection or the
						 * target. */
						if (failure.code === "app_not_ready") {
							throw new McpInvalidInputError(
								`This app isn't ready to upload. Fix these first: ${
									failure.details.length > 0
										? failure.details.join(" ")
										: failure.message
								}`,
							);
						}
						if (failure.code === "hq_not_connected") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.hq_not_configured,
								failure.message,
								appId,
							);
						}
						if (failure.code === "domain_not_authorized") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.domain_not_authorized,
								failure.message,
								appId,
							);
						}
						return makeGateError(
							UPLOAD_ERROR_TAGS.hq_upload_failed,
							failure.message,
							appId,
						);
					}

					const record = outcome.deployment.deployment;
					const remote = activeRemoteApp(outcome.deployment);
					const hqAppId = remote?.remoteId ?? null;
					call.current?.progress.notify(
						"upload_complete",
						`Uploaded. HQ app id ${hqAppId ?? "unknown"}`,
						{ app_id: appId, hq_app_id: hqAppId },
					);

					const payload = {
						stage: "upload_complete",
						app_id: appId,
						hq_app_id: hqAppId,
						url: outcome.hqAppUrl,
						warnings: outcome.warnings,
						feature_flag_requirements: outcome.featureFlags,
						deployment_state: record.state,
						deployment: describeDeployment(outcome.deployment),
						setup_artifact: outcome.artifact,
					};

					/* Record the upload success on the event log as a
					 * `tool-result` conversation event. `toolCallId` is a fresh
					 * uuid (not `runId`) to preserve the `tool-call` ↔
					 * `tool-result` pairing contract in `lib/log/types.ts`. */
					call.current?.mcpCtx.recordConversation({
						type: "tool-result",
						toolCallId: crypto.randomUUID(),
						toolName: "upload_app_to_hq",
						output: {
							hq_app_id: hqAppId,
							url: outcome.hqAppUrl,
							warnings: outcome.warnings,
							feature_flag_requirements: outcome.featureFlags,
						},
					});

					return {
						content: [{ type: "text", text: JSON.stringify(payload) }],
					};
				} finally {
					/* Drain the event-log buffer before returning OR
					 * throwing. `LogWriter.flush` never throws; it resolves
					 * once every inflight log batch has acknowledged.
					 * A missed flush silently drops any events that hadn't
					 * triggered the batch-size flush threshold yet. */
					const opened = call.current;
					if (opened !== null) await opened.logWriter.flush();
				}
			} catch (err) {
				/* Ownership failures, missing-blueprint races, and any
				 * throw from `importApp` (network fault, etc.) all land
				 * here. `toMcpErrorResult` classifies via the shared
				 * taxonomy. Gate 2-3 failures never reach this block:
				 * they return structured envelopes directly. */
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
