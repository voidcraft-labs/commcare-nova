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
 * Doc IDs are Firestore's auto-generated 20-char IDs, so concurrent
 * writers (including multiple requests sharing a `runId`) cannot collide
 * on disk. Chronological order is recovered at read time by
 * `readEvents` via `orderBy("ts").orderBy("seq")`.
 */
import { collections } from "@/lib/db/firestore";
import { log } from "@/lib/logger";
import type { Event } from "./types";

/** Batch size beyond which the writer flushes synchronously. Matches the
 *  Firestore `WriteBatch` hard limit (500) with a safety margin. */
const DEFAULT_MAX_BATCH = 450;

/** Flush interval — coalesces SSE bursts into a single round-trip. */
const DEFAULT_FLUSH_MS = 100;

/** Persistence target the writer drains into. Tests inject a mock; the
 *  production default is `firestoreSink`. */
export type EventSink = (
	appId: string,
	events: readonly Event[],
) => Promise<void>;

/** Production sink: one document per event via `WriteBatch`. `.doc()`
 *  with no argument mints a fresh auto-ID — collision-free by
 *  construction, so concurrent writers (including multiple requests in
 *  the same run) never overwrite each other. */
const firestoreSink: EventSink = async (appId, events) => {
	const col = collections.events(appId);
	const batch = col.firestore.batch();
	for (const ev of events) {
		batch.create(col.doc(), ev);
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
	/**
	 * The entrypoint ("chat" | "mcp") this writer was built for. Stamped
	 * onto every event in `logEvent`. The writer is the single source of
	 * truth for the surface tag: call sites cannot cause drift because
	 * `logEvent` overwrites any caller-provided `source` with this value.
	 */
	private readonly source: "chat" | "mcp";

	/**
	 * @param appId - Firestore app id the events belong to.
	 * @param source - Entrypoint producing the events. Authoritative:
	 *   overwrites any `source` field set by callers on individual
	 *   events. Callers may still include `source` inline on the
	 *   envelopes they build (for type satisfaction + self-documentation
	 *   of the in-memory value), but the persisted value is always this
	 *   constructor argument.
	 * @param opts - Optional sink / batching overrides (tests use this to
	 *   inject a mock sink).
	 */
	constructor(
		private readonly appId: string,
		source: "chat" | "mcp",
		opts: LogWriterOptions = {},
	) {
		this.source = source;
		this.sink = opts.sink ?? firestoreSink;
		this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
		this.maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
	}

	/**
	 * Enqueue an event for persistence. Never throws. When the buffer
	 * reaches `maxBatch`, flushes synchronously; otherwise arms a
	 * `flushMs` timer (idempotent — re-arming during an existing window
	 * is a no-op).
	 *
	 * Re-stamps `source` with the writer's constructor-provided value
	 * regardless of what the caller set. This makes the writer the
	 * single authority for "which surface produced this event", so a
	 * miswired call site cannot pollute the persisted stream.
	 */
	logEvent(event: Event): void {
		// `as Event` — spread drops the `kind` discriminator narrowing; reasserting
		// the union is safe because we only overwrote `source`, not `kind`.
		const stamped = { ...event, source: this.source } as Event;
		this.buffer.push(stamped);
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
