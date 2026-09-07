import { expect } from "vitest";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";

/** Check a reachable fixture without repairing, stripping, or replacing it. */
export function assertAdmittedDoc(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext = LOOKUP_CONTEXT_UNAVAILABLE,
): void {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	// Do not seed identity-keyed production caches on a mutable fixture under construction.
	// Clone exact values; neither schema parsing nor this check repairs the document.
	expect(
		evaluateCommit({ nextDoc: structuredClone(doc), lookupContext }),
	).toEqual({ ok: true });
}
