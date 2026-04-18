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

	it("does not write synchronously — buffers until the flush timer fires", () => {
		const sink = vi.fn();
		const writer = new LogWriter("app-1", { sink });

		writer.logEvent(makeEvent(0));
		expect(sink).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink).toHaveBeenCalledWith("app-1", [
			expect.objectContaining({ seq: 0 }),
		]);
	});

	it("coalesces bursts into a single batch", () => {
		const sink = vi.fn();
		const writer = new LogWriter("app-1", { sink });

		for (let i = 0; i < 5; i++) writer.logEvent(makeEvent(i));
		expect(sink).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][1]).toHaveLength(5);
	});

	it("flushes immediately when buffer exceeds MAX_BATCH", () => {
		const sink = vi.fn();
		const writer = new LogWriter("app-1", { sink, maxBatch: 3 });

		writer.logEvent(makeEvent(0));
		writer.logEvent(makeEvent(1));
		writer.logEvent(makeEvent(2));
		/* Threshold crossed during the third push — flush synchronously. */
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
});
