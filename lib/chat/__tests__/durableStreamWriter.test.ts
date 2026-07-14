/**
 * DurableStreamWriter — the invariants the resumable-stream contract rides on:
 *
 *   - chunk indices are assigned in write order and stay contiguous across
 *     flush boundaries (`firstIndex` continuity is the resume cursor's math);
 *   - a dead client (inner `write` throws) stops FORWARDING, never LOGGING —
 *     the whole run still lands in the log for a reconnect;
 *   - every stream ends: `close()` synthesizes a `finish` chunk when the run's
 *     own stream never produced one, seals with a terminal row, and is
 *     idempotent;
 *   - a persistently failing log marks the stream broken (bounded memory, the
 *     live response untouched) instead of throwing into the run.
 *
 * `appendStreamChunks` is mocked — the Postgres data layer has its own
 * integration coverage; this suite pins the writer's batching/ordering logic.
 */

import type { UIMessageChunk, UIMessageStreamWriter } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunkAppend } from "@/lib/db/streamChunks";

const { appendMock } = vi.hoisted(() => ({
	appendMock: vi.fn(),
}));

vi.mock("@/lib/db/streamChunks", () => ({
	appendStreamChunks: appendMock,
}));

const { DurableStreamWriter } = await import("../durableStreamWriter");

/** A recording inner writer; `dead` makes every write throw (client gone). */
function makeInner(opts: { dead?: boolean } = {}) {
	const written: UIMessageChunk[] = [];
	let dead = opts.dead ?? false;
	const inner: UIMessageStreamWriter = {
		write(part) {
			if (dead) throw new Error("client gone");
			written.push(part);
		},
		merge() {},
		onError: undefined,
	};
	return {
		inner,
		written,
		kill() {
			dead = true;
		},
	};
}

function makeWriter(inner: UIMessageStreamWriter) {
	return new DurableStreamWriter({
		streamId: "stream-1",
		appId: "app-1",
		runId: "run-1",
		inner,
	});
}

const chunk = (i: number): UIMessageChunk =>
	({ type: "text-delta", id: "0", delta: `c${i}` }) as UIMessageChunk;

/** All appended chunks across every recorded flush, in row order. */
function appendedChunks(): unknown[] {
	return appendMock.mock.calls.flatMap(
		(call) => (call[0] as StreamChunkAppend).chunks,
	);
}

beforeEach(() => {
	appendMock.mockReset();
	appendMock.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("DurableStreamWriter", () => {
	it("assigns contiguous indices across flush boundaries and seals with a terminal row", async () => {
		const { inner, written } = makeInner();
		const writer = makeWriter(inner);

		// 70 chunks crosses the 64-chunk burst trigger → at least two rows.
		for (let i = 0; i < 70; i++) writer.write(chunk(i));
		writer.write({ type: "finish" });
		await writer.close();

		const appends = appendMock.mock.calls.map(
			(call) => call[0] as StreamChunkAppend,
		);
		expect(appends.length).toBeGreaterThanOrEqual(2);
		// firstIndex continuity: each row starts where the previous ended.
		let expected = 0;
		for (const a of appends) {
			expect(a.firstIndex).toBe(expected);
			expected += a.chunks.length;
		}
		// 70 deltas + the explicit finish, nothing dropped or duplicated.
		expect(expected).toBe(71);
		// Exactly one terminal row, and it is the last.
		expect(appends.filter((a) => a.terminal)).toHaveLength(1);
		expect(appends.at(-1)?.terminal).toBe(true);
		// The live response saw the same sequence.
		expect(written).toHaveLength(71);
	});

	it("keeps logging after the client dies mid-stream", async () => {
		const { inner, written, kill } = makeInner();
		const writer = makeWriter(inner);

		writer.write(chunk(0));
		kill();
		writer.write(chunk(1));
		writer.write(chunk(2));
		await writer.close();

		// Only the pre-death chunk reached the response…
		expect(written).toHaveLength(1);
		// …but the log carries everything plus the synthetic finish.
		const all = appendedChunks();
		expect(all).toHaveLength(4);
		expect((all.at(-1) as UIMessageChunk).type).toBe("finish");
	});

	it("synthesizes a finish chunk on close only when the stream never produced one", async () => {
		const withFinish = makeInner();
		const w1 = makeWriter(withFinish.inner);
		w1.write(chunk(0));
		w1.write({ type: "finish" });
		await w1.close();
		expect(
			appendedChunks().filter((c) => (c as UIMessageChunk).type === "finish"),
		).toHaveLength(1);

		appendMock.mockClear();
		const withoutFinish = makeInner();
		const w2 = makeWriter(withoutFinish.inner);
		w2.write(chunk(0));
		await w2.close();
		const chunks = appendedChunks();
		expect((chunks.at(-1) as UIMessageChunk).type).toBe("finish");
		// The synthetic finish is also forwarded live, so the transport
		// doesn't reconnect after an error-terminated POST.
		expect(withoutFinish.written.at(-1)?.type).toBe("finish");
	});

	it("close is idempotent and drops (but survives) writes after close", async () => {
		const { inner } = makeInner();
		const writer = makeWriter(inner);
		writer.write(chunk(0));
		await writer.close();
		const rowsAfterClose = appendMock.mock.calls.length;

		writer.write(chunk(1));
		await writer.close();
		// No new rows: the late write was dropped, the second close a no-op.
		expect(appendMock.mock.calls.length).toBe(rowsAfterClose);
	});

	it("flushes on the timer without waiting for close", async () => {
		const { inner } = makeInner();
		const writer = makeWriter(inner);
		writer.write(chunk(0));
		await vi.waitFor(() => expect(appendMock).toHaveBeenCalledOnce(), {
			timeout: 2_000,
		});
		expect((appendMock.mock.calls[0][0] as StreamChunkAppend).terminal).toBe(
			false,
		);
		await writer.close();
	});

	it("marks the stream broken after a failed append + failed retry, and stops buffering", async () => {
		appendMock.mockRejectedValue(new Error("pg down"));
		const { inner, written } = makeInner();
		const writer = makeWriter(inner);

		for (let i = 0; i < 70; i++) writer.write(chunk(i));
		await writer.close();

		// One flush attempt + its in-chain retry, then broken — the close's
		// terminal flush no-ops rather than retrying forever.
		expect(appendMock.mock.calls.length).toBe(2);
		// The live response never noticed.
		expect(written.length).toBeGreaterThanOrEqual(70);
	});
});
