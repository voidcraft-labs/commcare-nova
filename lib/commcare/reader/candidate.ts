/**
 * One proposal of the reader, as a document of its own. The projections the
 * reader judges a proposal by memoize their plans by the document object
 * (`casePlacementPlan.ts`, `placement.ts`, `basicCaseSlots.ts`, each a
 * `WeakMap` keyed by the document), so every candidate is judged over a new
 * frozen object and the document it was made from is never changed.
 */
import { type Draft, freeze, produce } from "immer";
import type { BlueprintDoc } from "@/lib/domain";

/** `doc` with `patch` applied: a new frozen document, `doc` itself untouched. */
export function withCandidate(
	doc: BlueprintDoc,
	patch: (draft: Draft<BlueprintDoc>) => void,
): BlueprintDoc {
	const next = produce(doc, patch);
	// A patch that changes nothing gives `doc` back; a candidate is still its
	// own object, so a plan memoized for `doc` is never its answer.
	return freeze(next === doc ? { ...doc } : next, true);
}
