import "server-only";

import { type Kysely, sql, type Transaction } from "kysely";
import { readCommittedSliceReceiptsForPlan } from "@/lib/agent/change-set/commit";
import { loadCommittedPlanHandleBindings } from "@/lib/agent/change-set/store";
import { readToolLookupDefinitions } from "@/lib/agent/lookupContext";
import { resolveAuthorizedAppSnapshot } from "@/lib/db/appAccess";
import { loadAppInTransaction } from "@/lib/db/apps";
import { nonRetiredDesignSession } from "@/lib/db/designSessionReadScope";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	DesignArtifactStoreError,
	type DesignArtifactWriteAuthority,
	readDesignBuildPlan,
	readDesignRevision,
} from "./artifactStore";
import {
	assessCanonicalPlan,
	type CanonicalConformance,
	canonicalConformanceSchema,
} from "./canonicalConformance";
import {
	designArtifactEnvelopeSchema,
	sealArtifactEnvelope,
	verifyArtifactEnvelope,
} from "./envelope";

const envelopeSchema = designArtifactEnvelopeSchema(
	"design-conformance",
	canonicalConformanceSchema,
);
type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;

/** Production entry: all assessment inputs come from authorized canonical
 * state and immutable accepted artifacts, never a model-supplied candidate. */
export async function recordCanonicalConformance(args: {
	designSessionId: string;
	appId: string;
	designRevisionId: string;
	buildPlanId: string;
	authority: DesignArtifactWriteAuthority;
}) {
	const access = await resolveAuthorizedAppSnapshot(
		args.appId,
		args.authority.actorUserId,
		"view",
	);
	const [revision, plan] = await Promise.all([
		readDesignRevision(args.designRevisionId),
		readDesignBuildPlan(args.buildPlanId),
	]);
	if (!revision || !plan)
		throw new DesignArtifactStoreError(
			"The accepted design or build plan is unavailable.",
		);
	const doc = hydratePersistedBlueprint(access.app.blueprint);
	const [receipts, bindings, lookup] = await Promise.all([
		readCommittedSliceReceiptsForPlan(plan.id),
		loadCommittedPlanHandleBindings({
			designSessionId: args.designSessionId,
			designRevisionId: revision.id,
			designRevisionDigest: revision.artifactDigest,
			buildPlanId: plan.id,
			buildPlanDigest: plan.artifactDigest,
			appId: args.appId,
			throughSeq: access.baseSeq,
		}),
		readToolLookupDefinitions(
			{
				projectId: access.projectId,
				actorId: args.authority.actorUserId,
				role: access.role,
			},
			extractLookupReferenceTargets(doc).tableIds,
		),
	]);
	const assessment = assessCanonicalPlan({
		designSessionId: args.designSessionId,
		revision,
		plan,
		doc,
		appSeq: access.baseSeq,
		bindings,
		receipts,
		tables: lookup.definitions,
	});
	return insertConformanceReport({
		designSessionId: args.designSessionId,
		assessment,
		authority: args.authority,
	});
}

/** Internal artifact read. User-facing callers authorize the app separately. */
export async function readConformanceReport(id: string, handle?: Db) {
	const db = handle ?? (await getAppDb());
	const row = await db
		.selectFrom("design_conformance_reports")
		.select([
			"id",
			"design_session_id",
			"design_revision_id",
			"build_plan_id",
			"app_id",
			"app_seq",
			"snapshot_digest",
			"assessment_digest",
			"artifact_digest",
		])
		.select(sql<string>`envelope::text`.as("envelope_text"))
		.where("id", "=", id)
		.where(
			nonRetiredDesignSession(
				sql.ref("design_conformance_reports.design_session_id"),
			),
		)
		.executeTakeFirst();
	if (!row) return null;
	const envelope = envelopeSchema.parse(
		parsePersistedJsonText(row.envelope_text, `conformance report ${id}`),
	);
	verifyArtifactEnvelope(envelope);
	const assessment = envelope.payload;
	if (
		envelope.artifactId !== row.id ||
		envelope.artifactDigest !== row.artifact_digest ||
		envelope.designSessionId !== row.design_session_id ||
		assessment.designRevisionId !== row.design_revision_id ||
		assessment.buildPlanId !== row.build_plan_id ||
		assessment.appId !== row.app_id ||
		assessment.appSeq !==
			safePersistedSequence(row.app_seq, "conformance app sequence") ||
		assessment.snapshotDigest !== row.snapshot_digest ||
		canonicalJsonDigest(assessment) !== row.assessment_digest
	)
		throw new DesignArtifactStoreError(
			"A conformance report disagrees with its stored identity or digest.",
		);
	return envelope;
}

/** Append an assessment only while its exact app head and reviewed lineage
 * are current under the run's authority lock. Retries reuse the sealed row. */
export async function insertConformanceReport(args: {
	designSessionId: string;
	assessment: CanonicalConformance;
	authority: DesignArtifactWriteAuthority;
}) {
	const assessment = canonicalConformanceSchema.parse(args.assessment);
	const [revision, plan] = await Promise.all([
		readDesignRevision(assessment.designRevisionId),
		readDesignBuildPlan(assessment.buildPlanId),
	]);
	if (
		!revision ||
		!plan ||
		revision.lifecycle !== "accepted" ||
		revision.designSessionId !== args.designSessionId ||
		plan.designSessionId !== args.designSessionId ||
		plan.designRevisionId !== revision.id ||
		plan.designRevisionDigest !== revision.artifactDigest ||
		revision.artifactDigest !== assessment.designRevisionDigest ||
		plan.artifactDigest !== assessment.buildPlanDigest
	)
		throw new DesignArtifactStoreError(
			"Conformance must name one exact accepted revision and its build plan.",
		);
	const assessmentDigest = canonicalJsonDigest(assessment);
	return withAppTx(async (tx) => {
		const scope = await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.designSessionId,
			actorUserId: args.authority.actorUserId,
			expectedProjectId: args.authority.expectedProjectId,
			holder: {
				mode: "build",
				runId: args.authority.runId,
				nonce: args.authority.holderNonce,
			},
		});
		if (scope.appId !== assessment.appId)
			throw new DesignArtifactStoreError(
				"Conformance names a different app from its design session.",
			);
		const app = await loadAppInTransaction(tx, assessment.appId);
		const session = await tx
			.selectFrom("design_sessions")
			.select(["active_design_revision_id", "active_build_plan_id"])
			.where("id", "=", args.designSessionId)
			.executeTakeFirstOrThrow();
		if (
			!app ||
			app.mutation_seq !== assessment.appSeq ||
			canonicalJsonDigest(app.blueprint) !== assessment.snapshotDigest ||
			session.active_design_revision_id !== revision.id ||
			session.active_build_plan_id !== plan.id
		)
			throw new DesignArtifactStoreError(
				"The app or accepted design changed before conformance was recorded.",
			);
		const existing = await tx
			.selectFrom("design_conformance_reports")
			.select("id")
			.where("design_session_id", "=", args.designSessionId)
			.where("build_plan_id", "=", plan.id)
			.where("app_id", "=", assessment.appId)
			.where("app_seq", "=", assessment.appSeq)
			.where("assessment_digest", "=", assessmentDigest)
			.executeTakeFirst();
		if (existing) {
			const report = await readConformanceReport(existing.id, tx);
			if (!report)
				throw new DesignArtifactStoreError(
					"A conformance retry lost its existing report.",
				);
			return report;
		}
		const envelope = envelopeSchema.parse(
			sealArtifactEnvelope({
				artifactType: "design-conformance",
				artifactSchemaVersion: assessment.schemaVersion,
				artifactId: crypto.randomUUID(),
				designSessionId: args.designSessionId,
				revision: revision.revision,
				parentArtifactId: plan.id,
				sourcePackageDigest: revision.sourcePackageDigest,
				inputArtifactDigests: [
					revision.artifactDigest,
					plan.artifactDigest,
					assessment.projectionDigest,
				],
				promptVersion: `conformance-${assessment.ruleVersion}`,
				producer: {
					provider: "nova",
					modelId: "deterministic",
					finishReason: null,
				},
				createdAt: new Date().toISOString(),
				payload: assessment,
			}),
		);
		verifyArtifactEnvelope(envelope);
		await tx
			.insertInto("design_conformance_reports")
			.values({
				id: envelope.artifactId,
				design_session_id: args.designSessionId,
				design_revision_id: revision.id,
				build_plan_id: plan.id,
				app_id: assessment.appId,
				app_seq: assessment.appSeq,
				snapshot_digest: assessment.snapshotDigest,
				assessment_digest: assessmentDigest,
				artifact_digest: envelope.artifactDigest,
				created_by_run_id: args.authority.runId,
				envelope: JSON.stringify(envelope),
			})
			.execute();
		const report = await readConformanceReport(envelope.artifactId, tx);
		if (!report)
			throw new DesignArtifactStoreError(
				"The conformance report vanished after insertion.",
			);
		return report;
	});
}
