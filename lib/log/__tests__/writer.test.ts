/**
 * Tests for the LogWriter batcher.
 *
 * We verify batching semantics and failure isolation WITHOUT touching a
 * real Firestore. The writer accepts an injectable "sink" function whose
 * real default is `docs.events(appId).doc(...).set(event)`. Tests pass a
 * capture function so we can assert exactly which events land with which
 * doc ids, in which batches, and at which times.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../types";
import { LogWriter } from "../writer";

function makeEvent(seq: number, runId = "r"): Event {
	return {
		kind: "mutation",
		runId,
		ts: Date.now(),
		seq,
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
		const writer = new LogWriter("app-1", { sink });

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
		const writer = new LogWriter("app-1", { sink });

		for (let i = 0; i < 5; i++) writer.logEvent(makeEvent(i));
		expect(sink).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][1]).toHaveLength(5);
	});

	it("flushes immediately when buffer exceeds MAX_BATCH", async () => {
		const sink = vi.fn().mockResolvedValue(undefined);
		const writer = new LogWriter("app-1", { sink, maxBatch: 3 });

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
		const writer = new LogWriter("app-1", { sink });

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
		const writer = new LogWriter("app-1", { sink });

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
		const writer = new LogWriter("app-1", { sink: slowSink });

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
		const writer = new LogWriter("app-1", { sink: slowSink });

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
});
