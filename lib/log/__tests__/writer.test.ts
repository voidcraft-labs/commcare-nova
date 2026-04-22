/**
 * Tests for the LogWriter batcher.
 *
 * Two surfaces under test:
 *   - `LogWriter`'s batching + failure-isolation semantics, exercised
 *     via an injected sink stub (no Firestore).
 *   - The default production sink (`firestoreSink`), exercised via the
 *     no-opts-sink branch of `LogWriter` with Firestore mocked at the
 *     `collections.events(appId)` entry point — so a regression that
 *     reverted to deterministic doc IDs would be caught.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../types";

/* Hoisted mocks for the production-sink test. `collections.events(appId)`
 * returns a minimal chainable stub: `.doc()` mints a tracked ref,
 * `.firestore.batch()` returns a batch stub with `create` + `commit`.
 * Hoisted so the `vi.mock` factory can reference them at hoist time. */
const { eventsDocMock, batchCreateMock, batchCommitMock, firestoreBatchMock } =
	vi.hoisted(() => ({
		eventsDocMock: vi.fn(),
		batchCreateMock: vi.fn(),
		batchCommitMock: vi.fn().mockResolvedValue(undefined),
		firestoreBatchMock: vi.fn(),
	}));

vi.mock("@/lib/db/firestore", () => ({
	collections: {
		events: () => ({
			doc: eventsDocMock,
			firestore: { batch: firestoreBatchMock },
		}),
	},
}));

import { LogWriter } from "../writer";

function makeEvent(seq: number, runId = "r"): Event {
	return {
		kind: "mutation",
		runId,
		ts: Date.now(),
		seq,
		/* Matches the writer's own source so most tests are exercising
		 * the pass-through path; the authority test below deliberately
		 * passes a conflicting value to verify overwrite behavior. */
		source: "chat",
		actor: "agent",
		mutation: { kind: "setAppName", name: `app-${seq}` },
	};
}

describe("LogWriter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not write synchronously — buffers until the flush timer fires", async () => {
		const sink = vi.fn().mockResolvedValue(undefined);
		const writer = new LogWriter("app-1", "chat", { sink });

		writer.logEvent(makeEvent(0));
		expect(sink).not.toHaveBeenCalled();

		/* advanceTimersByTimeAsync drains the microtask queue after firing the
		 * timer, so the chained sink call inside flush() has a chance to run. */
		await vi.advanceTimersByTimeAsync(100);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink).toHaveBeenCalledWith("app-1", [
			expect.objectContaining({ seq: 0 }),
		]);
	});

	it("coalesces bursts into a single batch", async () => {
		const sink = vi.fn().mockResolvedValue(undefined);
		const writer = new LogWriter("app-1", "chat", { sink });

		for (let i = 0; i < 5; i++) writer.logEvent(makeEvent(i));
		expect(sink).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][1]).toHaveLength(5);
	});

	it("flushes immediately when buffer exceeds MAX_BATCH", async () => {
		const sink = vi.fn().mockResolvedValue(undefined);
		const writer = new LogWriter("app-1", "chat", { sink, maxBatch: 3 });

		writer.logEvent(makeEvent(0));
		writer.logEvent(makeEvent(1));
		writer.logEvent(makeEvent(2));
		/* Threshold crossed during the third push — flush is kicked off via
		 * `void this.flush()`. The sink call runs as a microtask on the inflight
		 * chain, so drain once before asserting. */
		await Promise.resolve();
		await Promise.resolve();
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][1]).toHaveLength(3);
	});

	it("flush() drains the buffer immediately", async () => {
		const sink = vi.fn().mockResolvedValue(undefined);
		const writer = new LogWriter("app-1", "chat", { sink });

		writer.logEvent(makeEvent(0));
		writer.logEvent(makeEvent(1));
		await writer.flush();

		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][1]).toHaveLength(2);
	});

	it("continues after a sink failure", async () => {
		const sink = vi
			.fn()
			.mockRejectedValueOnce(new Error("firestore down"))
			.mockResolvedValueOnce(undefined);
		const writer = new LogWriter("app-1", "chat", { sink });

		writer.logEvent(makeEvent(0));
		await writer.flush();
		writer.logEvent(makeEvent(1));
		await writer.flush();

		expect(sink).toHaveBeenCalledTimes(2);
	});

	it("flush() awaits in-flight sinks from prior timer fires", async () => {
		let resolveSlow: (() => void) | undefined;
		const slowSink = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((res) => {
						resolveSlow = res;
					}),
			)
			.mockResolvedValue(undefined);
		const writer = new LogWriter("app-1", "chat", { sink: slowSink });

		writer.logEvent(makeEvent(0));
		/* Advance through the 100ms timer — first sink starts, does not resolve. */
		await vi.advanceTimersByTimeAsync(100);
		expect(slowSink).toHaveBeenCalledTimes(1);

		/* Enqueue another event + call flush while the first sink is still pending. */
		writer.logEvent(makeEvent(1));
		const secondFlush = writer.flush();

		/* secondFlush must NOT have resolved yet — it's awaiting the slow sink. */
		let resolved = false;
		void secondFlush.then(() => {
			resolved = true;
		});
		await Promise.resolve(); // microtask drain
		expect(resolved).toBe(false);

		/* Resolve the slow sink; now the chain completes and secondFlush settles. */
		resolveSlow?.();
		await secondFlush;
		expect(slowSink).toHaveBeenCalledTimes(2);
	});

	it("flush() on an empty buffer still awaits prior in-flight sinks", async () => {
		let resolveSlow: (() => void) | undefined;
		const slowSink = vi.fn().mockImplementationOnce(
			() =>
				new Promise<void>((res) => {
					resolveSlow = res;
				}),
		);
		const writer = new LogWriter("app-1", "chat", { sink: slowSink });

		writer.logEvent(makeEvent(0));
		await vi.advanceTimersByTimeAsync(100);

		/* Now call flush with an empty buffer — must still wait for the prior sink. */
		const emptyFlush = writer.flush();
		let resolved = false;
		void emptyFlush.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);

		resolveSlow?.();
		await emptyFlush;
		expect(resolved).toBe(true);
	});

	/**
	 * Authority guarantee: the writer stamps its constructor-provided
	 * `source` onto every event, overwriting whatever the caller set on
	 * the envelope. This matters because tool adapters and
	 * GenerationContext deliberately include `source` inline (for type
	 * safety + SSE wire semantics) — if a caller ever built an envelope
	 * with the wrong surface tag, the writer must overwrite it so the
	 * persisted stream cannot lie about its origin. Regression here
	 * would let a chat-surface miswire leak into MCP analytics (or
	 * vice-versa).
	 */
	it("overwrites caller-provided source with the writer's own", async () => {
		const sink = vi.fn().mockResolvedValue(undefined);
		const writer = new LogWriter("app-1", "mcp", { sink });

		// Caller lies and says "chat"; writer built with "mcp" must win.
		const misstamped: Event = {
			kind: "mutation",
			runId: "r",
			ts: Date.now(),
			seq: 0,
			source: "chat",
			actor: "agent",
			mutation: { kind: "setAppName", name: "x" },
		};
		writer.logEvent(misstamped);
		await writer.flush();

		expect(sink).toHaveBeenCalledTimes(1);
		const flushed = sink.mock.calls[0][1] as readonly Event[];
		expect(flushed).toHaveLength(1);
		expect(flushed[0].source).toBe("mcp");
		// Original envelope must not have been mutated — the writer
		// spreads into a fresh object before stamping.
		expect(misstamped.source).toBe("chat");
	});
});

/**
 * Production-sink path. Guards against regressions that would swap the
 * `.doc()` + `batch.create()` pair (auto-ID, collision-free) for a
 * deterministic-ID pattern — which is exactly the bug the event-log
 * refactor fixed (runId+seq doc IDs colliding across edit turns).
 *
 * The injected-sink tests above can't catch that regression because
 * they don't exercise `firestoreSink`. These tests do, via a Firestore
 * mock that tracks the exact calls `firestoreSink` makes.
 */
describe("LogWriter default firestoreSink", () => {
	beforeEach(() => {
		vi.useRealTimers();
		eventsDocMock.mockReset();
		batchCreateMock.mockReset();
		batchCommitMock.mockReset();
		batchCommitMock.mockResolvedValue(undefined);
		firestoreBatchMock.mockReset();
		firestoreBatchMock.mockImplementation(() => ({
			create: batchCreateMock,
			commit: batchCommitMock,
		}));
		/* Each call to `.doc()` returns a distinct sentinel — lets us
		 * assert `batch.create` was called with matching refs and events. */
		let nextRefId = 0;
		eventsDocMock.mockImplementation(() => ({ __refId: nextRefId++ }));
	});

	it("mints one auto-ID per event and creates each in the batch", async () => {
		const writer = new LogWriter("app-1", "chat");
		writer.logEvent(makeEvent(0));
		writer.logEvent(makeEvent(1));
		writer.logEvent(makeEvent(2));
		await writer.flush();

		/* `.doc()` called with NO arguments — the fingerprint of auto-ID
		 * allocation. A regression to `.doc(someDeterministicId)` would
		 * fail this assertion. */
		expect(eventsDocMock).toHaveBeenCalledTimes(3);
		for (const call of eventsDocMock.mock.calls) {
			expect(call).toHaveLength(0);
		}
		/* `batch.create(ref, event)` for each enqueued event — the
		 * `.create` form (vs `.set`) is the collision-fails form, which
		 * is the safer of the two pairings with auto-IDs. */
		expect(batchCreateMock).toHaveBeenCalledTimes(3);
		for (let i = 0; i < 3; i++) {
			expect(batchCreateMock.mock.calls[i][0]).toEqual({ __refId: i });
			expect(batchCreateMock.mock.calls[i][1]).toMatchObject({ seq: i });
		}
		expect(batchCommitMock).toHaveBeenCalledTimes(1);
	});
});
