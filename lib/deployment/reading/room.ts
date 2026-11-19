import "server-only";

/**
 * Room for a bring-in in the process: every request that reads an app from
 * CommCare HQ, or the changes made to one there, runs under a lease of the
 * process's memory meter (`lib/commcare/hq/memoryMeter.ts`).
 *
 * The lease is a meter, not a reservation: it holds what the request has
 * kept so far, charged where it is kept. Every body CommCare HQ sends is
 * charged as it is read (`readBody.ts`); a source taken into a reading is
 * charged for what the reading builds from it (`holdReading`); a media file
 * judged and let go is given back where it is let go. So an ordinary app of a
 * few megabytes holds a few dozen megabytes of the bound, and many run at
 * once.
 *
 * A charge that would take the process past its bound stops that request:
 * its reads stop, it writes nothing, and it answers `nova-busy`, which asks
 * the person to check again in a minute and says nothing was changed. A
 * request may stop this way partway through its reads; none is stopped once
 * it has begun to write (`BringInRoom.beginWrites`), which comes after its
 * last read of CommCare HQ that a refusal could stop. The lease ends when the
 * request settles, however it settles: an answer, a thrown error, or a
 * request its caller cancelled.
 */

import {
	currentMemoryLease,
	type MemoryLease,
	MemoryMeterFullError,
	processMemoryMeter,
	READING_HEAP_PER_SOURCE_BYTE,
	runInLease,
	SECOND_READING_HEAP_PER_SOURCE_BYTE,
} from "@/lib/commcare/hq/memoryMeter";
import { log } from "@/lib/logger";
import {
	type CircumstanceFinding,
	circumstanceFinding,
} from "@/lib/publish/hqFindings";

/**
 * What a request of a bring-in does: `review` and `create` read an app to
 * bring it in, `changes-review` and `changes-bring-in` read the changes made
 * in CommCare HQ to one Nova publishes there.
 */
export type BringInWork =
	| "review"
	| "create"
	| "changes-review"
	| "changes-bring-in";

/** What a request running in the room is handed. */
export interface BringInRoom {
	/** Aborts where a charge of the request's lease is refused: every read it gives this to stops. */
	readonly signal: AbortSignal;
	/**
	 * The request is about to write, after its reads. Throws, so the room
	 * answers busy and nothing is written, where a charge of its lease was
	 * refused before; from here on none is.
	 */
	beginWrites(): void;
}

/** The stop a request the process has no room for answers. */
export function noRoomFinding(): CircumstanceFinding {
	return circumstanceFinding("nova-busy", { kind: "app" }, {});
}

/**
 * Charge the running request for a reading of a source of `sourceBytes`:
 * what the reader and acceptance build from it
 * (`memoryMeter.ts::READING_HEAP_PER_SOURCE_BYTE`). False where the lease
 * refuses it: the caller then stops, reading nothing more, and the room
 * answers busy. True where the request runs under no room, as the proof
 * lane's reading does.
 */
export function holdReading(sourceBytes: number): boolean {
	return currentMemoryLease()?.charge("reading", sourceBytes) ?? true;
}

/** The source bytes, as one reading's, each lease's changes readings are charged for so far. */
const changesCharged = new WeakMap<MemoryLease, number>();

/**
 * Charge the running request for the readings of a changes review of a
 * baseline of `baselineBytes` and CommCare HQ's source of `nowBytes` (0 where
 * it is not read yet): one reading of the larger and
 * `memoryMeter.ts::SECOND_READING_HEAP_PER_SOURCE_BYTE` over the smaller, as
 * measured, since the two readings run one after the other. A request charges
 * them once, however often it reviews (a bring-in reviews again, then checks
 * once more): a later call charges only what a larger source adds, as its
 * peak, measured, is one review's. False where the lease refuses the charge,
 * as `holdReading`.
 */
export function holdChangesReadings(
	baselineBytes: number,
	nowBytes: number,
): boolean {
	const lease = currentMemoryLease();
	if (lease === undefined) return true;
	const larger = Math.max(baselineBytes, nowBytes);
	const smaller = Math.min(baselineBytes, nowBytes);
	const asOneReading =
		larger +
		Math.ceil(
			(smaller * SECOND_READING_HEAP_PER_SOURCE_BYTE) /
				READING_HEAP_PER_SOURCE_BYTE,
		);
	const charged = changesCharged.get(lease) ?? 0;
	if (asOneReading <= charged) return !lease.exhausted;
	if (!lease.charge("reading", asOneReading - charged)) return false;
	changesCharged.set(lease, asOneReading);
	return true;
}

/**
 * Run `run` under a lease of the process's meter, and end the lease when it
 * settles, however it settles. Where a charge of the lease was refused
 * before the request began to write, the answer is `busy`'s, whatever `run`
 * answered or threw: what it answered was made of reads the meter stopped.
 */
export async function withBringInRoom<T>(
	work: BringInWork,
	run: (room: BringInRoom) => Promise<T>,
	busy: () => T,
): Promise<T> {
	const meter = processMemoryMeter();
	const lease = meter.open();
	const room: BringInRoom = {
		signal: lease.signal,
		beginWrites() {
			if (!lease.beginWrites()) throw new MemoryMeterFullError();
		},
	};
	const noRoom = (thrown: unknown) => {
		log.warn("[reading] no room for a bring-in", {
			work,
			heldHeapBytes: lease.held().heap,
			heldExternalBytes: lease.held().external,
			processHeapBytes: meter.held().heap,
			processExternalBytes: meter.held().external,
			heapBoundBytes: meter.bounds.heap,
			externalBoundBytes: meter.bounds.external,
			openRequests: meter.openLeases(),
			...(thrown !== undefined &&
				!(thrown instanceof MemoryMeterFullError) && {
					thrown: thrown instanceof Error ? thrown.name : typeof thrown,
				}),
		});
		return busy();
	};
	try {
		let answer: T;
		try {
			answer = await runInLease(lease, () => run(room));
		} catch (error) {
			if (lease.exhausted && !lease.writing) return noRoom(error);
			throw error;
		}
		return lease.exhausted && !lease.writing ? noRoom(undefined) : answer;
	} finally {
		lease.end();
	}
}
