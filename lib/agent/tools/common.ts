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
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import {
	describeCommitFindings,
	evaluatePreparedMutationCandidate,
	mutationCommitVerdict,
	mutationWireCanonicalityRejection,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import {
	extractLookupReferenceTargets,
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
	unionLookupReferenceTargetSets,
} from "@/lib/doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	type AdmittedMutationStages,
	admitMutationBatch,
	admitMutationStages,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
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
export function applyToDoc(doc: BlueprintDoc, muts: unknown): BlueprintDoc {
	const admitted = admitMutationBatch(muts);
	if (admitted.length === 0) return doc;
	return produce(doc, (draft) => {
		applyMutations(draft, admitted);
	});
}

/**
 * Outcome of a {@link guardedMutate} call. `ok: true` means the batch
 * passed the validity gate AND was persisted; `newDoc` is the doc the
 * tool continues against. `ok: false` means the gate rejected the batch
 * — nothing was written — and `error` is the person-to-person message
 * (one line per candidate finding) the tool returns in its `{ error }`
 * envelope so the agent self-corrects in its loop.
 */
export type GuardedMutateOutcome =
	| {
			ok: true;
			newDoc: BlueprintDoc;
			mutations: AdmittedMutationBatch;
	  }
	| { ok: false; error: string };

/**
 * The Project definitions this batch's verdict needs.
 *
 * The commit gate is absolute, not a delta: a lookup occurrence it cannot
 * check is a soundness finding, and a soundness finding rejects. So handing it
 * an unavailable context whenever the doc holds ANY lookup carrier would refuse
 * every mutating call on that app — not just the ones touching lookups. The
 * targets are unioned across the before and after docs so an addition, an edit,
 * and a clear all resolve against the same snapshot.
 */
async function lookupContextForCandidate(
	ctx: ToolExecutionContext,
	prevDoc: BlueprintDoc,
	nextDoc: BlueprintDoc,
): Promise<LookupValidationContext> {
	const targets = unionLookupReferenceTargetSets(
		extractLookupReferenceTargets(prevDoc),
		extractLookupReferenceTargets(nextDoc),
	);
	if (targets.tableIds.length === 0) return LOOKUP_CONTEXT_UNAVAILABLE;
	if (ctx.lookupDefinitions === undefined) return LOOKUP_CONTEXT_UNAVAILABLE;
	const snapshot = await ctx.lookupDefinitions(targets.tableIds);
	return {
		kind: "available",
		projectId: snapshot.projectId,
		projectRevision: snapshot.projectRevision,
		definitions: snapshot.definitions,
	};
}

/**
 * The one write path for every mutating shared tool: gate the batch
 * through the validity verdict, then persist via `ctx.recordMutations`.
 *
 * The gate (`lib/doc/commitVerdicts.ts::mutationCommitVerdict` over
 * `evaluateCommit`) accepts a batch iff it introduces no validator
 * finding of a gating class — shape, soundness, or completeness. A
 * rejected batch persists NOTHING: the gate runs before the write, so an
 * invalid intermediate state never reaches Postgres or the mutation
 * stream, on the chat surface and MCP alike.
 *
 * Tools must route every batch through here rather than calling
 * `applyToDoc` + `ctx.recordMutations` themselves — a direct write would
 * skip the gate. (`applyToDoc` stays exported for non-commit candidate
 * computation, e.g. `editField`'s convert pre-check.)
 */
export async function guardedMutate(
	ctx: ToolExecutionContext,
	prevDoc: BlueprintDoc,
	mutations: unknown,
	stage?: string,
): Promise<GuardedMutateOutcome> {
	const verdict = mutationCommitVerdict(
		prevDoc,
		mutations,
		await lookupContextForCandidate(ctx, prevDoc, prevDoc),
	);
	if (!verdict.ok) {
		return { ok: false, error: describeCommitFindings(verdict.findings) };
	}
	if (verdict.mutations.length > 0) {
		/* The guarded commit re-applies onto the FRESH stored doc, so its
		 * `committedDoc` may carry a peer's concurrent edit merged in — the SA
		 * continues against THAT, not the tool's pre-commit `nextDoc`. A
		 * pre-commit finding already returned above (no reload); an
		 * authoritative commit conflict throws `BlueprintCommitRejectedError`,
		 * which is NOT caught here — it propagates to `wrapMutating`, which
		 * reloads fresh. */
		const { committedDoc } = await ctx.recordMutations(verdict.prepared, stage);
		return {
			ok: true,
			newDoc: committedDoc,
			mutations: verdict.mutations,
		};
	}
	return {
		ok: true,
		newDoc: verdict.nextDoc,
		mutations: verdict.mutations,
	};
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
	stages: unknown,
): Promise<GuardedMutateOutcome> {
	let admitted: AdmittedMutationStages;
	try {
		admitted = admitMutationStages(stages);
	} catch (error) {
		if (!(error instanceof MutationWireCanonicalityError)) throw error;
		const rejected = mutationWireCanonicalityRejection(prevDoc, error);
		if (rejected.ok) throw new Error("Canonicality rejection was accepted");
		return {
			ok: false,
			error: describeCommitFindings(rejected.findings),
		};
	}
	const prepared = prepareMutationCandidate(prevDoc, admitted.batch);
	const verdict = evaluatePreparedMutationCandidate(
		prepared,
		await lookupContextForCandidate(ctx, prevDoc, prepared.nextDoc),
	);
	if (!verdict.ok) {
		return { ok: false, error: describeCommitFindings(verdict.findings) };
	}
	if (admitted.batch.length === 0) {
		return { ok: true, newDoc: prevDoc, mutations: admitted.batch };
	}
	// The SA continues against the writer's committed doc (a peer edit merged
	// in), not the tool's final-stage doc.
	const { committedDoc } = await ctx.recordMutationStages(prepared, admitted);
	return { ok: true, newDoc: committedDoc, mutations: admitted.batch };
}

/**
 * Standard output shape for every mutating shared tool.
 *
 * Tagged with `kind: "mutate"` so the MCP adapter's result projector
 * dispatches via a `switch` on the discriminator rather than
 * runtime structural inspection — the type system catches a future
 * third shape at compile time, and `MutatingToolResult` /
 * `ReadToolResult` are unambiguous regardless of incidental shape
 * collisions in their inner payload.
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
	mutations: readonly Mutation[];
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

/**
 * The one exit for a mutating tool body's outer `catch (err)`.
 *
 * A tool wraps its whole body — including the guarded commit — in a blanket
 * `catch` so an unexpected throw surfaces to the model as a friendly `{ error }`
 * rather than an unhandled rejection. But the four AUTHORITATIVE commit signals
 * MUST NOT be swallowed there: they are how the chat SA's `wrapMutating`
 * (`solutionsArchitect.ts`) recovers.
 *
 * - `BlueprintCommitRejectedError` — a peer deleted/changed the target between
 *   the tool's read and the guarded commit. RE-THROWN so `wrapMutating` catches
 *   it, returns `{ error }` to the SA, AND reloads fresh so the next tool builds
 *   on the current server state (not the stale closure doc). Swallowing it here
 *   strands the SA on a stale doc.
 * - `AppProjectChangedError` — the app no longer belongs to the Project this run
 *   was admitted against. RE-THROWN past `wrapMutating` so the route terminates
 *   the stale-scope run; reloading inside it must not cross the tenant boundary.
 * - `CommitReauthError` — the actor lost edit access mid-run. RE-THROWN so it
 *   propagates past `wrapMutating` (which does NOT catch it) and fails the run;
 *   a reload can't restore authorization, so continuing would just re-deny.
 * - `RunHolderLostError` — this run no longer owns the app-holder generation.
 *   RE-THROWN so neither a stale doc commit nor a read-shaped external side
 *   effect can be reported as successful after a successor took over.
 *
 * Every other throw (a genuine tool-body fault) becomes the standard
 * `{ error }` envelope — the same shape + behavior the inline `catch` used
 * before, with `newDoc` unchanged (nothing committed). A pre-commit gate
 * finding never reaches here: `guardedMutate`/`guardedMutateStages` RETURN
 * `{ ok: false, error }` rather than throwing, so the tool returns its own
 * `{ error }` and nothing reloads.
 */
export function toToolErrorResult(
	err: unknown,
	doc: BlueprintDoc,
): MutatingToolResult<{ error: string }> {
	if (
		err instanceof AppProjectChangedError ||
		err instanceof BlueprintCommitRejectedError ||
		err instanceof CommitReauthError ||
		err instanceof RunHolderLostError ||
		// A batch id is server-minted, so reusing one for different content is an
		// internal protocol failure rather than anything the model did. Returning
		// the ordinary `{ error }` envelope would hand it a message it reads as
		// retryable and invite it to remint the id and call again — turning one
		// broken write into a loop. Re-thrown so the run aborts instead.
		err instanceof MutationBatchIdCollisionError
	) {
		throw err;
	}
	return {
		kind: "mutate",
		mutations: [],
		newDoc: doc,
		result: { error: err instanceof Error ? err.message : String(err) },
	};
}
