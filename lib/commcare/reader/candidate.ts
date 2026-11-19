/**
 * One proposal of the reader, as a document of its own. The projections the
 * reader judges a proposal by memoize their plans by the document object
 * (`casePlacementPlan.ts`, `placement.ts`, `basicCaseSlots.ts`, each a
 * `WeakMap` keyed by the document), so every candidate is judged over a new
 * frozen object and the document it was made from is never changed. Each
 * candidate charges the work meter (`workMeter.ts`, kind `propose`) one unit
 * and one an object it walks or freezes.
 */
import { type Draft, Immer } from "immer";
import type { BlueprintDoc } from "@/lib/domain";
import { chargeWork } from "../workMeter";

/** Immer with its own freezing off: its default deep-freezes every subtree a
 *  result shares with the document it was made from. */
const immer = new Immer({ autoFreeze: false });

/** Every object reachable from `value` through objects not yet frozen. */
function unfrozenObjects(value: unknown, into: Set<object>): Set<object> {
	if (typeof value !== "object" || value === null || Object.isFrozen(value))
		return into;
	if (into.has(value)) return into;
	into.add(value);
	for (const child of Object.values(value)) unfrozenObjects(child, into);
	return into;
}

/** Freezes every object of `value` that `shared` does not hold; the number it froze. */
function freezeOwn(value: unknown, shared: ReadonlySet<object>): number {
	if (
		typeof value !== "object" ||
		value === null ||
		Object.isFrozen(value) ||
		shared.has(value)
	)
		return 0;
	Object.freeze(value);
	let frozen = 1;
	for (const child of Object.values(value)) frozen += freezeOwn(child, shared);
	return frozen;
}

/** `doc` with `patch` applied: a new document, every object of it that `doc`
 *  does not share frozen, `doc` itself untouched. */
export function withCandidate(
	doc: BlueprintDoc,
	patch: (draft: Draft<BlueprintDoc>) => void,
): BlueprintDoc {
	const next = immer.produce(doc, patch);
	// A patch that changes nothing gives `doc` back; a candidate is still its
	// own object, so a plan memoized for `doc` is never its answer.
	const candidate = next === doc ? { ...doc } : next;
	const shared = unfrozenObjects(doc, new Set());
	chargeWork("propose", 1 + shared.size + freezeOwn(candidate, shared));
	return candidate;
}
