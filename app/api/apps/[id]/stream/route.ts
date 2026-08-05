/**
 * Real-time relay: Server-Sent Events over a Postgres LISTEN/NOTIFY poke.
 *
 * GET /api/apps/{id}/stream: a same-origin SSE channel that pipes the app's
 * durable app-change stream (`app_changes`), Project lookup manifest, and
 * live presence roster to the browser. The browser carries no database client
 * and no second identity: this
 * route subscribes to the process-wide LISTEN connection (`lib/db/streamListener`)
 * and authorizes with the Better Auth session cookie, exactly like every other
 * authenticated app route. On each poke it SELECTs the rows since its cursor:
 * the poke carries no data, so no notification content is ever lost; a missed
 * poke degrades to the next poke or the reconnect catch-up, never to lost data.
 *
 * Connect-time authorization checks app membership (the user must have access).
 * A ~10 s cadence re-checks the session plus the current Project/role/canEdit
 * tuple; a confirmed view loss revokes, while an authorized tuple change reloads.
 * Ban/deletion is a separate `isUserActive` signal. A transient backend blip
 * skips the tick.
 *
 * The 60-minute Cloud Run request cap surfaces as a transparent EventSource
 * reconnect via the `Last-Event-ID` header (where `requireSession` re-runs);
 * `maxDuration` below is advisory.
 *
 * Frames:
 *   event: mutation  id:<seq> , one browser-replayable committed batch.
 *   event: organization-revision a payload-free poke to re-read this app's
 *                                organization snapshot.
 *   event: lookup-revision       the Project's complete authoritative lookup
 *                                manifest. Seq-less; the mutation cursor stays
 *                                exclusively on `mutation` frames.
 *   event: presence              the full presence roster snapshot.
 *   event: app-status            the app row's run-lifecycle status
 *                                (`generating | complete | error`). Emitted on
 *                                connect, on the completion notify a build's
 *                                terminal transaction sends (so the release
 *                                lands the moment `complete` commits), and
 *                                when the reauthorization cadence observes any
 *                                other change — the channel that tells a tab
 *                                not attached to a run's chat stream that a
 *                                build finished. Seq-less.
 *   event: reload                replay is impossible (below the retention
 *                                efficiency bound or a gap), or a server-only
 *                                change requires a fresh snapshot handoff; the
 *                                client GETs the current blueprint.
 *                                Seq-less, no `id:` line.
 *   event: protocol-failure      the complete post-cursor suffix failed the
 *                                canonical frame grammar. No mutation frame
 *                                was emitted and the client reloads from its
 *                                unchanged cursor. Seq-less and terminal.
 *   event: revoked               access was revoked; the client stops. Seq-less.
 */

import { sql } from "kysely";
import { ApiError, handleApiError } from "@/lib/apiError";
import { getSessionSafe, requireSession } from "@/lib/auth-utils";
import type { AppStatusFrame } from "@/lib/collab/appStatusFrame";
import { lookupManifestFrameSchema } from "@/lib/collab/lookupManifestFrame";
import {
	admitMutationFrame,
	type MutationFrame,
} from "@/lib/collab/mutationFrame";
import type { RevocationReason } from "@/lib/collab/revocationFrame";
import { isUserActive } from "@/lib/db/api-keys";
import {
	AppAccessError,
	reauthorizeStreamScope,
	type TransactionalAppScope,
} from "@/lib/db/appAccess";
import { readAppChangeStreamRowsSince } from "@/lib/db/appChangeStream";
import { createCoalescedStreamPump } from "@/lib/db/coalescedStreamPump";
import { RETENTION_COUNT } from "@/lib/db/constants";
import { parsePersistedAppChangeEnvelope } from "@/lib/db/persistedJson";
import { getAppDb } from "@/lib/db/pg";
import {
	type PresenceRosterRow,
	projectPresenceRoster,
} from "@/lib/db/presenceRoster";
import {
	subscribeAppOrganization,
	subscribeAppStream,
	subscribeLookupProject,
} from "@/lib/db/streamListener";
import {
	runAfterAppStreamSubscribeTestHook,
	runBeforeAppChangeReauthorizationTestHook,
	runBeforeLookupManifestReadTestHook,
	runBeforeMutationReadTestHook,
} from "@/lib/db/streamReadTestHooks";
import type { AppLifecycleStatus } from "@/lib/db/types";
import { log } from "@/lib/logger";
import { getLookupManifest } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";

/* Node runtime: the route holds a long-lived subscription to the Postgres
 * LISTEN connection and `setInterval`s, neither of which the Edge runtime
 * supports. */
export const runtime = "nodejs";
/* Never statically prerender or cache: every connection is a live per-user
 * stream keyed on the session cookie. */
export const dynamic = "force-dynamic";
/* Advisory: the platform caps a request at 60 min regardless; the client
 * reconnects transparently via `Last-Event-ID`. */
export const maxDuration = 3600;

/**
 * Re-check session + scope on this cadence and close on a CONFIRMED denial. ~10 s
 * in prod; the revocation tests override it via `NOVA_STREAM_CADENCE_MS` so they
 * don't have to wait a full 10 s per case (a testability seam only, prod never
 * sets the var).
 */
const REVOCATION_CADENCE_MS = (() => {
	const parsed = Number.parseInt(
		process.env.NOVA_STREAM_CADENCE_MS ?? "10000",
		10,
	);
	// Guard the test-only override like `parseCursor` guards its input: a
	// non-numeric/non-positive value would reach `setInterval(fn, NaN)`, which
	// coerces to ~0 ms: a full session+scope re-check spinning per tick.
	return Number.isNaN(parsed) || parsed <= 0 ? 10_000 : parsed;
})();

/**
 * Re-emit the presence roster on this cadence too (not only on a poke): a
 * roster entry silently EXPIRES when its `expire_at` lapses with no write to
 * poke us, so a periodic re-query lets the client drop a collaborator whose tab
 * died without a DELETE.
 */
const PRESENCE_ROSTER_INTERVAL_MS = 15_000;

/**
 * Parse the recovery cursor from the reconnect header (`Last-Event-ID`, set by
 * the browser's EventSource on every reconnect) or the initial `?since` query,
 * flooring to 0 on anything non-numeric. `seq` is numeric; the wire carries it
 * as a string.
 */
function parseCursor(req: Request): number {
	const url = new URL(req.url);
	const raw =
		req.headers.get("Last-Event-ID") ?? url.searchParams.get("since") ?? "0";
	try {
		return safePersistedSequence(raw, "App stream cursor");
	} catch {
		return 0;
	}
}

const STREAM_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
} as const;

/** One terminal, seq-less SSE frame for a request rejected after authentication. */
function _terminalStreamResponse(event: string, data: unknown): Response {
	return new Response(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, {
		headers: STREAM_HEADERS,
	});
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id: appId } = await params;
		const userId = session.user.id;
		const cursor = parseCursor(req);

		/* Re-authorize app membership. An `AppAccessError` retains the route's
		 * IDOR-safe 404 if the user lacks access. */
		const scope = await reauthorizeStreamScope(appId, userId);

		return openStream({
			appId,
			userId,
			cursor,
			scope,
			req,
		});
	} catch (err) {
		/* Pre-stream failure (auth, admission/registration): OR a client
		 * disconnect that aborted an in-flight await here. `handleApiError`
		 * centrally maps an `ApiError` → its status, an `AppAccessError` → 404, a
		 * CLIENT ABORT → 499 logged at WARN (never Sentry: a disconnect is the
		 * most common `/stream` event), and any genuine fault → 500 + `log.error`.
		 * No stream opened, so nothing to tear down. */
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to open stream", 500),
		);
	}
}

/**
 * Build the SSE `Response` once the connect-time gate has passed. Split out so
 * the gate's failures return a normal JSON error (404/500) while the stream body
 * itself never throws synchronously out of the handler.
 */
function openStream(args: {
	appId: string;
	userId: string;
	cursor: number;
	scope: TransactionalAppScope;
	req: Request;
}): Response {
	const { appId, userId, cursor, scope, req } = args;
	const head = scope.baseSeq;
	const lookupScope: LookupScope = {
		projectId: scope.projectId,
		actorId: scope.actorUserId,
		role: scope.role,
	};

	const encoder = new TextEncoder();

	/* `start` populates this so `cancel` can tear down too: see the `cancel`
	 * handler at the bottom. `teardown` is idempotent, so a double invocation
	 * (abort + cancel) is safe. */
	const teardownRef: { current: (() => void) | null } = { current: null };

	let stream: ReadableStream<Uint8Array>;
	try {
		stream = new ReadableStream<Uint8Array>({
			start(controller) {
				/* Set on teardown (client abort). Every enqueue/close checks it first,
				 * so a poke-driven pump or a cadence tick that resolves AFTER teardown is
				 * a no-op: no enqueue on a closed controller, no leaked timer or
				 * subscription. */
				let closed = false;
				/* The highest seq delivered so far. The first `mutation` frame must be
				 * `cursor + 1`; any hole means the browser missed entries → reload. */
				let deliveredThrough = cursor;
				/* The same single-flight coalescing for the roster emit: the initial
				 * emit, the connect-time catch-up poke, presence pokes, and the
				 * freshness interval must never launch two racing presence SELECTs. */
				let rosterInFlight = false;
				let rosterPending = false;
				/* Pump, subscription, and interval holders: nullable so `teardown` is safe to
				 * call BEFORE they attach (the retention-overrun early return below
				 * reloads-and-closes before any subscribe). */
				let mutationPump: ReturnType<typeof createCoalescedStreamPump> | null =
					null;
				let lookupPump: ReturnType<typeof createCoalescedStreamPump> | null =
					null;
				let organizationPump: ReturnType<
					typeof createCoalescedStreamPump
				> | null = null;
				let statusPump: ReturnType<typeof createCoalescedStreamPump> | null =
					null;
				let unsubscribeApp: (() => void) | null = null;
				let unsubscribeOrganization: (() => void) | null = null;
				let unsubscribeLookup: (() => void) | null = null;
				let cadence: ReturnType<typeof setInterval> | null = null;
				let rosterInterval: ReturnType<typeof setInterval> | null = null;
				let abortListenerAttached = false;

				function send(event: string, data: unknown, seqId?: number): void {
					if (closed) return;
					let frame = `event: ${event}\n`;
					/* `revoked` / `reload` are seq-less: no `id:` line, so a reconnect
					 * never advances past a change that requires a fresh snapshot. */
					if (seqId !== undefined) frame += `id: ${seqId}\n`;
					frame += `data: ${JSON.stringify(data)}\n\n`;
					try {
						controller.enqueue(encoder.encode(frame));
					} catch {
						/* The platform cancelled the response stream before our `abort`
						 * listener ran, so the controller is already closed ("Invalid
						 * state: Controller is already closed"). Treat the first failed
						 * write as the disconnect: tear everything down rather than let the
						 * throw escape a pump/cadence callback as an unhandled error. */
						teardown();
					}
				}

				function teardown(): void {
					if (closed) return;
					closed = true;
					mutationPump?.close();
					lookupPump?.close();
					organizationPump?.close();
					statusPump?.close();
					unsubscribeApp?.();
					unsubscribeOrganization?.();
					unsubscribeLookup?.();
					if (cadence) clearInterval(cadence);
					if (rosterInterval) clearInterval(rosterInterval);
					if (abortListenerAttached) {
						req.signal.removeEventListener("abort", teardown);
						abortListenerAttached = false;
					}
					try {
						controller.close();
					} catch {
						/* Already closed by the platform (client gone): nothing to do. */
					}
				}
				/* Expose teardown to `cancel` (a consumer/platform `cancel()` that does
				 * not also abort `req.signal`). */
				teardownRef.current = teardown;

				/* A gap or a retention overrun means the browser can't rebuild from the
				 * deltas it has: tell it to GET the fresh blueprint. `reload` is
				 * terminal for this connection's replay; the client reconnects at the
				 * fresh seq. */
				function reloadAndClose(reason = "replay-unavailable"): void {
					send("reload", { reason });
					teardown();
				}

				function revokeAndClose(reason: RevocationReason): void {
					send("revoked", { reason });
					teardown();
				}

				function protocolFailureAndClose(reason: string): void {
					send("protocol-failure", { reason });
					teardown();
				}

				/* The last run-lifecycle status this connection announced. `null`
				 * until the connect-time emit, so the first call always sends. The
				 * value arrives already admitted through the closed vocabulary
				 * (`parsePersistedAppLifecycleStatus` at the scope read), so the
				 * frame is constructed typed rather than re-validated here. */
				let announcedStatus: AppLifecycleStatus | null = null;
				function sendAppStatus(status: AppLifecycleStatus): void {
					if (closed || status === announcedStatus) return;
					announcedStatus = status;
					send("app-status", { status } satisfies AppStatusFrame);
				}

				/* SELECT every committed batch past the delivered cursor and emit it. The
				 * `app_changes` log is PERMANENT, so the entries always exist above
				 * the retention efficiency bound: a gap here means the cursor is a real
				 * hole, not a pruned window. */
				async function deliverSince(): Promise<void> {
					if (closed) return;
					runBeforeMutationReadTestHook();
					const db = await getAppDb();
					const rows = await readAppChangeStreamRowsSince(
						db,
						appId,
						deliveredThrough,
					);
					/* Validate the COMPLETE fetched suffix with the server-only durable
					 * parser before emitting any browser frame. A disruptive change later
					 * in the SELECT prevents partial delivery of earlier ordinary rows. */
					let previousSeq = deliveredThrough;
					const parsedFrames: MutationFrame[] = [];
					let containsDisruptiveChange = false;
					for (const row of rows) {
						try {
							const expectedSeq = nextPersistedSequence(
								previousSeq,
								`delivered app-change sequence for app ${appId}`,
							);
							const change = parsePersistedAppChangeEnvelope(
								{
									seq: row.seq,
									batchId: row.batch_id,
									runId: row.run_id,
									actorId: row.actor_id,
									kind: row.kind,
									mutationsText: row.mutations_text,
									fromProjectId: row.from_project_id,
									toProjectId: row.to_project_id,
								},
								`app_changes row for app ${appId}`,
							);
							if (change.seq !== expectedSeq) {
								reloadAndClose();
								return;
							}
							const baselineSeq =
								row.baseline_seq === null
									? null
									: safePersistedSequence(
											row.baseline_seq,
											`app_change_fold_baselines.seq for app ${appId}`,
										);
							if (
								(change.kind === "fold-baseline") !== (baselineSeq !== null) ||
								(baselineSeq !== null && baselineSeq !== change.seq)
							) {
								throw new Error(
									"fold-baseline change and immutable baseline do not match",
								);
							}
							previousSeq = change.seq;
							if (
								change.kind === "autosave" ||
								change.kind === "mcp" ||
								change.kind === "chat"
							) {
								const frame = admitMutationFrame({
									seq: change.seq,
									batchId: change.batchId,
									actorId: change.actorId,
									kind: change.kind,
									mutations: change.mutations,
									...(change.runId === undefined
										? {}
										: { runId: change.runId }),
								});
								if (frame === null) {
									throw new Error(
										"durable client change failed browser-frame admission",
									);
								}
								parsedFrames.push(frame);
							} else {
								containsDisruptiveChange = true;
							}
						} catch (error) {
							log.error("[stream] malformed durable app-change suffix", {
								appId,
								error,
							});
							protocolFailureAndClose("malformed-app-change-suffix");
							return;
						}
					}

					if (containsDisruptiveChange) {
						/* Blueprint migrations, fold baselines, and Project moves require
						 * fresh scope. Reauthorize before advancing any cursor or emitting
						 * any earlier ordinary row. A
						 * transient failure leaves `deliveredThrough` unchanged and the
						 * pump retries the whole suffix; a confirmed loss revokes. */
						try {
							runBeforeAppChangeReauthorizationTestHook();
							await reauthorizeStreamScope(appId, userId);
						} catch (err) {
							if (err instanceof AppAccessError) {
								revokeAndClose("access-revoked");
								return;
							}
							throw err;
						}
						if (closed) return;
						reloadAndClose("app-changed");
						return;
					}

					for (const frame of parsedFrames) {
						if (closed) return;
						deliveredThrough = frame.seq;
						/* Project the client-relevant shape: the reconciler keys on these
						 * fields (echo classification, gap detection, apply). The row's
						 * server-only `ts` is not on the wire. */
						send("mutation", frame, frame.seq);
					}
				}

				/* Read and validate the complete live roster before emitting anything.
				 * One malformed stored row rejects this current page; publishing the
				 * remaining rows would falsely present a partial roster as authoritative. */
				async function emitRosterOnce(): Promise<void> {
					if (closed) return;
					const db = await getAppDb();
					const rows = await db
						.selectFrom("presence")
						.select([
							"user_id",
							"session_id",
							"name",
							"image",
							"email",
							"color",
							"location",
							"updated_at",
						])
						.where("app_id", "=", appId)
						.where(sql<boolean>`expire_at > now()`)
						.execute();
					if (closed) return;
					send("presence", projectPresenceRoster(rows as PresenceRosterRow[]));
				}

				/* Coalesce overlapping roster emits into one follow-up query, a poke or
				 * interval tick arriving mid-emit re-runs it once at the end, never a
				 * racing presence SELECT on the pool (two concurrent identical roster
				 * queries churn fresh pool connections needlessly). */
				async function emitRoster(): Promise<void> {
					if (closed) return;
					if (rosterInFlight) {
						rosterPending = true;
						return;
					}
					rosterInFlight = true;
					try {
						do {
							rosterPending = false;
							await emitRosterOnce();
						} while (rosterPending && !closed);
					} catch (err) {
						/* Transient read fault: warn; the interval / next poke re-queries. */
						log.warn("[stream] presence roster error", {
							appId,
							err: err instanceof Error ? err.message : String(err),
						});
					} finally {
						rosterInFlight = false;
					}
				}

				try {
					/* Both durable readers share the same headless single-flight contract:
					 * pokes coalesce, a failed SELECT retries for the lifetime of the stream
					 * with a capped delay, and teardown cancels any unref'ed retry timer.
					 * Separate instances keep the app mutation cursor independent from the
					 * Project lookup snapshot clock. */
					mutationPump = createCoalescedStreamPump({
						run: deliverSince,
						onError(err) {
							log.warn("[stream] mutation pump error (will retry)", {
								appId,
								err: err instanceof Error ? err.message : String(err),
							});
						},
					});
					lookupPump = createCoalescedStreamPump({
						async run() {
							if (closed) return;
							runBeforeLookupManifestReadTestHook();
							const manifest = await getLookupManifest(lookupScope);
							if (closed) return;
							/* Validate the complete current page before emission. Deliberately
							 * seq-less: only mutation frames own Last-Event-ID. */
							send(
								"lookup-revision",
								lookupManifestFrameSchema.parse(manifest),
							);
						},
						onError(err) {
							log.warn("[stream] lookup manifest pump error (will retry)", {
								appId,
								projectId: lookupScope.projectId,
								err: err instanceof Error ? err.message : String(err),
							});
						},
					});
					organizationPump = createCoalescedStreamPump({
						async run() {
							if (closed) return;
							send("organization-revision", {});
						},
						onError(err) {
							log.warn("[stream] organization pump error (will retry)", {
								appId,
								err: err instanceof Error ? err.message : String(err),
							});
						},
					});
					/* Run-lifecycle status lane: `completeAndSettleRun` pokes this the
					 * moment a build commits `complete`, so a tab not attached to the
					 * run's own chat stream (a second tab, a co-member) releases its
					 * build-rate latch immediately instead of waiting out the reauth
					 * cadence below (which stays as the carrier for every other
					 * transition and the notify's at-least-once backstop). The scope
					 * re-read keeps the emit authorized and admits the status through
					 * the closed vocabulary, same as the cadence's read. */
					statusPump = createCoalescedStreamPump({
						async run() {
							if (closed) return;
							const fresh = await reauthorizeStreamScope(appId, userId);
							if (closed) return;
							sendAppStatus(fresh.status);
						},
						onError(err) {
							if (err instanceof AppAccessError) {
								revokeAndClose("access-revoked");
								return;
							}
							log.warn("[stream] app-status pump error (will retry)", {
								appId,
								err: err instanceof Error ? err.message : String(err),
							});
						},
					});

					/* If the cursor fell below the retention window, the client is too far
					 * behind to replay economically. The log is PERMANENT so the entries DO
					 * exist, but replaying thousands of batches is slower than a single
					 * blueprint reload: the retention bound is now purely an efficiency cap. */
					if (cursor < head - RETENTION_COUNT) {
						reloadAndClose();
						return;
					}

					/* Subscribe FIRST, then do the initial reads: a commit landing between
					 * the initial SELECT and the subscribe would otherwise be missed, and the
					 * listener's connect-time catch-up re-pokes us anyway (it treats any poke
					 * as "re-query from your cursor"). */
					unsubscribeApp = subscribeAppStream(
						appId,
						() => {
							mutationPump?.poke();
						},
						() => {
							void emitRoster();
						},
						() => {
							statusPump?.poke();
						},
					);
					runAfterAppStreamSubscribeTestHook();
					unsubscribeOrganization = subscribeAppOrganization(appId, () => {
						organizationPump?.poke();
					});
					unsubscribeLookup = subscribeLookupProject(
						lookupScope.projectId,
						() => {
							lookupPump?.poke();
						},
					);
					mutationPump.poke();
					lookupPump.poke();
					organizationPump.poke();
					void emitRoster();

					/* The connect-time status snapshot. The completion notify (the
					 * status pump above) and the cadence below re-emit on change.
					 * There is NO emit-time validation here: every status this
					 * function sees was already admitted through the closed
					 * vocabulary by `parsePersistedAppLifecycleStatus` at its scope
					 * read (connect admission, the pump's reauthorization, the
					 * cadence's), which is the one place an out-of-vocabulary row
					 * value is stopped before it can reach a connected tab's
					 * pricing latch. */
					sendAppStatus(scope.status);

					/* Continuous revocation: re-run the session + scope check on a cadence and
					 * close ONLY on a CONFIRMED denial: never on a transient backend blip.
					 * The confirmed signals are:
					 *   - `getSessionSafe` returns a session for a DIFFERENT user (the cookie
					 *     now belongs to someone else: a real rotation).
					 *   - `isUserActive(userId) === false`: a definitively banned/deleted
					 *     user (`isUserActive` THROWS on a DB fault, so a throw is transient,
					 *     not a ban).
					 *   - `reauthorizeStreamScope` throws `AppAccessError`: a real non-member /
					 *     insufficient-role.
					 * Everything else: a bare `getSessionSafe` null (its own `getSession`
					 * throw is swallowed to null, so null is ambiguous), an `isUserActive`
					 * throw, a non-`AppAccessError` reauthorization throw (pool exhaustion,
					 * a DB blip): SKIPS this tick and leaves the stream open. The next tick
					 * re-checks; a real loss confirms then. This keeps the cadence at least as
					 * forgiving as the connect path, which lets EventSource auto-reconnect
					 * through a transient 500. */
					cadence = setInterval(() => {
						void (async () => {
							if (closed) return;
							const live = await getSessionSafe(req);
							if (closed) return;
							/* A confirmed identity change: a session that resolves to a
							 * different user. A bare `null` is NOT confirmed (a swallowed
							 * transient error looks identical), so it does not revoke here. */
							if (live && live.user.id !== userId) {
								revokeAndClose("session-revoked");
								return;
							}

							/* Confirmed ban/deletion. `isUserActive` throws on a DB fault, so a
							 * throw is transient → skip (do not revoke). */
							try {
								if (!(await isUserActive(userId))) {
									revokeAndClose("account-inactive");
									return;
								}
							} catch {
								return; // transient: leave the stream open, re-check next tick
							}
							if (closed) return;

							/* Confirmed view loss revokes. An authorized Project, role, or edit-
							 * capability change instead reloads through the snapshot handoff. */
							try {
								const fresh = await reauthorizeStreamScope(appId, userId);
								if (closed) return;
								if (
									fresh.projectId !== scope.projectId ||
									fresh.role !== scope.role ||
									fresh.canEdit !== scope.canEdit
								) {
									reloadAndClose("authorization-changed");
								}
								/* Same tick, no extra read: announce a run-lifecycle change
								 * (build finished, build failed, re-drive started) to tabs
								 * that aren't attached to the run's own chat stream. No-op
								 * when the reload above closed the connection. */
								sendAppStatus(fresh.status);
							} catch (err) {
								if (err instanceof AppAccessError) {
									revokeAndClose("access-revoked");
								}
								// else transient: leave open, re-check next tick.
							}
						})();
					}, REVOCATION_CADENCE_MS);
					cadence.unref?.();

					/* Re-emit the roster periodically so an expired-but-un-DELETEd peer drops
					 * off the client's view (their `expire_at` lapsed with no write to poke
					 * us). */
					rosterInterval = setInterval(() => {
						void emitRoster();
					}, PRESENCE_ROSTER_INTERVAL_MS);
					rosterInterval.unref?.();

					/* Client disconnect (tab closed, navigation, EventSource.close), tear
					 * down the subscription + both intervals. Handle an already-aborted
					 * signal (the client vanished before `start` ran): a late
					 * `addEventListener` never fires for a past abort, so tear down now. */
					if (req.signal.aborted) teardown();
					else {
						req.signal.addEventListener("abort", teardown);
						abortListenerAttached = true;
					}
				} catch (err) {
					/* `ReadableStream` may convert a thrown `start` into an errored body
					 * instead of propagating it through the constructor. Teardown must happen
					 * here, while the partial subscription holders are still reachable. */
					teardown();
					throw err;
				}
			},
			/* A consumer/platform `cancel()` that doesn't also abort `req.signal` would
			 * otherwise leak the subscription + both intervals: tear down here too.
			 * Runs the same idempotent teardown, so an abort+cancel pair is a no-op the
			 * second time. */
			cancel() {
				teardownRef.current?.();
			},
		});
	} catch (err) {
		/* `ReadableStream.start` runs during construction. If setup throws after
		 * attaching any subscription, the installed teardown disowns everything. */
		if (teardownRef.current) teardownRef.current();
		throw err;
	}

	try {
		return new Response(stream, { headers: STREAM_HEADERS });
	} catch (err) {
		if (teardownRef.current) teardownRef.current();
		throw err;
	}
}
