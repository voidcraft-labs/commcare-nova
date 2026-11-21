/**
 * The work meter: a count of the work a reading of a CommCare HQ app does, in
 * units that grow with what each door of the reader's method handles, and the
 * limit that stops a reading past it. Same input, same count and same
 * verdict: nothing here reads a clock.
 *
 * The reader's method has few doors, and each charges by the size of what it
 * handles: a grammar read charges its text's characters (`parse`,
 * `reader/syntaxRead.ts`), a candidate document the objects it makes and
 * freezes (`propose`, `reader/candidate.ts::withCandidate`), a print the text
 * the XPath and XML serializers write (`print`, `xpath/wire/serialize.ts`,
 * `serializeXml.ts`) and the documents an emission plan reads, a comparison
 * the nodes it compares (`compare`, `reader/jsonCursor.ts::sameJson`,
 * `reader/syntaxCompare.ts`), and a walk the reader makes of a collection the
 * source holds the members it examines (`visit`). A door outside a metered run
 * charges nothing, so an export, a publish or a test that calls a stage's
 * helper on its own counts nowhere.
 *
 * A metered run is synchronous: `underMeter` sets the meter for one piece and
 * restores the one before it, so no count outlives the piece that made it and
 * two requests on one process never charge each other. A meter may charge a
 * parent too (a reading inside a request's pieces), so the request counts the
 * work of every piece it runs.
 *
 * A charge past the meter's limit, or one made once the request's signal has
 * aborted, throws, and so does every later charge of that meter: a stop no
 * code can swallow by catching it once. Every `catch` of the reader rethrows
 * it first (`rethrowWorkStop`).
 */

/** What one unit of work was spent on. */
export const WORK_KINDS = [
	"parse",
	"propose",
	"print",
	"compare",
	"visit",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** The stop a charge past a meter's limit makes. `meter` is the meter whose limit it passed. */
export class WorkLimitReached extends Error {
	override readonly name = "WorkLimitReached";
	constructor(readonly meter: WorkMeter) {
		super(
			"This work passed the limit Nova gives it, so it stopped. The limit is a count of the work, not a clock, so the same input stops at the same place.",
		);
	}
}

/** The stop a charge makes once the request the work is for has gone or was stopped. */
export class WorkCancelled extends Error {
	override readonly name = "WorkCancelled";
	constructor() {
		super(
			"The request this work was for was cancelled, so the work stopped at its next step.",
		);
	}
}

export type WorkStop = WorkLimitReached | WorkCancelled;

export function isWorkStop(error: unknown): error is WorkStop {
	return error instanceof WorkLimitReached || error instanceof WorkCancelled;
}

/** Rethrows `error` where it is a work stop. The first statement of every `catch` in the reader,
 *  so no `catch` that guards an emitter or a parse for an app's content swallows a stop. */
export function rethrowWorkStop(error: unknown): void {
	if (isWorkStop(error)) throw error;
}

export interface WorkMeterOptions {
	/** The units past which a charge stops the work. `Infinity` counts and never stops. */
	readonly limit: number;
	/** The request's signal: once it aborts, the next charge stops the work. */
	readonly signal?: AbortSignal;
	/** The meter this one also charges: the request's, for a reading inside it. */
	readonly parent?: WorkMeter;
}

/** One count of work, its units by kind and its limit. */
export class WorkMeter {
	#units = 0;
	readonly #byKind: Record<WorkKind, number> = {
		parse: 0,
		propose: 0,
		print: 0,
		compare: 0,
		visit: 0,
	};
	readonly #limit: number;
	#syntaxReads = 0;
	#stop: WorkStop | undefined;
	readonly #signal: AbortSignal | undefined;
	readonly #parent: WorkMeter | undefined;

	constructor(options: WorkMeterOptions) {
		this.#limit = options.limit;
		this.#signal = options.signal;
		this.#parent = options.parent;
	}

	get units(): number {
		return this.#units;
	}

	get byKind(): Readonly<Record<WorkKind, number>> {
		return { ...this.#byKind };
	}

	get limit(): number {
		return this.#limit;
	}

	/** Texts read with the XPath grammar. */
	get syntaxReads(): number {
		return this.#syntaxReads;
	}

	/** The stop this meter made, or undefined while it runs. */
	get stopped(): WorkStop | undefined {
		return this.#stop;
	}

	/** Adds `units` of `kind`; throws where that passes the limit, where the signal has aborted,
	 *  or where this meter or its parent stopped before. */
	charge(kind: WorkKind, units: number): void {
		this.#count(kind, units);
		this.#parent?.charge(kind, units);
	}

	/** Adds `units` of `kind` that this run would have done and another run of the request did
	 *  for it (a held emission): counted toward this meter's limit, so its verdict is the same
	 *  either way, and never toward the parent's, which counts the work done. */
	chargeDoneElsewhere(kind: WorkKind, units: number): void {
		this.#count(kind, units);
	}

	#count(kind: WorkKind, units: number): void {
		if (this.#stop !== undefined) throw this.#stop;
		this.#units += units;
		this.#byKind[kind] += units;
		if (this.#signal?.aborted === true) this.#stop = new WorkCancelled();
		else if (this.#units > this.#limit) this.#stop = new WorkLimitReached(this);
		if (this.#stop !== undefined) throw this.#stop;
	}

	/** A text of `characters` read with the XPath grammar: one unit for the read and one a
	 *  character. */
	syntaxRead(characters: number): void {
		this.#syntaxReads += 1;
		this.charge("parse", characters + 1);
	}

	/** Throws where the meter stopped or its signal has aborted: for the step between two pieces,
	 *  where no charge is made. */
	check(): void {
		if (this.#stop === undefined && this.#signal?.aborted === true)
			this.#stop = new WorkCancelled();
		if (this.#stop !== undefined) throw this.#stop;
		this.#parent?.check();
	}
}

/** The meter of the piece running now, or undefined outside a metered run. */
let current: WorkMeter | undefined;

/** The meter of the piece running now, for a meter made inside it to charge as its parent. */
export function currentWorkMeter(): WorkMeter | undefined {
	return current;
}

/** Whether a metered run is in progress: a door whose measure costs something asks first. */
export function metering(): boolean {
	return current !== undefined;
}

/** Charges `units` of `kind` to the meter of the piece running now; nothing outside one. */
export function chargeWork(kind: WorkKind, units: number): void {
	current?.charge(kind, units);
}

/** Counts one grammar read of a text of `characters` against the piece running now. */
export function chargeSyntaxRead(characters: number): void {
	current?.syntaxRead(characters);
}

/** `run`'s answer, every charge it makes counted by `meter`. */
export function underMeter<T>(meter: WorkMeter, run: () => T): T {
	const outer = current;
	current = meter;
	try {
		return run();
	} finally {
		current = outer;
	}
}
