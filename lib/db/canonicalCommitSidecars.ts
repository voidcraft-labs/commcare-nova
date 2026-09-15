import { lockPlanForBuild } from "@/lib/db/authoringPlanGuard";
import { assertDesignSessionRunAuthorityInTransaction } from "./designSessions";
import { safePersistedSequence } from "./persistedJson";
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
 *   - `commit-authoring-workspace` — flip the locked change set
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

import type { Transaction } from "kysely";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { AppDatabase } from "./pg";
import { updatedExactlyOne } from "./runHolderWrites";

export type CanonicalCommitSidecar =
	| {
			readonly kind: "commit-authoring-workspace";
			readonly changeSetId: string;
			readonly requestId: string;
			readonly expectedRevision: number;
			/** Receipt-row identity, minted by the caller OUTSIDE the retryable
			 * transaction so a retry reuses it. */
			readonly receiptId: string;
			readonly designSessionId: string;
			readonly planRevision: number;
			readonly actorUserId: string;
			readonly runId: string;
			readonly holderNonce: string;
			readonly projectId: string;
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
			case "commit-authoring-workspace": {
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
		{ kind: "commit-authoring-workspace" }
	>,
): Promise<void> {
	await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId: sidecar.designSessionId,
		actorUserId: sidecar.actorUserId,
		expectedProjectId: sidecar.projectId,
		holder: { mode: "build", runId: sidecar.runId, nonce: sidecar.holderNonce },
	});
	await lockPlanForBuild(tx, sidecar.designSessionId, sidecar.planRevision);
	const row = await tx
		.selectFrom("authoring_workspaces")
		.selectAll()
		.where("id", "=", sidecar.changeSetId)
		.forUpdate()
		.executeTakeFirst();
	if (
		row?.status !== "open" ||
		(row.kind === "genesis" ? row.proposed_app_id : row.app_id) !==
			commit.appId ||
		safePersistedSequence(row.revision, "workspace revision") !==
			sidecar.expectedRevision ||
		row.design_session_id !== sidecar.designSessionId ||
		safePersistedSequence(row.plan_revision, "workspace plan revision") !==
			sidecar.planRevision ||
		row.owner_user_id !== sidecar.actorUserId ||
		row.owner_run_id !== sidecar.runId ||
		row.base_project_id !== sidecar.projectId
	)
		throw new CanonicalCommitSidecarError(
			"The workspace changed before its checkpoint could commit.",
		);
	const digest = canonicalJsonDigest(commit.committedSnapshot);
	await tx
		.updateTable("authoring_workspaces")
		.set({
			status: "committed",
			committed_seq: commit.seq,
			committed_batch_id: commit.batchId,
			committed_snapshot_digest: digest,
			updated_at: new Date(),
		})
		.where("id", "=", row.id)
		.execute();
	await tx
		.insertInto("authoring_checkpoints")
		.values({
			id: sidecar.receiptId,
			design_session_id: sidecar.designSessionId,
			request_id: sidecar.requestId,
			plan_revision: sidecar.planRevision,
			change_set_id: sidecar.changeSetId,
			app_id: commit.appId,
			seq: commit.seq,
			batch_id: commit.batchId,
			committed_snapshot_digest: digest,
			mutation_count: sidecar.mutationCount,
		})
		.execute();
}
