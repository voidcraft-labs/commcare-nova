/**
 * Real-time relay — Server-Sent Events over a gRPC Firestore listen.
 *
 * GET /api/apps/{id}/stream — a same-origin SSE channel that pipes the app's
 * durable mutation stream (`acceptedMutations`) and live presence roster to the
 * browser. The browser carries no Firestore SDK and no second identity: this
 * route holds the gRPC `onSnapshot` and authorizes with the Better Auth session
 * cookie, exactly like every other authenticated app route.
 *
 * Auth is enforced twice: once at connect (`requireSession` + `resolveAppScope`
 * at `view`) and continuously by a ~10 s cadence that re-checks the session +
 * scope and closes the stream on a CONFIRMED denial — a removed / role-dropped
 * / banned / deleted member's open stream is revoked within the cadence, not at
 * the next reconnect. `resolveAppScope` reads only `project_id` + the
 * `auth_member` role and does NOT check ban/deletion, so the cadence also reads
 * `isUserActive` for the ban/deletion signal. A transient backend blip (pool
 * exhaustion, a Firestore hiccup) is NOT a denial — the cadence skips that tick
 * and leaves the stream open rather than booting an authorized collaborator.
 *
 * The 60-minute Cloud Run request cap surfaces as a transparent EventSource
 * reconnect via the `Last-Event-ID` header (where `requireSession` re-runs);
 * `maxDuration` below is advisory.
 *
 * Frames:
 *   event: mutation  id:<seq>  — one committed batch (the `AcceptedMutationDoc`).
 *   event: presence            — the full presence roster snapshot.
 *   event: reload              — replay is impossible (below retention, a gap,
 *                                or a migration sentinel); the client GETs the
 *                                fresh blueprint. Seq-less, no `id:` line.
 *   event: revoked             — access was revoked; the client stops. Seq-less.
 */

import type { QuerySnapshot } from "@google-cloud/firestore";
import { ApiError, handleApiError } from "@/lib/apiError";
import { getSessionSafe, requireSession } from "@/lib/auth-utils";
import type { PresenceEntry } from "@/lib/collab/presenceTypes";
import { isUserActive } from "@/lib/db/api-keys";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { RETENTION_COUNT } from "@/lib/db/constants";
import { collections, docs } from "@/lib/db/firestore";
import { getListenDb } from "@/lib/db/firestoreListen";
import type { AcceptedMutationDoc, PresenceDoc } from "@/lib/db/types";
import { log } from "@/lib/logger";

/* Node runtime — the route holds a long-lived gRPC listen (`@google-cloud/firestore`)
 * and a `setInterval`, neither of which the Edge runtime supports. */
export const runtime = "nodejs";
/* Never statically prerender or cache — every connection is a live per-user
 * listen keyed on the session cookie. */
export const dynamic = "force-dynamic";
/* Advisory: the platform caps a request at 60 min regardless; the client
 * reconnects transparently via `Last-Event-ID`. */
export const maxDuration = 3600;

/**
 * Re-check session + scope on this cadence and close on a CONFIRMED denial. ~10 s
 * in prod; the emulator revocation tests override it via `NOVA_STREAM_CADENCE_MS`
 * so they don't have to wait a full 10 s per case (a testability seam only —
 * prod never sets the var).
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

/**
 * Project a stored `PresenceDoc` into the client's `PresenceEntry` wire shape —
 * the exact contract `lib/collab/presence.ts` parses. The raw doc's `updatedAt`
 * is a Firestore `Timestamp`, which serializes as `{_seconds,_nanoseconds}`; the
 * client types `updatedAt` as epoch millis and does arithmetic on it
 * (`now − updatedAt` for stale-hide, `>` for newest-wins dedup), so shipping the
 * raw object makes both compute `NaN`. Convert it to millis and drop the
 * server-only `expireAt` TTL, mirroring the `mutation`-frame projection that
 * strips its own Timestamps.
 */
function projectPresence(doc: PresenceDoc): PresenceEntry {
	return {
		userId: doc.userId,
		sessionId: doc.sessionId,
		name: doc.name,
		image: doc.image ?? null,
		color: doc.color,
		location: doc.location,
		updatedAt: doc.updatedAt.toMillis(),
	};
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	let userId: string;
	let cursor: number;
	let head: number;
	try {
		const session = await requireSession(req);
		const { id: appId } = await params;
		userId = session.user.id;

		/* Connect-time membership gate (view). An `AppAccessError` (absent /
		 * non-member / under-privileged) maps to a 404 in `handleApiError` — the
		 * shared IDOR-safe not-found posture every sibling `/api/apps` route
		 * returns (a denial is wire-indistinguishable from a missing id, and the
		 * browser's EventSource treats a non-200 as a failed connection). */
		await resolveAppScope(appId, userId, "view");

		cursor = parseCursor(req);

		/* Head at connect — the retention-overrun check compares the cursor against
		 * `head − RETENTION_COUNT`. Read the RAW doc (not the converter ref): only
		 * `mutation_seq` is needed, and parsing the full `AppDoc` through the Zod
		 * converter would throw the whole stream on a legacy/partial doc for a field
		 * this route doesn't read. A stale value only ever over-triggers a reload
		 * (safe); the first delivered seq is the authoritative gap check below. */
		const appSnap = await docs.appRaw(appId).get();
		head = (appSnap.data()?.mutation_seq as number | undefined) ?? 0;

		/* TTL floor check. The count-based retention check (below, in the stream
		 * body) can PASS while the 7-day `expireAt` TTL already deleted the
		 * entries the client needs: a tab resurrected after a week idle (cursor
		 * behind head by fewer than RETENTION_COUNT) would subscribe, receive
		 * NOTHING — the seq-gap check fires only on a DELIVERED frame — and
		 * silently render a stale blueprint until some future commit finally
		 * arrives. When the client is behind the head, one doc read proves the
		 * replay floor (`cursor + 1`) still exists; a TTL-pruned floor means
		 * replay is impossible → tell the client to reload the snapshot. */
		let replayUnavailable = false;
		if (cursor < head) {
			const floor = await docs.acceptedMutation(appId, cursor + 1).get();
			replayUnavailable = !floor.exists;
		}

		return openStream({ appId, userId, cursor, head, replayUnavailable, req });
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
	/** The connect-time floor read proved replay impossible (TTL-pruned). */
	replayUnavailable: boolean;
	req: Request;
}): Response {
	const { appId, userId, cursor, head, replayUnavailable, req } = args;

	const encoder = new TextEncoder();

	/* `start` populates this so `cancel` can tear down too — see the `cancel`
	 * handler at the bottom. `teardown` is idempotent, so a double invocation
	 * (abort + cancel) is safe. */
	let teardownRef: (() => void) | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			/* Set on teardown (client abort). Every enqueue/close checks it first,
			 * so a cadence tick or an `onSnapshot` callback that resolves AFTER
			 * teardown is a no-op — no enqueue on a closed controller, no leaked
			 * timer or listener. */
			let closed = false;
			/* The next seq we expect to deliver. The first `mutation` frame must be
			 * `cursor + 1`; any hole means the browser missed entries → reload. */
			let expectedSeq = cursor + 1;
			/* Subscription + interval holders — nullable so `teardown` is safe to
			 * call BEFORE the listeners attach (the retention-overrun early return
			 * below reloads-and-closes before any subscribe). */
			let unsubMutations: (() => void) | null = null;
			let unsubPresence: (() => void) | null = null;
			let cadence: ReturnType<typeof setInterval> | null = null;

			function send(event: string, data: unknown, seqId?: number): void {
				if (closed) return;
				let frame = `event: ${event}\n`;
				/* `revoked` / `reload` are seq-less — no `id:` line, so a reconnect
				 * never resumes from a sentinel. */
				if (seqId !== undefined) frame += `id: ${seqId}\n`;
				frame += `data: ${JSON.stringify(data)}\n\n`;
				try {
					controller.enqueue(encoder.encode(frame));
				} catch {
					/* The platform cancelled the response stream before our `abort`
					 * listener ran, so the controller is already closed ("Invalid
					 * state: Controller is already closed"). Treat the first failed
					 * write as the disconnect: tear everything down rather than let the
					 * throw escape an onSnapshot/cadence callback as an unhandled error. */
					teardown();
				}
			}

			function teardown(): void {
				if (closed) return;
				closed = true;
				unsubMutations?.();
				unsubPresence?.();
				if (cadence) clearInterval(cadence);
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

			/* If the cursor fell below the retention window — or the connect-time
			 * floor read found the needed entries TTL-pruned — the entries the
			 * client missed are already gone: it must reload rather than replay. */
			if (cursor < head - RETENTION_COUNT || replayUnavailable) {
				reloadAndClose();
				return;
			}

			unsubMutations = collections
				.acceptedMutations(appId, getListenDb())
				.where("seq", ">", cursor)
				.orderBy("seq")
				.onSnapshot(
					(snap: QuerySnapshot<AcceptedMutationDoc>) => {
						if (closed) return;
						/* Only `added` changes carry new commits. A retention-prune
						 * `removed` (the writer deletes `seq − RETENTION_COUNT`) must
						 * NOT re-emit the window. */
						for (const change of snap.docChanges()) {
							if (change.type !== "added") continue;
							/* `.data()` runs the Zod converter, which THROWS synchronously
							 * on a malformed/legacy entry — inside this success callback,
							 * so it would bypass the `err` handler and leak the other
							 * listener + the interval. A malformed frame means the client
							 * can't trust the incremental stream, so reload rather than
							 * throw. */
							let entry: AcceptedMutationDoc;
							try {
								entry = change.doc.data();
							} catch (parseErr) {
								log.warn("[stream] malformed acceptedMutations entry", {
									appId,
									docId: change.doc.id,
									err:
										parseErr instanceof Error
											? parseErr.message
											: String(parseErr),
								});
								reloadAndClose();
								return;
							}
							/* A hole — the client missed entries between its cursor and
							 * the first delivered seq (retention pruned them, or a gap).
							 * Replay is impossible; reload. */
							if (entry.seq !== expectedSeq) {
								reloadAndClose();
								return;
							}
							expectedSeq = entry.seq + 1;
							/* A migration sentinel (empty `mutations`) can't be replayed —
							 * the client reloads the snapshot instead. */
							if (entry.kind === "migration") {
								reloadAndClose();
								return;
							}
							/* Project the client-relevant shape — the reconciler keys on
							 * these fields (echo classification, gap detection, apply). The
							 * raw doc's server-only `ts`/`expireAt` are Firestore
							 * `Timestamp`s that would serialize as `{_seconds,_nanoseconds}`
							 * and don't belong on the wire. */
							send(
								"mutation",
								{
									seq: entry.seq,
									batchId: entry.batchId,
									runId: entry.runId,
									actorId: entry.actorId,
									kind: entry.kind,
									mutations: entry.mutations,
								},
								entry.seq,
							);
						}
					},
					(err) => {
						/* A recoverable gRPC transport blip (channel reset) hits here; the
						 * client's EventSource reconnects and resumes at `Last-Event-ID`.
						 * Warn (Cloud-Logging-only), not error — this is not a Sentry-worthy
						 * fault, it's the expected lifecycle of a long-lived listen. */
						log.warn("[stream] mutation listen error (reconnecting)", {
							appId,
							err: err instanceof Error ? err.message : String(err),
						});
						teardown();
					},
				);

			unsubPresence = collections.presence(appId, getListenDb()).onSnapshot(
				(snap: QuerySnapshot<PresenceDoc>) => {
					if (closed) return;
					/* Presence is best-effort: a single malformed/legacy presence doc's
					 * converter throw must not blow up the whole roster (and, in this
					 * success callback, bypass the `err` handler → leak). Skip the bad
					 * doc and continue building the roster. Each surviving doc is
					 * PROJECTED to the client's `PresenceEntry` wire shape — the raw
					 * doc's `updatedAt` Timestamp would serialize as
					 * `{_seconds,_nanoseconds}`, which the client's numeric stale-hide /
					 * newest-wins arithmetic reads as `NaN`. */
					const roster: PresenceEntry[] = [];
					for (const d of snap.docs) {
						try {
							roster.push(projectPresence(d.data()));
						} catch (parseErr) {
							log.warn("[stream] malformed presence doc (skipped)", {
								appId,
								docId: d.id,
								err:
									parseErr instanceof Error
										? parseErr.message
										: String(parseErr),
							});
						}
					}
					send("presence", roster);
				},
				(err) => {
					/* Recoverable transport blip — warn (Cloud-Logging-only), not error;
					 * the client reconnects. Same rationale as the mutation listen. */
					log.warn("[stream] presence listen error (reconnecting)", {
						appId,
						err: err instanceof Error ? err.message : String(err),
					});
					teardown();
				},
			);

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
			 * throw, a non-`AppAccessError` `resolveAppScope` throw (Cloud SQL pool
			 * exhaustion, Firestore blip) — SKIPS this tick and leaves the stream
			 * open. The next tick re-checks; a real loss confirms then. This keeps
			 * the cadence at least as forgiving as the connect path, which lets
			 * EventSource auto-reconnect through a transient 500. */
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
					 * (pool exhaustion, Firestore blip) is transient → skip. */
					try {
						await resolveAppScope(appId, userId, "view");
					} catch (err) {
						if (err instanceof AppAccessError) revoke("access-revoked");
						// else transient — leave open, re-check next tick.
					}
				})();
			}, REVOCATION_CADENCE_MS);

			/* Client disconnect (tab closed, navigation, EventSource.close) — tear
			 * down both listeners + the cadence. Handle an already-aborted signal
			 * (the client vanished before `start` ran) — a late `addEventListener`
			 * never fires for a past abort, so tear down now. */
			if (req.signal.aborted) teardown();
			else req.signal.addEventListener("abort", teardown);
		},
		/* A consumer/platform `cancel()` that doesn't also abort `req.signal` would
		 * otherwise leak both listeners + the interval — tear down here too. Runs
		 * the same idempotent teardown, so an abort+cancel pair is a no-op the
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
