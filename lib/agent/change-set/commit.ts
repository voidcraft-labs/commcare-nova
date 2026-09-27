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
 * checkpoint receipt ride the same transaction
 * (`lib/db/canonicalCommitSidecars.ts`). No success path performs a second
 * transaction to mark the change set committed.
 *
 * A rejected commit retains every step. Any change to the canonical base
 * refuses publication; the author can inspect, discard and restart.
 * A retry of a committed set returns the stored receipt: the sidecar wrote
 * it atomically, so a canonical batch without it is corruption, never a new
 * commit.
 *
 * Genesis change sets do not commit here: materialization is the prepared
 * genesis kernel's separate unit, and this module refuses them loudly.
 */

import { sql, type Transaction } from "kysely";
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
import { migrationOutcomeSchema } from "@/lib/db/migrationOutcome";
import {
	parsePersistedJsonText,
	parsePersistedMutationBatchText,
} from "@/lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import type { ClientAppChangeKind } from "@/lib/db/types";
import { encodeAdmittedMutationEnvelope } from "@/lib/doc/mutationAdmission";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { canonicalJsonDigest } from "./digest";
import {
	ChangeSetIntegrityError,
	ChangeSetScopeLostError,
	ChangeSetWorkspaceRevisionStaleError,
} from "./errors";
import { authorizeChangeSet, loadChangeSet, loadChangeSetSteps } from "./store";
import {
	type CheckpointReceipt,
	type DesignChangeSet,
	designChangeSetBatchId,
} from "./types";

export type CommitDesignChangeSetOutcome =
	| {
			readonly kind: "committed";
			readonly receipt: CheckpointReceipt;
			readonly migration?: MigrationOutcome;
			/** True when a prior attempt had already committed this exact
			 * revision (dedup replay — nothing written). */
			readonly replayed: boolean;
	  }
	| {
			readonly kind: "stale-base";
			readonly baseSeq: number;
			readonly currentSeq: number;
			readonly message: string;
	  }
	| {
			/** The fresh whole-document gate rejected the candidate. Steps are
			 * retained; append corrections and retry. */
			readonly kind: "gate-rejected";
			readonly message: string;
			readonly currentSeq: number;
	  };

export interface CommitDesignChangeSetArgs {
	readonly changeSetId: string;
	readonly requestId?: string;
	readonly actorUserId: string;
	readonly runId: string;
	readonly chatRunHolder?: ChatRunHolderCapability;
	readonly kind: ClientAppChangeKind;
	readonly expectedRevision: number;
	/** Absolute run wall-clock deadline; direct callers omit it. */
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
	const { changeSet, steps } = await withAppTx(async (tx) => {
		const changeSet = await authorizeChangeSet(args, tx);
		const steps = await loadChangeSetSteps(args.changeSetId, tx);
		return { changeSet, steps };
	});
	if (changeSet === undefined) {
		throw new ChangeSetScopeLostError("This change set no longer exists.");
	}
	if (changeSet.kind !== "app-edit" || changeSet.appId === null) {
		throw new ChangeSetScopeLostError(
			"A genesis change set materializes through the prepared genesis kernel, not the app-edit commit.",
		);
	}
	if (
		changeSet.ownerUserId !== args.actorUserId ||
		(changeSet.authoringSessionId == null &&
			changeSet.ownerRunId !== args.runId)
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
	if (changeSet.status === "committed")
		return committedOutcome(
			await requireAuthorizedCommittedReceipt(changeSet, args),
			true,
		);

	if (changeSet.status !== "open") {
		throw new ChangeSetScopeLostError(
			`This change set is ${changeSet.status} and can no longer commit.`,
		);
	}
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

	/* Preflight gives an actionable stale-base result. The kernel repeats
	 * exact equality under the app lock before reducing any mutation. */
	const preflight = await staleBaseOutcome(changeSet);
	if (deadlineExpired(args.deadlineAt)) {
		return deadlineRejection(changeSet.baseSeq ?? 0);
	}
	if (preflight !== undefined) {
		const committed = await committedReplayIfWon(changeSet, args);
		return committed ?? preflight;
	}

	const receiptId = crypto.randomUUID();
	try {
		await applyBlueprintChange({
			appId: changeSet.appId,
			userId: args.actorUserId,
			expectedProjectId: changeSet.baseProjectId,
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
					kind: "commit-authoring-workspace",
					changeSetId: changeSet.id,
					requestId: args.requestId ?? changeSet.id,
					expectedRevision: changeSet.revision,
					receiptId,
					designSessionId: changeSet.designSessionId,
					planRevision: changeSet.planRevision,
					actorUserId: args.actorUserId,
					runId: args.runId,
					holderNonce: args.chatRunHolder?.nonce,
					authoringSessionId: changeSet.authoringSessionId ?? null,
					baseSeq: changeSet.baseSeq,
					projectId: changeSet.baseProjectId,
					mutationCount: batch.length,
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
			...(receipt.migration !== undefined && { migration: receipt.migration }),
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
			if (fresh.status === "committed")
				return committedOutcome(
					await requireAuthorizedCommittedReceipt(fresh, args),
					true,
				);

			if (fresh.revision !== args.expectedRevision) {
				throw new ChangeSetWorkspaceRevisionStaleError(
					args.expectedRevision,
					fresh.revision,
				);
			}
			const stale = await staleBaseOutcome(changeSet);
			if (stale) return stale;
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
		/* A competing commit may have advanced after the advisory check.
		 * A duplicate of this checkpoint still returns its exact receipt. */
		const committed = await committedReplayIfWon(changeSet, args);
		if (committed !== undefined) return committed;
		const reclassified = await staleBaseOutcome(changeSet);
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
		message: "The run deadline expired before commit.",
		currentSeq,
	};
}

/** The concurrent-duplicate check: when the change set has meanwhile
 *  committed (another attempt of this run won), the stored receipt is the
 *  outcome — never a conflict report against its own committed work. */
async function committedReplayIfWon(
	changeSet: DesignChangeSet,
	args: CommitDesignChangeSetArgs,
): Promise<
	Extract<CommitDesignChangeSetOutcome, { kind: "committed" }> | undefined
> {
	const fresh = await loadChangeSet(changeSet.id);
	if (fresh === undefined || fresh.status !== "committed") return undefined;
	return committedOutcome(
		await requireAuthorizedCommittedReceipt(fresh, args),
		true,
	);
}

/** A lost response still belongs to its exact owner/run and current Project
 * access. The app and membership locks bind the receipt read to one scope. */
async function requireAuthorizedCommittedReceipt(
	changeSet: DesignChangeSet,
	args: CommitDesignChangeSetArgs,
): Promise<CheckpointReceipt> {
	if (changeSet.revision !== args.expectedRevision)
		throw new ChangeSetWorkspaceRevisionStaleError(
			args.expectedRevision,
			changeSet.revision,
		);
	const appId = changeSet.appId;
	if (
		appId === null ||
		changeSet.ownerUserId !== args.actorUserId ||
		(changeSet.authoringSessionId == null &&
			changeSet.ownerRunId !== args.runId)
	) {
		throw new ChangeSetScopeLostError(
			"This change set belongs to a different run.",
		);
	}
	await authorizeChangeSet(args);
	return requireStoredReceipt(changeSet);
}

// ── Internals ──────────────────────────────────────────────────────

async function requireStoredReceipt(
	changeSet: DesignChangeSet,
	dbHandle?: Awaited<ReturnType<typeof getAppDb>> | Transaction<AppDatabase>,
): Promise<CheckpointReceipt> {
	const db = dbHandle ?? (await getAppDb());
	const row = await db
		.selectFrom("authoring_checkpoints")
		.select([
			"id",
			"design_session_id",
			"authoring_session_id",
			"plan_revision",
			"change_set_id",
			"app_id",
			"seq",
			"batch_id",
			"committed_snapshot_digest",
			"mutation_count",
			"committed_at",
		])
		.select(
			sql<string | null>`${sql.ref("migration_report")}::text`.as(
				"migration_report_text",
			),
		)
		.where("change_set_id", "=", changeSet.id)
		.executeTakeFirst();
	if (row === undefined) {
		throw new ChangeSetIntegrityError(
			`Change set ${changeSet.id} is committed but its atomic checkpoint receipt is missing — a canonical batch without its sidecars is corruption, not a commit.`,
		);
	}
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		authoringSessionId: row.authoring_session_id,
		planRevision:
			row.plan_revision === null
				? null
				: safePersistedSequence(row.plan_revision, "checkpoint plan revision"),
		changeSetId: row.change_set_id,
		appId: row.app_id,
		seq: safePersistedSequence(row.seq, "authoring_checkpoints.seq"),
		batchId: row.batch_id,
		committedSnapshotDigest: row.committed_snapshot_digest,
		mutationCount: row.mutation_count,
		committedAt: row.committed_at,
		...(row.migration_report_text === null
			? {}
			: {
					migration: migrationOutcomeSchema.parse(
						parsePersistedJsonText(
							row.migration_report_text,
							"checkpoint migration outcome",
						),
					),
				}),
	};
}

/** Read-only reconciliation for a canonical commit whose response raced the
 * run deadline. `null` means no commit became durable before the read;
 * this function never retries or starts a write. */
export async function readCheckpointReceipt(
	changeSetId: string,
): Promise<CheckpointReceipt | null> {
	const changeSet = await loadChangeSet(changeSetId);
	if (changeSet === undefined || changeSet.status !== "committed") return null;
	return await requireStoredReceipt(changeSet);
}

/** Read every immutable receipt for one plan through the same strict JSON and
 * sequence boundary as the commit replay path. Completion policy uses this
 * aggregate; row presence alone is never enough to call a build finished. */
export async function readCheckpointsForSession(
	designSessionId: string,
): Promise<CheckpointReceipt[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("authoring_checkpoints")
		.select([
			"id",
			"design_session_id",
			"authoring_session_id",
			"plan_revision",
			"change_set_id",
			"app_id",
			"seq",
			"batch_id",
			"committed_snapshot_digest",
			"mutation_count",
			"committed_at",
		])
		.select(
			sql<string | null>`${sql.ref("migration_report")}::text`.as(
				"migration_report_text",
			),
		)
		.where("design_session_id", "=", designSessionId)
		.orderBy("seq", "asc")
		.execute();
	return rows.map((row) => ({
		id: row.id,
		designSessionId: row.design_session_id,
		authoringSessionId: row.authoring_session_id,
		planRevision:
			row.plan_revision === null
				? null
				: safePersistedSequence(row.plan_revision, "checkpoint plan revision"),
		changeSetId: row.change_set_id,
		appId: row.app_id,
		seq: safePersistedSequence(row.seq, "authoring_checkpoints.seq"),
		batchId: row.batch_id,
		committedSnapshotDigest: row.committed_snapshot_digest,
		mutationCount: row.mutation_count,
		committedAt: row.committed_at,
		...(row.migration_report_text === null
			? {}
			: {
					migration: migrationOutcomeSchema.parse(
						parsePersistedJsonText(
							row.migration_report_text,
							"checkpoint migration outcome",
						),
					),
				}),
	}));
}

async function currentAppSeq(appId: string): Promise<number> {
	const app = await loadApp(appId);
	return app === null ? 0 : app.mutation_seq;
}

/** Advisory check; publication repeats exact base equality under the app lock. */
async function staleBaseOutcome(
	changeSet: DesignChangeSet,
): Promise<
	Extract<CommitDesignChangeSetOutcome, { kind: "stale-base" }> | undefined
> {
	if (!changeSet.appId || changeSet.baseSeq === null)
		throw new ChangeSetIntegrityError(
			"This candidate lost its saved base identity.",
		);
	const app = await loadApp(changeSet.appId);
	if (!app || app.deleted_at || app.project_id !== changeSet.baseProjectId)
		throw new ChangeSetScopeLostError(
			"This app is no longer available in the work's Project.",
		);
	if (app.mutation_seq !== changeSet.baseSeq)
		return {
			kind: "stale-base",
			baseSeq: changeSet.baseSeq,
			currentSeq: app.mutation_seq,
			message:
				"The saved app changed after this work began. Your pending work is preserved. Inspect it, then discard and restart from the current app.",
		};
	return undefined;
}

function committedOutcome(
	receipt: CheckpointReceipt,
	replayed: boolean,
): Extract<CommitDesignChangeSetOutcome, { kind: "committed" }> {
	return {
		kind: "committed",
		receipt,
		replayed,
		...(receipt.migration === undefined
			? {}
			: { migration: receipt.migration }),
	};
}
