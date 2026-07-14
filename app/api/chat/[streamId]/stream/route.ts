/**
 * Resumable chat stream — replay + live tail of one chat POST's UI message
 * chunk stream, from the durable chunk log (`lib/db/streamChunks`).
 *
 * GET /api/chat/{streamId}/stream?startIndex=N
 *
 * This is the server half of the AI SDK's `WorkflowChatTransport` contract
 * (the client half ships in `@ai-sdk/workflow`; Nova serves the contract from
 * its own Postgres — no workflow runtime involved). The transport calls this
 * whenever a chat POST's response ends without a `finish` chunk — a network
 * blip, a mid-run deploy hiccup, Cloud Run's 60-minute request cap — passing
 * the count of chunks it already received as `startIndex`. (The endpoint
 * equally serves a cursor-0 cold reconnect from a client with no prior POST;
 * nothing wires that on refresh yet — a live run's stream is discoverable
 * only by the transport instance that started it.) It expects:
 *
 *  - the same SSE encoding the POST uses (`data: <UIMessageChunk JSON>`
 *    frames, `data: [DONE]` at the end),
 *  - a negative `startIndex` resolved from the stream's end, with the
 *    absolute tail position returned in `x-workflow-stream-tail-index`,
 *  - the stream to END once complete (the terminal chunk-log row, whose
 *    stream always closes with a `finish` chunk — the durable writer
 *    guarantees one), rather than tail forever.
 *
 * The run itself is untouched: it executes inside its original POST, and this
 * route only reads what that POST's `DurableStreamWriter` appended — replay
 * from the cursor, then live tail on the `nova_chat_stream` poke (plus a slow
 * poll so a dropped poke degrades to latency, never loss).
 *
 * Auth mirrors the app relay (`/api/apps/[id]/stream`): Project membership at
 * `view` against the stream's owning app, re-checked on a cadence that closes
 * the stream on a CONFIRMED denial only. A missing stream and a denied one
 * are both 404 (the IDOR-safe posture of every app-scoped route).
 *
 * If the producing process died without sealing the log (instance kill), the
 * cadence notices the app is no longer held live and closes the tail with a
 * synthetic `finish` — a resuming client always terminates.
 */

import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { ApiError, handleApiError } from "@/lib/apiError";
import { getSessionSafe, requireSession } from "@/lib/auth-utils";
import { isUserActive } from "@/lib/db/api-keys";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { appHeldLive } from "@/lib/db/apps";
import {
	readStreamChunksFrom,
	streamChunkMeta,
	streamChunkTail,
} from "@/lib/db/streamChunks";
import { subscribeChatStream } from "@/lib/db/streamListener";
import { log } from "@/lib/logger";

/* Node runtime — the route holds a long-lived subscription to the Postgres
 * LISTEN connection and `setInterval`s, neither of which the Edge runtime
 * supports. */
export const runtime = "nodejs";
/* Never statically prerender or cache — every connection is a live per-user
 * stream keyed on the session cookie. */
export const dynamic = "force-dynamic";
/* Advisory: the platform caps a request at 60 min regardless; the transport
 * reconnects with its running cursor. */
export const maxDuration = 3600;

/**
 * Re-check session + scope + run liveness on this cadence. ~10 s in prod; the
 * same test seam shape as the app relay's cadence (a testability seam only —
 * prod never sets the var).
 */
const CADENCE_MS = (() => {
	const parsed = Number.parseInt(
		process.env.NOVA_CHAT_STREAM_CADENCE_MS ?? "10000",
		10,
	);
	return Number.isNaN(parsed) || parsed <= 0 ? 10_000 : parsed;
})();

/**
 * Poll fallback between pokes. A dropped notification (LISTEN reconnect gap)
 * degrades to this latency instead of a stall; each tick is one indexed
 * range SELECT that usually returns nothing.
 */
const POLL_FALLBACK_MS = 2_500;

/**
 * Consecutive liveness-cadence ticks with the app held by NO live run before
 * a terminal-less tail is closed with a synthetic `finish`. Two ticks (not
 * one) because a clean run releases its hold shortly BEFORE the durable
 * writer seals the log — a single-tick read landing in that gap would cut a
 * healthy close; the pump between ticks delivers the terminal row instead.
 */
const DEAD_TICKS_TO_CLOSE = 2;

/** Parse `?startIndex=` — any integer; negative reads from the stream's end. */
function parseStartIndex(req: Request): number {
	const raw = new URL(req.url).searchParams.get("startIndex") ?? "0";
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ streamId: string }> },
) {
	let streamId: string;
	let appId: string;
	let userId: string;
	let cursor: number;
	let tailHeader: string | undefined;
	try {
		const session = await requireSession(req);
		({ streamId } = await params);
		userId = session.user.id;

		/* The stream's owning app is the auth anchor. A stream that never wrote
		 * a row (or was pruned) is indistinguishable from one the caller may not
		 * see — both 404. */
		const meta = await streamChunkMeta(streamId);
		if (!meta) throw new ApiError("Stream not found", 404);
		appId = meta.appId;
		await resolveAppScope(appId, userId, "view");

		const startIndex = parseStartIndex(req);
		if (startIndex < 0) {
			/* Resolve a from-the-end cursor against the current extent, and tell
			 * the transport the absolute tail so its retries use absolute
			 * positions (`x-workflow-stream-tail-index` = last chunk's index). */
			const tail = await streamChunkTail(streamId);
			const total = tail?.total ?? 0;
			cursor = Math.max(0, total + startIndex);
			tailHeader = String(total - 1);
		} else {
			cursor = startIndex;
		}
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to open stream", 500),
		);
	}

	return openStream({ req, streamId, appId, userId, cursor, tailHeader });
}

/**
 * Build the SSE `Response` once the connect-time gate has passed — the same
 * split as the app relay: gate failures return JSON errors, the stream body
 * never throws synchronously.
 */
function openStream(args: {
	req: Request;
	streamId: string;
	appId: string;
	userId: string;
	cursor: number;
	tailHeader: string | undefined;
}): Response {
	const { req, streamId, appId, userId, tailHeader } = args;

	const encoder = new TextEncoder();
	let teardownRef: (() => void) | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			/** Next chunk index to deliver (count of chunks emitted + skipped). */
			let cursor = args.cursor;
			/* Overlapping-pump coalescing — a poke mid-pump re-queries once more
			 * at the end rather than racing a second SELECT. */
			let pumpInFlight = false;
			let pumpPending = false;
			/** Consecutive cadence ticks with no live hold on the app. */
			let deadTicks = 0;
			/** A real `finish` chunk was delivered — the dead-run fallback must
			 *  not append a second one (the client's stream processor finalizes
			 *  on the first; a duplicate is malformed framing). */
			let sawFinishChunk = false;
			let unsubscribe: (() => void) | null = null;
			let pollTimer: ReturnType<typeof setInterval> | null = null;
			let cadence: ReturnType<typeof setInterval> | null = null;

			function send(payload: string): void {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
				} catch {
					/* Platform closed the response before our abort listener ran —
					 * treat the first failed write as the disconnect. */
					teardown();
				}
			}

			function teardown(): void {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (pollTimer) clearInterval(pollTimer);
				if (cadence) clearInterval(cadence);
				try {
					controller.close();
				} catch {
					/* Already closed by the platform (client gone). */
				}
			}
			teardownRef = teardown;

			/** Seal the wire. The transport terminates on a `finish` CHUNK — a
			 *  response that closes without ever delivering one sends the client
			 *  back into an immediate reconnect, forever (`[DONE]` is ignored by
			 *  its parser). A completed replay can legitimately deliver none: a
			 *  resume cursor at or past the log's own finish (reachable when a
			 *  throw escaping the POST's execute enqueues an error chunk on the
			 *  raw response, skewing the client's count past the sealed log), or
			 *  the dead-run fallback. So EVERY close synthesizes the missing
			 *  finish first. */
			function finishAndClose(): void {
				if (!sawFinishChunk) {
					sawFinishChunk = true;
					send(JSON.stringify({ type: "finish" }));
				}
				send("[DONE]");
				teardown();
			}

			/* Deliver everything past the cursor; close if the terminal row has
			 * been consumed. */
			async function deliverSince(): Promise<void> {
				if (closed) return;
				const read = await readStreamChunksFrom(streamId, cursor);
				if (closed) return;
				for (const chunk of read.chunks) {
					if (closed) return;
					if ((chunk as { type?: unknown }).type === "finish") {
						sawFinishChunk = true;
					}
					send(JSON.stringify(chunk));
				}
				cursor = Math.max(cursor, read.endIndex);
				if (read.terminal) finishAndClose();
			}

			async function pump(): Promise<void> {
				if (closed) return;
				if (pumpInFlight) {
					pumpPending = true;
					return;
				}
				pumpInFlight = true;
				try {
					do {
						pumpPending = false;
						await deliverSince();
					} while (pumpPending && !closed);
				} catch (err) {
					/* Transient read fault — the next poke / poll tick re-queries. */
					log.warn("[chat-stream] pump error", {
						streamId,
						err: err instanceof Error ? err.message : String(err),
					});
				} finally {
					pumpInFlight = false;
				}
			}

			/* Subscribe FIRST, then the initial read — a flush landing between
			 * them is covered by the subscription's poke. */
			unsubscribe = subscribeChatStream(streamId, () => {
				void pump();
			});
			void pump();

			pollTimer = setInterval(() => {
				void pump();
			}, POLL_FALLBACK_MS);
			pollTimer.unref?.();

			/* Continuous revocation + dead-run fallback. Revocation mirrors the
			 * app relay: close ONLY on a CONFIRMED denial (an identity change, a
			 * definitive ban/deletion, an `AppAccessError`), never on a transient
			 * backend blip. The dead-run fallback closes a terminal-less tail once
			 * the app has been held by NO live run for consecutive ticks — the
			 * producing process died without sealing the log; the synthetic
			 * `finish` chunk tells the client the turn is over. */
			cadence = setInterval(() => {
				void (async () => {
					if (closed) return;

					const live = await getSessionSafe(req);
					if (closed) return;
					if (live && live.user.id !== userId) {
						teardown();
						return;
					}

					try {
						if (!(await isUserActive(userId))) {
							teardown();
							return;
						}
					} catch {
						return; // transient — leave the stream open, re-check next tick
					}
					if (closed) return;

					try {
						await resolveAppScope(appId, userId, "view");
					} catch (err) {
						if (err instanceof AppAccessError) teardown();
						return; // non-access throw: transient — re-check next tick
					}
					if (closed) return;

					try {
						if (await appHeldLive(appId)) {
							deadTicks = 0;
							return;
						}
					} catch {
						return; // transient — re-check next tick
					}
					deadTicks += 1;
					if (deadTicks < DEAD_TICKS_TO_CLOSE) {
						/* Give the just-released clean run one more pump to land its
						 * terminal row before concluding it died. */
						void pump();
						return;
					}
					if (closed) return;
					/* Final drain BEFORE concluding: rows appended since the last
					 * poll (the released run's closing flush) must reach the client
					 * rather than be cut off by the synthetic close. The pump itself
					 * closes the stream if it consumes the terminal row. */
					await pump();
					if (closed) return;
					finishAndClose();
				})();
			}, CADENCE_MS);
			cadence.unref?.();

			if (req.signal.aborted) teardown();
			else req.signal.addEventListener("abort", teardown);
		},
		cancel() {
			teardownRef?.();
		},
	});

	return new Response(stream, {
		headers: {
			...UI_MESSAGE_STREAM_HEADERS,
			"x-workflow-run-id": streamId,
			...(tailHeader !== undefined
				? { "x-workflow-stream-tail-index": tailHeader }
				: {}),
		},
	});
}
