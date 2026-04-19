/**
 * Event log writer — batched fire-and-forget Firestore sink.
 *
 * A single `LogWriter` instance is created per HTTP request (chat route).
 * Callers invoke `logEvent(event)` for each mutation/conversation event
 * they want persisted; the writer buffers events, flushes every ~100ms
 * via a timer, and drains on demand via `flush()` (called on request
 * finalization + abort).
 *
 * Failures never throw — the writer is off the critical path. A Firestore
 * outage degrades observability but does NOT block generation or the
 * spend cap (usage tracking flushes via its own path).
 *
 * Doc IDs use `eventDocId(event)` = `{runId}_{seqPad}` so chronological
 * sort aligns with Firestore's default document-id ordering.
 */
import { collections } from "@/lib/db/firestore";
import { log } from "@/lib/logger";
import { type Event, eventDocId } from "./types";

/** Batch size beyond which the writer flushes synchronously. Matches the
 *  Firestore `WriteBatch` hard limit (500) with a safety margin. */
const DEFAULT_MAX_BATCH = 450;

/** Flush interval — coalesces SSE bursts into a single round-trip. */
const DEFAULT_FLUSH_MS = 100;

/** Firestore-facing sink. Tests inject a mock; production uses the default. */
export type EventSink = (
	appId: string,
	events: readonly Event[],
) => Promise<void>;

/** Production sink: one document per event, via WriteBatch for atomicity. */
const defaultSink: EventSink = async (appId, events) => {
	const db = collections.events(appId).firestore;
	const batch = db.batch();
	for (const ev of events) {
		batch.set(collections.events(appId).doc(eventDocId(ev)), ev);
	}
	await batch.commit();
};

interface LogWriterOptions {
	sink?: EventSink;
	flushMs?: number;
	maxBatch?: number;
}

export class LogWriter {
	private buffer: Event[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Chain of all pending sink invocations. Each `flush()` appends its
	 * own sink call onto this chain and updates the reference, so any
	 * caller that `await`s `flush()` transitively awaits every earlier
	 * sink call too. Cloud Run shutdown after a response cannot truncate
	 * writes if the request handler's final `await writer.flush()`
	 * correctly covers all in-flight persistence.
	 */
	private inflight: Promise<void> = Promise.resolve();
	private readonly sink: EventSink;
	private readonly flushMs: number;
	private readonly maxBatch: number;

	constructor(
		private readonly appId: string,
		opts: LogWriterOptions = {},
	) {
		this.sink = opts.sink ?? defaultSink;
		this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
		this.maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
	}

	/**
	 * Enqueue an event for persistence. Never throws. When the buffer
	 * reaches `maxBatch`, flushes synchronously; otherwise arms a
	 * `flushMs` timer (idempotent — re-arming during an existing window
	 * is a no-op).
	 */
	logEvent(event: Event): void {
		this.buffer.push(event);
		if (this.buffer.length >= this.maxBatch) {
			void this.flush();
			return;
		}
		if (this.timer === null) {
			this.timer = setTimeout(() => {
				void this.flush();
			}, this.flushMs);
		}
	}

	/**
	 * Drain the buffer and await every pending sink call (including any
	 * triggered by timer fires before this call). Safe to invoke from
	 * multiple sites (onFinish, abort handler, explicit finalize) — each
	 * caller awaits the full chain.
	 *
	 * Errors from the sink are logged but never rethrown. `flush()` still
	 * returns a resolved (not rejected) promise in the failure path, so
	 * request handlers don't need to wrap the call in try/catch.
	 */
	async flush(): Promise<void> {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.buffer.length > 0) {
			const events = this.buffer;
			this.buffer = [];
			/* Chain this batch onto the pending-sink promise. Every future
			 * `flush()` awaits the full chain, so a caller's await covers
			 * writes scheduled by earlier timer fires too. */
			this.inflight = this.inflight.then(async () => {
				try {
					await this.sink(this.appId, events);
				} catch (err) {
					log.error("[LogWriter] batch flush failed", err, {
						appId: this.appId,
						count: String(events.length),
					});
				}
			});
		}
		await this.inflight;
	}
}
