import { setImmediate as nextTurn } from "node:timers/promises";
import { HeldExpansions } from "@/lib/commcare/reader/heldExpansions";
import { underMeter, WorkMeter } from "@/lib/commcare/workMeter";

/**
 * Times and meters each synchronous piece of a request, and lets the event
 * loop turn before each one, so no two pieces run in one turn. A review of
 * changes made in CommCare HQ times its own pieces with it.
 *
 * Every piece runs under the request's work meter (`workMeter.ts`), which a
 * reading's own meter charges as its parent, so `units` is the work of every
 * piece and `longestUnits` the most one piece did between two turns: the
 * deterministic twin of `longest`. The meter counts and never stops a piece by
 * itself; a run of steps given an allowance (`steps`, the change planner's)
 * runs under a meter of its own whose parent it is.
 * Where the request's `cancel` has aborted, the next piece does not run: it
 * throws `WorkCancelled`, as a charge inside a running piece does, so a
 * request whose caller went away stops working at its next step.
 */
export class Pieces {
	total = 0;
	longest = 0;
	/** What the longest piece was part of, as `at` named it. */
	longestAt = "";
	/** The most units one piece did, and what it was part of. */
	longestUnits = 0;
	longestUnitsAt = "";
	/** What the pieces now running are part of. */
	private part = "";
	/** The emissions this request's readings share (`heldExpansions.ts`). */
	readonly expansions = new HeldExpansions();
	/** The request's work meter. */
	readonly meter: WorkMeter;

	constructor(cancel?: AbortSignal) {
		this.meter = new WorkMeter({
			limit: Number.POSITIVE_INFINITY,
			...(cancel !== undefined && { signal: cancel }),
		});
	}

	/** Every unit the request's pieces did. */
	get units(): number {
		return this.meter.units;
	}

	/** Names what the pieces that follow are part of, for the facts that
	 *  name the longest. */
	at(part: string): this {
		this.part = part;
		return this;
	}

	async run<T>(piece: () => T, meter: WorkMeter = this.meter): Promise<T> {
		await nextTurn();
		meter.check();
		const started = performance.now();
		const before = this.meter.units;
		try {
			return underMeter(meter, piece);
		} finally {
			const took = performance.now() - started;
			this.total += took;
			if (took > this.longest) {
				this.longest = took;
				this.longestAt = this.part;
			}
			const units = this.meter.units - before;
			if (units > this.longestUnits) {
				this.longestUnits = units;
				this.longestUnitsAt = this.part;
			}
		}
	}

	/** Runs `steps` to their end, each step its own piece. Given `allowance`, the steps together
	 *  do at most that many units, and one that would pass it throws `WorkLimitReached` there:
	 *  for a step a request makes only within a limit of its own (the change planner's). */
	async steps<T>(
		steps: Generator<void, T, void>,
		allowance?: number,
	): Promise<T> {
		const meter =
			allowance === undefined
				? this.meter
				: new WorkMeter({ limit: allowance, parent: this.meter });
		for (;;) {
			const step = await this.run(() => steps.next(), meter);
			if (step.done) return step.value;
		}
	}
}
