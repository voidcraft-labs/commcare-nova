/**
 * Canonical commit sidecars — the closed, typed SQL-only operations a
 * server-owned caller may ride on the canonical commit kernel's
 * transaction-hook seam.
 *
 * A sidecar runs INSIDE the same retryable app-locked transaction as the
 * canonical write, after the committed-batch write tail (so the provenance
 * rows' foreign key onto the fresh `app_changes` row is immediately
 * checkable, and a lost holder CAS has already aborted). It must be
 * deterministic, idempotent under transaction retry, and free of
 * network/object-store effects; it cannot alter the candidate Blueprint or
 * bypass the gate. This dispatcher is the whole vocabulary — arbitrary
 * closures never enter the kernel.
 *
 * Initial variants (the Atomic Change Set runtime's two):
 *
 *   - `commit-design-change-set` — flip the locked change set
 *     `open → committed` beside the canonical write and insert the
 *     immutable committed-slice receipt with the kernel's authoritative
 *     sequence, batch id, and committed snapshot digest. The change-set row
 *     lock is taken here, AFTER the kernel's app lock — the canonical
 *     order.
 *
 *   - `write-intent-provenance` — insert `app_change_intents` rows binding
 *     accepted design intents to the committed sequence's implementation
 *     coordinates. The rows' `(app_id, seq)` foreign key onto `app_changes`
 *     makes "provenance without its canonical change" unrepresentable — the
 *     kernel's app-change row is already written in this same transaction.
 *
 * On a kernel DEDUP hit sidecars are skipped entirely: the original commit
 * ran them, and a canonical batch without its change-set/receipt sidecars
 * is corruption for the CALLER to detect, never a new commit.
 */

import type { Transaction } from "kysely";
import { implementationCoordinateSchema } from "@/lib/agent/design/projection/coordinates";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { AppDatabase } from "./pg";
import { updatedExactlyOne } from "./runHolderWrites";

export interface IntentProvenanceRow {
	readonly designSessionId: string;
	readonly designRevisionId: string;
	readonly buildPlanId: string;
	readonly sliceId: string;
	readonly intentId: string;
	/** Strict-parsed through the closed implementation-coordinate union. */
	readonly coordinate: unknown;
}

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
			readonly owningIntentIds: readonly string[];
			readonly mutationCount: number;
	  }
	| {
			readonly kind: "write-intent-provenance";
			readonly rows: readonly IntentProvenanceRow[];
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
			case "write-intent-provenance": {
				await writeIntentProvenanceSidecar(tx, args, sidecar);
				break;
			}
		}
	}
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
		.set({ status: "committed", failure_code: null, updated_at: new Date() })
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
			owning_intent_ids: JSON.stringify([...sidecar.owningIntentIds]),
			mutation_count: sidecar.mutationCount,
		})
		.execute();
}

async function writeIntentProvenanceSidecar(
	tx: Transaction<AppDatabase>,
	commit: { readonly appId: string; readonly seq: number },
	sidecar: Extract<CanonicalCommitSidecar, { kind: "write-intent-provenance" }>,
): Promise<void> {
	if (sidecar.rows.length === 0) return;
	await tx
		.insertInto("app_change_intents")
		.values(
			sidecar.rows.map((row) => ({
				app_id: commit.appId,
				seq: commit.seq,
				design_session_id: row.designSessionId,
				design_revision_id: row.designRevisionId,
				build_plan_id: row.buildPlanId,
				slice_id: row.sliceId,
				intent_id: row.intentId,
				coordinate_kind: implementationCoordinateSchema.parse(row.coordinate)
					.kind,
				coordinate_payload: JSON.stringify(
					implementationCoordinateSchema.parse(row.coordinate),
				),
			})),
		)
		.execute();
}
