// lib/doc/fieldRemovalMutations.ts
//
// Removing a question removes what it saves. A field holds no destination of
// its own: its "Saves to" is the writes of the form's case operations that
// save its answer (`fieldCaseWriteViews`), and a write reading a removed
// field would dangle. So a removal first stops every write of every field
// of the removed subtree through the one "Saves to" planner
// (`planFieldCaseWrite(…, null)`), which also removes a case the form
// creates that is left with nothing to save, and only then removes the
// field, all in one batch.

import { produce } from "immer";
import { fieldCaseWriteViews, type Uuid } from "@/lib/domain";
import { planFieldCaseWrite } from "./fieldCaseWriteMutations";
import { descendantFieldUuids } from "./fieldWalk";
import { applyMutations } from "./mutations";
import type { BlueprintDoc, Mutation } from "./types";

export type FieldRemovalPlan =
	| { readonly ok: true; readonly mutations: readonly Mutation[] }
	| { readonly ok: false; readonly message: string };

/**
 * The batch that removes `fieldUuid` and everything inside it: each written
 * field's writes stopped, in subtree order, then the `removeField`. A write
 * the planner cannot stop (the name of the case a registration creates)
 * refuses the removal in the planner's own sentence.
 */
export function planFieldRemoval(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): FieldRemovalPlan {
	const mutations: Mutation[] = [];
	let candidate = doc;
	for (const uuid of [fieldUuid, ...descendantFieldUuids(doc, fieldUuid)]) {
		if (fieldCaseWriteViews(candidate, uuid).length === 0) continue;
		const plan = planFieldCaseWrite(candidate, uuid, null);
		if (!plan.ok) return { ok: false, message: plan.message };
		mutations.push(...plan.mutations);
		candidate = produce(candidate, (draft) => {
			applyMutations(draft, plan.mutations);
		});
	}
	mutations.push({ kind: "removeField", uuid: fieldUuid });
	return { ok: true, mutations };
}
