/**
 * `CanonicalMutationWorkspace` — the workspace both canonical surfaces (chat
 * SA, MCP) execute shared tools through.
 *
 * It owns the current document and the serialized invocation order the SA's
 * closure-`doc` + promise-chain mutex used to own, with the ordering made
 * EXPLICIT: `invoke` allocates the invocation ordinal synchronously (before
 * any await), enqueues strictly by that ordinal, and asserts bodies START in
 * allocation order — a refactor that broke the queue's FIFO would fail
 * loudly instead of silently corrupting the working document, and every body
 * observes the doc as left by the previous one. The ordinal captures
 * DISPATCH order; whether dispatch matches model-emit order remains the
 * SDK-boundary property it always was (an await inserted upstream of
 * `invoke` reorders dispatch itself — sibling-dependent calls then miss
 * their target visibly rather than corrupting state). Each invocation reads
 * one frozen snapshot and may perform at most one workspace mutation
 * operation, verified against the exact revision it read.
 *
 * The optimistic validity gate lives HERE (not in tool bodies): `applyBatch`
 * runs the whole-document verdict against the invocation's snapshot before
 * anything reaches the host, and the host's canonical commit re-applies the
 * admitted batch to fresh locked state — the same two-layer discipline
 * `guardedMutate` + `commitGuardedBatch` always had, with the same outcomes.
 *
 * Conflict recovery is a workspace concern: a `BlueprintCommitRejectedError`
 * escaping an invocation makes the workspace adopt one fresh AUTHORIZED
 * snapshot through the host (when the host provides one — chat does, MCP's
 * per-call lifecycle does not) before the error propagates to the surface
 * wrapper, so the next invocation builds on current server state, never the
 * stale document.
 */

import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
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
	type AdmittedMutationStages,
	admitMutationStages,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import type { CanonicalMutationHost } from "./canonicalHost";
import type {
	MutationApplicationPolicy,
	ToolInvocationContext,
	ToolWorkspace,
	WorkspaceMutationOutcome,
	WorkspaceRevision,
	WorkspaceSnapshot,
} from "./types";

/**
 * The Project definitions a candidate's verdict needs.
 *
 * The commit gate is absolute, not a delta: a lookup occurrence it cannot
 * check is a soundness finding, and a soundness finding rejects. So handing it
 * an unavailable context whenever the doc holds ANY lookup carrier would refuse
 * every mutating call on that app — not just the ones touching lookups. The
 * targets are unioned across the before and after docs so an addition, an edit,
 * and a clear all resolve against the same snapshot.
 */
async function lookupContextForCandidate(
	host: CanonicalMutationHost,
	prevDoc: BlueprintDoc,
	nextDoc: BlueprintDoc,
): Promise<LookupValidationContext> {
	const targets = unionLookupReferenceTargetSets(
		extractLookupReferenceTargets(prevDoc),
		extractLookupReferenceTargets(nextDoc),
	);
	if (targets.tableIds.length === 0) return LOOKUP_CONTEXT_UNAVAILABLE;
	if (host.lookupDefinitions === undefined) return LOOKUP_CONTEXT_UNAVAILABLE;
	const snapshot = await host.lookupDefinitions(targets.tableIds);
	return {
		kind: "available",
		projectId: snapshot.projectId,
		projectRevision: snapshot.projectRevision,
		definitions: snapshot.definitions,
	};
}

export interface CanonicalMutationWorkspaceOptions {
	readonly host: CanonicalMutationHost;
	/** The authorized starting document — the canonical genesis receipt on a
	 * build, the app's current state on an edit or an MCP call. */
	readonly initialDoc: BlueprintDoc;
	/** The canonical `mutation_seq` the initial document was loaded at, when
	 * the surface knows it (MCP's per-call load does). `null` = not observed. */
	readonly baseSeq?: number | null;
}

export class CanonicalMutationWorkspace implements ToolWorkspace {
	readonly mode = "canonical" as const;

	private readonly host: CanonicalMutationHost;
	private doc: BlueprintDoc;
	private revision: WorkspaceRevision = 0;
	private canonicalSeq: number | null;

	/** Next ordinal to hand out — allocated synchronously in `invoke`. */
	private nextOrdinal = 0;
	/** Ordinal of the invocation whose body most recently STARTED — the
	 * explicit ordering proof (see `invoke`). */
	private lastStartedOrdinal = -1;
	/** Serialization chain. Both `then` handlers swallow so a failing tool
	 * doesn't poison the chain; the caller's promise still rejects. */
	private chain: Promise<void> = Promise.resolve();

	constructor(options: CanonicalMutationWorkspaceOptions) {
		this.host = options.host;
		this.doc = options.initialDoc;
		this.canonicalSeq = options.baseSeq ?? null;
	}

	currentSnapshot(): WorkspaceSnapshot {
		return {
			doc: this.doc,
			revision: this.revision,
			canonicalSeq: this.canonicalSeq,
			projectId: this.host.projectId,
		};
	}

	invoke<T>(args: {
		readonly toolName: string;
		readonly requestId?: string;
		execute(ctx: ToolInvocationContext): Promise<T>;
	}): Promise<T> {
		/* Ordinal allocation is SYNCHRONOUS, before any await — the order tools
		 * were dispatched is captured at entry, so nothing a provider hook or a
		 * future SDK change awaits later can reorder what was already decided. */
		const invocationOrdinal = this.nextOrdinal++;
		const requestId = args.requestId ?? crypto.randomUUID();

		const run = async (): Promise<T> => {
			/* The chain drains in append order and appends happen in allocation
			 * order (both synchronous in this method), so this assertion cannot
			 * fire today. It exists so a refactor that breaks either property —
			 * an await between allocation and append, a non-FIFO queue — fails
			 * loudly here instead of silently corrupting the working document.
			 * It deliberately proves nothing about what happened UPSTREAM of
			 * `invoke`: dispatch-order-vs-model-emit-order is the caller's
			 * boundary. */
			if (invocationOrdinal !== this.lastStartedOrdinal + 1) {
				throw new Error(
					`[workspace] invocation ${invocationOrdinal} (${args.toolName}) started out of order after ${this.lastStartedOrdinal}.`,
				);
			}
			this.lastStartedOrdinal = invocationOrdinal;
			const ctx = this.buildInvocationContext({
				requestId,
				invocationOrdinal,
				toolName: args.toolName,
			});
			try {
				return await args.execute(ctx);
			} catch (err) {
				/* A RETRYABLE authoritative conflict — a peer deleted/changed what
				 * this tool targeted between our snapshot and the commit. Adopt one
				 * fresh AUTHORIZED snapshot (when the host provides the reload)
				 * before the error reaches the surface wrapper, so the next
				 * invocation builds on current server state. Terminal scope errors
				 * thrown BY the reload propagate in its place. */
				if (
					err instanceof BlueprintCommitRejectedError &&
					this.host.reloadAuthorizedSnapshot !== undefined
				) {
					const reloaded = await this.host.reloadAuthorizedSnapshot();
					this.adopt(reloaded.doc, reloaded.canonicalSeq);
				}
				throw err;
			}
		};

		const next = this.chain.then(run);
		this.chain = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	/** Adopt a new current document and advance the revision. `canonicalSeq`
	 *  is the sequence the adopted document is KNOWN to be at, or `null` when
	 *  the adopter cannot name one — never a stale sequence carried over from
	 *  an older document. */
	private adopt(doc: BlueprintDoc, canonicalSeq: number | null): void {
		this.doc = doc;
		this.canonicalSeq = canonicalSeq;
		this.revision += 1;
	}

	private buildInvocationContext(invocation: {
		requestId: string;
		invocationOrdinal: number;
		toolName: string;
	}): ToolInvocationContext {
		const snapshot = this.currentSnapshot();
		/* One workspace mutation operation per invocation. The counter lives on
		 * the invocation context, so a tool that stashes its context cannot
		 * carry the budget across calls (the stale-revision check catches the
		 * stashed context anyway). */
		let writesUsed = 0;
		const consumeWriteBudget = (operation: string): void => {
			if (writesUsed > 0) {
				throw new Error(
					`[workspace] ${invocation.toolName} attempted a second workspace mutation (${operation}); one invocation may perform at most one.`,
				);
			}
			writesUsed += 1;
			if (snapshot.revision !== this.revision) {
				throw new Error(
					`[workspace] ${invocation.toolName} presented a stale workspace revision (read ${snapshot.revision}, current ${this.revision}).`,
				);
			}
		};

		const host = this.host;
		return {
			appId: host.appId,
			projectId: host.projectId,
			userId: host.userId,
			runId: host.runId,
			...(host.chatRunHolder !== undefined && {
				chatRunHolder: host.chatRunHolder,
			}),
			snapshot,
			invocation,
			...(host.lookupDefinitions !== undefined && {
				lookupDefinitions: host.lookupDefinitions,
			}),
			...(host.lookupCatalog !== undefined && {
				lookupCatalog: host.lookupCatalog,
			}),
			conversionImpact: (impactArgs) => host.conversionImpact(impactArgs),

			applyBatch: async ({ mutations, stage, policy }) => {
				consumeWriteBudget("applyBatch");
				return this.applyBatchAgainst(snapshot.doc, mutations, stage, policy);
			},

			applyStages: async ({ stages }) => {
				consumeWriteBudget("applyStages");
				return this.applyStagesAgainst(snapshot.doc, stages);
			},

			adoptAuthoritativeSnapshot: ({ doc, canonicalSeq }) => {
				consumeWriteBudget("adoptAuthoritativeSnapshot");
				this.adopt(doc, canonicalSeq ?? null);
			},
		};
	}

	/**
	 * The one write path for every single-batch mutating tool: gate the batch
	 * through the validity verdict, then persist via the host.
	 *
	 * The gate (`lib/doc/commitVerdicts.ts::mutationCommitVerdict` over
	 * `evaluateCommit`) accepts a batch iff it introduces no validator
	 * finding of a gating class — shape, soundness, or completeness. A
	 * rejected batch persists NOTHING: the gate runs before the write, so an
	 * invalid intermediate state never reaches Postgres or the mutation
	 * stream, on the chat surface and MCP alike.
	 */
	private async applyBatchAgainst(
		prevDoc: BlueprintDoc,
		mutations: unknown,
		stage: string | undefined,
		policy: MutationApplicationPolicy | undefined,
	): Promise<WorkspaceMutationOutcome> {
		const verdict = mutationCommitVerdict(
			prevDoc,
			mutations,
			await lookupContextForCandidate(this.host, prevDoc, prevDoc),
		);
		if (!verdict.ok) {
			return { ok: false, error: describeCommitFindings(verdict.findings) };
		}
		if (verdict.mutations.length > 0) {
			/* The canonical commit re-applies onto the FRESH stored doc, so its
			 * `committedDoc` may carry a peer's concurrent edit merged in — the
			 * workspace continues against THAT, not the local candidate. A
			 * pre-commit finding already returned above (no reload); an
			 * authoritative commit conflict throws `BlueprintCommitRejectedError`,
			 * which is NOT caught here — it propagates to `invoke`'s conflict
			 * recovery. */
			const result = await this.host.recordMutations(
				verdict.prepared,
				stage,
				policy,
			);
			this.adopt(result.committedDoc, result.seq ?? null);
			return {
				ok: true,
				newDoc: result.committedDoc,
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
	 * The multi-stage twin of {@link applyBatchAgainst}: gate the WHOLE staged
	 * sequence as one candidate, then persist it as ONE save that keeps the
	 * per-stage event-log tags.
	 *
	 * The verdict runs over the concatenated batches against the snapshot doc,
	 * so a rejection — wherever in the sequence the finding would arise —
	 * commits NOTHING. The persistence side holds the same property: the whole
	 * sequence goes through the host as one save, so a surface whose write can
	 * itself reject (the MCP transactional commit re-verdicts against the
	 * FRESH stored doc) evaluates the concatenated batch once and commits
	 * all-or-nothing. There is no committed prefix to report or re-issue
	 * around, and no per-stage re-verdict that could be stricter than the
	 * whole-sequence gate — which is what lets every surface state "a rejected
	 * call saved nothing" without a multi-stage asterisk.
	 */
	private async applyStagesAgainst(
		prevDoc: BlueprintDoc,
		stages: unknown,
	): Promise<WorkspaceMutationOutcome> {
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
			await lookupContextForCandidate(this.host, prevDoc, prepared.nextDoc),
		);
		if (!verdict.ok) {
			return { ok: false, error: describeCommitFindings(verdict.findings) };
		}
		if (admitted.batch.length === 0) {
			return { ok: true, newDoc: prevDoc, mutations: admitted.batch };
		}
		const result = await this.host.recordMutationStages(prepared, admitted);
		this.adopt(result.committedDoc, result.seq ?? null);
		return { ok: true, newDoc: result.committedDoc, mutations: admitted.batch };
	}
}
