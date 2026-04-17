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
import type { BlueprintDoc, Mutation, MutationResult } from "@/lib/doc/types";
import { applyAppMutation } from "./app";
import { applyFieldMutation } from "./fields";
import { applyFormMutation } from "./forms";
import { assertNever } from "./helpers";
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
			applyAppMutation(draft, mut);
			return;
		case "addModule":
		case "removeModule":
		case "moveModule":
		case "renameModule":
		case "updateModule":
			applyModuleMutation(draft, mut);
			return;
		case "addForm":
		case "removeForm":
		case "moveForm":
		case "renameForm":
		case "updateForm":
			applyFormMutation(draft, mut);
			return;
		case "addField":
		case "removeField":
		case "moveField":
		case "renameField":
		case "duplicateField":
		case "updateField":
		case "convertField":
			return applyFieldMutation(draft, mut);
		default:
			assertNever(mut);
	}
}

/**
 * Apply a single mutation to an Immer draft and return any metadata the
 * reducer produces. `moveField` returns `MoveFieldResult`;
 * `renameField` returns `FieldRenameMeta`; all others return `undefined`.
 *
 * After the reducer runs, the `fieldParent` reverse index is rebuilt so
 * consumers observing the post-mutation draft see a consistent index.
 */
export function applyMutation(
	draft: Draft<BlueprintDoc>,
	mut: Mutation,
): MutationResult {
	const result = dispatchMutation(draft, mut);
	rebuildFieldParent(draft as unknown as BlueprintDoc);
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
 */
export function applyMutations(
	draft: Draft<BlueprintDoc>,
	muts: Mutation[],
): MutationResult[] {
	const results: MutationResult[] = [];
	for (const mut of muts) {
		results.push(dispatchMutation(draft, mut));
	}
	rebuildFieldParent(draft as unknown as BlueprintDoc);
	return results;
}
