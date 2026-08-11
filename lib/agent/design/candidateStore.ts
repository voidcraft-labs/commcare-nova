import { sql } from "kysely";
import type { ChangeSetMutationWorkspace } from "@/lib/agent/change-set/workspace";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { updatedExactlyOne } from "@/lib/db/runHolderWrites";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	type CandidateReview,
	candidateReviewBlocksAcceptance,
	candidateReviewSchema,
	type DesignBriefV1,
	designBriefDigest,
	designBriefV1Schema,
} from "./candidate";

export interface CandidateAuthority {
	readonly actorUserId: string;
	readonly runId: string;
	readonly holderNonce: string;
	readonly expectedProjectId: string;
}

export interface CandidateCheckpoint {
	readonly id: string;
	readonly designSessionId: string;
	readonly changeSetId: string;
	readonly parentCheckpointId: string | null;
	readonly lifecycle: "draft" | "accepted";
	readonly workspaceRevision: number;
	readonly stepCount: number;
	readonly candidateDigest: string;
	readonly sourcePackageDigest: string;
	readonly brief: DesignBriefV1;
	readonly createdByRunId: string;
	readonly createdAt: Date;
}

export interface CandidateReviewRecord {
	readonly id: string;
	readonly checkpointId: string;
	readonly kind: "full" | "verification";
	readonly candidateDigest: string;
	readonly artifactDigest: string;
	readonly review: CandidateReview;
}

export type PersistedCandidatePhase =
	| "authoring"
	| "reviewing"
	| "revising"
	| "accepted"
	| "blocked";

function parseCandidatePhase(
	value: string | null,
): PersistedCandidatePhase | null {
	if (value === null) return null;
	if (
		value === "authoring" ||
		value === "reviewing" ||
		value === "revising" ||
		value === "accepted" ||
		value === "blocked"
	) {
		return value;
	}
	throw new Error(`Unknown durable candidate phase ${value}.`);
}

export async function checkpointCandidate(args: {
	readonly workspace: ChangeSetMutationWorkspace;
	readonly designSessionId: string;
	readonly sourcePackageDigest: string;
	readonly brief: DesignBriefV1;
	readonly lifecycle: "draft" | "accepted";
	readonly parentCheckpointId?: string;
	readonly authority: CandidateAuthority;
}): Promise<CandidateCheckpoint> {
	const brief = designBriefV1Schema.parse(args.brief);
	const diagnostics = await args.workspace.inspect();
	if (!diagnostics.canCommit) {
		const messages = diagnostics.allFindings
			.slice(0, 20)
			.map((finding) => finding.message)
			.join("; ");
		throw new Error(
			`The private app candidate is not ready for review: ${messages || "external reads are stale or the candidate is empty"}`,
		);
	}
	const current = args.workspace.current();
	if (
		current.purpose !== "design-candidate" ||
		current.designSessionId !== args.designSessionId
	) {
		throw new Error(
			"Only this session's private design candidate can checkpoint.",
		);
	}
	const id = crypto.randomUUID();
	return withAppTx(async (tx) => {
		await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.designSessionId,
			actorUserId: args.authority.actorUserId,
			expectedProjectId: args.authority.expectedProjectId,
			holder: {
				mode: "build",
				runId: args.authority.runId,
				nonce: args.authority.holderNonce,
			},
		});
		const session = await tx
			.selectFrom("design_sessions")
			.select([
				"active_candidate_change_set_id",
				"active_candidate_checkpoint_id",
				"candidate_phase",
			])
			.where("id", "=", args.designSessionId)
			.executeTakeFirstOrThrow();
		const lockedChangeSet = await tx
			.selectFrom("design_change_sets")
			.select(["purpose", "status", "revision"])
			.where("id", "=", current.id)
			.forUpdate()
			.executeTakeFirst();
		if (
			lockedChangeSet === undefined ||
			lockedChangeSet.purpose !== "design-candidate" ||
			lockedChangeSet.status !== "open" ||
			Number(lockedChangeSet.revision) !== current.revision ||
			session.active_candidate_change_set_id !== current.id
		) {
			throw new Error(
				"The private app changed before this exact checkpoint could be recorded.",
			);
		}
		const expectedPhase =
			args.lifecycle === "accepted"
				? "reviewing"
				: args.parentCheckpointId === undefined
					? "authoring"
					: "revising";
		if (session.candidate_phase !== expectedPhase) {
			throw new Error(
				`The private app cannot checkpoint while its durable phase is ${session.candidate_phase ?? "missing"}.`,
			);
		}

		let parent:
			| {
					id: string;
					parent_checkpoint_id: string | null;
					lifecycle: string;
					workspace_revision: string | number | bigint;
					candidate_digest: string;
					source_package_digest: string;
					brief_digest: string;
			  }
			| undefined;
		if (args.parentCheckpointId !== undefined) {
			parent = await tx
				.selectFrom("design_candidate_checkpoints")
				.select([
					"id",
					"parent_checkpoint_id",
					"lifecycle",
					"workspace_revision",
					"candidate_digest",
					"source_package_digest",
					"brief_digest",
				])
				.where("id", "=", args.parentCheckpointId)
				.where("design_session_id", "=", args.designSessionId)
				.where("change_set_id", "=", current.id)
				.executeTakeFirst();
			if (parent === undefined || parent.lifecycle !== "draft") {
				throw new Error(
					"The candidate checkpoint parent does not belong to this exact private app.",
				);
			}
		}
		if (args.lifecycle === "draft" && parent !== undefined) {
			if (
				Number(parent.workspace_revision) >= current.revision ||
				parent.candidate_digest === diagnostics.candidateDigest ||
				parent.source_package_digest !== args.sourcePackageDigest ||
				session.active_candidate_checkpoint_id !== parent.id
			) {
				throw new Error(
					"A reviewed correction must create one newer candidate revision from the active original draft.",
				);
			}
		}
		if (args.lifecycle === "accepted") {
			if (
				parent === undefined ||
				parent.candidate_digest !== diagnostics.candidateDigest ||
				Number(parent.workspace_revision) !== current.revision ||
				parent.source_package_digest !== args.sourcePackageDigest ||
				parent.brief_digest !== designBriefDigest(brief) ||
				session.active_candidate_checkpoint_id !== parent.id
			) {
				throw new Error(
					"Only the active reviewed draft of this exact private app can be accepted.",
				);
			}
			const requiredReviewKind =
				parent.parent_checkpoint_id === null ? "full" : "verification";
			const reviewRow = await tx
				.selectFrom("design_candidate_reviews")
				.select([
					"candidate_digest",
					sql<string>`payload::text`.as("payload_text"),
				])
				.where("checkpoint_id", "=", parent.id)
				.where("review_kind", "=", requiredReviewKind)
				.executeTakeFirst();
			if (
				reviewRow === undefined ||
				reviewRow.candidate_digest !== diagnostics.candidateDigest ||
				candidateReviewBlocksAcceptance(
					candidateReviewSchema.parse(
						parsePersistedJsonText(
							reviewRow.payload_text,
							"candidate acceptance review",
						),
					),
				)
			) {
				throw new Error(
					"The exact private app candidate has not passed its required independent review.",
				);
			}
		}
		await tx
			.insertInto("design_candidate_checkpoints")
			.values({
				id,
				design_session_id: args.designSessionId,
				change_set_id: current.id,
				parent_checkpoint_id: args.parentCheckpointId ?? null,
				lifecycle: args.lifecycle,
				workspace_revision: current.revision,
				step_count: current.nextOrdinal,
				candidate_digest: diagnostics.candidateDigest,
				source_package_digest: args.sourcePackageDigest,
				brief_digest: designBriefDigest(brief),
				brief: JSON.stringify(brief),
				created_by_run_id: args.authority.runId,
			})
			.onConflict((oc) =>
				oc
					.columns(["change_set_id", "workspace_revision", "lifecycle"])
					.doNothing(),
			)
			.execute();
		const row = await tx
			.selectFrom("design_candidate_checkpoints")
			.selectAll()
			.where("change_set_id", "=", current.id)
			.where("workspace_revision", "=", current.revision)
			.where("lifecycle", "=", args.lifecycle)
			.executeTakeFirstOrThrow();
		if (
			row.candidate_digest !== diagnostics.candidateDigest ||
			row.source_package_digest !== args.sourcePackageDigest ||
			row.brief_digest !== designBriefDigest(brief) ||
			row.parent_checkpoint_id !== (args.parentCheckpointId ?? null)
		) {
			throw new Error(
				"This candidate revision already has a different durable checkpoint.",
			);
		}
		const phaseUpdate = await tx
			.updateTable("design_sessions")
			.set({
				active_candidate_change_set_id: current.id,
				active_candidate_checkpoint_id: row.id,
				active_candidate_review_id: null,
				candidate_phase:
					args.lifecycle === "accepted" ? "accepted" : "reviewing",
				updated_at: new Date(),
			})
			.where("id", "=", args.designSessionId)
			.where("active_candidate_change_set_id", "=", current.id)
			.where("candidate_phase", "=", expectedPhase)
			.executeTakeFirst();
		if (!updatedExactlyOne(phaseUpdate)) {
			throw new Error(
				"The private app phase changed before its checkpoint could become active.",
			);
		}
		return parseCheckpoint(row);
	});
}

/** An explicit Continue action may reopen a candidate whose focused
 * verification still found a blocker. The exact active checkpoint, review,
 * holder, and Project are re-proved together; ordinary messages never call
 * this transition. */
export async function resumeBlockedCandidateRevision(args: {
	readonly checkpoint: CandidateCheckpoint;
	readonly review: CandidateReviewRecord;
	readonly authority: CandidateAuthority;
}): Promise<void> {
	if (
		args.review.kind !== "verification" ||
		args.review.checkpointId !== args.checkpoint.id ||
		!candidateReviewBlocksAcceptance(args.review.review)
	) {
		throw new Error(
			"Only a blocked focused verification can reopen candidate authoring.",
		);
	}
	await withAppTx(async (tx) => {
		await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.checkpoint.designSessionId,
			actorUserId: args.authority.actorUserId,
			expectedProjectId: args.authority.expectedProjectId,
			holder: {
				mode: "build",
				runId: args.authority.runId,
				nonce: args.authority.holderNonce,
			},
		});
		const persistedCheckpoint = await tx
			.selectFrom("design_candidate_checkpoints")
			.select(["design_session_id", "change_set_id", "lifecycle"])
			.where("id", "=", args.checkpoint.id)
			.executeTakeFirst();
		const persistedReview = await tx
			.selectFrom("design_candidate_reviews")
			.select([
				"checkpoint_id",
				"review_kind",
				sql<string>`payload::text`.as("payload_text"),
			])
			.where("id", "=", args.review.id)
			.executeTakeFirst();
		if (
			persistedCheckpoint === undefined ||
			persistedCheckpoint.design_session_id !==
				args.checkpoint.designSessionId ||
			persistedCheckpoint.change_set_id !== args.checkpoint.changeSetId ||
			persistedCheckpoint.lifecycle !== "draft" ||
			persistedReview === undefined ||
			persistedReview.checkpoint_id !== args.checkpoint.id ||
			persistedReview.review_kind !== "verification" ||
			!candidateReviewBlocksAcceptance(
				candidateReviewSchema.parse(
					parsePersistedJsonText(
						persistedReview.payload_text,
						"blocked candidate verification",
					),
				),
			)
		) {
			throw new Error(
				"The durable focused verification does not authorize another correction.",
			);
		}
		const updated = await tx
			.updateTable("design_sessions")
			.set({ candidate_phase: "revising", updated_at: new Date() })
			.where("id", "=", args.checkpoint.designSessionId)
			.where("active_candidate_change_set_id", "=", args.checkpoint.changeSetId)
			.where("active_candidate_checkpoint_id", "=", args.checkpoint.id)
			.where("active_candidate_review_id", "=", args.review.id)
			.where("candidate_phase", "=", "blocked")
			.executeTakeFirst();
		if (!updatedExactlyOne(updated)) {
			throw new Error(
				"The blocked app design changed before it could resume correction.",
			);
		}
	});
}

export async function insertCandidateReview(args: {
	readonly checkpoint: CandidateCheckpoint;
	readonly kind: "full" | "verification";
	readonly review: CandidateReview;
	readonly producerModel: string;
	readonly promptVersion: string;
	readonly authority: CandidateAuthority;
}): Promise<CandidateReviewRecord> {
	const review = candidateReviewSchema.parse(args.review);
	const artifactDigest = canonicalJsonDigest({
		kind: args.kind,
		candidateDigest: args.checkpoint.candidateDigest,
		review,
	});
	const id = crypto.randomUUID();
	return withAppTx(async (tx) => {
		await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.checkpoint.designSessionId,
			actorUserId: args.authority.actorUserId,
			expectedProjectId: args.authority.expectedProjectId,
			holder: {
				mode: "build",
				runId: args.authority.runId,
				nonce: args.authority.holderNonce,
			},
		});
		const session = await tx
			.selectFrom("design_sessions")
			.select([
				"active_candidate_change_set_id",
				"active_candidate_checkpoint_id",
				"candidate_phase",
			])
			.where("id", "=", args.checkpoint.designSessionId)
			.executeTakeFirstOrThrow();
		const checkpoint = await tx
			.selectFrom("design_candidate_checkpoints")
			.select([
				"design_session_id",
				"change_set_id",
				"parent_checkpoint_id",
				"lifecycle",
				"candidate_digest",
			])
			.where("id", "=", args.checkpoint.id)
			.executeTakeFirst();
		if (
			checkpoint === undefined ||
			checkpoint.design_session_id !== args.checkpoint.designSessionId ||
			checkpoint.change_set_id !== args.checkpoint.changeSetId ||
			checkpoint.lifecycle !== "draft" ||
			checkpoint.candidate_digest !== args.checkpoint.candidateDigest ||
			session.active_candidate_change_set_id !== args.checkpoint.changeSetId ||
			session.active_candidate_checkpoint_id !== args.checkpoint.id ||
			session.candidate_phase !== "reviewing" ||
			(args.kind === "full"
				? checkpoint.parent_checkpoint_id !== null
				: checkpoint.parent_checkpoint_id === null)
		) {
			throw new Error(
				"The review checkpoint does not belong to this design session.",
			);
		}
		await tx
			.insertInto("design_candidate_reviews")
			.values({
				id,
				design_session_id: args.checkpoint.designSessionId,
				checkpoint_id: args.checkpoint.id,
				review_kind: args.kind,
				candidate_digest: args.checkpoint.candidateDigest,
				artifact_digest: artifactDigest,
				producer_model: args.producerModel,
				prompt_version: args.promptVersion,
				created_by_run_id: args.authority.runId,
				payload: JSON.stringify(review),
			})
			.onConflict((oc) =>
				oc.columns(["checkpoint_id", "review_kind"]).doNothing(),
			)
			.execute();
		const stored = await tx
			.selectFrom("design_candidate_reviews")
			.select([
				"id",
				"candidate_digest",
				"artifact_digest",
				"producer_model",
				"prompt_version",
			])
			.where("checkpoint_id", "=", args.checkpoint.id)
			.where("review_kind", "=", args.kind)
			.executeTakeFirstOrThrow();
		if (
			stored.candidate_digest !== args.checkpoint.candidateDigest ||
			stored.artifact_digest !== artifactDigest ||
			stored.producer_model !== args.producerModel ||
			stored.prompt_version !== args.promptVersion
		) {
			throw new Error(
				"This exact candidate already has a different independent review.",
			);
		}
		const nextPhase = candidateReviewBlocksAcceptance(review)
			? args.kind === "full"
				? "revising"
				: "blocked"
			: "reviewing";
		const phaseUpdate = await tx
			.updateTable("design_sessions")
			.set({
				active_candidate_review_id: stored.id,
				candidate_phase: nextPhase,
				updated_at: new Date(),
			})
			.where("id", "=", args.checkpoint.designSessionId)
			.where("active_candidate_checkpoint_id", "=", args.checkpoint.id)
			.where("candidate_phase", "=", "reviewing")
			.executeTakeFirst();
		if (!updatedExactlyOne(phaseUpdate)) {
			throw new Error(
				"The private app phase changed before its independent review could become active.",
			);
		}
		return {
			id: stored.id,
			checkpointId: args.checkpoint.id,
			kind: args.kind,
			candidateDigest: args.checkpoint.candidateDigest,
			artifactDigest,
			review,
		};
	});
}

export async function readCandidateReviewForCheckpoint(
	checkpointId: string,
	kind: "full" | "verification",
): Promise<CandidateReviewRecord | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_candidate_reviews")
		.select([
			"id",
			"checkpoint_id",
			"review_kind",
			"candidate_digest",
			"artifact_digest",
			sql<string>`payload::text`.as("payload_text"),
		])
		.where("checkpoint_id", "=", checkpointId)
		.where("review_kind", "=", kind)
		.executeTakeFirst();
	if (row === undefined) return null;
	return {
		id: row.id,
		checkpointId: row.checkpoint_id,
		kind: row.review_kind as "full" | "verification",
		candidateDigest: row.candidate_digest,
		artifactDigest: row.artifact_digest,
		review: candidateReviewSchema.parse(
			parsePersistedJsonText(row.payload_text, "candidate review"),
		),
	};
}

export async function readActiveCandidateState(
	designSessionId: string,
): Promise<{
	checkpoint: CandidateCheckpoint | null;
	review: CandidateReviewRecord | null;
	phase: PersistedCandidatePhase | null;
}> {
	const db = await getAppDb();
	const session = await db
		.selectFrom("design_sessions")
		.select([
			"active_candidate_checkpoint_id",
			"active_candidate_review_id",
			"candidate_phase",
		])
		.where("id", "=", designSessionId)
		.executeTakeFirst();
	if (!session?.active_candidate_checkpoint_id) {
		return {
			checkpoint: null,
			review: null,
			phase: parseCandidatePhase(session?.candidate_phase ?? null),
		};
	}
	const checkpointRow = await db
		.selectFrom("design_candidate_checkpoints")
		.selectAll()
		.where("id", "=", session.active_candidate_checkpoint_id)
		.executeTakeFirstOrThrow();
	let review: CandidateReviewRecord | null = null;
	if (session.active_candidate_review_id) {
		const row = await db
			.selectFrom("design_candidate_reviews")
			.select([
				"id",
				"checkpoint_id",
				"review_kind",
				"candidate_digest",
				"artifact_digest",
				sql<string>`payload::text`.as("payload_text"),
			])
			.where("id", "=", session.active_candidate_review_id)
			.executeTakeFirstOrThrow();
		review = {
			id: row.id,
			checkpointId: row.checkpoint_id,
			kind: row.review_kind as "full" | "verification",
			candidateDigest: row.candidate_digest,
			artifactDigest: row.artifact_digest,
			review: candidateReviewSchema.parse(
				parsePersistedJsonText(row.payload_text, "candidate review"),
			),
		};
	}
	return {
		checkpoint: parseCheckpoint(checkpointRow),
		review,
		phase: parseCandidatePhase(session.candidate_phase),
	};
}

function parseCheckpoint(row: {
	id: string;
	design_session_id: string;
	change_set_id: string;
	parent_checkpoint_id: string | null;
	lifecycle: string;
	workspace_revision: string | number | bigint;
	step_count: string | number | bigint;
	candidate_digest: string;
	source_package_digest: string;
	brief: unknown;
	created_by_run_id: string;
	created_at: Date;
}): CandidateCheckpoint {
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		changeSetId: row.change_set_id,
		parentCheckpointId: row.parent_checkpoint_id,
		lifecycle: row.lifecycle as "draft" | "accepted",
		workspaceRevision: safePersistedSequence(
			typeof row.workspace_revision === "bigint"
				? row.workspace_revision.toString()
				: row.workspace_revision,
			"design_candidate_checkpoints.workspace_revision",
		),
		stepCount: safePersistedSequence(
			typeof row.step_count === "bigint"
				? row.step_count.toString()
				: row.step_count,
			"design_candidate_checkpoints.step_count",
		),
		candidateDigest: row.candidate_digest,
		sourcePackageDigest: row.source_package_digest,
		brief: designBriefV1Schema.parse(row.brief),
		createdByRunId: row.created_by_run_id,
		createdAt: row.created_at,
	};
}
