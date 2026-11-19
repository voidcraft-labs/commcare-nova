/**
 * The process's meter of what running bring-ins hold, over meters of its own
 * bounds (charges are numbers, so nothing here allocates what it charges),
 * and the bounds it reads from the instance.
 *
 * A charge that passes the bound and is kept, a later lease that is not
 * stopped, the oldest lease stopped (a request that can only ever run alone,
 * answered "busy" forever), a lease stopped between its writes, and a lease
 * whose bytes are never given back are what these catch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	chargeHeld,
	currentMemoryLease,
	giveBackHeld,
	MemoryMeter,
	MemoryMeterFullError,
	processMemoryBounds,
	READING_HEAP_PER_SOURCE_BYTE,
	runInLease,
	TEXT_HEAP_PER_WIRE_BYTE,
	UNCONSTRAINED_MEMORY_BYTES,
} from "../hq/memoryMeter";

const MiB = 1024 * 1024;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MemoryMeter", () => {
	it("holds what each lease charges, by what it is held as, and gives it back as it is let go and when the lease ends", () => {
		const meter = new MemoryMeter({ heap: 10_000, external: 10_000 });
		const lease = meter.open();
		expect(lease.charge("text", 100)).toBe(true);
		expect(lease.charge("bytes", 300)).toBe(true);
		expect(lease.charge("reading", 10)).toBe(true);
		expect(meter.held()).toEqual({
			heap: 100 * TEXT_HEAP_PER_WIRE_BYTE + 10 * READING_HEAP_PER_SOURCE_BYTE,
			external: 300,
		});
		lease.giveBack("bytes", 200);
		expect(lease.held().external).toBe(100);
		/* A give-back never takes back more than the lease holds. */
		lease.giveBack("bytes", 5_000);
		expect(lease.held().external).toBe(0);
		lease.end();
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
		expect(meter.openLeases()).toBe(0);
	});

	it("refuses a later lease's charge that would pass the bound, aborts its signal, holds nothing of it, and refuses it from then on", () => {
		const meter = new MemoryMeter({ heap: 1_000, external: 1_000 });
		const first = meter.open();
		const second = meter.open();
		expect(first.charge("bytes", 900)).toBe(true);
		expect(second.charge("bytes", 101)).toBe(false);
		expect(second.exhausted).toBe(true);
		expect(second.signal.aborted).toBe(true);
		expect(second.signal.reason).toBeInstanceOf(MemoryMeterFullError);
		expect(second.held()).toEqual({ heap: 0, external: 0 });
		/* Refused once, refused for good: its reads stop at once. */
		expect(second.charge("bytes", 1)).toBe(false);
		expect(second.beginWrites()).toBe(false);
		/* The other pool is its own: the heap is empty, yet the lease is spent. */
		expect(second.charge("text", 1)).toBe(false);
		second.end();
		first.end();
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
	});

	it("keeps the pools apart: bytes kept as files never crowd out a reading's heap", () => {
		const meter = new MemoryMeter({ heap: 1_000, external: 1_000 });
		const first = meter.open();
		const second = meter.open();
		expect(first.charge("bytes", 1_000)).toBe(true);
		expect(second.charge("text", 400)).toBe(true);
		expect(second.charge("bytes", 1)).toBe(false);
		first.end();
		second.end();
	});

	it("never refuses the oldest open lease, so a request past the bound by itself still runs, and refuses the next", () => {
		const meter = new MemoryMeter({ heap: 1_000, external: 1_000 });
		const eldest = meter.open();
		expect(eldest.charge("reading", 100)).toBe(true);
		expect(meter.held().heap).toBe(100 * READING_HEAP_PER_SOURCE_BYTE);
		const next = meter.open();
		expect(next.charge("text", 1)).toBe(false);
		next.end();
		/* Once the eldest ends, the next oldest is the one that runs. */
		const later = meter.open();
		eldest.end();
		expect(later.charge("reading", 100)).toBe(true);
		later.end();
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
	});

	it("refuses nothing of a lease that has begun to write, and counts what it charges so a later lease meets it", () => {
		const meter = new MemoryMeter({ heap: 1_000, external: 1_000 });
		const eldest = meter.open();
		const writer = meter.open();
		expect(writer.charge("bytes", 10)).toBe(true);
		expect(writer.beginWrites()).toBe(true);
		expect(writer.writing).toBe(true);
		expect(writer.charge("bytes", 5_000)).toBe(true);
		expect(writer.exhausted).toBe(false);
		expect(meter.held().external).toBe(5_010);
		const later = meter.open();
		expect(later.charge("bytes", 1)).toBe(false);
		later.end();
		writer.end();
		eldest.end();
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
	});

	it("refuses every charge of a lease that has ended, so work that outlived its request keeps nothing", () => {
		const meter = new MemoryMeter({ heap: 1_000, external: 1_000 });
		const lease = meter.open();
		lease.end();
		expect(lease.charge("bytes", 1)).toBe(false);
		lease.giveBack("bytes", 1);
		lease.end();
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
	});
});

describe("the running request's lease", () => {
	it("is the lease the request runs under, through every await, and none outside one", async () => {
		const meter = new MemoryMeter({ heap: 1_000, external: 1_000 });
		const lease = meter.open();
		expect(currentMemoryLease()).toBeUndefined();
		expect(chargeHeld("bytes", 10)).toBe(true);
		await runInLease(lease, async () => {
			await Promise.resolve();
			expect(currentMemoryLease()).toBe(lease);
			expect(chargeHeld("bytes", 10)).toBe(true);
			giveBackHeld("bytes", 4);
		});
		expect(meter.held().external).toBe(6);
		lease.end();
	});
});

describe("processMemoryBounds", () => {
	it("gives bring-ins half the heap and a quarter of the memory of a 2 GiB instance", () => {
		vi.spyOn(process, "constrainedMemory").mockReturnValue(2048 * MiB);
		const bounds = processMemoryBounds();
		expect(bounds.external).toBe(512 * MiB);
		expect(bounds.heap).toBeLessThanOrEqual(512 * MiB);
	});

	it("sizes an unconstrained process as the instance, and reads no more memory than the machine has", () => {
		vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
		expect(processMemoryBounds().external).toBe(UNCONSTRAINED_MEMORY_BYTES / 4);
		/* A cgroup with no limit set reads as the largest number there is. */
		vi.spyOn(process, "constrainedMemory").mockReturnValue(
			Number.MAX_SAFE_INTEGER,
		);
		expect(processMemoryBounds().external).toBeLessThan(
			Number.MAX_SAFE_INTEGER / 4,
		);
	});
});
