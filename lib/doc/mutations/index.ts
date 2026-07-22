/**
 * Mutation dispatcher. Every way the doc can change flows through here.
 *
 * Sub-files (`app.ts`, `modules.ts`, `forms.ts`, `fields.ts`) each
 * handle a related family of mutations. This top-level switch routes
 * on `kind` and delegates.
 *
 * `applyMutation` operates on an Immer draft — call sites wrap it in
 * `produce()` or let the Zustand store's Immer middleware handle the
 * drafting. Returns a `MutationResult`: `MoveFieldResult` for `moveField`,
 * `FieldRenameMeta` for `renameField`, and `undefined` for every other
 * kind.
 *
 * `applyMutations` is the batched variant — it runs the same dispatch
 * loop and returns a parallel `MutationResult[]` (one entry per input
 * mutation). This is what backs the store's sole public write entry point,
 * `applyMany`, used by the agent stream and for restoring a doc from a
 * mutation log.
 */

import type { Draft } from "immer";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import {
	applyReferenceIndexMaintenance,
	devAssertReferenceIndexParity,
	ensureReferenceIndex,
	planReferenceIndexMaintenance,
} from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, Mutation, MutationResult } from "@/lib/doc/types";
import { assertNever } from "@/lib/utils/assertNever";
import { applyAppMutation } from "./app";
import { applyFieldMutation } from "./fields";
import { applyFormMutation } from "./forms";
import { applyModuleMutation } from "./modules";

/**
 * Internal: dispatch a single mutation to the appropriate sub-reducer
 * WITHOUT rebuilding the `fieldParent` reverse index.
 *
 * Individual reducers never touch `fieldParent` themselves — the index is
 * rebuilt by the public entry points (`applyMutation` / `applyMutations`)
 * after the reducer(s) finish. That makes `applyMutations` O(N) in the
 * parent-index rebuild regardless of batch size, instead of O(N × M)
 * when every reducer triggered its own rebuild.
 */
function dispatchMutation(
	draft: Draft<BlueprintDoc>,
	mut: Mutation,
): MutationResult {
	switch (mut.kind) {
		case "setAppName":
		case "setConnectType":
		case "setCaseTypes":
		case "setAppLogo":
		case "declareCaseType":
		case "retireCaseType":
		case "addCaseProperty":
		case "setCaseProperty":
		case "removeCaseProperty":
		case "setCaseTypeMeta":
			applyAppMutation(draft, mut);
			return;
		case "addModule":
		case "removeModule":
		case "moveModule":
		case "renameModule":
		case "updateModule":
		case "setModuleMedia":
		case "addColumn":
		case "updateColumn":
		case "removeColumn":
		case "moveColumn":
		case "addSearchInput":
		case "updateSearchInput":
		case "removeSearchInput":
		case "moveSearchInput":
		case "setCaseListMeta":
			applyModuleMutation(draft, mut);
			return;
		case "addForm":
		case "removeForm":
		case "moveForm":
		case "renameForm":
		case "updateForm":
		case "setFormMedia":
			applyFormMutation(draft, mut);
			return;
		case "addField":
		case "removeField":
		case "moveField":
		case "renameField":
		case "duplicateField":
		case "updateField":
		case "convertField":
		case "setFieldMedia":
		case "addOption":
		case "updateOption":
		case "removeOption":
		case "moveOption":
			return applyFieldMutation(draft, mut);
		default:
			assertNever(mut, "applyMutation");
	}
}

/**
 * Internal: one mutation's full application — the reference-index
 * maintenance bracketing the reducer. The plan captures pre-state facts
 * only the doc-before-the-reducer can answer (removed subtrees, the
 * carriers a rename re-keys); the apply step re-derives those carriers
 * from post-reducer state. The index is therefore CURRENT after every
 * mutation, not just at batch end — reducers later in the same batch
 * (a rename following an add that referenced it) read fresh lookups,
 * which is what lets them be lookup-driven at all.
 */
function applyOne(draft: Draft<BlueprintDoc>, mut: Mutation): MutationResult {
	const doc = draft as unknown as BlueprintDoc;
	const plan = planReferenceIndexMaintenance(doc, mut);
	const result = dispatchMutation(draft, mut);
	applyReferenceIndexMaintenance(doc, plan);
	return result;
}

/**
 * Apply a single mutation to an Immer draft and return any metadata the
 * reducer produces. `moveField` returns `MoveFieldResult`;
 * `renameField` returns `FieldRenameMeta`; all others return `undefined`.
 *
 * The reference index is seeded (built from the full doc) on first
 * contact and maintained incrementally by the mutation's application;
 * after the reducer runs, the `fieldParent` reverse index is rebuilt so
 * consumers observing the post-mutation draft see consistent indexes.
 */
export function applyMutation(
	draft: Draft<BlueprintDoc>,
	mut: Mutation,
): MutationResult {
	ensureReferenceIndex(draft as unknown as BlueprintDoc);
	const result = applyOne(draft, mut);
	rebuildFieldParent(draft as unknown as BlueprintDoc);
	devAssertReferenceIndexParity(draft as unknown as BlueprintDoc);
	return result;
}

/**
 * Apply a batch of mutations to a single Immer draft.
 *
 * The `fieldParent` reverse index is rebuilt EXACTLY ONCE at the end of
 * the batch — not per mutation. This collapses an O(N × M) rebuild cost
 * (N = fields, M = mutations) into a single O(N) pass, critical when
 * agent streams land hundreds of mutations in one batch. Mid-batch reads
 * of `fieldParent` would see stale data, but no reducer reads it —
 * structural lookups use `fieldOrder` directly.
 *
 * The reference index is the opposite: maintained PER MUTATION (see
 * `applyOne`), because reducers inside the batch read it — its
 * increments are scoped to what each mutation touched, so the batch
 * cost stays proportional to the batch's own changes.
 */
export function applyMutations(
	draft: Draft<BlueprintDoc>,
	muts: readonly Mutation[],
): MutationResult[] {
	ensureReferenceIndex(draft as unknown as BlueprintDoc);
	const results: MutationResult[] = [];
	for (const mut of muts) {
		results.push(applyOne(draft, mut));
	}
	rebuildFieldParent(draft as unknown as BlueprintDoc);
	devAssertReferenceIndexParity(draft as unknown as BlueprintDoc);
	return results;
}
