/**
 * The bounded body reader and the bounds it takes: a stream it controls, and
 * the constants file. Under a lease of a meter of its own, what the reader
 * charges for each body it keeps, gives back for each it lets go, and the
 * stream it stops where the lease refuses.
 */
import { describe, expect, it } from "vitest";
import * as bounds from "../hq/bounds";
import { HQ_BODY_BOUND_CEILING } from "../hq/bounds";
import type { HqAnswer } from "../hq/http";
import {
	MemoryMeter,
	MemoryMeterFullError,
	runInLease,
	TEXT_HEAP_PER_WIRE_BYTE,
} from "../hq/memoryMeter";
import { assertBodyBound, readBoundedBody } from "../hq/readBody";
import type { readHqJson } from "../hq/readJson";

/** A stream of `chunks`, counting how many the reader pulled and whether it cancelled. */
function counted(chunks: readonly Uint8Array[]) {
	const seen = { pulled: 0, cancelled: false };
	let next = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks[next];
				next += 1;
				if (chunk === undefined) {
					controller.close();
					return;
				}
				seen.pulled += 1;
				controller.enqueue(chunk);
			},
			cancel() {
				seen.cancelled = true;
			},
		},
		/* No read-ahead: a chunk is pulled only when the reader asks for it. */
		{ highWaterMark: 0 },
	);
	return { stream, seen };
}

const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill);

describe("readBoundedBody", () => {
	it("reads a body of exactly its bound whole", async () => {
		const { stream } = counted([bytes(4), bytes(4)]);
		const read = await readBoundedBody(stream, 8, null, "bytes");
		expect(read).toEqual({ kind: "read", bytes: bytes(8) });
	});

	it("cancels a body one byte past its bound and reads nothing past it", async () => {
		const { stream, seen } = counted([bytes(4), bytes(5), bytes(4)]);
		const read = await readBoundedBody(stream, 8, null, "bytes");
		expect(read).toMatchObject({ kind: "too-long", bytes: 9 });
		expect(seen.cancelled).toBe(true);
		/* The chunk that passed the bound was the last one pulled. */
		expect(seen.pulled).toBe(2);
	});

	it("writes a body its size hint names into one array, and carries on past a hint that was short", async () => {
		const exact = await readBoundedBody(
			counted([bytes(3, 1), bytes(3, 2)]).stream,
			16,
			6,
			"bytes",
		);
		expect(exact).toEqual({
			kind: "read",
			bytes: Uint8Array.of(1, 1, 1, 2, 2, 2),
		});
		/* The hint never bounds: a compressed length is shorter than the body. */
		const longer = await readBoundedBody(
			counted([bytes(3, 1), bytes(3, 2)]).stream,
			16,
			4,
			"bytes",
		);
		expect(longer).toEqual({
			kind: "read",
			bytes: Uint8Array.of(1, 1, 1, 2, 2, 2),
		});
		/* A hint past the bound sizes nothing, and the bound still stops the read. */
		expect(
			await readBoundedBody(counted([bytes(10)]).stream, 8, 10, "bytes"),
		).toMatchObject({ kind: "too-long" });
	});

	it("throws on a bound that is no whole number of bytes from one to the ceiling", async () => {
		for (const bound of [0, -1, 1.5, Number.NaN, HQ_BODY_BOUND_CEILING + 1])
			expect(() => assertBodyBound(bound), String(bound)).toThrow(
				/Every read takes a whole number of bytes/,
			);
		await expect(readBoundedBody(null, 0, null, "bytes")).rejects.toThrow();
	});

	it("takes its bound as a required argument, through the reader and through an answer", () => {
		const typeOnly = (answer: HqAnswer, read: typeof readHqJson) => {
			// @ts-expect-error: a body is never read without a bound.
			void readBoundedBody(null);
			// @ts-expect-error: an answer's body is never read without a bound.
			void answer.read();
			// @ts-expect-error: nor without saying what it is kept as.
			void answer.read(8);
			// @ts-expect-error: a JSON read takes a bound.
			void read({ username: "", apiKey: "", server: "india" }, "", "", {});
		};
		expect(typeOnly).toBeTypeOf("function");
	});
});

describe("readBoundedBody under a lease", () => {
	/** A meter whose heap and external pools hold `bound` bytes each, with one lease open on it. */
	function leased(bound: number) {
		const meter = new MemoryMeter({ heap: bound, external: bound });
		const lease = meter.open();
		return { meter, lease };
	}

	it("keeps a body it read charged as what it is kept as, and the meter holds nothing once the lease ends", async () => {
		const { meter, lease } = leased(1024);
		const read = await runInLease(lease, () =>
			readBoundedBody(counted([bytes(4), bytes(4)]).stream, 64, null, "text"),
		);
		expect(read).toEqual({ kind: "read", bytes: bytes(8) });
		expect(meter.held()).toEqual({
			heap: 8 * TEXT_HEAP_PER_WIRE_BYTE,
			external: 0,
		});
		const file = await runInLease(lease, () =>
			readBoundedBody(counted([bytes(6)]).stream, 64, 9, "bytes"),
		);
		expect(file).toEqual({ kind: "read", bytes: bytes(6) });
		expect(file.kind === "read" && file.bytes.buffer.byteLength).toBe(6);
		expect(meter.held().external).toBe(6);
		lease.end();
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
	});

	it("gives back everything of a body past its bound and of one the stream broke", async () => {
		const { meter, lease } = leased(1024);
		const long = await runInLease(lease, () =>
			readBoundedBody(counted([bytes(4), bytes(5)]).stream, 8, null, "bytes"),
		);
		expect(long).toMatchObject({ kind: "too-long", bytes: 9 });
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
		const broken = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes(4));
			},
			pull(controller) {
				controller.error(new Error("the connection closed"));
			},
		});
		const read = await runInLease(lease, () =>
			readBoundedBody(broken, 64, null, "bytes"),
		);
		expect(read.kind).toBe("unavailable");
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
		lease.end();
	});

	it("stops the stream where a later lease's charge would pass the bound, keeping nothing of the body", async () => {
		const meter = new MemoryMeter({ heap: 1024, external: 10 });
		const eldest = meter.open();
		const lease = meter.open();
		const { stream, seen } = counted([bytes(4), bytes(4), bytes(4), bytes(4)]);
		const read = await runInLease(lease, () =>
			readBoundedBody(stream, 64, null, "bytes"),
		);
		expect(read).toEqual({
			kind: "unavailable",
			error: expect.any(MemoryMeterFullError),
		});
		expect(seen.cancelled).toBe(true);
		/* Two chunks fit the ten bytes; the third was refused and none past it pulled. */
		expect(seen.pulled).toBe(3);
		expect(lease.exhausted).toBe(true);
		expect(lease.signal.reason).toBeInstanceOf(MemoryMeterFullError);
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
		lease.end();
		eldest.end();
	});

	it("charges the array a size hint makes before making it, and refuses it there where it would pass the bound", async () => {
		const meter = new MemoryMeter({ heap: 1024, external: 10 });
		const eldest = meter.open();
		const lease = meter.open();
		const { stream, seen } = counted([bytes(16)]);
		const read = await runInLease(lease, () =>
			readBoundedBody(stream, 64, 16, "bytes"),
		);
		expect(read.kind).toBe("unavailable");
		expect(seen.pulled).toBe(0);
		expect(seen.cancelled).toBe(true);
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
		lease.end();
		eldest.end();
	});
});

describe("bounds.ts", () => {
	it("names every bound as a whole number of bytes from one to the ceiling", () => {
		const named = Object.entries(bounds).filter(([name]) =>
			name.endsWith("_BYTES"),
		);
		expect(named.length).toBeGreaterThan(20);
		for (const [name, value] of named) {
			expect(Number.isSafeInteger(value), name).toBe(true);
			expect(value, name).toBeGreaterThan(0);
			expect(value, name).toBeLessThanOrEqual(HQ_BODY_BOUND_CEILING);
		}
	});
});
