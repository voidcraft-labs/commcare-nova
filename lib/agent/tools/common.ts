/**
 * Shared building blocks for SA tool modules.
 *
 * The SA chat factory and the MCP adapter both compose tools out of
 * these helpers. Centralizing them keeps the per-tool boilerplate
 * identical across surfaces and gives adapters one import surface for
 * the mutation scaffolding.
 */

import { produce } from "immer";
import {
	describeIntroducedErrors,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	StagedMutationBatch,
	ToolExecutionContext,
} from "../toolExecutionContext";

export type { StagedMutationBatch };

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
 * Outcome of a {@link guardedMutate} call. `ok: true` means the batch
 * passed the validity gate AND was persisted; `newDoc` is the doc the
 * tool continues against. `ok: false` means the gate rejected the batch
 * — nothing was written — and `error` is the person-to-person message
 * (one line per introduced finding) the tool returns in its `{ error }`
 * envelope so the agent self-corrects in its loop.
 */
export type GuardedMutateOutcome =
	| { ok: true; newDoc: BlueprintDoc }
	| { ok: false; error: string };

/**
 * The one write path for every mutating shared tool: gate the batch
 * through the validity verdict, then persist via `ctx.recordMutations`.
 *
 * The gate (`lib/doc/commitVerdicts.ts::mutationCommitVerdict` over
 * `evaluateCommit`) accepts a batch iff it introduces no error of a
 * gating class for `ctx.commitPhase` — soundness always, completeness
 * once the app is complete. A rejected batch persists NOTHING: the gate
 * runs before the write, so an invalid intermediate state never reaches
 * Firestore or the mutation stream, on the chat surface and MCP alike.
 *
 * Tools must route every batch through here rather than calling
 * `applyToDoc` + `ctx.recordMutations` themselves — a direct write would
 * skip the gate. (`applyToDoc` stays exported for non-commit candidate
 * computation, e.g. `editField`'s convert pre-check.)
 */
export async function guardedMutate(
	ctx: ToolExecutionContext,
	prevDoc: BlueprintDoc,
	mutations: Mutation[],
	stage?: string,
): Promise<GuardedMutateOutcome> {
	const verdict = mutationCommitVerdict(prevDoc, mutations, ctx.commitPhase);
	if (!verdict.ok) {
		return { ok: false, error: describeIntroducedErrors(verdict.introduced) };
	}
	if (mutations.length > 0) {
		await ctx.recordMutations(mutations, verdict.nextDoc, stage);
	}
	return { ok: true, newDoc: verdict.nextDoc };
}

/**
 * The multi-stage twin of {@link guardedMutate}: gate the WHOLE staged
 * sequence as one candidate, then persist it as ONE save that keeps the
 * per-stage event-log tags.
 *
 * The verdict runs over the concatenated batches against `prevDoc`, so a
 * rejection — wherever in the sequence the finding would arise — commits
 * NOTHING. The persistence side holds the same property: the whole
 * sequence goes through `ctx.recordMutationStages` as one save, so a
 * surface whose write can itself reject (the MCP transactional commit
 * re-verdicts against the FRESH stored doc) evaluates the concatenated
 * batch once and commits all-or-nothing. There is no committed prefix to
 * report or re-issue around, and no per-stage re-verdict that could be
 * stricter than the whole-sequence gate — which is what lets every
 * surface state "a rejected call saved nothing" without a multi-stage
 * asterisk.
 */
export async function guardedMutateStages(
	ctx: ToolExecutionContext,
	prevDoc: BlueprintDoc,
	stages: StagedMutationBatch[],
): Promise<GuardedMutateOutcome> {
	const all = stages.flatMap((s) => s.mutations);
	const verdict = mutationCommitVerdict(prevDoc, all, ctx.commitPhase);
	if (!verdict.ok) {
		return { ok: false, error: describeIntroducedErrors(verdict.introduced) };
	}
	const nonEmpty = stages.filter((s) => s.mutations.length > 0);
	if (nonEmpty.length === 0) return { ok: true, newDoc: prevDoc };
	await ctx.recordMutationStages(nonEmpty);
	return { ok: true, newDoc: nonEmpty[nonEmpty.length - 1].doc };
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
