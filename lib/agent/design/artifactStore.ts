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
import { z } from "zod";
import type { BuildPlan } from "@/lib/agent/design/buildPlan";
import {
	buildPlanSchema,
	newPlanAdmissionMessages,
	normalizeStoredBuildPlan,
} from "@/lib/agent/design/buildPlan";
import {
	type AppDesignContract,
	appDesignContractSchema,
	normalizeStoredAppDesignContract,
} from "@/lib/agent/design/contract";
import {
	type DesignArtifactEnvelope,
	designArtifactEnvelopeSchema,
	verifyArtifactEnvelope,
} from "@/lib/agent/design/envelope";
import {
	designLookupMaterializationPayloadSchema,
	projectBuildPlanLookupBindings,
} from "@/lib/agent/design/lookupMaterializationTypes";
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
	sourcePackageProofExtends,
	toPersistedSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import { releaseDesignLookupProtectionsInTransaction } from "@/lib/db/designLookupMaterializations";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

/** A protocol violation at this boundary — a caller tried to persist or
 *  read something the artifact discipline forbids. */
export class DesignArtifactStoreError extends Error {
	readonly name = "DesignArtifactStoreError";
}

export interface DesignArtifactWriteAuthority {
	readonly actorUserId: string;
	readonly runId: string;
	readonly holderNonce: string;
	readonly expectedProjectId: string;
}

export interface DesignArtifactWorkspaceFinalization {
	readonly workspaceId: string;
	readonly expectedRevision: number;
	readonly artifactKind: "contract" | "revision" | "plan";
}

function contractRequiresLookupMaterialization(
	contract: AppDesignContract,
): boolean {
	return (
		contract.lookupTables.length > 0 ||
		contract.records.some((record) =>
			record.properties.some((property) => property.choiceSource !== undefined),
		) ||
		contract.workflows.some((workflow) =>
			workflow.inputs.some((input) => input.choiceSource !== undefined),
		)
	);
}

async function finalizeArtifactWorkspaceInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		designSessionId: string;
		artifactId: string;
		runId: string;
		workspace: DesignArtifactWorkspaceFinalization;
	},
): Promise<void> {
	const now = new Date();
	const result = await tx
		.updateTable("design_artifact_workspaces")
		.set({
			status: "finalized",
			finalized_artifact_id: args.artifactId,
			updated_by_run_id: args.runId,
			updated_at: now,
			finalized_at: now,
		})
		.where("id", "=", args.workspace.workspaceId)
		.where("design_session_id", "=", args.designSessionId)
		.where("artifact_kind", "=", args.workspace.artifactKind)
		.where("status", "=", "open")
		.where("revision", "=", args.workspace.expectedRevision)
		.executeTakeFirst();
	if (result.numUpdatedRows !== BigInt(1)) {
		throw new DesignArtifactStoreError(
			"The design workspace changed or closed before its artifact finalized. Inspect the current workspace and retry from its latest revision.",
		);
	}
}

async function authorizeArtifactWrite(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
	authority: DesignArtifactWriteAuthority,
): Promise<void> {
	await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId,
		actorUserId: authority.actorUserId,
		expectedProjectId: authority.expectedProjectId,
		holder: {
			mode: "build",
			runId: authority.runId,
			nonce: authority.holderNonce,
		},
	});
}

const contractEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-contract",
	appDesignContractSchema,
);
const storedContractEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-contract",
	z.unknown(),
);
const reviewEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-review",
	designReviewSchema,
);
const buildPlanEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-build-plan",
	buildPlanSchema,
);
const storedBuildPlanEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-build-plan",
	z.unknown(),
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
	authority: DesignArtifactWriteAuthority;
}): Promise<DesignSourcePackageRecord> {
	const { pkg, authority } = args;
	const { packageDigest: claimedDigest, ...unsealed } = pkg;
	if (computeSourcePackageDigest(unsealed) !== claimedDigest) {
		throw new DesignArtifactStoreError(
			"The source package's digest does not match its own projection — it was mutated after sealing. Rebuild the package instead of persisting a drifted one.",
		);
	}
	const payload = toPersistedSourcePackage(pkg);
	const id = crypto.randomUUID();
	return withAppTx(async (tx) => {
		await authorizeArtifactWrite(tx, pkg.designSessionId, authority);
		if (pkg.projectId !== authority.expectedProjectId) {
			throw new DesignArtifactStoreError(
				"The source package Project does not match its authorized design session.",
			);
		}
		await tx
			.insertInto("design_source_packages")
			.values({
				id,
				design_session_id: pkg.designSessionId,
				project_id: pkg.projectId,
				package_digest: pkg.packageDigest,
				created_by_run_id: authority.runId,
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

/** Workspace lineage asks the artifact boundary—not the workspace store—to
 * compare persisted package projections. Missing pre-release proofs fail
 * closed, so only a cryptographically demonstrated cumulative extension can
 * inherit staged authoring work. */
export async function isCumulativeDesignSourcePackageExtensionInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		designSessionId: string;
		previousPackageDigest: string;
		nextPackageDigest: string;
	},
): Promise<boolean> {
	const previous = await readSourcePackageInTx(
		tx,
		args.designSessionId,
		args.previousPackageDigest,
	);
	const next = await readSourcePackageInTx(
		tx,
		args.designSessionId,
		args.nextPackageDigest,
	);
	return sourcePackageProofExtends(
		previous?.payload.extensionProof,
		next?.payload.extensionProof,
	);
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
	authority: DesignArtifactWriteAuthority;
	/** A newer source package is replacing a planned design. Retire every open
	 * carrier from the historical plan in this same authority-locked write. */
	supersedeUncommittedExecution?: boolean;
	/** Required for an accepted revision: every disposition plus the review
	 *  row ids whose findings they close. */
	dispositions?: ReadonlyArray<{
		reviewId: string;
		disposition: FindingDisposition;
	}>;
	/** When present, artifact insertion and the exact open-workspace terminal
	 * transition are one transaction. */
	workspaceFinalization?: DesignArtifactWorkspaceFinalization;
}): Promise<DesignRevisionRecord> {
	const { envelope, lifecycle, authority } = args;
	const parsed = contractEnvelopeSchema.parse(envelope);
	verifyArtifactEnvelope(parsed);
	const contractDigest = canonicalJsonDigest(parsed.payload);

	return withAppTx(async (tx) => {
		await authorizeArtifactWrite(tx, parsed.designSessionId, authority);
		if (args.supersedeUncommittedExecution) {
			const now = new Date();
			await tx
				.updateTable("design_change_sets")
				.set({ status: "superseded", updated_at: now })
				.where("design_session_id", "=", parsed.designSessionId)
				.where("status", "=", "open")
				.execute();
			await tx
				.updateTable("design_slice_attempts")
				.set({
					status: "superseded",
					failure_code: "artifact-superseded",
					updated_at: now,
				})
				.where("design_session_id", "=", parsed.designSessionId)
				.where("status", "=", "running")
				.execute();
			await releaseDesignLookupProtectionsInTransaction(
				tx,
				parsed.designSessionId,
			);
		}
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
				created_by_run_id: authority.runId,
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

		if (args.workspaceFinalization !== undefined) {
			if (args.workspaceFinalization.artifactKind === "plan") {
				throw new DesignArtifactStoreError(
					"A Design Contract revision cannot finalize a plan workspace.",
				);
			}
			await finalizeArtifactWorkspaceInTransaction(tx, {
				designSessionId: parsed.designSessionId,
				artifactId: parsed.artifactId,
				runId: authority.runId,
				workspace: args.workspaceFinalization,
			});
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

/** Every revision of one session, ascending, each row through the same
 *  verified record conversion — the inspector's integrity walk. ONE query:
 *  the gate loader runs this on every tool call, so a per-row fetch would be
 *  an N+1 against the session's whole history. */
export async function readDesignRevisionsForSession(
	designSessionId: string,
): Promise<DesignRevisionRecord[]> {
	const db = await getAppDb();
	const rows = await revisionRowsQuery(db)
		.where("design_session_id", "=", designSessionId)
		.orderBy("revision", "asc")
		.execute();
	return rows.map(revisionRecordFromRow);
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

/** The revision columns every record read selects — one spelling, so the
 *  by-id and whole-session readers cannot drift. */
function revisionRowsQuery(db: Db) {
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
		);
}

type RevisionRow = Awaited<
	ReturnType<ReturnType<typeof revisionRowsQuery>["execute"]>
>[number];

async function readRevisionRowInTx(db: Db, id: string) {
	return revisionRowsQuery(db).where("id", "=", id).executeTakeFirst();
}

function revisionRecordFromRow(row: RevisionRow): DesignRevisionRecord {
	const storedEnvelope = storedContractEnvelopeSchema.parse(
		parsePersistedJsonText(
			row.envelope_text,
			`design_revisions.envelope for revision ${row.id}`,
		),
	);
	/* Verify the exact sealed bytes before normalizing additive collections.
	 * The normalized payload is the only domain shape consumers receive, but it
	 * must never be mistaken for the stored envelope's digest input. */
	verifyArtifactEnvelope(storedEnvelope);
	const envelope: DesignArtifactEnvelope<AppDesignContract> = {
		...storedEnvelope,
		payload: normalizeStoredAppDesignContract(storedEnvelope.payload),
	};
	if (
		envelope.artifactDigest !== row.artifact_digest ||
		envelope.artifactId !== row.id ||
		envelope.designSessionId !== row.design_session_id
	) {
		throw new DesignArtifactStoreError(
			`The stored revision ${row.id} disagrees with its own envelope about identity or digest — corruption, not drift to repair.`,
		);
	}
	const lifecycle = row.lifecycle;
	if (lifecycle !== "draft" && lifecycle !== "accepted") {
		throw new DesignArtifactStoreError(
			`The stored revision ${row.id} carries an unknown lifecycle "${lifecycle}".`,
		);
	}
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		revision: safePersistedSequence(
			row.revision,
			`design_revisions.revision for ${row.id}`,
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

async function readRevisionRecordInTx(
	db: Db,
	id: string,
): Promise<DesignRevisionRecord | null> {
	const row = await readRevisionRowInTx(db, id);
	return row ? revisionRecordFromRow(row) : null;
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
	authority: DesignArtifactWriteAuthority;
}): Promise<DesignReviewRecord> {
	const parsed = reviewEnvelopeSchema.parse(args.envelope);
	verifyArtifactEnvelope(parsed);

	return withAppTx(async (tx) => {
		await authorizeArtifactWrite(tx, parsed.designSessionId, args.authority);
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
				created_by_run_id: args.authority.runId,
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
	const reviews = await readDesignReviewsForRevisions([designRevisionId]);
	return [...(reviews.get(designRevisionId) ?? [])];
}

/**
 * Every review of the named revisions, keyed by revision id (every requested
 * id gets an entry, empty when unreviewed), each list ascending by
 * `review_ordinal`. ONE query: the gate loader reads reviews for the whole
 * session's revision list on every tool call, so a per-revision-per-review
 * fetch would be a nested N+1.
 */
export async function readDesignReviewsForRevisions(
	designRevisionIds: readonly string[],
): Promise<ReadonlyMap<string, readonly DesignReviewRecord[]>> {
	const reviews = new Map<string, DesignReviewRecord[]>(
		designRevisionIds.map((id) => [id, []]),
	);
	if (designRevisionIds.length === 0) return reviews;
	const db = await getAppDb();
	const rows = await reviewRowsQuery(db)
		.where("design_revision_id", "in", [...designRevisionIds])
		.orderBy("design_revision_id")
		.orderBy("review_ordinal", "asc")
		.execute();
	for (const row of rows) {
		reviews.get(row.design_revision_id)?.push(reviewRecordFromRow(row));
	}
	return reviews;
}

/** The review columns every record read selects — one spelling, so the
 *  by-id and batch readers cannot drift. */
function reviewRowsQuery(db: Db) {
	return db
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
		);
}

type ReviewRow = Awaited<
	ReturnType<ReturnType<typeof reviewRowsQuery>["execute"]>
>[number];

function reviewRecordFromRow(row: ReviewRow): DesignReviewRecord {
	const envelope = reviewEnvelopeSchema.parse(
		parsePersistedJsonText(
			row.envelope_text,
			`design_reviews.envelope for review ${row.id}`,
		),
	);
	verifyArtifactEnvelope(envelope);
	if (
		envelope.artifactDigest !== row.artifact_digest ||
		envelope.artifactId !== row.id
	) {
		throw new DesignArtifactStoreError(
			`The stored review ${row.id} disagrees with its own envelope — corruption.`,
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

async function readReviewRecordInTx(
	db: Db,
	id: string,
): Promise<DesignReviewRecord | null> {
	const row = await reviewRowsQuery(db).where("id", "=", id).executeTakeFirst();
	return row ? reviewRecordFromRow(row) : null;
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
	authority: DesignArtifactWriteAuthority;
	workspaceFinalization?: DesignArtifactWorkspaceFinalization;
}): Promise<DesignBuildPlanRecord> {
	const parsed = buildPlanEnvelopeSchema.parse(args.envelope);
	verifyArtifactEnvelope(parsed);
	const plan = parsed.payload;
	const admissionMessages = newPlanAdmissionMessages(plan);
	if (admissionMessages.length > 0) {
		throw new DesignArtifactStoreError(admissionMessages.join("\n"));
	}
	const planDigest = canonicalJsonDigest(plan);

	return withAppTx(async (tx) => {
		await authorizeArtifactWrite(tx, parsed.designSessionId, args.authority);
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
		const acceptedContract = revisionRecordFromRow(revision).envelope.payload;
		if (
			contractRequiresLookupMaterialization(acceptedContract) &&
			plan.lookupMaterialization === null
		) {
			throw new DesignArtifactStoreError(
				"This accepted design depends on Project data, but its BuildPlan has no durable lookup materialization receipt.",
			);
		}
		if (plan.lookupMaterialization !== null) {
			const receipt = await tx
				.selectFrom("design_lookup_materializations")
				.select([
					"design_session_id",
					"design_revision_id",
					"design_revision_digest",
					"project_id",
					"project_revision",
					"result_digest",
				])
				.select(
					sql<string>`${sql.ref("design_lookup_materializations.mapping")}::text`.as(
						"mapping_text",
					),
				)
				.where("id", "=", plan.lookupMaterialization.receiptId)
				.executeTakeFirst();
			if (
				receipt === undefined ||
				receipt.design_session_id !== parsed.designSessionId ||
				receipt.design_revision_id !== plan.designRevisionId ||
				receipt.design_revision_digest !== plan.designRevisionDigest ||
				receipt.project_id !== args.authority.expectedProjectId ||
				receipt.result_digest !== plan.lookupMaterialization.resultDigest ||
				String(receipt.project_revision) !==
					plan.lookupMaterialization.projectRevision
			) {
				throw new DesignArtifactStoreError(
					"The BuildPlan lookup receipt does not match its accepted revision, Project, or materialization result.",
				);
			}
			const materialization = designLookupMaterializationPayloadSchema.parse(
				parsePersistedJsonText(
					receipt.mapping_text,
					`design_lookup_materializations.mapping for receipt ${plan.lookupMaterialization.receiptId}`,
				),
			);
			if (
				canonicalJsonDigest(materialization) !== receipt.result_digest ||
				canonicalJsonDigest(
					projectBuildPlanLookupBindings(materialization.bindings),
				) !== canonicalJsonDigest(plan.lookupMaterialization.bindings) ||
				!parsed.inputArtifactDigests.includes(receipt.result_digest)
			) {
				throw new DesignArtifactStoreError(
					"The BuildPlan does not carry the exact digest-bound lookup identity mapping produced by its receipt.",
				);
			}
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
				created_by_run_id: args.authority.runId,
				envelope: JSON.stringify(parsed),
			})
			.execute();

		if (args.workspaceFinalization !== undefined) {
			if (args.workspaceFinalization.artifactKind !== "plan") {
				throw new DesignArtifactStoreError(
					"A build plan can finalize only a plan workspace.",
				);
			}
			await finalizeArtifactWorkspaceInTransaction(tx, {
				designSessionId: parsed.designSessionId,
				artifactId: plan.id,
				runId: args.authority.runId,
				workspace: args.workspaceFinalization,
			});
		}

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
	const storedEnvelope = storedBuildPlanEnvelopeSchema.parse(
		parsePersistedJsonText(
			row.envelope_text,
			`design_build_plans.envelope for plan ${id}`,
		),
	);
	/* Verify the exact sealed bytes before normalizing additive plan members.
	 * The normalized payload is the only plan shape consumers receive. */
	verifyArtifactEnvelope(storedEnvelope);
	const envelope: DesignArtifactEnvelope<BuildPlan> = {
		...storedEnvelope,
		payload: normalizeStoredBuildPlan(storedEnvelope.payload),
	};
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
