/**
 * Snapshot-bound certificates for exact mutation verdicts completed outside
 * the interaction thread.
 *
 * A certificate is useful only while BOTH identity-bearing snapshots are the
 * same objects: the live BlueprintDoc and the Project lookup-definition
 * context. Any local/remote edit replaces the doc snapshot; any lookup refresh
 * replaces the context. The canonical mutation JSON is the final key, so a
 * broader patch or a different value cannot reuse a narrower proof.
 */

import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

const prevalidatedByDoc = new WeakMap<
	BlueprintDoc,
	WeakMap<LookupValidationContext, Set<string>>
>();

function proofKey(mutations: readonly Mutation[]): string {
	/* Admission reparses the same JSON-shaped mutation through Zod. Its object
	 * insertion order is schema order, which need not match the UI literal's
	 * insertion order. Canonical text preserves exact values while making those
	 * semantically identical representations share one certificate. */
	return canonicalJsonText(mutations);
}

/** Record one successful complete-candidate verdict. */
export function registerMutationPrevalidation(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext,
	mutations: readonly Mutation[],
): void {
	let byContext = prevalidatedByDoc.get(doc);
	if (byContext === undefined) {
		byContext = new WeakMap();
		prevalidatedByDoc.set(doc, byContext);
	}
	let proofs = byContext.get(lookupContext);
	if (proofs === undefined) {
		proofs = new Set();
		byContext.set(lookupContext, proofs);
	}
	proofs.add(proofKey(mutations));
}

/** Match the exact document, lookup snapshot, and mutation batch. */
export function hasMutationPrevalidation(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext,
	mutations: readonly Mutation[],
): boolean {
	return (
		prevalidatedByDoc.get(doc)?.get(lookupContext)?.has(proofKey(mutations)) ??
		false
	);
}
