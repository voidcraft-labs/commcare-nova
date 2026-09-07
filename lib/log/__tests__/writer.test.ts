/** The real batcher with controlled persistence completion. Postgres storage,
 * JSONB and cross-writer collisions are exercised in writer.postgres.test.ts. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";
import type { Event } from "../types";
import { type EventSink, LogWriter } from "../writer";

function event(seq: number): Event {
	return {
		kind: "mutation",
		runId: "run",
		ts: 1000 + seq,
		seq,
		source: "chat",
		actor: "agent",
		mutation: { kind: "setAppName", name: `Name ${seq}` },
	};
}

const writers: LogWriter[] = [];
function writer(sink: EventSink, source: "chat" | "mcp" = "chat") {
	const instance = new LogWriter("app", source, { sink });
	writers.push(instance);
	return instance;
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
	try {
		await Promise.all(writers.splice(0).map((instance) => instance.flush()));
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
	}
});

it("coalesces a burst until the original timer deadline, then disarms the timer", async () => {
	const sink = vi.fn<EventSink>().mockResolvedValue(undefined);
	const w = writer(sink);
	w.logEvent(event(0));
	await vi.advanceTimersByTimeAsync(99);
	w.logEvent(event(1));
	expect(sink).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	await w.flush();
	expect(sink.mock.calls).toEqual([["app", [event(0), event(1)]]]);
	expect(vi.getTimerCount()).toBe(0);
});

it("bounds a default batch at 450 and drains the tail exactly once", async () => {
	const sink = vi.fn<EventSink>().mockResolvedValue(undefined);
	const w = writer(sink);
	const events = Array.from({ length: 452 }, (_, seq) => event(seq));
	for (const e of events.slice(0, 449)) w.logEvent(e);
	await Promise.resolve();
	expect(sink).not.toHaveBeenCalled();
	w.logEvent(events[449]);
	await Promise.resolve();
	expect(sink.mock.calls).toEqual([["app", events.slice(0, 450)]]);
	expect(vi.getTimerCount()).toBe(0);
	for (const e of events.slice(450)) w.logEvent(e);
	await Promise.all([w.flush(), w.flush()]);
	expect(sink.mock.calls).toEqual([
		["app", events.slice(0, 450)],
		["app", events.slice(450)],
	]);
	await vi.advanceTimersByTimeAsync(100);
	expect(sink).toHaveBeenCalledTimes(2);
});

it("drains immediately on request finalization without leaving a later duplicate timer write", async () => {
	const sink = vi.fn<EventSink>().mockResolvedValue(undefined);
	const w = writer(sink);
	w.logEvent(event(0));
	await w.flush();
	expect(sink.mock.calls).toEqual([["app", [event(0)]]]);
	expect(vi.getTimerCount()).toBe(0);
	await w.flush();
	await vi.advanceTimersByTimeAsync(100);
	expect(sink.mock.calls).toEqual([["app", [event(0)]]]);
});

it.each([false, true])(
	"joins the in-flight write before finalization (buffered tail: %s)",
	async (bufferedTail) => {
		const blocked = Promise.withResolvers<void>();
		const sink = vi
			.fn<EventSink>()
			.mockImplementationOnce(() => blocked.promise)
			.mockResolvedValue(undefined);
		const w = writer(sink);
		let completion: Promise<void> | undefined;
		try {
			w.logEvent(event(0));
			await vi.advanceTimersByTimeAsync(100);
			expect(sink.mock.calls).toEqual([["app", [event(0)]]]);
			if (bufferedTail) w.logEvent(event(1));
			let finished = false;
			completion = w.flush().then(() => {
				finished = true;
			});
			await vi.advanceTimersByTimeAsync(100);
			expect(finished).toBe(false);
			expect(sink.mock.calls).toEqual([["app", [event(0)]]]);
			blocked.resolve();
			await completion;
			expect(finished).toBe(true);
			expect(sink.mock.calls).toEqual(
				bufferedTail
					? [
							["app", [event(0)]],
							["app", [event(1)]],
						]
					: [["app", [event(0)]]],
			);
		} finally {
			blocked.resolve();
			await completion;
		}
	},
);

it.each(["reject", "throw"] as const)(
	"reports a sink %s without rejecting finalization or losing the next batch",
	async (failure) => {
		const error = new Error("Storage unavailable");
		const sink = vi
			.fn<EventSink>()
			.mockImplementationOnce(() => {
				if (failure === "throw") throw error;
				return Promise.reject(error);
			})
			.mockResolvedValue(undefined);
		const w = writer(sink);
		w.logEvent(event(0));
		await expect(w.flush()).resolves.toBeUndefined();
		expect(log.error).toHaveBeenCalledWith(
			"[LogWriter] batch flush failed",
			error,
			{ appId: "app", count: "1" },
		);
		w.logEvent(event(1));
		await expect(w.flush()).resolves.toBeUndefined();
		expect(sink.mock.calls).toEqual([
			["app", [event(0)]],
			["app", [event(1)]],
		]);
	},
);

it("stamps the writer's source without mutating the supplied envelope", async () => {
	const sink = vi.fn<EventSink>().mockResolvedValue(undefined);
	const w = writer(sink, "mcp");
	const supplied = Object.freeze(event(0));
	w.logEvent(supplied);
	await w.flush();
	expect(sink.mock.calls).toEqual([["app", [{ ...event(0), source: "mcp" }]]]);
	expect(supplied).toEqual(event(0));
});
