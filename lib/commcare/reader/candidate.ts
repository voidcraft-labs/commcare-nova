/**
 * One proposal of the reader, as a document of its own. The projections the
 * reader judges a proposal by memoize their plans by the document object
 * (`casePlacementPlan.ts`, `placement.ts`, `basicCaseSlots.ts`, each a
 * `WeakMap` keyed by the document), so every candidate is judged over a new
 * frozen object and the document it was made from is never changed.
 */
import { type Draft, Immer } from "immer";
import type { BlueprintDoc } from "@/lib/domain";

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

/** Freezes every object of `value` that `shared` does not hold. */
function freezeOwn(value: unknown, shared: ReadonlySet<object>): void {
	if (
		typeof value !== "object" ||
		value === null ||
		Object.isFrozen(value) ||
		shared.has(value)
	)
		return;
	Object.freeze(value);
	for (const child of Object.values(value)) freezeOwn(child, shared);
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
	freezeOwn(candidate, unfrozenObjects(doc, new Set()));
	return candidate;
}
