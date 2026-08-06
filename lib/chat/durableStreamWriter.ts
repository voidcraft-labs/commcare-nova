/**
 * DurableStreamWriter — the chat route's one write choke point, wrapping the
 * live response writer so every ordinary UI message chunk is forwarded to the
 * open POST response (best-effort), appended to the live-catch-up chunk log
 * (`lib/db/streamChunks`), and teed into the route's barrier fold when one is
 * attached. The log is what makes a LIVE stream resumable: a client whose
 * connection broke replays from its cursor via
 * `app/api/chat/[streamId]/stream` instead of losing the run. The fold is the
 * SDK-side assembly of the same sequence, whose completion callbacks persist
 * the durable transcript step by step.
 *
 * One chunk is deliberately split: `writePrivateHolderNonce` sends the real
 * run-holder capability only on the authenticated POST response and persists
 * an inert marker at the same index. The reconnect route replaces that marker
 * from the actor-bound thread/app projection for the owning actor and leaves it
 * redacted for every other Project viewer. The one-for-one marker preserves the
 * transport's count-based cursor without putting the capability in the
 * view-scoped chunk log.
 *
 * Semantics, in order of importance:
 *
 *  - **Per-token tool-input JSON dies at the door.** `tool-input-delta`
 *    chunks are dropped before any destination sees them: no rendered or
 *    durable surface consumes partial tool input (tool parts show as pending
 *    on `tool-input-start` and complete on `tool-input-available`), and the
 *    deltas dominate chunk volume. Filtering once, here, keeps the response,
 *    the log, and the fold on one identical sequence.
 *  - **Logging never stops when the client dies.** A throw out of the inner
 *    `write` means the browser is gone; forwarding stops (the route's
 *    "closed tab neither cancels nor finalizes" contract) but chunks keep
 *    flowing to the log so a reconnect sees the whole run.
 *  - **The fold outlives everything else.** The tee ignores a dead client
 *    and a broken log — the fold keeps assembling so the run's TERMINAL
 *    transcript write always lands. (Mid-run barrier writes are the one
 *    consumer that must NOT outrun a broken log — `flushNow` reports the
 *    break so the route can hold them; see its doc.) A fold sink that
 *    throws is dropped and logged once; the route's finalize fallback
 *    still retires the run marker.
 *  - **Indices are assigned here, in write order.** The resume cursor is a
 *    count of chunks; the POST response and the log emit the same sequence,
 *    so a client that received N chunks resumes at `startIndex=N` with no gap
 *    and no overlap.
 *  - **Every stream ends.** `close()` appends a synthetic `finish` chunk when
 *    the run's own stream never produced one (error paths) and marks the last
 *    row terminal — a resuming client always reaches a close instead of
 *    tailing forever. The synthetic finish is also forwarded live so the
 *    resumable transport doesn't reconnect after an error-terminated POST.
 *  - **The log is supplemental.** A persistent append failure marks the
 *    stream broken and stops buffering (bounded memory, one error log); the
 *    live response is untouched and the run proceeds — only resumability is
 *    lost, and the reconnect endpoint's liveness fallback still closes any
 *    tailer.
 *
 * Flushes are batched (a timer or a buffer-size trigger) and serialized on a
 * promise chain so rows land in index order.
 */

import type { UIMessageChunk, UIMessageStreamWriter } from "ai";
import { appendStreamChunks } from "@/lib/db/streamChunks";
import { log } from "@/lib/logger";
import {
	holderNonceReplayDigest,
	PRIVATE_HOLDER_NONCE_CHUNK_TYPE,
} from "./privateHolderNonce";

/** Batch window — chunks buffered up to this long before an append. */
const FLUSH_MS = 300;
/** Buffer-size trigger — a burst flushes immediately past this many chunks. */
const FLUSH_CHUNK_COUNT = 64;

export interface DurableStreamWriterOptions {
	streamId: string;
	appId: string;
	runId: string;
	threadId: string;
	inner: UIMessageStreamWriter;
	/**
	 * The route's barrier fold: the writer of a server-internal SDK stream
	 * that re-assembles the run so completion callbacks can persist the
	 * transcript at each step barrier. Receives exactly the sequence the
	 * response and log carry, and keeps receiving after the client dies or
	 * the log breaks.
	 */
	fold?: UIMessageStreamWriter;
}

export class DurableStreamWriter implements UIMessageStreamWriter {
	private readonly streamId: string;
	private readonly appId: string;
	private readonly runId: string;
	private readonly threadId: string;
	private readonly inner: UIMessageStreamWriter;
	private readonly fold: UIMessageStreamWriter | null;

	/** Chunks written but not yet appended; `buffer[0]` sits at `flushedCount`. */
	private buffer: UIMessageChunk[] = [];
	/** Chunks already appended to the log (the next row's `firstIndex`). */
	private flushedCount = 0;
	/** Serializes appends so rows land in index order. */
	private flushChain: Promise<void> = Promise.resolve();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	/** The inner writer threw — the client is gone; stop forwarding. */
	private forwardingDead = false;
	/** The fold sink threw — barrier persistence for this run is over. */
	private foldDead = false;
	/** The log rejected twice — stop buffering; resumability is lost. */
	private broken = false;
	private sawFinish = false;
	private closed = false;

	constructor(options: DurableStreamWriterOptions) {
		this.streamId = options.streamId;
		this.appId = options.appId;
		this.runId = options.runId;
		this.threadId = options.threadId;
		this.inner = options.inner;
		this.fold = options.fold ?? null;
	}

	write(part: UIMessageChunk): void {
		/* Per-token tool-input JSON is dropped whole: nothing downstream
		 * consumes partial tool input, and every destination must see the same
		 * sequence — see the module doc. */
		if (part.type === "tool-input-delta") return;
		/* Defense at the choke point: even if a future caller uses the generic
		 * writer for this private part, never serialize the capability into the
		 * view-scoped log. */
		if (part.type === "data-holder-nonce") {
			const holderNonce = (part.data as { holderNonce?: unknown }).holderNonce;
			if (typeof holderNonce === "string") {
				this.writePrivateHolderNonce(holderNonce);
				return;
			}
		}
		this.writePair(part, part);
	}

	/**
	 * Forward a holder nonce to the POST caller without persisting the token.
	 * The durable marker occupies exactly one chunk index; the actor-bound
	 * reconnect route resolves it back to `data-holder-nonce` when authorized.
	 */
	writePrivateHolderNonce(holderNonce: string): void {
		this.writePair(
			{
				type: "data-holder-nonce",
				data: { holderNonce },
				transient: true,
			},
			{
				type: PRIVATE_HOLDER_NONCE_CHUNK_TYPE,
				data: {
					threadId: this.threadId,
					holderDigest: holderNonceReplayDigest(holderNonce),
				},
				transient: true,
			},
		);
	}

	/** Persist `durablePart` and forward `livePart` at the same chunk index. */
	private writePair(
		livePart: UIMessageChunk,
		durablePart: UIMessageChunk,
	): void {
		if (this.closed) {
			log.warn("[durableStream] write after close dropped", {
				streamId: this.streamId,
				type: livePart.type,
			});
			return;
		}
		if (livePart.type === "finish") this.sawFinish = true;
		if (!this.broken) {
			this.buffer.push(durablePart);
			if (this.buffer.length >= FLUSH_CHUNK_COUNT) {
				this.enqueueFlush(false);
			} else {
				this.scheduleFlush();
			}
		}
		/* The fold gets the live shape: the holder-nonce marker swap is
		 * fold-invisible either way (both halves are transient data chunks,
		 * which the SDK excludes from the assembled message). */
		if (this.fold && !this.foldDead) {
			try {
				this.fold.write(livePart);
			} catch (err) {
				this.foldDead = true;
				log.error("[durableStream] barrier fold write failed", err, {
					streamId: this.streamId,
					appId: this.appId,
				});
			}
		}
		if (!this.forwardingDead) {
			try {
				this.inner.write(livePart);
			} catch {
				this.forwardingDead = true;
			}
		}
	}

	/** Satisfies the interface; the chat route never merges sub-streams into
	 *  the response writer, and a merged stream would bypass chunk indexing —
	 *  pump through `write` instead. */
	merge(stream: ReadableStream<UIMessageChunk>): void {
		void (async () => {
			const reader = stream.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					this.write(value);
				}
			} catch (err) {
				log.warn("[durableStream] merged stream errored", {
					streamId: this.streamId,
					err: err instanceof Error ? err.message : String(err),
				});
			} finally {
				reader.releaseLock();
			}
		})();
	}

	get onError(): UIMessageStreamWriter["onError"] {
		return this.inner.onError;
	}

	/**
	 * Drain the buffer and await the append chain, so everything written so
	 * far is durably in the log. Barrier callers run this before persisting a
	 * step's snapshot: with the step's `finish-step` in the log first, a
	 * resume replay windowed against the persisted transcript can never
	 * re-deliver content that transcript already holds.
	 *
	 * Returns whether the log actually holds everything written so far. A
	 * BROKEN log (the append latch tripped) resolves `false` rather than
	 * throwing: the caller must then SKIP its barrier write — a barrier that
	 * outran a truncated log would invert the log ≥ transcript ordering the
	 * resume protocol depends on, re-delivering already-persisted steps as
	 * duplicates on the next replay. The run's terminal transcript write is
	 * exempt (it never consults the log again), so losing the log costs
	 * resumability and mid-run barriers, never the final record.
	 */
	async flushNow(): Promise<boolean> {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.enqueueFlush(false);
		await this.flushChain;
		return !this.broken;
	}

	/**
	 * Terminate the stream in the log: synthesize the missing `finish` (error
	 * paths), flush everything buffered, and mark the last row terminal. Runs
	 * exactly once; the route awaits it at execute end so the terminal row is
	 * durable before the response closes.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		if (!this.sawFinish) this.write({ type: "finish" });
		this.closed = true;
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.enqueueFlush(true);
		await this.flushChain;
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.enqueueFlush(false);
		}, FLUSH_MS);
		// Never keep the process (or a test worker) alive for a pending batch.
		this.flushTimer.unref();
	}

	private enqueueFlush(terminal: boolean): void {
		this.flushChain = this.flushChain.then(() => this.flush(terminal));
	}

	/**
	 * Append the buffered batch (possibly empty, when `terminal` — the pure
	 * end-marker row). One in-chain retry; a second failure marks the stream
	 * broken so memory stays bounded and the error logs once.
	 */
	private async flush(terminal: boolean): Promise<void> {
		if (this.broken) return;
		if (this.buffer.length === 0 && !terminal) return;
		const chunks = this.buffer;
		this.buffer = [];
		const append = {
			streamId: this.streamId,
			appId: this.appId,
			runId: this.runId,
			firstIndex: this.flushedCount,
			chunks: chunks as unknown[],
			terminal,
		};
		try {
			await appendStreamChunks(append);
		} catch {
			try {
				await appendStreamChunks(append);
			} catch (err) {
				this.broken = true;
				this.buffer = [];
				log.error("[durableStream] chunk append failed twice", err, {
					streamId: this.streamId,
					appId: this.appId,
				});
				return;
			}
		}
		this.flushedCount += chunks.length;
	}
}
