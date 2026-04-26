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
 * Tagged with `kind: "mutate"` so the MCP adapter's result projector
 * dispatches via a `switch` on the discriminator rather than
 * runtime structural inspection — the type system catches a future
 * fourth shape at compile time, and `MutatingToolResult` /
 * `ReadToolResult` / `ValidateAppResult` are unambiguous regardless of
 * incidental shape collisions in their inner payload.
 *
 * - `kind`: the discriminator — always `"mutate"`.
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
	kind: "mutate";
	mutations: Mutation[];
	newDoc: BlueprintDoc;
	result: R;
}

/**
 * Standard output shape for every read-only shared tool. Tagged with
 * `kind: "read"` so the MCP adapter dispatches via the same switch the
 * mutating + validate branches use; the inner `data` field carries the
 * per-tool typed payload. The chat-side wrapper unwraps `data` so the
 * AI SDK tool surface still sees just the bare result — the
 * discriminator is an internal contract between the tool body and the
 * two consumers (chat factory, MCP adapter).
 */
export interface ReadToolResult<R> {
	kind: "read";
	data: R;
}
