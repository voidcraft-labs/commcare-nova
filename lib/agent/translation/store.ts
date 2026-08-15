/** Durable authority and recovery store for post-slice localization. */

import { z } from "zod";
import type { DesignLocalizationIntent } from "@/lib/agent/design/contract";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

export const persistedTranslationUsageSchema = z
	.object({
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		cacheReadTokens: z.number().int().nonnegative(),
		cacheWriteTokens: z.number().int().nonnegative(),
	})
	.strict();
export type PersistedTranslationUsage = z.infer<
	typeof persistedTranslationUsageSchema
>;

const persistedBatchOutputSchema = z
	.object({
		translations: z.array(
			z
				.object({
					unitId: z.string().min(1),
					translatedText: z.string(),
				})
				.strict(),
		),
	})
	.strict();
export type PersistedTranslationBatchOutput = z.infer<
	typeof persistedBatchOutputSchema
>;

export interface DesignLocalizationLineage {
	readonly designSessionId: string;
	readonly designRevisionId: string;
	readonly designRevisionDigest: string;
	readonly buildPlanId: string;
	readonly buildPlanDigest: string;
	readonly appId: string;
}

export interface DesignLocalizationAuthority {
	readonly actorUserId: string;
	readonly projectId: string;
	readonly runId: string;
	readonly holderNonce: string;
}

export interface DesignLocalizationAttempt extends DesignLocalizationLineage {
	readonly id: string;
	readonly sourceSeq: number;
	readonly sourceSnapshotDigest: string;
	readonly intentDigest: string;
	readonly intent: DesignLocalizationIntent;
	readonly status: "running" | "committed";
	readonly committedSeq: number | null;
	readonly committedBatchId: string | null;
	readonly committedSnapshotDigest: string | null;
}

export interface TranslationBatchSpec {
	readonly batchIndex: number;
	readonly sourceLanguage: string;
	readonly targetLanguage: string;
	readonly unitIds: readonly string[];
	readonly inputDigest: string;
	readonly modelId: string;
	readonly promptVersion: string;
	readonly schemaVersion: string;
}

export type ClaimedTranslationBatch =
	| {
			readonly kind: "run";
			readonly id: string;
			readonly claimToken: string;
	  }
	| {
			readonly kind: "accepted";
			readonly id: string;
			readonly output: PersistedTranslationBatchOutput;
			readonly usage: PersistedTranslationUsage | null;
	  }
	| {
			readonly kind: "failed";
			readonly id: string;
			readonly failureCode: string;
			readonly usage: PersistedTranslationUsage | null;
	  };

export interface DesignLocalizationReceipt extends DesignLocalizationLineage {
	readonly id: string;
	readonly attemptId: string;
	readonly sourceSeq: number;
	readonly sourceSnapshotDigest: string;
	readonly seq: number;
	readonly batchId: string;
	readonly committedSnapshotDigest: string;
	readonly mutationCount: number;
}

function holder(authority: DesignLocalizationAuthority) {
	return {
		mode: "build" as const,
		runId: authority.runId,
		nonce: authority.holderNonce,
	};
}

function attemptFromRow(row: {
	id: string;
	design_session_id: string;
	design_revision_id: string;
	design_revision_digest: string;
	build_plan_id: string;
	build_plan_digest: string;
	app_id: string;
	source_seq: string | number;
	source_snapshot_digest: string;
	intent_digest: string;
	intent: Record<string, unknown>;
	status: string;
	committed_seq: string | number | null;
	committed_batch_id: string | null;
	committed_snapshot_digest: string | null;
}): DesignLocalizationAttempt {
	const status = z.enum(["running", "committed"]).parse(row.status);
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		designRevisionId: row.design_revision_id,
		designRevisionDigest: row.design_revision_digest,
		buildPlanId: row.build_plan_id,
		buildPlanDigest: row.build_plan_digest,
		appId: row.app_id,
		sourceSeq: safePersistedSequence(row.source_seq, "localization source seq"),
		sourceSnapshotDigest: row.source_snapshot_digest,
		intentDigest: row.intent_digest,
		intent: z.custom<DesignLocalizationIntent>().parse(row.intent),
		status,
		committedSeq:
			row.committed_seq === null
				? null
				: safePersistedSequence(
						row.committed_seq,
						"localization committed seq",
					),
		committedBatchId: row.committed_batch_id,
		committedSnapshotDigest: row.committed_snapshot_digest,
	};
}

function assertAttemptIdentity(
	attempt: DesignLocalizationAttempt,
	args: {
		readonly lineage: DesignLocalizationLineage;
		readonly sourceSeq: number;
		readonly sourceSnapshotDigest: string;
		readonly intentDigest: string;
	},
): void {
	if (
		attempt.designSessionId !== args.lineage.designSessionId ||
		attempt.designRevisionId !== args.lineage.designRevisionId ||
		attempt.designRevisionDigest !== args.lineage.designRevisionDigest ||
		attempt.buildPlanId !== args.lineage.buildPlanId ||
		attempt.buildPlanDigest !== args.lineage.buildPlanDigest ||
		attempt.appId !== args.lineage.appId ||
		attempt.sourceSeq !== args.sourceSeq ||
		attempt.sourceSnapshotDigest !== args.sourceSnapshotDigest ||
		attempt.intentDigest !== args.intentDigest
	) {
		throw new Error(
			"The persisted localization attempt does not match this accepted design, plan, intent, and source snapshot.",
		);
	}
}

export async function beginOrRecoverLocalizationAttempt(args: {
	readonly lineage: DesignLocalizationLineage;
	readonly authority: DesignLocalizationAuthority;
	readonly sourceSeq: number;
	readonly sourceSnapshotDigest: string;
	readonly intent: DesignLocalizationIntent;
}): Promise<DesignLocalizationAttempt> {
	const intentDigest = canonicalJsonDigest(args.intent);
	return withAppTx(async (tx) => {
		const authority = await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.lineage.designSessionId,
			actorUserId: args.authority.actorUserId,
			expectedProjectId: args.authority.projectId,
			holder: holder(args.authority),
		});
		if (authority.appId !== args.lineage.appId) {
			throw new Error(
				"The localization attempt does not belong to the materialized app.",
			);
		}
		const existing = await tx
			.selectFrom("design_localization_attempts")
			.selectAll()
			.where("build_plan_id", "=", args.lineage.buildPlanId)
			.forUpdate()
			.executeTakeFirst();
		if (existing !== undefined) {
			const attempt = attemptFromRow(existing);
			assertAttemptIdentity(attempt, {
				lineage: args.lineage,
				sourceSeq: args.sourceSeq,
				sourceSnapshotDigest: args.sourceSnapshotDigest,
				intentDigest,
			});
			if (attempt.status === "running") {
				await tx
					.updateTable("design_localization_attempts")
					.set({
						updated_by_run_id: args.authority.runId,
						updated_at: new Date(),
					})
					.where("id", "=", attempt.id)
					.execute();
			}
			return attempt;
		}

		const plan = await tx
			.selectFrom("design_build_plans")
			.innerJoin(
				"design_revisions",
				"design_revisions.id",
				"design_build_plans.design_revision_id",
			)
			.select([
				"design_build_plans.design_session_id as plan_session_id",
				"design_build_plans.design_revision_digest",
				"design_build_plans.artifact_digest as plan_artifact_digest",
				"design_revisions.design_session_id as revision_session_id",
				"design_revisions.artifact_digest as revision_artifact_digest",
				"design_revisions.lifecycle",
			])
			.where("design_build_plans.id", "=", args.lineage.buildPlanId)
			.executeTakeFirst();
		if (
			plan === undefined ||
			plan.plan_session_id !== args.lineage.designSessionId ||
			plan.revision_session_id !== args.lineage.designSessionId ||
			plan.lifecycle !== "accepted" ||
			plan.design_revision_digest !== args.lineage.designRevisionDigest ||
			plan.revision_artifact_digest !== args.lineage.designRevisionDigest ||
			plan.plan_artifact_digest !== args.lineage.buildPlanDigest
		) {
			throw new Error(
				"The localization attempt requires one exact accepted design revision and build plan.",
			);
		}
		const app = await tx
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", args.lineage.appId)
			.executeTakeFirstOrThrow();
		if (
			safePersistedSequence(app.mutation_seq, "localization app seq") !==
			args.sourceSeq
		) {
			throw new Error(
				"The app changed after its final workflow receipt; localization must restart from the authoritative source snapshot.",
			);
		}
		const id = crypto.randomUUID();
		await tx
			.insertInto("design_localization_attempts")
			.values({
				id,
				design_session_id: args.lineage.designSessionId,
				design_revision_id: args.lineage.designRevisionId,
				design_revision_digest: args.lineage.designRevisionDigest,
				build_plan_id: args.lineage.buildPlanId,
				build_plan_digest: args.lineage.buildPlanDigest,
				app_id: args.lineage.appId,
				source_seq: args.sourceSeq,
				source_snapshot_digest: args.sourceSnapshotDigest,
				intent_digest: intentDigest,
				intent: JSON.stringify(args.intent),
				status: "running",
				committed_seq: null,
				committed_batch_id: null,
				committed_snapshot_digest: null,
				created_by_run_id: args.authority.runId,
				updated_by_run_id: args.authority.runId,
				created_at: new Date(),
				updated_at: new Date(),
			})
			.execute();
		return {
			...args.lineage,
			id,
			sourceSeq: args.sourceSeq,
			sourceSnapshotDigest: args.sourceSnapshotDigest,
			intentDigest,
			intent: args.intent,
			status: "running",
			committedSeq: null,
			committedBatchId: null,
			committedSnapshotDigest: null,
		};
	});
}

function parseUsage(value: Record<string, unknown> | null) {
	return value === null ? null : persistedTranslationUsageSchema.parse(value);
}

function assertBatchSpec(
	row: {
		batch_index: number;
		source_language: string;
		target_language: string;
		unit_ids: readonly string[];
		input_digest: string;
		model_id: string;
		prompt_version: string;
		schema_version: string;
	},
	spec: TranslationBatchSpec,
): void {
	if (
		row.batch_index !== spec.batchIndex ||
		row.source_language !== spec.sourceLanguage ||
		row.target_language !== spec.targetLanguage ||
		JSON.stringify(row.unit_ids) !== JSON.stringify(spec.unitIds) ||
		row.input_digest !== spec.inputDigest ||
		row.model_id !== spec.modelId ||
		row.prompt_version !== spec.promptVersion ||
		row.schema_version !== spec.schemaVersion
	) {
		throw new Error(
			`Translation batch ${spec.batchIndex} does not match the persisted deterministic batch plan.`,
		);
	}
}

export async function claimTranslationBatch(args: {
	readonly attempt: DesignLocalizationAttempt;
	readonly authority: DesignLocalizationAuthority;
	readonly spec: TranslationBatchSpec;
}): Promise<ClaimedTranslationBatch> {
	return withAppTx(async (tx) => {
		await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.attempt.designSessionId,
			actorUserId: args.authority.actorUserId,
			expectedProjectId: args.authority.projectId,
			holder: holder(args.authority),
		});
		const attempt = await tx
			.selectFrom("design_localization_attempts")
			.select(["status"])
			.where("id", "=", args.attempt.id)
			.forUpdate()
			.executeTakeFirst();
		if (attempt?.status !== "running") {
			throw new Error(
				`Localization attempt ${args.attempt.id} is ${attempt?.status ?? "missing"}; it cannot claim more translation work.`,
			);
		}
		let row = await tx
			.selectFrom("design_localization_batches")
			.selectAll()
			.where("attempt_id", "=", args.attempt.id)
			.where("batch_index", "=", args.spec.batchIndex)
			.where("input_digest", "=", args.spec.inputDigest)
			.where("model_id", "=", args.spec.modelId)
			.where("prompt_version", "=", args.spec.promptVersion)
			.where("schema_version", "=", args.spec.schemaVersion)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) {
			const id = crypto.randomUUID();
			await tx
				.insertInto("design_localization_batches")
				.values({
					id,
					attempt_id: args.attempt.id,
					batch_index: args.spec.batchIndex,
					source_language: args.spec.sourceLanguage,
					target_language: args.spec.targetLanguage,
					unit_ids: JSON.stringify(args.spec.unitIds),
					input_digest: args.spec.inputDigest,
					model_id: args.spec.modelId,
					prompt_version: args.spec.promptVersion,
					schema_version: args.spec.schemaVersion,
					status: "pending",
					claim_token: null,
					claimed_by_run_id: null,
					output: null,
					usage: null,
					failure_code: null,
					created_at: new Date(),
					updated_at: new Date(),
				})
				.execute();
			row = await tx
				.selectFrom("design_localization_batches")
				.selectAll()
				.where("id", "=", id)
				.executeTakeFirstOrThrow();
		}
		assertBatchSpec(row, args.spec);
		if (row.status === "accepted") {
			return {
				kind: "accepted",
				id: row.id,
				output: persistedBatchOutputSchema.parse(row.output),
				usage: parseUsage(row.usage),
			};
		}
		if (row.status === "failed") {
			return {
				kind: "failed",
				id: row.id,
				failureCode: z.string().min(1).parse(row.failure_code),
				usage: parseUsage(row.usage),
			};
		}
		const claimToken = crypto.randomUUID();
		await tx
			.updateTable("design_localization_batches")
			.set({
				status: "running",
				claim_token: claimToken,
				claimed_by_run_id: args.authority.runId,
				updated_at: new Date(),
			})
			.where("id", "=", row.id)
			.execute();
		return { kind: "run", id: row.id, claimToken };
	});
}

export async function completeTranslationBatch(args: {
	readonly attempt: DesignLocalizationAttempt;
	readonly authority: DesignLocalizationAuthority;
	readonly batchId: string;
	readonly claimToken: string;
	readonly result:
		| {
				readonly kind: "accepted";
				readonly output: PersistedTranslationBatchOutput;
				readonly usage: PersistedTranslationUsage | null;
		  }
		| {
				readonly kind: "failed";
				readonly failureCode: string;
				readonly usage: PersistedTranslationUsage | null;
		  };
}): Promise<ClaimedTranslationBatch> {
	return withAppTx(async (tx) => {
		await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.attempt.designSessionId,
			actorUserId: args.authority.actorUserId,
			expectedProjectId: args.authority.projectId,
			holder: holder(args.authority),
		});
		const row = await tx
			.selectFrom("design_localization_batches")
			.selectAll()
			.where("id", "=", args.batchId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined || row.attempt_id !== args.attempt.id) {
			throw new Error(`Translation batch ${args.batchId} no longer exists.`);
		}
		if (row.status === "accepted") {
			return {
				kind: "accepted",
				id: row.id,
				output: persistedBatchOutputSchema.parse(row.output),
				usage: parseUsage(row.usage),
			};
		}
		if (row.status === "failed") {
			return {
				kind: "failed",
				id: row.id,
				failureCode: z.string().min(1).parse(row.failure_code),
				usage: parseUsage(row.usage),
			};
		}
		if (
			row.status !== "running" ||
			row.claim_token !== args.claimToken ||
			row.claimed_by_run_id !== args.authority.runId
		) {
			throw new Error(
				`Translation batch ${args.batchId} is no longer owned by this claim.`,
			);
		}
		if (args.result.kind === "accepted") {
			await tx
				.updateTable("design_localization_batches")
				.set({
					status: "accepted",
					output: JSON.stringify(args.result.output),
					usage:
						args.result.usage === null
							? null
							: JSON.stringify(args.result.usage),
					failure_code: null,
					updated_at: new Date(),
				})
				.where("id", "=", row.id)
				.execute();
			return {
				kind: "accepted",
				id: row.id,
				output: args.result.output,
				usage: args.result.usage,
			};
		}
		await tx
			.updateTable("design_localization_batches")
			.set({
				status: "failed",
				output: null,
				usage:
					args.result.usage === null ? null : JSON.stringify(args.result.usage),
				failure_code: args.result.failureCode,
				updated_at: new Date(),
			})
			.where("id", "=", row.id)
			.execute();
		/* The exact protocol generation is terminal, but the accepted build is
		 * not. A same-version retry finds this failed row and refuses to purchase
		 * another random sample. A real deployment change to input/model/prompt/
		 * schema has a different immutable identity and may append a replacement
		 * row at the same semantic batch index. */
		await tx
			.updateTable("design_localization_attempts")
			.set({
				updated_by_run_id: args.authority.runId,
				updated_at: new Date(),
			})
			.where("id", "=", args.attempt.id)
			.where("status", "=", "running")
			.execute();
		return {
			kind: "failed",
			id: row.id,
			failureCode: args.result.failureCode,
			usage: args.result.usage,
		};
	});
}

export async function readLocalizationReceipt(
	buildPlanId: string,
): Promise<DesignLocalizationReceipt | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_localization_receipts")
		.selectAll()
		.where("build_plan_id", "=", buildPlanId)
		.executeTakeFirst();
	if (row === undefined) return null;
	return {
		id: row.id,
		attemptId: row.attempt_id,
		designSessionId: row.design_session_id,
		designRevisionId: row.design_revision_id,
		designRevisionDigest: row.design_revision_digest,
		buildPlanId: row.build_plan_id,
		buildPlanDigest: row.build_plan_digest,
		appId: row.app_id,
		sourceSeq: safePersistedSequence(row.source_seq, "localization source seq"),
		sourceSnapshotDigest: row.source_snapshot_digest,
		seq: safePersistedSequence(row.seq, "localization receipt seq"),
		batchId: row.batch_id,
		committedSnapshotDigest: row.committed_snapshot_digest,
		mutationCount: row.mutation_count,
	};
}

/** Re-offer every persisted paid response to the current run accumulator.
 * The run-summary transaction's batch account decides which ones are new. */
export async function readTerminalLocalizationBatchUsage(
	attemptId: string,
): Promise<
	readonly {
		readonly batchId: string;
		readonly usage: PersistedTranslationUsage;
	}[]
> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("design_localization_batches")
		.select(["id", "usage"])
		.where("attempt_id", "=", attemptId)
		.where("status", "in", ["accepted", "failed"])
		.where("usage", "is not", null)
		.orderBy("batch_index", "asc")
		.orderBy("created_at", "asc")
		.execute();
	return rows.map((row) => ({
		batchId: row.id,
		usage: persistedTranslationUsageSchema.parse(row.usage),
	}));
}
