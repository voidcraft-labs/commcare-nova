import "server-only";

/**
 * The process's meter of what running bring-ins hold.
 *
 * Every bound a bring-in reads under is per request. This meter bounds what
 * the requests running in one process hold together, by what each of them
 * actually holds rather than by what it could: a request opens a lease when
 * it starts, every byte it keeps is charged to its lease where it is kept,
 * and what it lets go is given back where it lets it go, or when the lease
 * ends. A charge that would take the process past its bound stops the
 * request that made it; the lease's signal aborts and every later charge of
 * it is refused, so its reads stop at once.
 *
 * The one place a body of CommCare HQ's enters is `readBody.ts`, and it
 * charges whatever lease the request runs under (`runInLease`), so no reader
 * of CommCare HQ can keep a byte this meter does not see. A request with no
 * lease (a publish, a status check) is not metered.
 *
 * Two pools, because they fail apart: what is parsed lives on V8's heap,
 * whose limit kills the process when passed whatever the container still
 * has, and a file kept as its bytes lives outside it, against the
 * container's memory.
 *
 * The oldest open lease is never refused, so a request that would pass the
 * bound by itself still runs, alone: refusing it would answer "busy" to a
 * request that no amount of waiting lets in. Every later lease is refused
 * once the process is past its bound.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

const MiB = 1024 * 1024;

/**
 * What a kept byte is held as.
 *
 * - `bytes`: the body kept as its bytes, a media file: one byte outside the
 *   heap per byte.
 * - `text`: a body decoded and parsed (JSON, XML), kept as what was parsed.
 * - `reading`: an app source taken into a reading, charged by its own size
 *   for everything the reader and acceptance build from it.
 */
export type HeldAs = "bytes" | "text" | "reading";

export type MemoryPool = "heap" | "external";

/**
 * The heap one wire byte of a parsed body holds, rounded up from two
 * measurements made with `--expose-gc` on this codebase's own shapes (a
 * collected heap before and after `JSON.parse`): the 16.0 MiB app source
 * of `reading/__tests__/cap.test.ts` parses to 18.8 MiB (1.18 a byte), and
 * 16.0 MiB of lookup rows shaped as `FixtureResource` serves them to
 * 25.2 MiB (1.57 a byte).
 */
export const TEXT_HEAP_PER_WIRE_BYTE = 2;

/**
 * The heap a reading holds at its peak per byte of the source it reads,
 * rounded up from one measurement: the read of a source of 15.99 MiB (and
 * 2.61 MiB of application resource), built as
 * `lib/deployment/reading/__tests__/cap.test.ts` builds its source at the cap,
 * held 576 MiB of live heap at its peak, sampled after a full collection every
 * 2 seconds through the read, against the heap before it: 36.0 bytes of heap
 * a byte of source. The same measurement before the reading let go of what it
 * no longer reads (a node's claim map made only at its first entry, the gate's
 * admitted batch let go before the fixed point, the parse cache weighed by
 * nodes) was 647 MiB, 40.5 a byte.
 */
export const READING_HEAP_PER_SOURCE_BYTE = 37;

/**
 * The heap a changes review's second reading adds per byte of its source,
 * rounded up from one measurement: the review of
 * `lib/deployment/hqChanges/__tests__/cap.test.ts`, a baseline and a changed
 * source of 15.99 MiB each, held 615 MiB at its peak, 39 MiB above one
 * reading of that size (2.5 a byte), since its two readings run one after the
 * other and share the emissions they print; its bring-in, which reviews again
 * and checks once more, held 605 MiB. A changes review is charged one reading
 * of the larger source and this rate over the smaller
 * (`lib/deployment/reading/room.ts::holdChangesReadings`).
 */
export const SECOND_READING_HEAP_PER_SOURCE_BYTE = 3;

const HELD: Readonly<
	Record<HeldAs, { readonly pool: MemoryPool; readonly perByte: number }>
> = {
	bytes: { pool: "external", perByte: 1 },
	text: { pool: "heap", perByte: TEXT_HEAP_PER_WIRE_BYTE },
	reading: { pool: "heap", perByte: READING_HEAP_PER_SOURCE_BYTE },
};

/** The memory a process with no constraint the OS reports is sized as: the serving instance's. */
export const UNCONSTRAINED_MEMORY_BYTES = 2048 * MiB;

export interface MemoryBounds {
	readonly heap: number;
	readonly external: number;
}

/**
 * The process's bounds, from the instance it runs on.
 *
 * The serving instance is one Cloud Run container of 2 GiB (1 vCPU, 80
 * requests at once). `process.constrainedMemory()` reads that limit from the
 * cgroup (0 where there is none, as in development and tests, which are
 * sized as the instance: `UNCONSTRAINED_MEMORY_BYTES`). Node gives V8 that
 * figure to size its heap, and V8 takes a quarter of it for its old
 * generation, doubled on 64-bit: about 1 GiB of heap on the instance, which
 * `getHeapStatistics().heap_size_limit` reports; the bound reads the
 * smaller of that and half the memory, so a development machine's larger
 * heap is metered as the instance's.
 *
 * - heap: half the heap. The other half is serving's: its modules, caches
 *   and 80 requests at once (a test worker with a bring-in's modules
 *   loaded held 322 MiB of heap before reading anything). On the instance,
 *   about 512 MiB: a reading of a 1 MiB source charges 37 MiB, so a dozen
 *   ordinary bring-ins run at once, and a changes review of two sources at
 *   the cap (`HQ_BRING_IN_APP_MAX_BYTES`) charges 480 MiB, which fits.
 * - external: a quarter of the memory. Outside V8's heap is about half the
 *   container, and half of that is serving's own: the runtime, sockets and
 *   buffers. On the instance, 512 MiB: one create at its media bound
 *   (`MAX_MEDIA_EXPORT_BYTES` kept and `HQ_MEDIA_IN_FLIGHT_MAX_BYTES` in
 *   flight, 264 MiB) fits, and so does a second of ordinary size.
 */
export function processMemoryBounds(): MemoryBounds {
	const constrained = process.constrainedMemory();
	const memory =
		constrained > 0
			? Math.min(constrained, totalmem())
			: UNCONSTRAINED_MEMORY_BYTES;
	const heap = Math.min(getHeapStatistics().heap_size_limit, memory / 2);
	return {
		heap: Math.floor(heap / 2),
		external: Math.floor(memory / 4),
	};
}

/** What a lease, or the whole meter, holds now, in bytes of each pool. */
export interface MemoryHeld {
	readonly heap: number;
	readonly external: number;
}

/**
 * The stop a charge past the bound makes: the reason a lease's signal
 * aborts with, and what a read refused by the meter answers as its error.
 */
export class MemoryMeterFullError extends Error {
	constructor() {
		super(
			"This request stopped reading because the bring-ins running in this process together hold as much as the process lets them. It answers that Nova is busy; the bound is lib/commcare/hq/memoryMeter.ts::processMemoryBounds.",
		);
		this.name = "MemoryMeterFullError";
	}
}

/** One request's account with the meter. */
export interface MemoryLease {
	/** Aborts, with a `MemoryMeterFullError`, when a charge of this lease is refused. */
	readonly signal: AbortSignal;
	/** Whether a charge of this lease has been refused. */
	readonly exhausted: boolean;
	/** Whether the request has begun to write (`beginWrites`). */
	readonly writing: boolean;
	/**
	 * Charge `wireBytes` held as `as`. False, holding nothing more, where the
	 * charge is refused: the process would pass its bound and this is not the
	 * oldest open lease, the lease was refused before, or it has ended.
	 * Never false once the request has begun to write.
	 */
	charge(as: HeldAs, wireBytes: number): boolean;
	/** Give back `wireBytes` held as `as`, at most what this lease holds of that pool. */
	giveBack(as: HeldAs, wireBytes: number): void;
	/**
	 * The request is about to write. False where a charge was refused
	 * before: the request then writes nothing and answers busy. Once true, no
	 * charge of this lease is refused, so nothing stops a request between its
	 * writes; what it charges after is still counted, and later requests meet it.
	 */
	beginWrites(): boolean;
	held(): MemoryHeld;
	/** Give everything back and close the lease. Called once a request has settled, however it settled. */
	end(): void;
}

/** A process's meter. One per process (`processMemoryMeter`); tests make their own. */
export class MemoryMeter {
	readonly bounds: MemoryBounds;
	#heap = 0;
	#external = 0;
	/** Open leases, oldest first. */
	readonly #open = new Set<Lease>();

	constructor(bounds: MemoryBounds) {
		this.bounds = bounds;
	}

	open(): MemoryLease {
		const lease = new Lease(this);
		this.#open.add(lease);
		return lease;
	}

	held(): MemoryHeld {
		return { heap: this.#heap, external: this.#external };
	}

	openLeases(): number {
		return this.#open.size;
	}

	/** @internal Whether `lease` may hold `amount` more of `pool`. */
	admits(lease: Lease, pool: MemoryPool, amount: number): boolean {
		const held = pool === "heap" ? this.#heap : this.#external;
		if (held + amount <= this.bounds[pool]) return true;
		return this.#open.values().next().value === lease;
	}

	/** @internal */
	add(pool: MemoryPool, amount: number): void {
		if (pool === "heap") this.#heap += amount;
		else this.#external += amount;
	}

	/** @internal */
	close(lease: Lease): void {
		this.#open.delete(lease);
	}
}

class Lease implements MemoryLease {
	readonly #meter: MemoryMeter;
	readonly #abort = new AbortController();
	#heap = 0;
	#external = 0;
	#exhausted = false;
	#writing = false;
	#ended = false;

	constructor(meter: MemoryMeter) {
		this.#meter = meter;
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	get exhausted(): boolean {
		return this.#exhausted;
	}

	get writing(): boolean {
		return this.#writing;
	}

	charge(as: HeldAs, wireBytes: number): boolean {
		if (this.#ended || this.#exhausted) return false;
		if (wireBytes <= 0) return true;
		const { pool, perByte } = HELD[as];
		const amount = wireBytes * perByte;
		if (!this.#writing && !this.#meter.admits(this, pool, amount)) {
			this.#exhausted = true;
			this.#abort.abort(new MemoryMeterFullError());
			return false;
		}
		this.#hold(pool, amount);
		return true;
	}

	giveBack(as: HeldAs, wireBytes: number): void {
		if (this.#ended || wireBytes <= 0) return;
		const { pool, perByte } = HELD[as];
		const held = pool === "heap" ? this.#heap : this.#external;
		this.#hold(pool, -Math.min(held, wireBytes * perByte));
	}

	beginWrites(): boolean {
		if (this.#exhausted || this.#ended) return false;
		this.#writing = true;
		return true;
	}

	held(): MemoryHeld {
		return { heap: this.#heap, external: this.#external };
	}

	end(): void {
		if (this.#ended) return;
		this.#hold("heap", -this.#heap);
		this.#hold("external", -this.#external);
		this.#ended = true;
		this.#meter.close(this);
	}

	#hold(pool: MemoryPool, amount: number): void {
		if (amount === 0) return;
		if (pool === "heap") this.#heap += amount;
		else this.#external += amount;
		this.#meter.add(pool, amount);
	}
}

/*
 * The meter and the lease a request runs under are the process's, kept on
 * `globalThis` so every copy of this module a bundle makes (a route handler's
 * layer and another's) meters one process against one bound.
 */
const METER = Symbol.for("nova.commcare.memoryMeter");
const LEASES = Symbol.for("nova.commcare.memoryLeases");
type Holder = {
	[METER]?: MemoryMeter;
	[LEASES]?: AsyncLocalStorage<MemoryLease>;
};
const holder = globalThis as Holder;

function leases(): AsyncLocalStorage<MemoryLease> {
	holder[LEASES] ??= new AsyncLocalStorage<MemoryLease>();
	return holder[LEASES];
}

/** The process's meter, bounded by `processMemoryBounds`. */
export function processMemoryMeter(): MemoryMeter {
	holder[METER] ??= new MemoryMeter(processMemoryBounds());
	return holder[METER];
}

/** Run `run` with `lease` as the lease every charge inside it, however deep, is made to. */
export function runInLease<T>(lease: MemoryLease, run: () => T): T {
	return leases().run(lease, run);
}

/** The lease the running request charges, or undefined where it runs under none. */
export function currentMemoryLease(): MemoryLease | undefined {
	return leases().getStore();
}

/** Charge the running request's lease; true where it runs under none. */
export function chargeHeld(as: HeldAs, wireBytes: number): boolean {
	return currentMemoryLease()?.charge(as, wireBytes) ?? true;
}

/** Give back to the running request's lease, where it runs under one. */
export function giveBackHeld(as: HeldAs, wireBytes: number): void {
	currentMemoryLease()?.giveBack(as, wireBytes);
}
