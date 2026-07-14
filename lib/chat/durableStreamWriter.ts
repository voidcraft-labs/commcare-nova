/**
 * DurableStreamWriter — the chat route's one write choke point, wrapping the
 * live response writer so every UI message chunk is BOTH forwarded to the open
 * POST response (best-effort) and appended to the durable chunk log
 * (`lib/db/streamChunks`). The log is what makes the stream resumable: a
 * client whose connection broke replays from its cursor via
 * `app/api/chat/[streamId]/stream` instead of losing the run.
 *
 * Semantics, in order of importance:
 *
 *  - **Logging never stops when the client dies.** A throw out of the inner
 *    `write` means the browser is gone; forwarding stops (the route's
 *    "closed tab neither cancels nor finalizes" contract) but chunks keep
 *    flowing to the log so a reconnect sees the whole run.
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

/** Batch window — chunks buffered up to this long before an append. */
const FLUSH_MS = 300;
/** Buffer-size trigger — a burst flushes immediately past this many chunks. */
const FLUSH_CHUNK_COUNT = 64;

export interface DurableStreamWriterOptions {
	streamId: string;
	appId: string;
	runId: string;
	inner: UIMessageStreamWriter;
}

export class DurableStreamWriter implements UIMessageStreamWriter {
	private readonly streamId: string;
	private readonly appId: string;
	private readonly runId: string;
	private readonly inner: UIMessageStreamWriter;

	/** Chunks written but not yet appended; `buffer[0]` sits at `flushedCount`. */
	private buffer: UIMessageChunk[] = [];
	/** Chunks already appended to the log (the next row's `firstIndex`). */
	private flushedCount = 0;
	/** Serializes appends so rows land in index order. */
	private flushChain: Promise<void> = Promise.resolve();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	/** The inner writer threw — the client is gone; stop forwarding. */
	private forwardingDead = false;
	/** The log rejected twice — stop buffering; resumability is lost. */
	private broken = false;
	private sawFinish = false;
	private closed = false;

	constructor(options: DurableStreamWriterOptions) {
		this.streamId = options.streamId;
		this.appId = options.appId;
		this.runId = options.runId;
		this.inner = options.inner;
	}

	write(part: UIMessageChunk): void {
		if (this.closed) {
			log.warn("[durableStream] write after close dropped", {
				streamId: this.streamId,
				type: part.type,
			});
			return;
		}
		if (part.type === "finish") this.sawFinish = true;
		if (!this.broken) {
			this.buffer.push(part);
			if (this.buffer.length >= FLUSH_CHUNK_COUNT) {
				this.enqueueFlush(false);
			} else {
				this.scheduleFlush();
			}
		}
		if (!this.forwardingDead) {
			try {
				this.inner.write(part);
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
