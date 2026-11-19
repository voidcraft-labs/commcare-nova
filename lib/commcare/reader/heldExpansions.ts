/**
 * Nova's emissions of one reading's documents, held for the readings of the
 * same request.
 *
 * A bring-in reads CommCare HQ's app, then reads Nova's own emission of the
 * document it gave, and each reading emits its provisional document to
 * compare the entry facts and its settled document to settle the menus.
 * Where the source's forms are the ones Nova writes, the second reading
 * reaches the very documents the first emitted, under the very inputs, and
 * emitting them again is the same work for the same answer.
 *
 * `expandDoc` is a pure function of what the document holds and of what its
 * options hold, so an emission is held by both, compared in full: the
 * document's persisted part and its parent index, key by key in their order
 * (`samePlainData`), and the projection's own description of its inputs
 * (`ProjectionFacts`: each override of the wire identity, the project space,
 * the tables' naming definitions and each asset, which the inputs are built
 * from and nothing else). The document's reference index is derived state,
 * maintained by every reducer and held to a fresh build by its oracle, and is
 * not compared. Only a settled document's emission is held (frozen all the
 * way down, `lib/domain/settled.ts`), so what it was compared by cannot
 * change after; and the emission is frozen whole when it is held, so no
 * reader of it can change what a later reading is answered with. Held for
 * one request only, at most `HELD_EXPANSIONS` at a time, oldest first out. A
 * reading answered with a held emission counts toward its own work limit what
 * the emission charged (`WorkMeter.chargeDoneElsewhere`), so the work a
 * reading counts, and its limit's verdict, are the same whether or not another
 * reading of the request emitted first, while the request's meter counts only
 * the work done.
 */
import type { HqApplication } from "@/lib/commcare";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { recordFromEntries } from "@/lib/domain/records";
import { isDeeplySettled } from "@/lib/domain/settled";
import { currentWorkMeter, WORK_KINDS, type WorkKind } from "../workMeter";

/** At most this many emissions are held: two per reading. */
const HELD_EXPANSIONS = 4;

/** A plain description of everything `ExpandOptions` the reader builds holds. */
export type ProjectionFacts = unknown;

interface Held {
	readonly facts: ProjectionFacts;
	readonly persisted: unknown;
	readonly fieldParent: unknown;
	readonly expansion: HqApplication;
	/** The work meter's units the emission charged, by kind, which a reading answered with it
	 *  charges again, so a reading's work is a function of its input alone. */
	readonly charged: Readonly<Record<WorkKind, number>>;
}

/**
 * Whether two values are the same plain data: primitives by `Object.is`,
 * arrays item by item, and objects whose prototype is `Object.prototype` or
 * null by their own enumerable keys in the same order, a key whose value is
 * `undefined` included. Any other object is the same only as itself, so a
 * value this cannot read through is never taken for another.
 */
export function samePlainData(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	)
		return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false;
		for (let index = 0; index < a.length; index += 1)
			if (!samePlainData(a[index], b[index])) return false;
		return true;
	}
	const protoA = Object.getPrototypeOf(a);
	const protoB = Object.getPrototypeOf(b);
	if (
		(protoA !== Object.prototype && protoA !== null) ||
		(protoB !== Object.prototype && protoB !== null)
	)
		return false;
	if (
		Object.getOwnPropertySymbols(a).length > 0 ||
		Object.getOwnPropertySymbols(b).length > 0
	)
		return false;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (let index = 0; index < keysA.length; index += 1) {
		const key = keysA[index] as string;
		if (key !== keysB[index]) return false;
		if (
			!samePlainData(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
			)
		)
			return false;
	}
	return true;
}

/** Every object reachable from `value`, frozen. */
function deepFreeze(value: unknown): void {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const next = pending.pop();
		if (typeof next !== "object" || next === null || Object.isFrozen(next))
			continue;
		Object.freeze(next);
		for (const key of Reflect.ownKeys(next))
			pending.push((next as Record<PropertyKey, unknown>)[key]);
	}
}

/** The emissions held for the readings of one request. */
export class HeldExpansions {
	private readonly held: Held[] = [];

	/**
	 * `emit()`'s emission of `doc` under the options `facts` describes, or the
	 * one held for the same document and facts. `emit` is the emission a part
	 * at a time, so a reading that emits still stops between its parts.
	 * `facts` is frozen whole as it is held.
	 */
	*expansionSteps(
		doc: BlueprintDoc,
		facts: ProjectionFacts,
		emit: () => Generator<void, HqApplication, void>,
	): Generator<void, HqApplication, void> {
		const persisted = toPersistableDoc(doc);
		for (const one of this.held)
			if (
				samePlainData(one.facts, facts) &&
				samePlainData(one.fieldParent, doc.fieldParent) &&
				samePlainData(one.persisted, persisted)
			) {
				const meter = currentWorkMeter();
				for (const kind of WORK_KINDS)
					meter?.chargeDoneElsewhere(kind, one.charged[kind]);
				return one.expansion;
			}
		const before = currentWorkMeter()?.byKind;
		const expansion = yield* emit();
		if (!isDeeplySettled(doc)) return expansion;
		const after = currentWorkMeter()?.byKind;
		const charged = recordFromEntries(
			WORK_KINDS.map((kind) => [
				kind,
				before === undefined || after === undefined
					? 0
					: after[kind] - before[kind],
			]),
		) as Record<WorkKind, number>;
		deepFreeze(expansion);
		deepFreeze(facts);
		this.held.push({
			facts,
			persisted,
			fieldParent: doc.fieldParent,
			expansion,
			charged,
		});
		if (this.held.length > HELD_EXPANSIONS) this.held.shift();
		return expansion;
	}
}
