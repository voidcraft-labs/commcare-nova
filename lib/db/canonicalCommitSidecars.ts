/**
 * Canonical commit sidecars — the closed, typed SQL-only operations a
 * server-owned caller may ride on the canonical commit kernel's
 * transaction-hook seam.
 *
 * A sidecar runs INSIDE the same retryable app-locked transaction as the
 * canonical write, after the committed-batch write tail. It must be
 * deterministic, idempotent under transaction retry, and free of
 * network/object-store effects; it cannot alter the candidate Blueprint or
 * bypass the gate. This dispatcher is the whole vocabulary — arbitrary
 * closures never enter the kernel.
 *
 * The server-owned build runtimes have two variants:
 *
 *   - `commit-design-change-set` — flip the locked change set
 *     `open → committed` beside the canonical write and insert the
 *     immutable committed-slice receipt with the kernel's authoritative
 *     sequence, batch id, and committed snapshot digest. The change-set row
 *     lock is taken here, AFTER the kernel's app lock — the canonical
 *     order.
 *
 *   - `commit-design-localization` — flip the exact locked post-slice
 *     localization attempt `running → committed` and insert its immutable
 *     receipt beside the one canonical localization batch.
 *
 * On a kernel DEDUP hit sidecars are skipped entirely: the original commit
 * ran them, and a canonical batch without its change-set/receipt sidecars
 * is corruption for the CALLER to detect, never a new commit.
 */

import { sql, type Transaction } from "kysely";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { AppDatabase } from "./pg";
import { updatedExactlyOne } from "./runHolderWrites";

export type CanonicalCommitSidecar =
	| {
			readonly kind: "commit-design-change-set";
			readonly changeSetId: string;
			readonly expectedRevision: number;
			/** Receipt-row identity, minted by the caller OUTSIDE the retryable
			 * transaction so a retry reuses it. */
			readonly receiptId: string;
			readonly sliceAttemptId: string;
			readonly designSessionId: string;
			readonly designRevisionId: string;
			readonly designRevisionDigest: string;
			readonly buildPlanId: string;
			readonly buildPlanDigest: string;
			readonly sliceId: string;
			readonly mutationCount: number;
	  }
	| {
			readonly kind: "commit-design-localization";
			readonly attemptId: string;
			readonly receiptId: string;
			readonly designSessionId: string;
			readonly designRevisionId: string;
			readonly designRevisionDigest: string;
			readonly buildPlanId: string;
			readonly buildPlanDigest: string;
			readonly sourceSeq: number;
			readonly sourceSnapshotDigest: string;
			readonly intentDigest: string;
			readonly mutationCount: number;
	  };

export class CanonicalCommitSidecarError extends Error {
	readonly name = "CanonicalCommitSidecarError";
}

/**
 * Execute the request's sidecars on the kernel's transaction. `seq`,
 * `batchId`, and `committedSnapshot` are the kernel's authoritative values
 * for THIS commit — a sidecar never receives caller-asserted ones.
 */
export async function executeCanonicalCommitSidecars(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly seq: number;
		readonly batchId: string;
		/** The exact persistable candidate the kernel is committing. */
		readonly committedSnapshot: unknown;
		readonly sidecars: readonly CanonicalCommitSidecar[];
	},
): Promise<void> {
	for (const sidecar of args.sidecars) {
		switch (sidecar.kind) {
			case "commit-design-change-set": {
				await commitDesignChangeSetSidecar(tx, args, sidecar);
				break;
			}
			case "commit-design-localization": {
				await commitDesignLocalizationSidecar(tx, args, sidecar);
				break;
			}
		}
	}
}

async function commitDesignLocalizationSidecar(
	tx: Transaction<AppDatabase>,
	commit: {
		readonly appId: string;
		readonly seq: number;
		readonly batchId: string;
		readonly committedSnapshot: unknown;
	},
	sidecar: Extract<
		CanonicalCommitSidecar,
		{ kind: "commit-design-localization" }
	>,
): Promise<void> {
	const attempt = await tx
		.selectFrom("design_localization_attempts")
		.selectAll()
		.where("id", "=", sidecar.attemptId)
		.forUpdate()
		.executeTakeFirst();
	if (
		attempt === undefined ||
		attempt.status !== "running" ||
		attempt.design_session_id !== sidecar.designSessionId ||
		attempt.design_revision_id !== sidecar.designRevisionId ||
		attempt.design_revision_digest !== sidecar.designRevisionDigest ||
		attempt.build_plan_id !== sidecar.buildPlanId ||
		attempt.build_plan_digest !== sidecar.buildPlanDigest ||
		attempt.app_id !== commit.appId ||
		Number(attempt.source_seq) !== sidecar.sourceSeq ||
		attempt.source_snapshot_digest !== sidecar.sourceSnapshotDigest ||
		attempt.intent_digest !== sidecar.intentDigest
	) {
		throw new CanonicalCommitSidecarError(
			`Localization attempt ${sidecar.attemptId} is not the exact running attempt for this accepted design and source snapshot.`,
		);
	}
	if (commit.seq !== sidecar.sourceSeq + 1) {
		throw new CanonicalCommitSidecarError(
			`Localization attempt ${sidecar.attemptId} was derived from app sequence ${sidecar.sourceSeq}, but the canonical commit would land at ${commit.seq}.`,
		);
	}
	const committedSnapshotDigest = canonicalJsonDigest(commit.committedSnapshot);
	const flip = await tx
		.updateTable("design_localization_attempts")
		.set({
			status: "committed",
			committed_seq: commit.seq,
			committed_batch_id: commit.batchId,
			committed_snapshot_digest: committedSnapshotDigest,
			updated_at: new Date(),
		})
		.where("id", "=", sidecar.attemptId)
		.where("status", "=", "running")
		.executeTakeFirst();
	if (!updatedExactlyOne(flip)) {
		throw new CanonicalCommitSidecarError(
			`Localization attempt ${sidecar.attemptId} could not flip from running to committed under its own lock.`,
		);
	}
	await tx
		.insertInto("design_localization_receipts")
		.values({
			id: sidecar.receiptId,
			attempt_id: sidecar.attemptId,
			design_session_id: sidecar.designSessionId,
			design_revision_id: sidecar.designRevisionId,
			design_revision_digest: sidecar.designRevisionDigest,
			build_plan_id: sidecar.buildPlanId,
			build_plan_digest: sidecar.buildPlanDigest,
			app_id: commit.appId,
			source_seq: sidecar.sourceSeq,
			source_snapshot_digest: sidecar.sourceSnapshotDigest,
			seq: commit.seq,
			batch_id: commit.batchId,
			committed_snapshot_digest: committedSnapshotDigest,
			mutation_count: sidecar.mutationCount,
		})
		.execute();
}

async function commitDesignChangeSetSidecar(
	tx: Transaction<AppDatabase>,
	commit: {
		readonly appId: string;
		readonly seq: number;
		readonly batchId: string;
		readonly committedSnapshot: unknown;
	},
	sidecar: Extract<
		CanonicalCommitSidecar,
		{ kind: "commit-design-change-set" }
	>,
): Promise<void> {
	const row = await tx
		.selectFrom("design_change_sets")
		.select([
			"id",
			"kind",
			"app_id",
			"proposed_app_id",
			"status",
			"revision",
			"attempt_id",
			"design_session_id",
			"design_revision_id",
			"design_revision_digest",
			"build_plan_id",
			"build_plan_digest",
			"slice_id",
		])
		.where("id", "=", sidecar.changeSetId)
		.forUpdate()
		.executeTakeFirst();
	if (row === undefined) {
		throw new CanonicalCommitSidecarError(
			`Change set ${sidecar.changeSetId} no longer exists, so this canonical commit cannot carry its receipt.`,
		);
	}
	/* A genesis set carries its app identity as `proposed_app_id` (its
	 * `app_id` stays NULL by table CHECK — the app row it proposed is being
	 * born in this very transaction); an app-edit set carries `app_id`. */
	const committingAppId =
		row.kind === "genesis" ? row.proposed_app_id : row.app_id;
	if (committingAppId !== commit.appId) {
		throw new CanonicalCommitSidecarError(
			`Change set ${sidecar.changeSetId} belongs to app ${committingAppId ?? "none"}, not the committing app ${commit.appId}.`,
		);
	}
	if (row.status !== "open") {
		throw new CanonicalCommitSidecarError(
			`Change set ${sidecar.changeSetId} is ${row.status}; only an open change set can commit.`,
		);
	}
	if (Number(row.revision) !== sidecar.expectedRevision) {
		throw new CanonicalCommitSidecarError(
			`Change set ${sidecar.changeSetId} advanced to revision ${row.revision} after this commit was derived at revision ${sidecar.expectedRevision}.`,
		);
	}
	if (
		row.design_session_id !== sidecar.designSessionId ||
		row.design_revision_id !== sidecar.designRevisionId ||
		row.design_revision_digest !== sidecar.designRevisionDigest ||
		row.build_plan_id !== sidecar.buildPlanId ||
		row.build_plan_digest !== sidecar.buildPlanDigest ||
		row.slice_id !== sidecar.sliceId ||
		row.attempt_id !== sidecar.sliceAttemptId
	) {
		throw new CanonicalCommitSidecarError(
			`Change set ${sidecar.changeSetId} no longer matches the design/plan lineage this commit was derived under.`,
		);
	}
	const attempt = await tx
		.selectFrom("design_slice_attempts")
		.select([
			"id",
			"design_session_id",
			"design_revision_id",
			"design_revision_digest",
			"build_plan_id",
			"build_plan_digest",
			"slice_id",
			"change_set_id",
			"status",
		])
		.where("id", "=", sidecar.sliceAttemptId)
		.forUpdate()
		.executeTakeFirst();
	if (
		attempt === undefined ||
		attempt.status !== "running" ||
		attempt.design_session_id !== sidecar.designSessionId ||
		attempt.design_revision_id !== sidecar.designRevisionId ||
		attempt.design_revision_digest !== sidecar.designRevisionDigest ||
		attempt.build_plan_id !== sidecar.buildPlanId ||
		attempt.build_plan_digest !== sidecar.buildPlanDigest ||
		attempt.slice_id !== sidecar.sliceId ||
		attempt.change_set_id !== sidecar.changeSetId
	) {
		throw new CanonicalCommitSidecarError(
			`Slice attempt ${sidecar.sliceAttemptId} is not the exact running attempt bound to change set ${sidecar.changeSetId}.`,
		);
	}
	const committedSnapshotDigest = canonicalJsonDigest(commit.committedSnapshot);
	const flip = await tx
		.updateTable("design_change_sets")
		.set({
			status: "committed",
			committed_seq: commit.seq,
			committed_batch_id: commit.batchId,
			committed_snapshot_digest: committedSnapshotDigest,
			updated_at: new Date(),
		})
		.where("id", "=", sidecar.changeSetId)
		.where("status", "=", "open")
		.where("revision", "=", sidecar.expectedRevision)
		.executeTakeFirst();
	if (!updatedExactlyOne(flip)) {
		throw new CanonicalCommitSidecarError(
			`Change set ${sidecar.changeSetId} could not flip to committed under its own lock.`,
		);
	}
	const attemptFlip = await tx
		.updateTable("design_slice_attempts")
		.set({
			status: "committed",
			failure_code: null,
			/* The canonical commit is the final executor operation, and every
			 * negative outcome is awaited into this attempt before the commit can
			 * start. Seal a live evidence window in the same transaction as the
			 * receipt so process death after COMMIT cannot strand it at collecting.
			 * An already-incomplete window remains fail-closed forever. */
			outcome_evidence_state: sql<string>`CASE
				WHEN outcome_evidence_state = 'collecting' THEN 'complete'
				ELSE outcome_evidence_state
			END`,
			updated_at: new Date(),
		})
		.where("id", "=", sidecar.sliceAttemptId)
		.where("status", "=", "running")
		.where("change_set_id", "=", sidecar.changeSetId)
		.executeTakeFirst();
	if (!updatedExactlyOne(attemptFlip)) {
		throw new CanonicalCommitSidecarError(
			`Slice attempt ${sidecar.sliceAttemptId} could not flip from running to committed under its own lock.`,
		);
	}
	await tx
		.insertInto("design_committed_slices")
		.values({
			id: sidecar.receiptId,
			design_session_id: sidecar.designSessionId,
			design_revision_id: sidecar.designRevisionId,
			design_revision_digest: sidecar.designRevisionDigest,
			build_plan_id: sidecar.buildPlanId,
			build_plan_digest: sidecar.buildPlanDigest,
			slice_id: sidecar.sliceId,
			slice_attempt_id: sidecar.sliceAttemptId,
			change_set_id: sidecar.changeSetId,
			app_id: commit.appId,
			seq: commit.seq,
			batch_id: commit.batchId,
			committed_snapshot_digest: committedSnapshotDigest,
			mutation_count: sidecar.mutationCount,
		})
		.execute();
}
