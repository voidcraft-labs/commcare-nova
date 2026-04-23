/**
 * Shared building blocks for SA tool modules.
 *
 * The SA chat factory and the MCP adapter both compose tools out of
 * these helpers. Centralizing them keeps the per-tool boilerplate
 * identical across surfaces and gives adapters one import surface for
 * the mutation scaffolding.
 */

import { produce } from "immer";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

/**
 * Apply a mutation batch to a `BlueprintDoc` via Immer `produce`.
 *
 * Pure — returns a new doc and leaves the input frozen. Matches the
 * mutation applier the client uses in `docStore.applyMany`, so a
 * server-computed `newDoc` and a client-derived one are byte-identical
 * given the same input + mutations.
 *
 * No-op on empty batches — returns the input doc by reference.
 */
export function applyToDoc(doc: BlueprintDoc, muts: Mutation[]): BlueprintDoc {
	if (muts.length === 0) return doc;
	return produce(doc, (draft) => {
		applyMutations(draft, muts);
	});
}

/**
 * Standard output shape for every mutating shared tool.
 *
 * - `mutations`: the computed batch. The tool has already persisted it
 *   via `ctx.recordMutations` before returning; the SA wrapper uses the
 *   presence of mutations to decide whether to advance its own working
 *   doc closure.
 * - `newDoc`: the post-mutation doc, precomputed once by the tool so
 *   callers avoid a redundant second Immer pass. MCP adapters ignore
 *   this (their doc lifecycle is per-call, not per-closure).
 * - `result`: the value the LLM sees as the tool's return. Per-tool
 *   typed via the `R` parameter.
 */
export interface MutatingToolResult<R> {
	mutations: Mutation[];
	newDoc: BlueprintDoc;
	result: R;
}
