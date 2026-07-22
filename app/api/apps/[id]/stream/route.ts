/**
 * Real-time relay — Server-Sent Events over a Postgres LISTEN/NOTIFY poke.
 *
 * GET /api/apps/{id}/stream — a same-origin SSE channel that pipes the app's
 * durable mutation stream (`accepted_mutations`), Project lookup manifest, and
 * live presence roster to the browser. The browser carries no database client
 * and no second identity: this
 * route subscribes to the process-wide LISTEN connection (`lib/db/streamListener`)
 * and authorizes with the Better Auth session cookie, exactly like every other
 * authenticated app route. On each poke it SELECTs the rows since its cursor —
 * the poke carries no data, so no notification content is ever lost; a missed
 * poke degrades to the next poke or the reconnect catch-up, never to lost data.
 *
 * Auth is enforced twice: once at connect (`requireSession` + `resolveAppScope`
 * at `view`) and continuously by a ~10 s cadence that re-checks the session +
 * scope and closes the stream on a CONFIRMED denial — a removed / role-dropped
 * / banned / deleted member's open stream is revoked within the cadence, not at
 * the next reconnect. `resolveAppScope` reads only `project_id` + the
 * `auth_member` role and does NOT check ban/deletion, so the cadence also reads
 * `isUserActive` for the ban/deletion signal. A transient backend blip (pool
 * exhaustion, a DB hiccup) is NOT a denial — the cadence skips that tick and
 * leaves the stream open rather than booting an authorized collaborator.
 *
 * The 60-minute Cloud Run request cap surfaces as a transparent EventSource
 * reconnect via the `Last-Event-ID` header (where `requireSession` re-runs);
 * `maxDuration` below is advisory.
 *
 * Frames:
 *   event: mutation  id:<seq>  — one committed batch (the `AcceptedMutationDoc`).
 *   event: lookup-revision     — the Project's complete authoritative lookup
 *                                manifest. Seq-less; the mutation cursor stays
 *                                exclusively on `mutation` frames.
 *   event: presence            — the full presence roster snapshot.
 *   event: reload              — replay is impossible (below the retention
 *                                efficiency bound, a gap, or a migration
 *                                batch); the client GETs the fresh blueprint.
 *                                Seq-less, no `id:` line.
 *   event: revoked             — access was revoked; the client stops. Seq-less.
 */

import { sql } from "kysely";
import { ApiError, handleApiError } from "@/lib/apiError";
import { getSessionSafe, requireSession } from "@/lib/auth-utils";
import type { PresenceEntry } from "@/lib/collab/presenceTypes";
import { isUserActive } from "@/lib/db/api-keys";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { createCoalescedStreamPump } from "@/lib/db/coalescedStreamPump";
import { RETENTION_COUNT } from "@/lib/db/constants";
import { getAppDb } from "@/lib/db/pg";
import {
	subscribeAppStream,
	subscribeLookupProject,
} from "@/lib/db/streamListener";
import {
	runBeforeLookupManifestReadTestHook,
	runBeforeMutationReadTestHook,
} from "@/lib/db/streamReadTestHooks";
import { log } from "@/lib/logger";
import { getLookupManifest } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { locationSchema } from "@/lib/routing/types";

/* Node runtime — the route holds a long-lived subscription to the Postgres
 * LISTEN connection and `setInterval`s, neither of which the Edge runtime
 * supports. */
export const runtime = "nodejs";
/* Never statically prerender or cache — every connection is a live per-user
 * stream keyed on the session cookie. */
export const dynamic = "force-dynamic";
/* Advisory: the platform caps a request at 60 min regardless; the client
 * reconnects transparently via `Last-Event-ID`. */
export const maxDuration = 3600;

/**
 * Re-check session + scope on this cadence and close on a CONFIRMED denial. ~10 s
 * in prod; the revocation tests override it via `NOVA_STREAM_CADENCE_MS` so they
 * don't have to wait a full 10 s per case (a testability seam only — prod never
 * sets the var).
 */
const REVOCATION_CADENCE_MS = (() => {
	const parsed = Number.parseInt(
		process.env.NOVA_STREAM_CADENCE_MS ?? "10000",
		10,
	);
	// Guard the test-only override like `parseCursor` guards its input: a
	// non-numeric/non-positive value would reach `setInterval(fn, NaN)`, which
	// coerces to ~0 ms — a full session+scope re-check spinning per tick.
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
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

/** A `presence` row as read back from Postgres (`selectAll`). */
interface PresenceRow {
	user_id: string;
	session_id: string;
	name: string;
	image: string | null;
	email: string;
	color: string;
	location: unknown;
	updated_at: Date;
}

/**
 * Project a `presence` row into the client's `PresenceEntry` wire shape — the
 * exact contract `lib/collab/presence.ts` parses. `updated_at` becomes epoch
 * millis (the client does `now − updatedAt` arithmetic for stale-hide and `>`
 * for newest-wins dedup), the server-only `expire_at` TTL is dropped, and
 * `location` is validated against the routing schema so a peer's location is a
 * structurally valid builder URL on the wire. THROWS on an invalid `location`;
 * the caller skips the row.
 */
function projectPresence(row: PresenceRow): PresenceEntry {
	return {
		userId: row.user_id,
		sessionId: row.session_id,
		name: row.name,
		image: row.image ?? null,
		email: row.email ?? "",
		color: row.color,
		location: locationSchema.parse(row.location),
		updatedAt: row.updated_at.getTime(),
	};
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	let userId: string;
	let cursor: number;
	let head: number;
	let appId: string;
	let lookupScope: LookupScope;
	try {
		const session = await requireSession(req);
		({ id: appId } = await params);
		userId = session.user.id;

		/* Connect-time membership gate (view). An `AppAccessError` (absent /
		 * non-member / under-privileged) maps to a 404 in `handleApiError` — the
		 * shared IDOR-safe not-found posture every sibling `/api/apps` route
		 * returns (a denial is wire-indistinguishable from a missing id, and the
		 * browser's EventSource treats a non-200 as a failed connection). */
		const access = await resolveAppScope(appId, userId, "view");
		lookupScope = {
			projectId: access.projectId,
			actorId: access.actorUserId,
			role: access.role,
		};

		cursor = parseCursor(req);

		/* Head at connect — the retention-overrun check compares the cursor against
		 * `head − RETENTION_COUNT`. Only `mutation_seq` is needed; a stale value
		 * only ever over-triggers a reload (safe), and the first delivered seq is
		 * the authoritative gap check below. */
		const db = await getAppDb();
		const appRow = await db
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", appId)
			.executeTakeFirst();
		head = appRow ? Number(appRow.mutation_seq) : 0;

		return openStream({ appId, userId, cursor, head, lookupScope, req });
	} catch (err) {
		/* Pre-stream failure (auth, membership, the head read) — OR a client
		 * disconnect that aborted an in-flight await here. `handleApiError`
		 * centrally maps an `ApiError` → its status, an `AppAccessError` → 404, a
		 * CLIENT ABORT → 499 logged at WARN (never Sentry — a disconnect is the
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
	head: number;
	lookupScope: LookupScope;
	req: Request;
}): Response {
	const { appId, userId, cursor, head, lookupScope, req } = args;

	const encoder = new TextEncoder();

	/* `start` populates this so `cancel` can tear down too — see the `cancel`
	 * handler at the bottom. `teardown` is idempotent, so a double invocation
	 * (abort + cancel) is safe. */
	let teardownRef: (() => void) | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			/* Set on teardown (client abort). Every enqueue/close checks it first,
			 * so a poke-driven pump or a cadence tick that resolves AFTER teardown is
			 * a no-op — no enqueue on a closed controller, no leaked timer or
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
			/* Pump, subscription, and interval holders — nullable so `teardown` is safe to
			 * call BEFORE they attach (the retention-overrun early return below
			 * reloads-and-closes before any subscribe). */
			let mutationPump: ReturnType<typeof createCoalescedStreamPump> | null =
				null;
			let lookupPump: ReturnType<typeof createCoalescedStreamPump> | null =
				null;
			let unsubscribeApp: (() => void) | null = null;
			let unsubscribeLookup: (() => void) | null = null;
			let cadence: ReturnType<typeof setInterval> | null = null;
			let rosterInterval: ReturnType<typeof setInterval> | null = null;
			let abortListenerAttached = false;

			function send(event: string, data: unknown, seqId?: number): void {
				if (closed) return;
				let frame = `event: ${event}\n`;
				/* `revoked` / `reload` are seq-less — no `id:` line, so a reconnect
				 * never resumes from a migration reload. */
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
				unsubscribeApp?.();
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
					/* Already closed by the platform (client gone) — nothing to do. */
				}
			}
			/* Expose teardown to `cancel` (a consumer/platform `cancel()` that does
			 * not also abort `req.signal`). */
			teardownRef = teardown;

			/* A gap or a retention overrun means the browser can't rebuild from the
			 * deltas it has — tell it to GET the fresh blueprint. `reload` is
			 * terminal for this connection's replay; the client reconnects at the
			 * fresh seq. */
			function reloadAndClose(): void {
				send("reload", { reason: "replay-unavailable" });
				teardown();
			}

			/* SELECT every committed batch past the delivered cursor and emit it. The
			 * `accepted_mutations` log is PERMANENT, so the entries always exist above
			 * the retention efficiency bound — a gap here means the cursor is a real
			 * hole, not a pruned window. */
			async function deliverSince(): Promise<void> {
				if (closed) return;
				runBeforeMutationReadTestHook();
				const db = await getAppDb();
				const rows = await db
					.selectFrom("accepted_mutations")
					.select([
						"seq",
						"batch_id",
						"run_id",
						"actor_id",
						"kind",
						"mutations",
					])
					.where("app_id", "=", appId)
					.where("seq", ">", deliveredThrough)
					.orderBy("seq")
					.execute();
				for (const row of rows) {
					if (closed) return;
					const seq = Number(row.seq);
					/* A hole — the browser missed entries between its cursor and the
					 * first delivered seq. Replay is impossible; reload. */
					if (seq !== deliveredThrough + 1) {
						reloadAndClose();
						return;
					}
					deliveredThrough = seq;
					/* Migration batches reload the complete snapshot even when their
					 * durable history row carries replayable deterministic mutations. */
					if (row.kind === "migration") {
						reloadAndClose();
						return;
					}
					/* Project the client-relevant shape — the reconciler keys on these
					 * fields (echo classification, gap detection, apply). The row's
					 * server-only `ts` is not on the wire. */
					send(
						"mutation",
						{
							seq,
							batchId: row.batch_id,
							runId: row.run_id ?? undefined,
							actorId: row.actor_id,
							kind: row.kind,
							mutations: row.mutations,
						},
						seq,
					);
				}
			}

			/* Read the live roster (unexpired rows) and emit a full snapshot. Each
			 * row is projected best-effort: a row whose `location` fails the schema
			 * is skipped (never blows up the whole roster), mirroring the presence
			 * contract. */
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
				const roster: PresenceEntry[] = [];
				for (const row of rows) {
					try {
						roster.push(projectPresence(row as PresenceRow));
					} catch (parseErr) {
						log.warn("[stream] malformed presence row (skipped)", {
							appId,
							sessionId: row.session_id,
							err:
								parseErr instanceof Error ? parseErr.message : String(parseErr),
						});
					}
				}
				send("presence", roster);
			}

			/* Coalesce overlapping roster emits into one follow-up query — a poke or
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
					/* Transient read fault — warn; the interval / next poke re-queries. */
					log.warn("[stream] presence roster error", {
						appId,
						err: err instanceof Error ? err.message : String(err),
					});
				} finally {
					rosterInFlight = false;
				}
			}

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
					/* Deliberately seq-less: only mutation frames own Last-Event-ID. */
					send("lookup-revision", manifest);
				},
				onError(err) {
					log.warn("[stream] lookup manifest pump error (will retry)", {
						appId,
						projectId: lookupScope.projectId,
						err: err instanceof Error ? err.message : String(err),
					});
				},
			});

			/* If the cursor fell below the retention window, the client is too far
			 * behind to replay economically. The log is PERMANENT so the entries DO
			 * exist, but replaying thousands of batches is slower than a single
			 * blueprint reload — the retention bound is now purely an efficiency cap. */
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
			);
			unsubscribeLookup = subscribeLookupProject(lookupScope.projectId, () => {
				lookupPump?.poke();
			});
			mutationPump.poke();
			lookupPump.poke();
			void emitRoster();

			/* Continuous revocation: re-run the session + scope check on a cadence and
			 * close ONLY on a CONFIRMED denial — never on a transient backend blip.
			 * The confirmed signals are:
			 *   - `getSessionSafe` returns a session for a DIFFERENT user (the cookie
			 *     now belongs to someone else — a real rotation).
			 *   - `isUserActive(userId) === false` — a definitively banned/deleted
			 *     user (`isUserActive` THROWS on a DB fault, so a throw is transient,
			 *     not a ban).
			 *   - `resolveAppScope` throws `AppAccessError` — a real non-member /
			 *     insufficient-role.
			 * Everything else — a bare `getSessionSafe` null (its own `getSession`
			 * throw is swallowed to null, so null is ambiguous), an `isUserActive`
			 * throw, a non-`AppAccessError` `resolveAppScope` throw (pool exhaustion,
			 * a DB blip) — SKIPS this tick and leaves the stream open. The next tick
			 * re-checks; a real loss confirms then. This keeps the cadence at least as
			 * forgiving as the connect path, which lets EventSource auto-reconnect
			 * through a transient 500. */
			cadence = setInterval(() => {
				void (async () => {
					if (closed) return;
					const revoke = (reason: string) => {
						if (closed) return;
						send("revoked", { reason });
						teardown();
					};

					const live = await getSessionSafe(req);
					if (closed) return;
					/* A confirmed identity change — a session that resolves to a
					 * different user. A bare `null` is NOT confirmed (a swallowed
					 * transient error looks identical), so it does not revoke here. */
					if (live && live.user.id !== userId) {
						revoke("session-revoked");
						return;
					}

					/* Confirmed ban/deletion. `isUserActive` throws on a DB fault, so a
					 * throw is transient → skip (do not revoke). */
					try {
						if (!(await isUserActive(userId))) {
							revoke("account-inactive");
							return;
						}
					} catch {
						return; // transient — leave the stream open, re-check next tick
					}
					if (closed) return;

					/* Confirmed membership loss — `AppAccessError` only. Any other throw
					 * (pool exhaustion, a DB blip) is transient → skip. S01 globally
					 * blocks Project moves; S02 owns a distinct scope-handoff protocol.
					 * Treating a future Project change as `revoked` here would permanently
					 * freeze blueprint reconciliation instead of rebinding lookup state. */
					try {
						await resolveAppScope(appId, userId, "view");
					} catch (err) {
						if (err instanceof AppAccessError) revoke("access-revoked");
						// else transient — leave open, re-check next tick.
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

			/* Client disconnect (tab closed, navigation, EventSource.close) — tear
			 * down the subscription + both intervals. Handle an already-aborted
			 * signal (the client vanished before `start` ran) — a late
			 * `addEventListener` never fires for a past abort, so tear down now. */
			if (req.signal.aborted) teardown();
			else {
				req.signal.addEventListener("abort", teardown);
				abortListenerAttached = true;
			}
		},
		/* A consumer/platform `cancel()` that doesn't also abort `req.signal` would
		 * otherwise leak the subscription + both intervals — tear down here too.
		 * Runs the same idempotent teardown, so an abort+cancel pair is a no-op the
		 * second time. */
		cancel() {
			teardownRef?.();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
