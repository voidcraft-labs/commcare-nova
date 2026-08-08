/**
 * The design-artifact store — one module owns every read and write of the
 * five artifact tables (`design_source_packages`, `design_revisions`,
 * `design_reviews`, `design_review_dispositions`, `design_build_plans`).
 *
 * The discipline (plan §6.12, §18.2–18.3):
 *
 *  - INSERT-ONLY. Nothing here updates or deletes; acceptance is a new
 *    accepted revision row, supersession is the session's active pointer
 *    (the design-session unit) plus ancestry.
 *  - DIGEST-BOUND. Every envelope is verified before insert and after every
 *    read (`envelope.ts::verifyArtifactEnvelope`); every insert proves its
 *    exact predecessors exist with matching digests, so a later state
 *    cannot exist without its predecessor (§7.1).
 *  - STRICT ON READ. Every JSONB payload is selected as `::text`, parsed
 *    through `parsePersistedJsonText`, then the exact producer schema —
 *    a contract revision re-proves its whole design graph on every read.
 *  - APPEND-ONLY AT THE PRIVILEGE LEVEL. These tables are never row-locked
 *    (`privilegeConvergence.ts`); the unique constraints are the race
 *    fences, and a violated one is a loud protocol error — the pipeline is
 *    single-flight per session by construction, so a race is corruption to
 *    surface, not contention to retry.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import type { BuildPlan } from "@/lib/agent/design/buildPlan";
import { buildPlanSchema } from "@/lib/agent/design/buildPlan";
import {
	type AppDesignContract,
	appDesignContractSchema,
} from "@/lib/agent/design/contract";
import {
	type DesignArtifactEnvelope,
	designArtifactEnvelopeSchema,
	verifyArtifactEnvelope,
} from "@/lib/agent/design/envelope";
import {
	type DesignReview,
	designReviewSchema,
	type FindingDisposition,
	findingDispositionSchema,
} from "@/lib/agent/design/review";
import {
	computeSourcePackageDigest,
	type DesignSourcePackage,
	type PersistedSourcePackage,
	persistedSourcePackageSchema,
	toPersistedSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

/** A protocol violation at this boundary — a caller tried to persist or
 *  read something the artifact discipline forbids. */
export class DesignArtifactStoreError extends Error {
	readonly name = "DesignArtifactStoreError";
}

const contractEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-contract",
	appDesignContractSchema,
);
const reviewEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-review",
	designReviewSchema,
);
const buildPlanEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-build-plan",
	buildPlanSchema,
);

export type RevisionLifecycle = "draft" | "accepted";

export interface DesignRevisionRecord {
	id: string;
	designSessionId: string;
	revision: number;
	parentRevisionId: string | null;
	lifecycle: RevisionLifecycle;
	artifactDigest: string;
	contractDigest: string;
	sourcePackageDigest: string;
	envelope: DesignArtifactEnvelope<AppDesignContract>;
	/** The run that produced this artifact: the join key to its reasoning
	 *  summaries and diagnostics in the run event log. */
	createdByRunId: string;
	createdAt: Date;
}

export interface DesignReviewRecord {
	id: string;
	designSessionId: string;
	designRevisionId: string;
	reviewOrdinal: number;
	reviewedRevisionDigest: string;
	artifactDigest: string;
	envelope: DesignArtifactEnvelope<DesignReview>;
	/** The run that produced this artifact: the join key to its reasoning
	 *  summaries and diagnostics in the run event log. */
	createdByRunId: string;
	createdAt: Date;
}

export interface DesignBuildPlanRecord {
	id: string;
	designSessionId: string;
	designRevisionId: string;
	designRevisionDigest: string;
	planDigest: string;
	artifactDigest: string;
	envelope: DesignArtifactEnvelope<BuildPlan>;
	createdAt: Date;
}

export interface DesignSourcePackageRecord {
	id: string;
	designSessionId: string;
	projectId: string;
	packageDigest: string;
	payload: PersistedSourcePackage;
	createdAt: Date;
}

export interface DispositionRecord {
	reviewId: string;
	findingId: string;
	resultingRevisionId: string;
	disposition: FindingDisposition;
	createdAt: Date;
}

/* ------------------------------------------------------------------ */
/* Source packages                                                     */
/* ------------------------------------------------------------------ */

/**
 * Persist a source package's references + normalized claims. Idempotent by
 * `(designSessionId, packageDigest)`: rebuilding the identical projection
 * converges on the stored row.
 */
export async function insertDesignSourcePackage(args: {
	pkg: DesignSourcePackage;
	runId: string;
}): Promise<DesignSourcePackageRecord> {
	const { pkg, runId } = args;
	const { packageDigest: claimedDigest, ...unsealed } = pkg;
	if (computeSourcePackageDigest(unsealed) !== claimedDigest) {
		throw new DesignArtifactStoreError(
			"The source package's digest does not match its own projection — it was mutated after sealing. Rebuild the package instead of persisting a drifted one.",
		);
	}
	const payload = toPersistedSourcePackage(pkg);
	const id = crypto.randomUUID();
	return withAppTx(async (tx) => {
		await tx
			.insertInto("design_source_packages")
			.values({
				id,
				design_session_id: pkg.designSessionId,
				project_id: pkg.projectId,
				package_digest: pkg.packageDigest,
				created_by_run_id: runId,
				payload: JSON.stringify(payload),
			})
			.onConflict((oc) =>
				oc.columns(["design_session_id", "package_digest"]).doNothing(),
			)
			.execute();
		const record = await readSourcePackageInTx(
			tx,
			pkg.designSessionId,
			pkg.packageDigest,
		);
		if (!record) {
			throw new DesignArtifactStoreError(
				"The source package vanished between insert and read-back — the database refused the row without raising. Investigate before continuing.",
			);
		}
		return record;
	});
}

export async function readDesignSourcePackage(
	designSessionId: string,
	packageDigest: string,
): Promise<DesignSourcePackageRecord | null> {
	const db = await getAppDb();
	return readSourcePackageInTx(db, designSessionId, packageDigest);
}

type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;

async function readSourcePackageInTx(
	db: Db,
	designSessionId: string,
	packageDigest: string,
): Promise<DesignSourcePackageRecord | null> {
	const row = await db
		.selectFrom("design_source_packages")
		.select([
			"id",
			"design_session_id",
			"project_id",
			"package_digest",
			"created_at",
		])
		.select(
			sql<string>`${sql.ref("design_source_packages.payload")}::text`.as(
				"payload_text",
			),
		)
		.where("design_session_id", "=", designSessionId)
		.where("package_digest", "=", packageDigest)
		.executeTakeFirst();
	if (!row) return null;
	const payload = persistedSourcePackageSchema.parse(
		parsePersistedJsonText(
			row.payload_text,
			`design_source_packages.payload for session ${designSessionId}`,
		),
	);
	if (payload.packageDigest !== row.package_digest) {
		throw new DesignArtifactStoreError(
			"A stored source package's payload names a different digest than its row — the two were written together and can only disagree through corruption.",
		);
	}
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		projectId: row.project_id,
		packageDigest: row.package_digest,
		payload,
		createdAt: row.created_at,
	};
}

/* ------------------------------------------------------------------ */
/* Contract revisions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Persist one contract revision. Proves, inside one transaction:
 *  - the envelope digest recomputes and its type/lifecycle shape is right;
 *  - the session's source package with the envelope's digest exists;
 *  - revision 1 has no parent; a later revision names its exact parent row,
 *    whose artifact digest rides the envelope's input digests;
 *  - the stored `contract_digest` is the canonical digest of the payload.
 *
 * An ACCEPTED revision additionally requires at least one persisted review
 * of its parent draft — "reviewed" can never be asserted without the review
 * artifact — and its dispositions land in the same transaction
 * (`dispositions`, each mapped to the review that raised its finding).
 */
export async function insertDesignRevision(args: {
	envelope: DesignArtifactEnvelope<AppDesignContract>;
	lifecycle: RevisionLifecycle;
	runId: string;
	/** Required for an accepted revision: every disposition plus the review
	 *  row ids whose findings they close. */
	dispositions?: ReadonlyArray<{
		reviewId: string;
		disposition: FindingDisposition;
	}>;
}): Promise<DesignRevisionRecord> {
	const { envelope, lifecycle, runId } = args;
	const parsed = contractEnvelopeSchema.parse(envelope);
	verifyArtifactEnvelope(parsed);
	const contractDigest = canonicalJsonDigest(parsed.payload);

	return withAppTx(async (tx) => {
		const pkg = await tx
			.selectFrom("design_source_packages")
			.select(["id"])
			.where("design_session_id", "=", parsed.designSessionId)
			.where("package_digest", "=", parsed.sourcePackageDigest)
			.executeTakeFirst();
		if (!pkg) {
			throw new DesignArtifactStoreError(
				"A contract revision must descend from a persisted source package, but no package with this envelope's source digest exists for the session. Persist the package first.",
			);
		}

		if (parsed.revision === 1) {
			if (parsed.parentArtifactId !== null) {
				throw new DesignArtifactStoreError(
					"The first revision of a session has no parent, but this envelope names one.",
				);
			}
		} else {
			if (parsed.parentArtifactId === null) {
				throw new DesignArtifactStoreError(
					`Revision ${parsed.revision} must name its parent revision — only revision 1 stands alone.`,
				);
			}
			const parent = await readRevisionRowInTx(tx, parsed.parentArtifactId);
			if (!parent || parent.design_session_id !== parsed.designSessionId) {
				throw new DesignArtifactStoreError(
					"This revision's parent does not exist in its session — a later state cannot exist without its exact predecessor.",
				);
			}
			if (!parsed.inputArtifactDigests.includes(parent.artifact_digest)) {
				throw new DesignArtifactStoreError(
					"This revision's inputs do not include its parent's digest — the predecessor binding is broken.",
				);
			}
		}

		if (lifecycle === "accepted" && parsed.parentArtifactId === null) {
			throw new DesignArtifactStoreError(
				"An accepted revision descends from a reviewed draft; revision 1 is always a draft.",
			);
		}
		if (lifecycle === "accepted" || (args.dispositions ?? []).length > 0) {
			if (parsed.parentArtifactId === null) {
				throw new DesignArtifactStoreError(
					"Dispositions close a PARENT revision's reviews; revision 1 has no parent to have been reviewed.",
				);
			}
			const reviews = await tx
				.selectFrom("design_reviews")
				.select(["id"])
				.where("design_revision_id", "=", parsed.parentArtifactId)
				.execute();
			if (lifecycle === "accepted" && reviews.length === 0) {
				throw new DesignArtifactStoreError(
					"An accepted revision requires a persisted review of its parent draft — without the review artifact, nothing here was reviewed.",
				);
			}
			const knownReviewIds = new Set(reviews.map((review) => review.id));
			for (const entry of args.dispositions ?? []) {
				if (!knownReviewIds.has(entry.reviewId)) {
					throw new DesignArtifactStoreError(
						"A disposition names a review that does not belong to the parent revision.",
					);
				}
			}
		}

		await tx
			.insertInto("design_revisions")
			.values({
				id: parsed.artifactId,
				design_session_id: parsed.designSessionId,
				revision: parsed.revision,
				parent_revision_id: parsed.parentArtifactId,
				lifecycle,
				artifact_digest: parsed.artifactDigest,
				contract_digest: contractDigest,
				source_package_digest: parsed.sourcePackageDigest,
				producer_model: parsed.producer.modelId,
				prompt_version: parsed.promptVersion,
				created_by_run_id: runId,
				envelope: JSON.stringify(parsed),
			})
			.execute();

		for (const entry of args.dispositions ?? []) {
			const disposition = findingDispositionSchema.parse(entry.disposition);
			await tx
				.insertInto("design_review_dispositions")
				.values({
					review_id: entry.reviewId,
					finding_id: disposition.findingId,
					status: disposition.status,
					resulting_revision_id: parsed.artifactId,
					payload: JSON.stringify(disposition),
				})
				.execute();
		}

		const record = await readRevisionRecordInTx(tx, parsed.artifactId);
		if (!record) {
			throw new DesignArtifactStoreError(
				"The revision vanished between insert and read-back.",
			);
		}
		return record;
	});
}

export async function readDesignRevision(
	revisionId: string,
): Promise<DesignRevisionRecord | null> {
	const db = await getAppDb();
	return readRevisionRecordInTx(db, revisionId);
}

/** The session's newest accepted revision, if any. */
export async function readLatestAcceptedDesignRevision(
	designSessionId: string,
): Promise<DesignRevisionRecord | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_revisions")
		.select(["id"])
		.where("design_session_id", "=", designSessionId)
		.where("lifecycle", "=", "accepted")
		.orderBy("revision", "desc")
		.limit(1)
		.executeTakeFirst();
	if (!row) return null;
	return readRevisionRecordInTx(db, row.id);
}

/** Every revision of one session, ascending, each read through the
 *  verified record reader — the inspector's integrity walk. */
export async function readDesignRevisionsForSession(
	designSessionId: string,
): Promise<DesignRevisionRecord[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("design_revisions")
		.select(["id"])
		.where("design_session_id", "=", designSessionId)
		.orderBy("revision", "asc")
		.execute();
	const records: DesignRevisionRecord[] = [];
	for (const row of rows) {
		const record = await readRevisionRecordInTx(db, row.id);
		if (record) records.push(record);
	}
	return records;
}

/** The session's newest revision of ANY lifecycle — the pipeline's resume
 *  anchor. */
export async function readLatestDesignRevision(
	designSessionId: string,
): Promise<DesignRevisionRecord | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_revisions")
		.select(["id"])
		.where("design_session_id", "=", designSessionId)
		.orderBy("revision", "desc")
		.limit(1)
		.executeTakeFirst();
	if (!row) return null;
	return readRevisionRecordInTx(db, row.id);
}

/** The session's revision count — the pipeline derives the next revision
 *  number from it before sealing an envelope. */
export async function countDesignRevisions(
	designSessionId: string,
): Promise<number> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_revisions")
		.select(({ fn }) => fn.countAll<string>().as("n"))
		.where("design_session_id", "=", designSessionId)
		.executeTakeFirst();
	return Number(row?.n ?? 0);
}

async function readRevisionRowInTx(db: Db, id: string) {
	return db
		.selectFrom("design_revisions")
		.select([
			"id",
			"design_session_id",
			"revision",
			"parent_revision_id",
			"lifecycle",
			"artifact_digest",
			"contract_digest",
			"source_package_digest",
			"created_by_run_id",
			"created_at",
		])
		.select(
			sql<string>`${sql.ref("design_revisions.envelope")}::text`.as(
				"envelope_text",
			),
		)
		.where("id", "=", id)
		.executeTakeFirst();
}

async function readRevisionRecordInTx(
	db: Db,
	id: string,
): Promise<DesignRevisionRecord | null> {
	const row = await readRevisionRowInTx(db, id);
	if (!row) return null;
	const envelope = contractEnvelopeSchema.parse(
		parsePersistedJsonText(
			row.envelope_text,
			`design_revisions.envelope for revision ${id}`,
		),
	);
	verifyArtifactEnvelope(envelope);
	if (
		envelope.artifactDigest !== row.artifact_digest ||
		envelope.artifactId !== row.id ||
		envelope.designSessionId !== row.design_session_id
	) {
		throw new DesignArtifactStoreError(
			`The stored revision ${id} disagrees with its own envelope about identity or digest — corruption, not drift to repair.`,
		);
	}
	const lifecycle = row.lifecycle;
	if (lifecycle !== "draft" && lifecycle !== "accepted") {
		throw new DesignArtifactStoreError(
			`The stored revision ${id} carries an unknown lifecycle "${lifecycle}".`,
		);
	}
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		revision: safePersistedSequence(
			row.revision,
			`design_revisions.revision for ${id}`,
		),
		parentRevisionId: row.parent_revision_id,
		lifecycle,
		artifactDigest: row.artifact_digest,
		contractDigest: row.contract_digest,
		sourcePackageDigest: row.source_package_digest,
		envelope,
		createdByRunId: row.created_by_run_id,
		createdAt: row.created_at,
	};
}

/* ------------------------------------------------------------------ */
/* Reviews and dispositions                                            */
/* ------------------------------------------------------------------ */

/**
 * Persist one independent review of one exact revision. Proves the reviewed
 * revision exists, the envelope's `reviewedRevisionDigest` claim matches its
 * stored artifact digest, and the review's source package is the revision's.
 */
export async function insertDesignReview(args: {
	envelope: DesignArtifactEnvelope<DesignReview>;
	designRevisionId: string;
	runId: string;
}): Promise<DesignReviewRecord> {
	const parsed = reviewEnvelopeSchema.parse(args.envelope);
	verifyArtifactEnvelope(parsed);

	return withAppTx(async (tx) => {
		const revision = await readRevisionRowInTx(tx, args.designRevisionId);
		if (!revision || revision.design_session_id !== parsed.designSessionId) {
			throw new DesignArtifactStoreError(
				"A review must name an existing revision of its own session — this one does not.",
			);
		}
		if (!parsed.inputArtifactDigests.includes(revision.artifact_digest)) {
			throw new DesignArtifactStoreError(
				"This review's inputs do not include the reviewed revision's digest — it cannot claim to have reviewed it.",
			);
		}
		if (parsed.sourcePackageDigest !== revision.source_package_digest) {
			throw new DesignArtifactStoreError(
				"The reviewer must receive the same source package the author worked from; the digests disagree.",
			);
		}
		const prior = await tx
			.selectFrom("design_reviews")
			.select(({ fn }) => fn.countAll<string>().as("n"))
			.where("design_revision_id", "=", args.designRevisionId)
			.executeTakeFirst();
		const ordinal = Number(prior?.n ?? 0) + 1;

		await tx
			.insertInto("design_reviews")
			.values({
				id: parsed.artifactId,
				design_session_id: parsed.designSessionId,
				design_revision_id: args.designRevisionId,
				review_ordinal: ordinal,
				reviewed_revision_digest: revision.artifact_digest,
				artifact_digest: parsed.artifactDigest,
				producer_model: parsed.producer.modelId,
				prompt_version: parsed.promptVersion,
				created_by_run_id: args.runId,
				envelope: JSON.stringify(parsed),
			})
			.execute();

		const record = await readReviewRecordInTx(tx, parsed.artifactId);
		if (!record) {
			throw new DesignArtifactStoreError(
				"The review vanished between insert and read-back.",
			);
		}
		return record;
	});
}

export async function readDesignReviews(
	designRevisionId: string,
): Promise<DesignReviewRecord[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("design_reviews")
		.select(["id"])
		.where("design_revision_id", "=", designRevisionId)
		.orderBy("review_ordinal", "asc")
		.execute();
	const records: DesignReviewRecord[] = [];
	for (const row of rows) {
		const record = await readReviewRecordInTx(db, row.id);
		if (record) records.push(record);
	}
	return records;
}

async function readReviewRecordInTx(
	db: Db,
	id: string,
): Promise<DesignReviewRecord | null> {
	const row = await db
		.selectFrom("design_reviews")
		.select([
			"id",
			"design_session_id",
			"design_revision_id",
			"review_ordinal",
			"reviewed_revision_digest",
			"artifact_digest",
			"created_by_run_id",
			"created_at",
		])
		.select(
			sql<string>`${sql.ref("design_reviews.envelope")}::text`.as(
				"envelope_text",
			),
		)
		.where("id", "=", id)
		.executeTakeFirst();
	if (!row) return null;
	const envelope = reviewEnvelopeSchema.parse(
		parsePersistedJsonText(
			row.envelope_text,
			`design_reviews.envelope for review ${id}`,
		),
	);
	verifyArtifactEnvelope(envelope);
	if (
		envelope.artifactDigest !== row.artifact_digest ||
		envelope.artifactId !== row.id
	) {
		throw new DesignArtifactStoreError(
			`The stored review ${id} disagrees with its own envelope — corruption.`,
		);
	}
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		designRevisionId: row.design_revision_id,
		reviewOrdinal: row.review_ordinal,
		reviewedRevisionDigest: row.reviewed_revision_digest,
		artifactDigest: row.artifact_digest,
		envelope,
		createdByRunId: row.created_by_run_id,
		createdAt: row.created_at,
	};
}

export async function readDispositions(
	reviewId: string,
): Promise<DispositionRecord[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("design_review_dispositions")
		.select(["review_id", "finding_id", "resulting_revision_id", "created_at"])
		.select(
			sql<string>`${sql.ref("design_review_dispositions.payload")}::text`.as(
				"payload_text",
			),
		)
		.where("review_id", "=", reviewId)
		.orderBy("finding_id", "asc")
		.execute();
	return rows.map((row) => ({
		reviewId: row.review_id,
		findingId: row.finding_id,
		resultingRevisionId: row.resulting_revision_id,
		disposition: findingDispositionSchema.parse(
			parsePersistedJsonText(
				row.payload_text,
				`design_review_dispositions.payload for review ${reviewId}, finding ${row.finding_id}`,
			),
		),
		createdAt: row.created_at,
	}));
}

/* ------------------------------------------------------------------ */
/* Build plans                                                         */
/* ------------------------------------------------------------------ */

/**
 * Persist one build plan, digest-bound to its exact accepted revision. The
 * payload's own revision identity must agree with the row's, and the
 * revision must be ACCEPTED — a plan over a draft is unpersistable.
 */
export async function insertDesignBuildPlan(args: {
	envelope: DesignArtifactEnvelope<BuildPlan>;
	runId: string;
}): Promise<DesignBuildPlanRecord> {
	const parsed = buildPlanEnvelopeSchema.parse(args.envelope);
	verifyArtifactEnvelope(parsed);
	const plan = parsed.payload;
	const planDigest = canonicalJsonDigest(plan);

	return withAppTx(async (tx) => {
		const revision = await readRevisionRowInTx(tx, plan.designRevisionId);
		if (!revision || revision.design_session_id !== parsed.designSessionId) {
			throw new DesignArtifactStoreError(
				"A build plan must name an existing revision of its own session.",
			);
		}
		if (revision.lifecycle !== "accepted") {
			throw new DesignArtifactStoreError(
				"A build plan lowers an ACCEPTED contract revision; this revision is a draft.",
			);
		}
		if (plan.designRevisionDigest !== revision.artifact_digest) {
			throw new DesignArtifactStoreError(
				"The plan's revision digest does not match the stored accepted revision — the plan was derived from something else.",
			);
		}
		if (!parsed.inputArtifactDigests.includes(revision.artifact_digest)) {
			throw new DesignArtifactStoreError(
				"This plan's inputs do not include the accepted revision's digest.",
			);
		}

		await tx
			.insertInto("design_build_plans")
			.values({
				id: plan.id,
				design_session_id: parsed.designSessionId,
				design_revision_id: plan.designRevisionId,
				design_revision_digest: plan.designRevisionDigest,
				plan_digest: planDigest,
				artifact_digest: parsed.artifactDigest,
				producer_model: parsed.producer.modelId,
				prompt_version: parsed.promptVersion,
				created_by_run_id: args.runId,
				envelope: JSON.stringify(parsed),
			})
			.execute();

		const record = await readBuildPlanRecordInTx(tx, plan.id);
		if (!record) {
			throw new DesignArtifactStoreError(
				"The build plan vanished between insert and read-back.",
			);
		}
		return record;
	});
}

export async function readDesignBuildPlan(
	planId: string,
): Promise<DesignBuildPlanRecord | null> {
	const db = await getAppDb();
	return readBuildPlanRecordInTx(db, planId);
}

/** The newest plan lowered from one exact revision — the pipeline's resume
 *  anchor after acceptance. */
export async function readLatestDesignBuildPlanForRevision(
	designRevisionId: string,
): Promise<DesignBuildPlanRecord | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_build_plans")
		.select(["id"])
		.where("design_revision_id", "=", designRevisionId)
		.orderBy("created_at", "desc")
		.limit(1)
		.executeTakeFirst();
	if (!row) return null;
	return readBuildPlanRecordInTx(db, row.id);
}

async function readBuildPlanRecordInTx(
	db: Db,
	id: string,
): Promise<DesignBuildPlanRecord | null> {
	const row = await db
		.selectFrom("design_build_plans")
		.select([
			"id",
			"design_session_id",
			"design_revision_id",
			"design_revision_digest",
			"plan_digest",
			"artifact_digest",
			"created_at",
		])
		.select(
			sql<string>`${sql.ref("design_build_plans.envelope")}::text`.as(
				"envelope_text",
			),
		)
		.where("id", "=", id)
		.executeTakeFirst();
	if (!row) return null;
	const envelope = buildPlanEnvelopeSchema.parse(
		parsePersistedJsonText(
			row.envelope_text,
			`design_build_plans.envelope for plan ${id}`,
		),
	);
	verifyArtifactEnvelope(envelope);
	if (
		envelope.artifactDigest !== row.artifact_digest ||
		envelope.payload.id !== row.id
	) {
		throw new DesignArtifactStoreError(
			`The stored build plan ${id} disagrees with its own envelope — corruption.`,
		);
	}
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		designRevisionId: row.design_revision_id,
		designRevisionDigest: row.design_revision_digest,
		planDigest: row.plan_digest,
		artifactDigest: row.artifact_digest,
		envelope,
		createdAt: row.created_at,
	};
}
