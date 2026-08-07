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
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { StagedMutationBatch } from "../toolExecutionContext";
import type {
	MutationApplicationPolicy,
	ToolInvocationContext,
	WorkspaceMutationOutcome,
} from "../workspace/types";

export type { StagedMutationBatch };

/**
 * Apply a mutation batch to a `BlueprintDoc` via Immer `produce`.
 *
 * Pure — returns a new doc and leaves the input frozen. Matches the
 * mutation applier the client uses in `docStore.applyMany`, so a
 * server-computed candidate and a client-derived one are byte-identical
 * given the same input + mutations.
 *
 * No-op on empty batches — returns the input doc by reference.
 *
 * This is a LOCAL candidate computation helper (e.g. `editField`'s convert
 * pre-check) — it persists nothing. Every committing batch goes through
 * `guardedMutate` / `guardedMutateStages`, whose workspace runs the validity
 * gate before anything reaches the canonical boundary.
 */
export function applyToDoc(doc: BlueprintDoc, muts: unknown): BlueprintDoc {
	const admitted = admitMutationBatch(muts);
	if (admitted.length === 0) return doc;
	return produce(doc, (draft) => {
		applyMutations(draft, admitted);
	});
}

/**
 * Outcome of a {@link guardedMutate} call — the workspace's mutation
 * outcome. `ok: true` means the batch passed the validity gate AND was
 * persisted; `newDoc` is the committed doc the tool builds its result from.
 * `ok: false` means the gate rejected the batch — nothing was written — and
 * `error` is the person-to-person message (one line per candidate finding)
 * the tool returns in its `{ error }` envelope so the agent self-corrects in
 * its loop.
 */
export type GuardedMutateOutcome = WorkspaceMutationOutcome;

/**
 * The one write path for every mutating shared tool: the workspace gates the
 * batch through the validity verdict against this invocation's exact
 * snapshot, then persists through the canonical host.
 *
 * A pure admission adapter — the workspace owns optimistic diagnostics and
 * the authoritative boundary. Tools must route every batch through here (or
 * `ctx.applyBatch` directly) rather than persisting themselves; the
 * invocation context exposes no persistence methods to bypass the gate with.
 */
export async function guardedMutate(
	ctx: ToolInvocationContext,
	mutations: unknown,
	stage?: string,
	policy?: MutationApplicationPolicy,
): Promise<GuardedMutateOutcome> {
	return ctx.applyBatch({ mutations, stage, policy });
}

/**
 * The multi-stage twin of {@link guardedMutate}: gate the WHOLE staged
 * sequence as one candidate, then persist it as ONE save that keeps the
 * per-stage event-log tags. A rejection — wherever in the sequence the
 * finding would arise — commits NOTHING; there is no committed prefix to
 * report or re-issue around.
 */
export async function guardedMutateStages(
	ctx: ToolInvocationContext,
	stages: unknown,
): Promise<GuardedMutateOutcome> {
	return ctx.applyStages({ stages });
}

/**
 * Narrow the invocation's app id for a tool whose behavior genuinely needs
 * the app's STORED record (organization state, chat-run app services). On
 * every canonical surface the app id is present; only a genesis change set —
 * an app still being assembled privately, with no app row — reaches a tool
 * with `null`, and such a tool honestly refuses rather than pretending an
 * app exists.
 */
export function requireInvocationAppId(ctx: ToolInvocationContext): string {
	if (ctx.appId === null) {
		throw new Error(
			"This tool reads the app's stored record, which does not exist yet while the app is being assembled in a private change set. Stage the app's structure first; this tool becomes available once the app is created.",
		);
	}
	return ctx.appId;
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
 *   through the workspace before returning when it is nonempty.
 * - `result`: the value the LLM sees as the tool's return. Per-tool
 *   typed via the `R` parameter.
 *
 * There is no `newDoc` slot: the WORKSPACE owns the current document. A tool
 * that proved a fresher authoritative snapshot adopts it through
 * `ctx.adoptAuthoritativeSnapshot`, never by nominating a document in its
 * result.
 */
export interface MutatingToolResult<R> {
	kind: "mutate";
	mutations: readonly Mutation[];
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
 * MUST NOT be swallowed there: they are how the chat surface recovers.
 *
 * - `BlueprintCommitRejectedError` — a peer deleted/changed the target between
 *   the tool's read and the guarded commit. RE-THROWN so the workspace adopts
 *   one fresh authorized snapshot and the surface wrapper returns `{ error }`
 *   to the SA; the next tool builds on the current server state (not a stale
 *   snapshot). Swallowing it here strands the run on stale state.
 * - `AppProjectChangedError` — the app no longer belongs to the Project this run
 *   was admitted against. RE-THROWN so the route terminates the stale-scope
 *   run; reloading must not cross the tenant boundary.
 * - `CommitReauthError` — the actor lost edit access mid-run. RE-THROWN so it
 *   fails the run; a reload can't restore authorization, so continuing would
 *   just re-deny.
 * - `RunHolderLostError` — this run no longer owns the app-holder generation.
 *   RE-THROWN so neither a stale doc commit nor a read-shaped external side
 *   effect can be reported as successful after a successor took over.
 *
 * Every other throw (a genuine tool-body fault) becomes the standard
 * `{ error }` envelope — nothing committed. A pre-commit gate finding never
 * reaches here: `guardedMutate`/`guardedMutateStages` RETURN
 * `{ ok: false, error }` rather than throwing, so the tool returns its own
 * `{ error }` and nothing reloads.
 */
export function toToolErrorResult(
	err: unknown,
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
		result: { error: err instanceof Error ? err.message : String(err) },
	};
}
