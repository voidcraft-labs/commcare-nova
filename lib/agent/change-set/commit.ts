/**
 * `commitDesignChangeSet` — the all-or-nothing canonical transition of one
 * open app-edit change set.
 *
 * The authoritative operation is `applyBlueprintChange` over the
 * concatenated admitted steps with the deterministic change-set batch id
 * and the typed transaction sidecars: rename/retire Phase A, ordinary
 * case-type sweeps, dedup, fresh authorization, holder proof, lookup/media/
 * organization integrity, and post-commit index convergence keep their
 * exact current semantics, and the `open → committed` flip plus the
 * committed-slice receipt ride the same transaction
 * (`lib/db/canonicalCommitSidecars.ts`). No success path performs a second
 * transaction to mark the change set committed.
 *
 * A rejected commit RETAINS every step for amendment and classifies the
 * conflict as a structured rebase report — never a name/position retarget.
 * A retry of a committed set returns the stored receipt: the sidecar wrote
 * it atomically, so a canonical batch without it is corruption, never a new
 * commit.
 *
 * Genesis change sets do not commit here: materialization is the prepared
 * genesis kernel's separate unit, and this module refuses them loudly.
 */

import { sql } from "kysely";
import type { DesignId } from "@/lib/agent/design/ids";
import {
	applyBlueprintChange,
	type MigrationOutcome,
} from "@/lib/db/applyBlueprintChange";
import type { ChatRunHolderCapability } from "@/lib/db/apps";
import { loadApp } from "@/lib/db/apps";
import { CanonicalCommitSidecarError } from "@/lib/db/canonicalCommitSidecars";
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	MutationBatchIdCollisionError,
} from "@/lib/db/commitGuard";
import {
	parsePersistedJsonText,
	parsePersistedMutationBatchText,
} from "@/lib/db/persistedJson";
import { getAppDb } from "@/lib/db/pg";
import type { ClientAppChangeKind } from "@/lib/db/types";
import {
	evaluatePreparedMutationCandidate,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	encodeAdmittedMutationEnvelope,
} from "@/lib/doc/mutationAdmission";
import { parseOrganizationRevision } from "@/lib/organization/schema";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { canonicalJsonDigest } from "./digest";
import {
	ChangeSetIntegrityError,
	ChangeSetScopeLostError,
	ChangeSetWorkspaceRevisionStaleError,
} from "./errors";
import {
	type ProvenIntentCoverage,
	proveIntentCoverage,
} from "./intentCoverage";
import { type ExternalReadDependency, intentIdsSchema } from "./schemas";
import { loadChangeSet, loadChangeSetSteps } from "./store";
import {
	type ChangeSetStep,
	type CommittedSliceReceipt,
	type DesignChangeSet,
	designChangeSetBatchId,
	type SliceDesignChangeSet,
} from "./types";

// ── Rebase reports ─────────────────────────────────────────────────

export type RebaseConflictCode =
	| "TARGET_REMOVED"
	| "TARGET_KIND_CHANGED"
	| "ANCHOR_REMOVED"
	| "IDENTITY_COLLISION"
	| "EXTERNAL_READ_SET_CHANGED"
	| "EXCLUSIVE_BASE_CHANGED"
	| "PROJECT_CHANGED"
	| "DESIGN_SUPERSEDED";

export interface ChangeSetRebaseConflict {
	readonly code: RebaseConflictCode;
	readonly stepOrdinal?: number;
	readonly mutationIndex?: number;
	readonly message: string;
}

export interface ChangeSetRebaseReport {
	readonly kind: "rebase-conflict";
	readonly baseSeq: number;
	readonly currentSeq: number;
	readonly conflicts: readonly ChangeSetRebaseConflict[];
}

export type CommitDesignChangeSetOutcome =
	| {
			readonly kind: "committed";
			readonly receipt: CommittedSliceReceipt;
			readonly migration?: MigrationOutcome;
			/** True when a prior attempt had already committed this exact
			 * revision (dedup replay — nothing written). */
			readonly replayed: boolean;
	  }
	| { readonly kind: "rebase-conflict"; readonly report: ChangeSetRebaseReport }
	| {
			/** The fresh whole-document gate rejected the candidate. Steps are
			 * retained; append corrections and retry. */
			readonly kind: "gate-rejected";
			readonly message: string;
			readonly currentSeq: number;
	  };

export interface CommitDesignChangeSetArgs {
	readonly changeSetId: string;
	readonly actorUserId: string;
	readonly runId: string;
	readonly chatRunHolder?: ChatRunHolderCapability;
	readonly kind: ClientAppChangeKind;
	readonly expectedRevision: number;
	readonly owningIntentIds: readonly DesignId[];
	/** Absolute executor wall-clock deadline; direct callers omit it. */
	readonly deadlineAt?: number;
}

/**
 * Commit one open app-edit change set as ONE canonical revision, or return
 * a structured conflict with every step retained.
 */
export async function commitDesignChangeSet(
	args: CommitDesignChangeSetArgs,
): Promise<CommitDesignChangeSetOutcome> {
	if (deadlineExpired(args.deadlineAt)) return deadlineRejection(0);
	const changeSet = await loadChangeSet(args.changeSetId);
	if (changeSet === undefined) {
		throw new ChangeSetScopeLostError("This change set no longer exists.");
	}
	if (changeSet.kind !== "app-edit" || changeSet.appId === null) {
		throw new ChangeSetScopeLostError(
			"A genesis change set materializes through the prepared genesis kernel, not the app-edit commit.",
		);
	}
	if (changeSet.purpose !== "slice") {
		throw new ChangeSetScopeLostError(
			"A reviewed design candidate publishes only through the genesis kernel.",
		);
	}
	if (changeSet.status === "committed") {
		return {
			kind: "committed",
			receipt: await requireStoredReceipt(changeSet),
			replayed: true,
		};
	}
	if (changeSet.status !== "open") {
		throw new ChangeSetScopeLostError(
			`This change set is ${changeSet.status} and can no longer commit.`,
		);
	}
	if (
		changeSet.ownerUserId !== args.actorUserId ||
		changeSet.ownerRunId !== args.runId
	) {
		throw new ChangeSetScopeLostError(
			"This change set belongs to a different run.",
		);
	}
	if (changeSet.revision !== args.expectedRevision) {
		throw new ChangeSetWorkspaceRevisionStaleError(
			args.expectedRevision,
			changeSet.revision,
		);
	}
	const steps = await loadChangeSetSteps(args.changeSetId);
	if (deadlineExpired(args.deadlineAt)) {
		return deadlineRejection(changeSet.baseSeq ?? 0);
	}
	if (steps.length !== changeSet.nextOrdinal) {
		throw new ChangeSetIntegrityError(
			`Change set ${args.changeSetId} records ${changeSet.nextOrdinal} step(s) but ${steps.length} are stored.`,
		);
	}
	if (steps.length === 0) {
		return {
			kind: "gate-rejected",
			message:
				"This change set has no staged steps, so there is nothing to commit.",
			currentSeq: changeSet.baseSeq ?? 0,
		};
	}
	let intentCoverage: ProvenIntentCoverage;
	try {
		intentCoverage = proveIntentCoverage({
			changeSet,
			steps,
			expectedOwningIntentIds: args.owningIntentIds,
			appId: changeSet.appId,
		});
	} catch (error) {
		return {
			kind: "gate-rejected",
			message: error instanceof Error ? error.message : String(error),
			currentSeq: changeSet.baseSeq ?? 0,
		};
	}

	/* One concatenated admitted batch, in exact ordinal order, re-admitted
	 * from its exact JSON bytes (already-admitted values carry the internal
	 * protector marks the raw admission rejects, so the round trip goes
	 * through the envelope encoder — byte-faithful by construction). The
	 * re-admission re-proves the whole-batch laws; the exclusive
	 * rename-alone rule holds because the exclusive fence kept such a batch
	 * the only step. */
	const batch = parsePersistedMutationBatchText(
		encodeAdmittedMutationEnvelope(steps.flatMap((step) => [...step.mutations]))
			.json,
		`change set ${changeSet.id} concatenated batch`,
	);
	const mutationDigest = canonicalJsonDigest(batch);
	const batchId = designChangeSetBatchId({
		changeSetId: changeSet.id,
		revision: changeSet.revision,
		mutationDigest,
	});

	/* The organization fence: the LATEST captured revision across steps —
	 * later steps observed newer state; the kernel requires exact equality
	 * with the current clock at commit. */
	const organizationRevision = latestOrganizationRevision(
		steps.flatMap((step) => step.readSet),
	);

	/* Preflight classification against a fresh (unlocked) snapshot: the
	 * structured report the executor amends from. The kernel's own locked
	 * replay remains the authority — a race between this read and the
	 * transaction reclassifies below. A conflict is reported only when the
	 * change set is STILL open: a concurrent duplicate commit makes the
	 * replay collide with its own already-committed work, and the honest
	 * answer there is the stored receipt, not an amendment demand. */
	const preflight = await classifyAgainstFreshState({
		changeSet,
		steps,
		organizationRevision,
	});
	if (deadlineExpired(args.deadlineAt)) {
		return deadlineRejection(changeSet.baseSeq ?? 0);
	}
	if (preflight !== undefined) {
		const committed = await committedReplayIfWon(changeSet);
		return committed ?? preflight;
	}

	const receiptId = crypto.randomUUID();
	try {
		const result = await applyBlueprintChange({
			appId: changeSet.appId,
			userId: args.actorUserId,
			expectedProjectId: changeSet.baseProjectId,
			...(organizationRevision !== undefined && {
				expectedOrganizationRevision: organizationRevision,
			}),
			runId: args.runId,
			...(args.chatRunHolder !== undefined && {
				chatRunHolder: args.chatRunHolder,
			}),
			batchId,
			kind: args.kind,
			...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			guard: { mutations: batch },
			sidecars: [
				{
					kind: "commit-design-change-set",
					changeSetId: changeSet.id,
					expectedRevision: changeSet.revision,
					receiptId,
					sliceAttemptId: changeSet.attemptId,
					designSessionId: changeSet.designSessionId,
					designRevisionId: changeSet.designRevisionId,
					designRevisionDigest: changeSet.designRevisionDigest,
					buildPlanId: changeSet.buildPlanId,
					buildPlanDigest: changeSet.buildPlanDigest,
					sliceId: changeSet.sliceId,
					owningIntentIds: [...intentCoverage.owningIntentIds],
					mutationCount: batch.length,
				},
				{
					kind: "write-intent-provenance" as const,
					rows: intentCoverage.provenance,
				},
			],
		});
		const receipt = await requireStoredReceipt(changeSet);
		/* A dedup replay pairs the ORIGINAL sequence with the CURRENT doc, so
		 * the stored receipt is the only honest snapshot identity either way
		 * (never derive the slice digest from result.committedDoc). Our
		 * sidecar minted `receiptId`; a stored receipt under a different id
		 * proves a concurrent attempt won and the kernel deduped this one. */
		return {
			kind: "committed",
			receipt,
			...(result.migration !== undefined && { migration: result.migration }),
			replayed: receipt.id !== receiptId,
		};
	} catch (error) {
		if (error instanceof CanonicalCommitSidecarError) {
			/* The sidecar's own locked verification failed AFTER the kernel's
			 * write — the whole transaction rolled back. Map it back into the
			 * package's closed taxonomy: a concurrent duplicate that won is a
			 * committed replay; an advanced revision is the ordinary stale
			 * signal (rehydrate, re-derive, retry); anything else is
			 * corruption. */
			const fresh = await loadChangeSet(args.changeSetId);
			if (fresh === undefined) {
				throw new ChangeSetScopeLostError("This change set no longer exists.");
			}
			if (fresh.status === "committed") {
				if (fresh.purpose !== "slice") {
					throw new ChangeSetIntegrityError(
						"An app-edit commit resolved to a reviewed genesis candidate.",
					);
				}
				return {
					kind: "committed",
					receipt: await requireStoredReceipt(fresh),
					replayed: true,
				};
			}
			if (fresh.revision !== args.expectedRevision) {
				throw new ChangeSetWorkspaceRevisionStaleError(
					args.expectedRevision,
					fresh.revision,
				);
			}
			throw new ChangeSetIntegrityError(error.message);
		}
		if (error instanceof AppProjectChangedError) {
			throw new ChangeSetScopeLostError(
				"This app moved to a different Project while the change set was committing; the change set cannot commit across tenant scope.",
			);
		}
		if (error instanceof MutationBatchIdCollisionError) {
			/* The deterministic batch id embeds the revision and mutation
			 * digest, so a collision means the stored canonical batch differs
			 * from what this exact revision replays to — corruption, never an
			 * ordinary retry. */
			throw new ChangeSetIntegrityError(
				`Change set ${args.changeSetId} derived batch id ${batchId}, which the app already holds with different content.`,
			);
		}
		if (!(error instanceof BlueprintCommitRejectedError)) throw error;
		/* The kernel rejected a batch the preflight passed — a narrow race.
		 * Reclassify on fresh state for the structured report; the gate
		 * message is the fallback when the fresh state has since healed. */
		const committed = await committedReplayIfWon(changeSet);
		if (committed !== undefined) return committed;
		const reclassified = await classifyAgainstFreshState({
			changeSet,
			steps,
			organizationRevision,
		});
		if (reclassified !== undefined) return reclassified;
		return {
			kind: "gate-rejected",
			message: error.message,
			currentSeq: await currentAppSeq(changeSet.appId),
		};
	}
}

function deadlineExpired(deadlineAt: number | undefined): boolean {
	return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

function deadlineRejection(currentSeq: number): CommitDesignChangeSetOutcome {
	return {
		kind: "gate-rejected",
		message: "The slice execution deadline expired before commit.",
		currentSeq,
	};
}

/** The concurrent-duplicate check: when the change set has meanwhile
 *  committed (another attempt of this run won), the stored receipt is the
 *  outcome — never a conflict report against its own committed work. */
async function committedReplayIfWon(
	changeSet: SliceDesignChangeSet,
): Promise<
	Extract<CommitDesignChangeSetOutcome, { kind: "committed" }> | undefined
> {
	const fresh = await loadChangeSet(changeSet.id);
	if (fresh === undefined || fresh.status !== "committed") return undefined;
	if (fresh.purpose !== "slice") {
		throw new ChangeSetIntegrityError(
			"A slice change set replay resolved to a reviewed genesis candidate.",
		);
	}
	return {
		kind: "committed",
		receipt: await requireStoredReceipt(fresh),
		replayed: true,
	};
}

// ── Post-commit envelope derivation (Unit E wiring point) ──────────

export interface CommittedStageEnvelope {
	readonly stepOrdinal: number;
	readonly toolName: string;
	readonly stageName: string | null;
	readonly mutations: AdmittedMutationBatch;
}

/**
 * Derive the per-stage event-envelope inputs from the stored step-stage
 * ranges — POST-commit projection only (the executor surface emits them;
 * nothing in Unit B streams or logs staged state).
 */
export function committedStageEnvelopes(
	steps: readonly ChangeSetStep[],
): CommittedStageEnvelope[] {
	const envelopes: CommittedStageEnvelope[] = [];
	for (const step of steps) {
		if (step.stages.length === 0) {
			envelopes.push({
				stepOrdinal: step.ordinal,
				toolName: step.toolName,
				stageName: null,
				mutations: step.mutations,
			});
			continue;
		}
		for (const stage of step.stages) {
			envelopes.push({
				stepOrdinal: step.ordinal,
				toolName: step.toolName,
				stageName: stage.stageName,
				mutations: parsePersistedMutationBatchText(
					encodeAdmittedMutationEnvelope(
						step.mutations.slice(
							stage.mutationStart,
							stage.mutationStart + stage.mutationCount,
						),
					).json,
					`step ${step.ordinal} stage ${stage.stageOrdinal} slice`,
				),
			});
		}
	}
	return envelopes;
}

// ── Internals ──────────────────────────────────────────────────────

async function requireStoredReceipt(
	changeSet: SliceDesignChangeSet,
): Promise<CommittedSliceReceipt> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_committed_slices")
		.select([
			"id",
			"design_session_id",
			"design_revision_id",
			"design_revision_digest",
			"build_plan_id",
			"build_plan_digest",
			"slice_id",
			"slice_attempt_id",
			"change_set_id",
			"app_id",
			"seq",
			"batch_id",
			"committed_snapshot_digest",
			"mutation_count",
			"committed_at",
		])
		.select(
			sql<string>`${sql.ref("design_committed_slices.owning_intent_ids")}::text`.as(
				"owning_intent_ids_text",
			),
		)
		.where("change_set_id", "=", changeSet.id)
		.executeTakeFirst();
	if (row === undefined) {
		throw new ChangeSetIntegrityError(
			`Change set ${changeSet.id} is committed but its atomic committed-slice receipt is missing — a canonical batch without its sidecars is corruption, not a commit.`,
		);
	}
	return {
		purpose: "slice",
		id: row.id,
		designSessionId: row.design_session_id,
		designRevisionId: row.design_revision_id,
		designRevisionDigest: row.design_revision_digest,
		buildPlanId: row.build_plan_id,
		buildPlanDigest: row.build_plan_digest,
		sliceId: row.slice_id as DesignId,
		attemptId: row.slice_attempt_id,
		changeSetId: row.change_set_id,
		appId: row.app_id,
		seq: safePersistedSequence(row.seq, "design_committed_slices.seq"),
		batchId: row.batch_id,
		committedSnapshotDigest: row.committed_snapshot_digest,
		owningIntentIds: intentIdsSchema.parse(
			parsePersistedJsonText(
				row.owning_intent_ids_text,
				`design_committed_slices.owning_intent_ids for change set ${changeSet.id}`,
			),
		),
		mutationCount: row.mutation_count,
		committedAt: row.committed_at,
	};
}

async function currentAppSeq(appId: string): Promise<number> {
	const app = await loadApp(appId);
	return app === null ? 0 : app.mutation_seq;
}

function latestOrganizationRevision(
	dependencies: readonly ExternalReadDependency[],
): string | undefined {
	let latest: bigint | undefined;
	for (const dependency of dependencies) {
		if (dependency.kind !== "organization") continue;
		const revision = BigInt(parseOrganizationRevision(dependency.revision));
		if (latest === undefined || revision > latest) latest = revision;
	}
	return latest === undefined ? undefined : latest.toString();
}

/**
 * Classify the steps' replay against a fresh app snapshot into a structured
 * report — per step, so the executor knows exactly which staged boundary to
 * amend. Returns undefined when the replay is clean and the gate passes
 * (the authoritative commit may proceed).
 */
async function classifyAgainstFreshState(args: {
	readonly changeSet: DesignChangeSet;
	readonly steps: readonly ChangeSetStep[];
	readonly organizationRevision: string | undefined;
}): Promise<
	| { kind: "rebase-conflict"; report: ChangeSetRebaseReport }
	| { kind: "gate-rejected"; message: string; currentSeq: number }
	| undefined
> {
	const { changeSet, steps } = args;
	if (changeSet.appId === null || changeSet.baseSeq === null) {
		throw new ChangeSetIntegrityError(
			`Change set ${changeSet.id} lost its app identity between reads.`,
		);
	}
	const app = await loadApp(changeSet.appId);
	if (app === null || app.deleted_at !== null) {
		throw new ChangeSetScopeLostError(
			"This change set's app is no longer available.",
		);
	}
	if (app.project_id !== changeSet.baseProjectId) {
		throw new ChangeSetScopeLostError(
			"This app moved to a different Project after the change set opened; the change set cannot commit across tenant scope.",
		);
	}
	const currentSeq = app.mutation_seq;
	const conflicts: ChangeSetRebaseConflict[] = [];

	if (args.organizationRevision !== undefined) {
		const db = await getAppDb();
		const organizationRow = await db
			.selectFrom("app_organization_state")
			.select("revision")
			.where("app_id", "=", changeSet.appId)
			.executeTakeFirst();
		const current =
			organizationRow === undefined
				? "0"
				: parseOrganizationRevision(organizationRow.revision);
		if (current !== args.organizationRevision) {
			conflicts.push({
				code: "EXTERNAL_READ_SET_CHANGED",
				message: `This app's places changed after the change set captured organization revision ${args.organizationRevision} (now ${current}). Re-derive the dependent steps against the current organization.`,
			});
		}
	}

	/* Per-step replay over the fresh document: an admission failure names
	 * the exact staged boundary; later steps still replay over the candidate
	 * so one report can carry several independent conflicts. The WHOLE
	 * gate stays the kernel's judgment — a gate-only rejection surfaces as
	 * `gate-rejected` off the authoritative attempt. */
	let current = hydratePersistedBlueprint(app.blueprint);
	for (const step of steps) {
		const prepared = prepareMutationCandidate(current, step.mutations);
		const conflictCode: RebaseConflictCode | undefined =
			prepared.identityAdmissionIssue !== undefined
				? "IDENTITY_COLLISION"
				: prepared.sequenceAdmissionIssue !== undefined
					? "ANCHOR_REMOVED"
					: prepared.targetAdmissionIssue === true
						? "TARGET_REMOVED"
						: prepared.renamePlanIssue !== undefined
							? "EXCLUSIVE_BASE_CHANGED"
							: undefined;
		if (conflictCode !== undefined) {
			const verdict = evaluatePreparedMutationCandidate(
				prepared,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			conflicts.push({
				code: conflictCode,
				stepOrdinal: step.ordinal,
				...(mutationIndexOf(prepared) !== undefined && {
					mutationIndex: mutationIndexOf(prepared),
				}),
				message: verdict.ok
					? "This staged step no longer replays over the current app."
					: verdict.findings.map((finding) => finding.message).join("\n"),
			});
			// The failed step contributed nothing; later steps replay over the
			// unchanged candidate.
			continue;
		}
		current = prepared.nextDoc;
	}
	if (conflicts.length > 0) {
		return {
			kind: "rebase-conflict",
			report: {
				kind: "rebase-conflict",
				baseSeq: changeSet.baseSeq,
				currentSeq,
				conflicts,
			},
		};
	}
	return undefined;
}

function mutationIndexOf(
	prepared: ReturnType<typeof prepareMutationCandidate>,
): number | undefined {
	const index =
		prepared.identityAdmissionIssue?.mutationIndex ??
		prepared.sequenceAdmissionIssue?.mutationIndex ??
		(prepared.renamePlanIssue === undefined
			? undefined
			: prepared.renamePlanIssue.mutationIndex);
	return typeof index === "number" ? index : undefined;
}
