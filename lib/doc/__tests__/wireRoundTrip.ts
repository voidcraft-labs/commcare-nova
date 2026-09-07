/** JSON serialization and mutation-admission helper for reducer tests.
 * Undefined object properties disappear in transit, so explicit wire clears
 * must survive serialization before the reducer sees them. This exercises
 * neither SSE framing nor the client reconciler or commit gate; callers own
 * fixture and final-document admission for reachable app claims. */

import { produce } from "immer";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";

/** Serialize, schema-admit each parsed command, then apply the real reducer.
 * A new document is returned and the input document remains unchanged. */
export function applyOverWire(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const parsed: unknown = JSON.parse(JSON.stringify(mutations));
	if (!Array.isArray(parsed)) throw new Error("Expected a mutation batch");
	const overWire = parsed.map((value) => mutationSchema.parse(value));
	return produce(doc, (draft) => {
		applyMutations(draft, overWire);
	});
}
