/**
 * Artifact-store integrity against a real Postgres: insert-only rows,
 * digest binding on write AND read, predecessor proofs, disposition
 * closure at the persistence boundary, and fail-closed unknown dialects.
 */

import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import {
	briefDigest,
	deriveSliceExecutionBrief,
} from "@/lib/agent/build/executionBrief";
import { beginOrRecoverSliceAttempt } from "@/lib/agent/build/sliceAttempts";
import { emptyGenesisBase } from "@/lib/agent/change-set/baseLoader";
import { beginGenesisChangeSet } from "@/lib/agent/change-set/store";
import {
	countDesignRevisions,
	DesignArtifactStoreError,
	type DesignArtifactWriteAuthority,
	type DesignRevisionRecord,
	insertDesignBuildPlan as insertDesignBuildPlanAuthorized,
	insertDesignReview as insertDesignReviewAuthorized,
	insertDesignRevision as insertDesignRevisionAuthorized,
	insertDesignSourcePackage as insertDesignSourcePackageAuthorized,
	readDesignBuildPlan,
	readDesignReviews,
	readDesignReviewsForRevisions,
	readDesignRevision,
	readDesignRevisionsForSession,
	readDesignSourcePackage,
	readDispositions,
	readLatestAcceptedDesignRevision,
	readLatestDesignRevision,
} from "@/lib/agent/design/artifactStore";
import { type BuildPlan, deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import {
	type DesignArtifactEnvelope,
	sealArtifactEnvelope,
	type UnsealedDesignArtifactEnvelope,
} from "@/lib/agent/design/envelope";
import { ensureAcceptedLookupMaterialization } from "@/lib/agent/design/lookupMaterialization";
import { projectBuildPlanLookupBindings } from "@/lib/agent/design/lookupMaterializationTypes";
import type { DesignReview } from "@/lib/agent/design/review";
import {
	buildDesignSourcePackage,
	computeSourcePackageDigest,
	type DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { openDesignArtifactWorkspace } from "../artifactWorkspaceStore";
import {
	planEnvelope as producedPlanEnvelope,
	reviewEnvelope as producedReviewEnvelope,
} from "../loop/artifacts";
import {
	addPatientReviewWorkflow,
	did,
	FIXTURE_THREAD_ID,
	fixtureValue,
	ids,
	makeContract,
	makeLookupContract,
	messageRef,
} from "./fixtures";

const h = setupAppStateTestDb("design_artifacts_", {
	poolMax: 3,
	authSchema: "migrated",
});

const RUN_ID = "run-unit-c-test";
const ACTOR = "owner-test";
const PROJECT = "proj-1";
const NONCE = "6a0a35a4-1111-4222-8333-944445555667";
let sessionId: string;
let packageFixture: DesignSourcePackage;

function authority(runId: string): DesignArtifactWriteAuthority {
	return {
		actorUserId: ACTOR,
		runId,
		holderNonce: NONCE,
		expectedProjectId: PROJECT,
	};
}

async function insertDesignSourcePackage(
	args: Omit<
		Parameters<typeof insertDesignSourcePackageAuthorized>[0],
		"authority"
	> & {
		runId: string;
	},
) {
	const { runId, ...rest } = args;
	return insertDesignSourcePackageAuthorized({
		...rest,
		authority: authority(runId),
	});
}

async function insertDesignRevision(
	args: Omit<
		Parameters<typeof insertDesignRevisionAuthorized>[0],
		"authority"
	> & {
		runId: string;
	},
) {
	const { runId, ...rest } = args;
	return insertDesignRevisionAuthorized({
		...rest,
		authority: authority(runId),
	});
}

async function insertDesignReview(
	args: Omit<
		Parameters<typeof insertDesignReviewAuthorized>[0],
		"authority"
	> & {
		runId: string;
	},
) {
	const { runId, ...rest } = args;
	return insertDesignReviewAuthorized({ ...rest, authority: authority(runId) });
}

async function insertDesignBuildPlan(
	args: Omit<
		Parameters<typeof insertDesignBuildPlanAuthorized>[0],
		"authority"
	> & {
		runId: string;
	},
) {
	const { runId, ...rest } = args;
	return insertDesignBuildPlanAuthorized({
		...rest,
		authority: authority(runId),
	});
}

function makePackage(): DesignSourcePackage {
	return structuredClone(packageFixture);
}

function draftEnvelope(
	pkg: DesignSourcePackage,
	contract: AppDesignContract = makeContract(),
): DesignArtifactEnvelope<AppDesignContract> {
	return sealArtifactEnvelope({
		artifactType: "design-contract",
		artifactSchemaVersion: contract.schemaVersion,
		artifactId: crypto.randomUUID(),
		designSessionId: sessionId,
		revision: 1,
		parentArtifactId: null,
		sourcePackageDigest: pkg.packageDigest,
		inputArtifactDigests: [],
		promptVersion: "design-author-v1",
		producer: { provider: "openai", modelId: "gpt-test", finishReason: "stop" },
		createdAt: new Date().toISOString(),
		payload: contract,
	});
}

function reviewEnvelope(
	draft: DesignRevisionRecord,
	review: DesignReview,
): DesignArtifactEnvelope<DesignReview> {
	return producedReviewEnvelope({ draft, review, finishReason: "stop" });
}

function acceptedEnvelope(
	draft: DesignRevisionRecord,
	reviewDigest: string,
	contract: AppDesignContract = makeContract(),
): DesignArtifactEnvelope<AppDesignContract> {
	return sealArtifactEnvelope({
		artifactType: "design-contract",
		artifactSchemaVersion: contract.schemaVersion,
		artifactId: crypto.randomUUID(),
		designSessionId: sessionId,
		revision: draft.revision + 1,
		parentArtifactId: draft.id,
		sourcePackageDigest: draft.sourcePackageDigest,
		inputArtifactDigests: [draft.artifactDigest, reviewDigest],
		promptVersion: "design-reviser-v1",
		producer: { provider: "openai", modelId: "gpt-test", finishReason: "stop" },
		createdAt: new Date().toISOString(),
		payload: contract,
	});
}

/** Re-seal an envelope with overrides — the tests' way of building a
 *  coherently-digested envelope that VIOLATES a store rule. */
function reseal<P>(
	envelope: DesignArtifactEnvelope<P>,
	overrides: Partial<UnsealedDesignArtifactEnvelope<P>>,
): DesignArtifactEnvelope<P> {
	const { artifactDigest: _sealed, ...unsealed } = envelope;
	return sealArtifactEnvelope({ ...unsealed, ...overrides });
}

function emptyReview(): DesignReview {
	return {
		schemaVersion: 1,
		id: did(400),
		summary: "Coherent; no gating findings.",
		findings: [],
	};
}

function planEnvelope(
	accepted: DesignRevisionRecord,
	plan?: BuildPlan,
): DesignArtifactEnvelope<BuildPlan> {
	const payload =
		plan ??
		deriveBuildPlan({
			contract: accepted.envelope.payload,
			revision: { id: accepted.id, digest: accepted.artifactDigest },
		});
	return producedPlanEnvelope({
		accepted,
		packageDigest: accepted.sourcePackageDigest,
		plan: payload,
		finishReason: "stop",
	});
}

async function persistAcceptedRevision(
	contract: AppDesignContract = makeContract(),
): Promise<{
	accepted: DesignRevisionRecord;
	draft: DesignRevisionRecord;
}> {
	const pkg = makePackage();
	await insertDesignSourcePackage({ pkg, runId: RUN_ID });
	const draft = await insertDesignRevision({
		envelope: draftEnvelope(pkg, contract),
		lifecycle: "draft",
		runId: RUN_ID,
	});
	const review = await insertDesignReview({
		envelope: reviewEnvelope(draft, emptyReview()),
		designRevisionId: draft.id,
		runId: RUN_ID,
	});
	const accepted = await insertDesignRevision({
		envelope: acceptedEnvelope(draft, review.artifactDigest, contract),
		lifecycle: "accepted",
		runId: RUN_ID,
		dispositions: [],
	});
	return { accepted, draft };
}

beforeEach(async () => {
	/* The design_sessions FK landed with the design-session unit: every
	 * artifact row's session id must reference a real session row. */
	sessionId = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		run_id: RUN_ID,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 60_000),
		reservation: {
			period: "2026-08",
			reserved: 1,
			settled: false,
			userId: ACTOR,
			runId: RUN_ID,
		},
	});
	packageFixture = await buildDesignSourcePackage({
		designSessionId: sessionId,
		projectId: PROJECT,
		threadId: FIXTURE_THREAD_ID,
		messages: [
			{
				id: "m1",
				role: "user",
				parts: [{ type: "text", text: "Track CHW visits." }],
			},
		],
		deps: {
			async loadAssets(ids) {
				if (ids.length) throw new Error("Text-only fixture requested assets");
				return [];
			},
			async readExtract() {
				throw new Error("Text-only fixture requested extracts");
			},
			async loadImage() {
				throw new Error("Text-only fixture requested images");
			},
		},
	});
});

describe("source packages", () => {
	it("refuses a write from a run whose holder nonce was superseded", async () => {
		await h
			.db()
			.updateTable("design_sessions")
			.set({ run_holder_nonce: crypto.randomUUID() })
			.where("id", "=", sessionId)
			.execute();
		await expect(
			insertDesignSourcePackage({ pkg: makePackage(), runId: RUN_ID }),
		).rejects.toMatchObject({ name: "RunHolderLostError" });
	});

	it("persists references + claims and converges on an identical rebuild", async () => {
		const pkg = makePackage();
		const first = await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const second = await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		expect(second.id).toBe(first.id);
		const read = await readDesignSourcePackage(sessionId, pkg.packageDigest);
		expect(read?.payload.sources).toHaveLength(1);
		expect(read?.payload.requestBlockCount).toBe(1);
		// No extract bodies in the persisted payload — references only.
		expect(JSON.stringify(read?.payload)).not.toContain("Track CHW visits");
	});

	it("refuses a package mutated after sealing", async () => {
		const pkg = makePackage();
		pkg.projectId = "proj-2";
		await expect(
			insertDesignSourcePackage({ pkg, runId: RUN_ID }),
		).rejects.toThrow(DesignArtifactStoreError);
	});

	it("refuses a validly sealed package for a foreign Project", async () => {
		const { packageDigest: _oldDigest, ...base } = makePackage();
		const unsealed = { ...base, projectId: "proj-2" };
		const pkg: DesignSourcePackage = {
			...unsealed,
			packageDigest: computeSourcePackageDigest(unsealed),
		};
		await expect(
			insertDesignSourcePackage({ pkg, runId: RUN_ID }),
		).rejects.toThrow(
			"The source package Project does not match its authorized design session.",
		);
	});
});

describe("contract revisions", () => {
	it("persists a draft and re-proves the graph + digest on read", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		const read = await readDesignRevision(draft.id);
		expect(read?.lifecycle).toBe("draft");
		expect(read?.envelope.payload.charter.appName).toBe("CHW patient visits");
		expect(read?.artifactDigest).toBe(draft.artifactDigest);
	});

	it("accepts normalized semantics from a legacy raw-digest draft without rewriting its lineage", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const currentContract = makeContract();
		addPatientReviewWorkflow(currentContract);
		const currentModule = fixtureValue(
			currentContract.moduleCompositions[0],
			"patient module composition",
		);
		currentModule.selection = {
			workflowIds: [ids.taskVisit, ids.taskReview],
			cases: "one",
		};
		const legacyPayload = structuredClone(currentContract) as unknown as Record<
			string,
			unknown
		>;
		const legacyModule = fixtureValue(
			(legacyPayload.moduleCompositions as Array<Record<string, unknown>>)[0],
			"patient module composition",
		);
		const legacyList = fixtureValue(
			(legacyPayload.lists as Array<Record<string, unknown>>)[0],
			"patient list",
		);
		delete legacyModule.selection;
		delete legacyList.selection;
		legacyList.selectionWorkflowId = ids.taskVisit;

		const { artifactDigest: _currentDigest, ...draftFields } = draftEnvelope(
			pkg,
			currentContract,
		);
		const legacyEnvelope = sealArtifactEnvelope({
			...draftFields,
			payload: legacyPayload,
		});
		const rawContractDigest = canonicalJsonDigest(legacyPayload);
		await h
			.db()
			.insertInto("design_revisions")
			.values({
				id: legacyEnvelope.artifactId,
				design_session_id: sessionId,
				revision: 1,
				parent_revision_id: null,
				lifecycle: "draft",
				artifact_digest: legacyEnvelope.artifactDigest,
				contract_digest: rawContractDigest,
				source_package_digest: pkg.packageDigest,
				producer_model: legacyEnvelope.producer.modelId,
				prompt_version: legacyEnvelope.promptVersion,
				created_by_run_id: RUN_ID,
				envelope: JSON.stringify(legacyEnvelope),
			})
			.execute();

		const draft = await readDesignRevision(legacyEnvelope.artifactId);
		if (draft === null) throw new Error("legacy draft was not readable");
		expect(draft.contractDigest).toBe(rawContractDigest);
		expect(draft.envelope.payload.moduleCompositions[0]?.selection).toEqual({
			workflowIds: [ids.taskVisit, ids.taskReview],
			cases: "one",
		});
		expect(draft.envelope.payload.lists[0]).not.toHaveProperty(
			"selectionWorkflowId",
		);
		const normalizedContractDigest = canonicalJsonDigest(
			draft.envelope.payload,
		);
		expect(normalizedContractDigest).not.toBe(rawContractDigest);

		const review = await insertDesignReview({
			envelope: reviewEnvelope(draft, emptyReview()),
			designRevisionId: draft.id,
			runId: RUN_ID,
		});
		const accepted = await insertDesignRevision({
			envelope: acceptedEnvelope(
				draft,
				review.artifactDigest,
				draft.envelope.payload,
			),
			lifecycle: "accepted",
			runId: RUN_ID,
			dispositions: [],
		});

		expect(accepted.parentRevisionId).toBe(draft.id);
		expect(accepted.envelope.inputArtifactDigests).toContain(
			legacyEnvelope.artifactDigest,
		);
		expect(accepted.contractDigest).toBe(normalizedContractDigest);
		expect(
			(await readDesignRevision(accepted.id))?.envelope.payload
				.moduleCompositions[0]?.selection,
		).toEqual({
			workflowIds: [ids.taskVisit, ids.taskReview],
			cases: "one",
		});
	});

	it("refuses a revision without its persisted source package", async () => {
		const pkg = makePackage();
		await expect(
			insertDesignRevision({
				envelope: draftEnvelope(pkg),
				lifecycle: "draft",
				runId: RUN_ID,
			}),
		).rejects.toThrow(/persisted source package/);
	});

	it("refuses an envelope whose stored body was tampered with, on read", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		// Simulate drift below the store: rewrite one envelope field in place.
		await sql`
			UPDATE design_revisions
			SET envelope = jsonb_set(envelope, '{promptVersion}', '"tampered-v9"')
			WHERE id = ${draft.id}
		`.execute(h.db());
		await expect(readDesignRevision(draft.id)).rejects.toThrow(
			/does not match its recorded digest/,
		);
	});

	it("refuses a revision whose relational raw contract digest drifted", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		await h
			.db()
			.updateTable("design_revisions")
			.set({ contract_digest: "d".repeat(64) })
			.where("id", "=", draft.id)
			.execute();

		await expect(readDesignRevision(draft.id)).rejects.toThrow(/raw digest/);
	});

	it("fails closed on an unknown envelope dialect", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		await sql`
			UPDATE design_revisions
			SET envelope = envelope || '{"surpriseKey": true}'::jsonb
			WHERE id = ${draft.id}
		`.execute(h.db());
		await expect(readDesignRevision(draft.id)).rejects.toThrow();
	});

	it("refuses acceptance without a persisted review of the parent draft", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		await expect(
			insertDesignRevision({
				envelope: acceptedEnvelope(draft, "c".repeat(64)),
				lifecycle: "accepted",
				runId: RUN_ID,
			}),
		).rejects.toThrow(/requires a persisted review/);
	});

	it("binds clean-review acceptance to the exact reviewed contract and source package", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		const review = await insertDesignReview({
			envelope: reviewEnvelope(draft, emptyReview()),
			designRevisionId: draft.id,
			runId: RUN_ID,
		});

		const changedContract = makeContract();
		changedContract.charter.appName = "Unreviewed replacement";
		await expect(
			insertDesignRevision({
				envelope: acceptedEnvelope(
					draft,
					review.artifactDigest,
					changedContract,
				),
				lifecycle: "accepted",
				runId: RUN_ID,
			}),
		).rejects.toThrow(/contract semantics and exact source package/);

		const { packageDigest: _oldDigest, ...sourceBase } = makePackage();
		const changedSourceUnsealed = {
			...sourceBase,
			request: {
				blocks: [
					{
						ref: messageRef(),
						text: "Unreviewed additional requirement.",
						truncated: false,
					},
				],
			},
		};
		const changedSource: DesignSourcePackage = {
			...changedSourceUnsealed,
			packageDigest: computeSourcePackageDigest(changedSourceUnsealed),
		};
		await insertDesignSourcePackage({ pkg: changedSource, runId: RUN_ID });
		await expect(
			insertDesignRevision({
				envelope: reseal(acceptedEnvelope(draft, review.artifactDigest), {
					sourcePackageDigest: changedSource.packageDigest,
				}),
				lifecycle: "accepted",
				runId: RUN_ID,
			}),
		).rejects.toThrow(/contract semantics and exact source package/);
	});

	it("persists dispositions on a revised draft and accepts only after its clean review", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		const review = await insertDesignReview({
			envelope: reviewEnvelope(draft, {
				schemaVersion: 1,
				id: did(400),
				summary: "One important usability correction.",
				findings: [
					{
						id: did(401),
						severity: "important",
						dispositionClass: "design-correction",
						claim: "Queue names could be shorter.",
						evidenceRefs: [messageRef()],
						affectedElementIds: [ids.rmPatients],
					},
				],
			}),
			designRevisionId: draft.id,
			runId: RUN_ID,
		});
		await expect(
			insertDesignRevision({
				envelope: acceptedEnvelope(draft, review.artifactDigest),
				lifecycle: "accepted",
				runId: RUN_ID,
				dispositions: [
					{
						reviewId: review.id,
						disposition: {
							findingId: did(401),
							status: "rejected",
							rationale: "The queue name mirrors the workers' own vocabulary.",
						},
					},
				],
			}),
		).rejects.toThrow(/latest independent review.*no blocking findings/);

		const revisedDraft = await insertDesignRevision({
			envelope: acceptedEnvelope(draft, review.artifactDigest),
			lifecycle: "draft",
			runId: RUN_ID,
			dispositions: [
				{
					reviewId: review.id,
					disposition: {
						findingId: did(401),
						status: "rejected",
						rationale: "The queue name mirrors the workers' own vocabulary.",
					},
				},
			],
		});
		expect(revisedDraft.lifecycle).toBe("draft");
		expect(await readLatestAcceptedDesignRevision(sessionId)).toBeNull();

		const cleanReview = await insertDesignReview({
			envelope: reviewEnvelope(revisedDraft, emptyReview()),
			designRevisionId: revisedDraft.id,
			runId: RUN_ID,
		});
		const accepted = await insertDesignRevision({
			envelope: acceptedEnvelope(revisedDraft, cleanReview.artifactDigest),
			lifecycle: "accepted",
			runId: RUN_ID,
		});
		expect(accepted.lifecycle).toBe("accepted");
		expect(accepted.parentRevisionId).toBe(revisedDraft.id);

		const latest = await readLatestAcceptedDesignRevision(sessionId);
		expect(latest?.id).toBe(accepted.id);

		const dispositions = await readDispositions(review.id);
		expect(dispositions).toHaveLength(1);
		expect(dispositions[0]?.resultingRevisionId).toBe(revisedDraft.id);
		expect(dispositions[0]?.disposition.status).toBe("rejected");

		const reviews = await readDesignReviews(draft.id);
		expect(reviews).toHaveLength(1);
		expect(reviews[0]?.reviewedRevisionDigest).toBe(draft.artifactDigest);
	});
});

describe("reviews", () => {
	it("refuses a review whose source package differs from the revision's", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		const drifted = reseal(reviewEnvelope(draft, emptyReview()), {
			sourcePackageDigest: "d".repeat(64),
		});
		await expect(
			insertDesignReview({
				envelope: drifted,
				designRevisionId: draft.id,
				runId: RUN_ID,
			}),
		).rejects.toThrow(/same source package/);
	});
});

describe("build plans", () => {
	it("retires a historical plan's open attempt and change set with its replacement draft", async () => {
		const { accepted } = await persistAcceptedRevision();
		const storedPlan = await insertDesignBuildPlan({
			envelope: planEnvelope(accepted),
			runId: RUN_ID,
		});
		const slice = storedPlan.envelope.payload.slices[0];
		if (slice === undefined) throw new Error("fixture plan has no root slice");
		const session = await h
			.db()
			.selectFrom("design_sessions")
			.select("proposed_app_id")
			.where("id", "=", sessionId)
			.executeTakeFirstOrThrow();
		if (!session.proposed_app_id)
			throw new Error("Fixture session has no proposed app");
		const base = emptyGenesisBase(session.proposed_app_id);
		const brief = deriveSliceExecutionBrief({
			contract: accepted.envelope.payload,
			revision: { id: accepted.id, digest: accepted.artifactDigest },
			plan: storedPlan.envelope.payload,
			sliceId: slice.id,
		});
		const { attempt: runningAttempt } = await beginOrRecoverSliceAttempt({
			designSessionId: sessionId,
			actorUserId: ACTOR,
			runId: RUN_ID,
			holderNonce: NONCE,
			expectedProjectId: PROJECT,
			designRevisionId: accepted.id,
			designRevisionDigest: accepted.artifactDigest,
			buildPlanId: storedPlan.id,
			buildPlanDigest: storedPlan.planDigest,
			sliceId: slice.id,
			baseTarget: {
				kind: "empty-genesis",
				proposedAppId: session.proposed_app_id,
				digest: base.digest,
			},
			executorModel: "offline-fixture",
			promptVersion: "fixture-v1",
			briefDigest: briefDigest(brief),
		});
		const openChangeSet = await beginGenesisChangeSet({
			proposedAppId: session.proposed_app_id,
			projectId: PROJECT,
			baseSnapshotDigest: base.digest,
			lineage: {
				designSessionId: sessionId,
				designRevisionId: accepted.id,
				designRevisionDigest: accepted.artifactDigest,
				buildPlanId: storedPlan.id,
				buildPlanDigest: storedPlan.planDigest,
				sliceId: slice.id,
				attemptId: runningAttempt.id,
			},
			ownerUserId: ACTOR,
			ownerRunId: RUN_ID,
			attemptAuthority: { holderNonce: NONCE, expectedProjectId: PROJECT },
		});
		const attemptId = runningAttempt.id;
		const changeSetId = openChangeSet.id;

		const { packageDigest: _currentDigest, ...current } = makePackage();
		const replacementUnsealed: Omit<DesignSourcePackage, "packageDigest"> = {
			...current,
			request: {
				blocks: [
					{
						ref: messageRef(2),
						text: "Also track referrals.",
						truncated: false,
					},
				],
			},
		};
		const replacementPkg: DesignSourcePackage = {
			...replacementUnsealed,
			packageDigest: computeSourcePackageDigest(replacementUnsealed),
		};
		await insertDesignSourcePackage({ pkg: replacementPkg, runId: RUN_ID });
		await insertDesignRevision({
			envelope: sealArtifactEnvelope({
				artifactType: "design-contract",
				artifactSchemaVersion: 1,
				artifactId: crypto.randomUUID(),
				designSessionId: sessionId,
				revision: accepted.revision + 1,
				parentArtifactId: accepted.id,
				sourcePackageDigest: replacementPkg.packageDigest,
				inputArtifactDigests: [accepted.artifactDigest],
				promptVersion: "design-agent-v1",
				producer: {
					provider: "openai",
					modelId: "gpt-test",
					finishReason: "stop",
				},
				createdAt: new Date().toISOString(),
				payload: makeContract(),
			}),
			lifecycle: "draft",
			runId: RUN_ID,
			supersedeUncommittedExecution: true,
		});

		const [attempt, changeSet] = await Promise.all([
			h
				.db()
				.selectFrom("design_slice_attempts")
				.select(["status", "failure_code"])
				.where("id", "=", attemptId)
				.executeTakeFirstOrThrow(),
			h
				.db()
				.selectFrom("design_change_sets")
				.select("status")
				.where("id", "=", changeSetId)
				.executeTakeFirstOrThrow(),
		]);
		expect(attempt).toEqual({
			status: "superseded",
			failure_code: "artifact-superseded",
		});
		expect(changeSet.status).toBe("superseded");
	});

	it("persists a plan over the accepted revision and reads it back digest-verified", async () => {
		const { accepted } = await persistAcceptedRevision();
		const stored = await insertDesignBuildPlan({
			envelope: planEnvelope(accepted),
			runId: RUN_ID,
		});
		const read = await readDesignBuildPlan(stored.id);
		if (read === null) throw new Error("Missing stored plan");
		expect(read.designRevisionDigest).toBe(accepted.artifactDigest);
		expect(read.envelope.payload.slices).toHaveLength(2);
	});

	it("normalizes an omitted additive plan member only after verifying its sealed body", async () => {
		const { accepted } = await persistAcceptedRevision();
		const currentPlan: BuildPlan = {
			...deriveBuildPlan({
				contract: accepted.envelope.payload,
				revision: { id: accepted.id, digest: accepted.artifactDigest },
			}),
			designRevisionId: accepted.id,
			designRevisionDigest: accepted.artifactDigest,
		};
		const {
			lookupMaterialization: _addedAfterThisPlanWasStored,
			...storedPayload
		} = currentPlan;
		const storedEnvelope = sealArtifactEnvelope({
			artifactType: "design-build-plan" as const,
			artifactSchemaVersion: storedPayload.schemaVersion,
			artifactId: crypto.randomUUID(),
			designSessionId: sessionId,
			revision: accepted.revision,
			parentArtifactId: accepted.id,
			sourcePackageDigest: accepted.sourcePackageDigest,
			inputArtifactDigests: [accepted.artifactDigest],
			promptVersion: "design-planner-v1",
			producer: {
				provider: "openai",
				modelId: "gpt-test",
				finishReason: "stop",
			},
			createdAt: new Date().toISOString(),
			payload: storedPayload,
		});
		await h
			.db()
			.insertInto("design_build_plans")
			.values({
				id: storedPayload.id,
				design_session_id: sessionId,
				design_revision_id: accepted.id,
				design_revision_digest: accepted.artifactDigest,
				plan_digest: canonicalJsonDigest(storedPayload),
				artifact_digest: storedEnvelope.artifactDigest,
				producer_model: storedEnvelope.producer.modelId,
				prompt_version: storedEnvelope.promptVersion,
				created_by_run_id: RUN_ID,
				envelope: JSON.stringify(storedEnvelope),
			})
			.execute();

		const read = await readDesignBuildPlan(storedPayload.id);
		if (read === null) throw new Error("Missing legacy plan");
		expect(read.envelope.payload.lookupMaterialization).toBeNull();
		expect(read.artifactDigest).toBe(storedEnvelope.artifactDigest);
		expect(read.planDigest).toBe(canonicalJsonDigest(storedPayload));
	});

	it("refuses a plan over a draft revision", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: RUN_ID });
		const draft = await insertDesignRevision({
			envelope: draftEnvelope(pkg),
			lifecycle: "draft",
			runId: RUN_ID,
		});
		await expect(
			insertDesignBuildPlan({
				envelope: planEnvelope(draft),
				runId: RUN_ID,
			}),
		).rejects.toThrow(/ACCEPTED contract revision/);
	});

	it("refuses a plan derived from a different revision digest", async () => {
		const { accepted } = await persistAcceptedRevision();
		const envelope = reseal(planEnvelope(accepted), {
			payload: {
				...deriveBuildPlan({
					contract: accepted.envelope.payload,
					revision: { id: accepted.id, digest: accepted.artifactDigest },
				}),
				designRevisionId: accepted.id,
				designRevisionDigest: "e".repeat(64),
			},
		});
		await expect(
			insertDesignBuildPlan({ envelope, runId: RUN_ID }),
		).rejects.toThrow(/derived from something else/);
	});

	it("refuses a lookup plan until its exact materialization receipt is bound", async () => {
		const contract = makeLookupContract();
		const { accepted } = await persistAcceptedRevision(contract);
		const noLookupPlan = deriveBuildPlan({
			contract: makeContract(),
			revision: { id: accepted.id, digest: accepted.artifactDigest },
		});
		await expect(
			insertDesignBuildPlan({
				envelope: planEnvelope(accepted, noLookupPlan),
				runId: RUN_ID,
			}),
		).rejects.toThrow(/no durable lookup materialization receipt/);
	});

	it("persists a BuildPlan only with the receipt's exact digest-bound identity mapping", async () => {
		const contract = makeLookupContract();
		const { accepted } = await persistAcceptedRevision(contract);
		const receipt = await ensureAcceptedLookupMaterialization({
			designSessionId: sessionId,
			designRevisionId: accepted.id,
			designRevisionDigest: accepted.artifactDigest,
			contract,
			authority: authority(RUN_ID),
		});
		if (receipt === null) throw new Error("Expected a lookup receipt.");
		const lookupMaterialization = {
			receiptId: receipt.id,
			resultDigest: receipt.resultDigest,
			projectRevision: receipt.payload.projectRevision,
			bindings: projectBuildPlanLookupBindings(receipt.payload.bindings),
		};
		const plan = deriveBuildPlan({
			contract,
			revision: { id: accepted.id, digest: accepted.artifactDigest },
			lookupMaterialization,
		});
		const stored = await insertDesignBuildPlan({
			envelope: planEnvelope(accepted, plan),
			runId: RUN_ID,
		});
		expect(stored.envelope.payload.schemaVersion).toBe(2);
		expect(
			receipt.payload.bindings.filter(
				(binding) => binding.kind === "lookup-row",
			),
		).toHaveLength(2);
		expect(
			stored.envelope.payload.lookupMaterialization?.bindings,
		).toHaveLength(3);

		const tampered = structuredClone(plan);
		if (tampered.lookupMaterialization === null)
			throw new Error("Expected a materialized BuildPlan.");
		tampered.lookupMaterialization.bindings =
			tampered.lookupMaterialization.bindings.slice(1);
		await expect(
			insertDesignBuildPlan({
				envelope: planEnvelope(accepted, {
					...tampered,
					id: crypto.randomUUID(),
				}),
				runId: RUN_ID,
			}),
		).rejects.toThrow(/exact digest-bound lookup identity mapping/);
	});
});

describe("artifact predecessor and relational integrity", () => {
	it.each(["parent", "revision"] as const)(
		"refuses a review with a false sealed %s",
		async (field) => {
			const { draft } = await persistAcceptedRevision();
			const envelope = reseal(
				reviewEnvelope(draft, emptyReview()),
				field === "parent"
					? { parentArtifactId: crypto.randomUUID() }
					: { revision: draft.revision + 4 },
			);
			await expect(
				insertDesignReview({
					envelope,
					designRevisionId: draft.id,
					runId: RUN_ID,
				}),
			).rejects.toThrow(DesignArtifactStoreError);
			expect(await readDesignReviews(draft.id)).toHaveLength(1);
		},
	);
	it.each(["parent", "revision", "source"] as const)(
		"refuses a plan with a false sealed %s",
		async (field) => {
			const { accepted } = await persistAcceptedRevision();
			const overrides =
				field === "parent"
					? { parentArtifactId: crypto.randomUUID() }
					: field === "revision"
						? { revision: accepted.revision + 4 }
						: { sourcePackageDigest: "e".repeat(64) };
			const envelope = reseal(planEnvelope(accepted), overrides);
			await expect(
				insertDesignBuildPlan({ envelope, runId: RUN_ID }),
			).rejects.toThrow(DesignArtifactStoreError);
			expect(await readDesignBuildPlan(envelope.payload.id)).toBeNull();
		},
	);
	it.each(["source", "revision", "parent"] as const)(
		"refuses a revision whose relational %s changed beneath the envelope",
		async (field) => {
			const { accepted } = await persistAcceptedRevision();
			if (field === "source")
				await h
					.db()
					.updateTable("design_revisions")
					.set({ source_package_digest: "e".repeat(64) })
					.where("id", "=", accepted.id)
					.execute();
			if (field === "revision")
				await h
					.db()
					.updateTable("design_revisions")
					.set({ revision: 8 })
					.where("id", "=", accepted.id)
					.execute();
			if (field === "parent")
				await h
					.db()
					.updateTable("design_revisions")
					.set({ parent_revision_id: accepted.id })
					.where("id", "=", accepted.id)
					.execute();
			await expect(readDesignRevision(accepted.id)).rejects.toThrow(
				DesignArtifactStoreError,
			);
		},
	);
	it.each(["session", "predecessor", "digest"] as const)(
		"refuses a review whose relational %s changed beneath the envelope",
		async (field) => {
			const { accepted, draft } = await persistAcceptedRevision();
			const [review] = await readDesignReviews(draft.id);
			if (!review) throw new Error("Missing fixture review");
			if (field === "session") {
				const other = await h.seedDesignSession();
				await h
					.db()
					.updateTable("design_reviews")
					.set({ design_session_id: other })
					.where("id", "=", review.id)
					.execute();
			}
			if (field === "predecessor")
				await h
					.db()
					.updateTable("design_reviews")
					.set({ design_revision_id: accepted.id })
					.where("id", "=", review.id)
					.execute();
			if (field === "digest")
				await h
					.db()
					.updateTable("design_reviews")
					.set({ reviewed_revision_digest: "e".repeat(64) })
					.where("id", "=", review.id)
					.execute();
			await expect(
				readDesignReviews(field === "predecessor" ? accepted.id : draft.id),
			).rejects.toThrow(DesignArtifactStoreError);
		},
	);
	it.each(["session", "predecessor", "revisionDigest", "planDigest"] as const)(
		"refuses a plan whose relational %s changed beneath the envelope",
		async (field) => {
			const { accepted, draft } = await persistAcceptedRevision();
			const plan = await insertDesignBuildPlan({
				envelope: planEnvelope(accepted),
				runId: RUN_ID,
			});
			if (field === "session") {
				const other = await h.seedDesignSession();
				await h
					.db()
					.updateTable("design_build_plans")
					.set({ design_session_id: other })
					.where("id", "=", plan.id)
					.execute();
			}
			if (field === "predecessor")
				await h
					.db()
					.updateTable("design_build_plans")
					.set({ design_revision_id: draft.id })
					.where("id", "=", plan.id)
					.execute();
			if (field === "revisionDigest")
				await h
					.db()
					.updateTable("design_build_plans")
					.set({ design_revision_digest: "e".repeat(64) })
					.where("id", "=", plan.id)
					.execute();
			if (field === "planDigest")
				await h
					.db()
					.updateTable("design_build_plans")
					.set({ plan_digest: "e".repeat(64) })
					.where("id", "=", plan.id)
					.execute();
			await expect(readDesignBuildPlan(plan.id)).rejects.toThrow(
				DesignArtifactStoreError,
			);
		},
	);
	it.each(["projectId", "designSessionId"] as const)(
		"refuses source-package %s disagreement",
		async (field) => {
			const pkg = makePackage();
			await insertDesignSourcePackage({ pkg, runId: RUN_ID });
			const wrong =
				field === "projectId" ? "another-project" : crypto.randomUUID();
			await sql`UPDATE design_source_packages SET payload = jsonb_set(payload, ARRAY[${field}]::text[], to_jsonb(${wrong}::text)) WHERE design_session_id=${sessionId}`.execute(
				h.db(),
			);
			await expect(
				readDesignSourcePackage(sessionId, pkg.packageDigest),
			).rejects.toThrow(DesignArtifactStoreError);
		},
	);
});

describe("artifact write authority and transaction ownership", () => {
	it.each(["source", "revision", "review", "plan"] as const)(
		"rechecks current Project permission before a %s write",
		async (kind) => {
			const { accepted, draft } = await persistAcceptedRevision();
			const originalRevisions = await readDesignRevisionsForSession(sessionId);
			const originalReviews = await readDesignReviews(draft.id);
			await h.seedProjectMember(ACTOR, PROJECT, "viewer");
			const write =
				kind === "source"
					? () =>
							insertDesignSourcePackage({ pkg: makePackage(), runId: RUN_ID })
					: kind === "revision"
						? () =>
								insertDesignRevision({
									envelope: reseal(draftEnvelope(makePackage()), {
										revision: 3,
										parentArtifactId: accepted.id,
										inputArtifactDigests: [accepted.artifactDigest],
									}),
									lifecycle: "draft",
									runId: RUN_ID,
								})
						: kind === "review"
							? () =>
									insertDesignReview({
										envelope: reviewEnvelope(draft, emptyReview()),
										designRevisionId: draft.id,
										runId: RUN_ID,
									})
							: () =>
									insertDesignBuildPlan({
										envelope: planEnvelope(accepted),
										runId: RUN_ID,
									});
			await expect(write()).rejects.toThrow();
			expect(await readDesignRevisionsForSession(sessionId)).toEqual(
				originalRevisions,
			);
			expect(await readDesignReviews(draft.id)).toEqual(originalReviews);
			expect(
				await h
					.db()
					.selectFrom("design_build_plans")
					.selectAll()
					.where("design_session_id", "=", sessionId)
					.execute(),
			).toEqual([]);
		},
	);
	it.each(["contract", "revision"] as const)(
		"atomically finalizes its exact %s workspace and rolls back a stale revision",
		async (kind) => {
			const pkg = makePackage();
			await insertDesignSourcePackage({ pkg, runId: RUN_ID });
			const draft =
				kind === "revision"
					? await insertDesignRevision({
							envelope: draftEnvelope(pkg),
							lifecycle: "draft",
							runId: RUN_ID,
						})
					: null;
			const review = draft
				? await insertDesignReview({
						envelope: reviewEnvelope(draft, emptyReview()),
						designRevisionId: draft.id,
						runId: RUN_ID,
					})
				: null;
			const state = await openDesignArtifactWorkspace({
				designSessionId: sessionId,
				lineage: {
					schemaVersion: 1,
					artifactKind: kind,
					sourcePackageDigest: pkg.packageDigest,
					reviewArtifacts: review
						? [{ id: review.id, digest: review.artifactDigest }]
						: [],
					...(draft
						? { baseRevision: { id: draft.id, digest: draft.artifactDigest } }
						: {}),
				},
				authority: authority(RUN_ID),
			});
			const write = (expectedRevision: number) =>
				insertDesignRevision({
					envelope:
						draft && review
							? acceptedEnvelope(
									draft,
									review.artifactDigest,
									draft.envelope.payload,
								)
							: draftEnvelope(pkg),
					lifecycle: "draft",
					runId: RUN_ID,
					workspaceFinalization: {
						workspaceId: state.workspace.id,
						expectedRevision,
						artifactKind: kind,
					},
				});
			const readRow = () =>
				h
					.db()
					.selectFrom("design_artifact_workspaces")
					.selectAll()
					.where("id", "=", state.workspace.id)
					.executeTakeFirstOrThrow();
			const before = await readRow();
			const beforeRevisions = await readDesignRevisionsForSession(sessionId);
			await expect(write(state.workspace.revision + 1)).rejects.toThrow(
				/changed or closed/,
			);
			expect(await readRow()).toEqual(before);
			expect(await readDesignRevisionsForSession(sessionId)).toEqual(
				beforeRevisions,
			);
			const stored = await write(state.workspace.revision);
			expect(await readRow()).toMatchObject({
				status: "finalized",
				finalized_artifact_id: stored.id,
			});
		},
	);
	it.each(["source", "review", "revision"] as const)(
		"observes competing %s writes at the authority lock",
		async (kind) => {
			const pkg = makePackage();
			let draft: DesignRevisionRecord | undefined;
			if (kind === "review") {
				await insertDesignSourcePackage({ pkg, runId: RUN_ID });
				draft = await insertDesignRevision({
					envelope: draftEnvelope(pkg),
					lifecycle: "draft",
					runId: RUN_ID,
				});
			} else if (kind === "revision")
				await insertDesignSourcePackage({ pkg, runId: RUN_ID });
			const run = () =>
				kind === "source"
					? insertDesignSourcePackage({ pkg, runId: RUN_ID })
					: kind === "review" && draft
						? insertDesignReview({
								envelope: reviewEnvelope(draft, emptyReview()),
								designRevisionId: draft.id,
								runId: RUN_ID,
							})
						: insertDesignRevision({
								envelope: draftEnvelope(pkg),
								lifecycle: "draft",
								runId: RUN_ID,
							});
			const results = await whileBlocked(
				h,
				(pg) =>
					pg.query("SELECT id FROM design_sessions WHERE id=$1 FOR UPDATE", [
						sessionId,
					]),
				() => Promise.allSettled([run(), run()]),
				async (settled, pg) => {
					expect(settled).toBe(false);
					const deadline = Date.now() + 2000;
					for (;;) {
						await pg.query("SELECT pg_stat_clear_snapshot()");
						const waits = await pg.query<{ n: number }>(
							"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
						);
						if (waits.rows[0].n >= 2) break;
						if (Date.now() > deadline)
							throw new Error(
								"Both writers did not reach PostgreSQL lock waits",
							);
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
				},
			);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(kind === "revision" ? 1 : 2);
			if (kind === "source") {
				const first = results[0],
					second = results[1];
				if (first.status !== "fulfilled" || second.status !== "fulfilled")
					throw new Error("Source writers failed");
				expect(first.value).toEqual(second.value);
			}
			if (kind === "review" && draft)
				expect(
					(await readDesignReviews(draft.id)).map(
						(review) => review.reviewOrdinal,
					),
				).toEqual([1, 2]);
			if (kind === "revision") {
				expect(await countDesignRevisions(sessionId)).toBe(1);
				const rejected = results.find((result) => result.status === "rejected");
				expect(
					rejected?.status === "rejected" ? rejected.reason : null,
				).toMatchObject({ code: "23505" });
			}
		},
	);
	it("reads revision order and isolated batched review keys without using timestamps", async () => {
		const { draft, accepted } = await persistAcceptedRevision();
		await h
			.db()
			.updateTable("design_revisions")
			.set({ created_at: new Date("2100-01-01T00:00:00Z") })
			.where("id", "=", draft.id)
			.execute();
		expect(
			(await readDesignRevisionsForSession(sessionId)).map((row) => row.id),
		).toEqual([draft.id, accepted.id]);
		expect((await readLatestDesignRevision(sessionId))?.id).toBe(accepted.id);
		const missing = crypto.randomUUID();
		const reviews = await readDesignReviewsForRevisions([
			accepted.id,
			draft.id,
			missing,
			draft.id,
		]);
		expect([...reviews.keys()]).toEqual([accepted.id, draft.id, missing]);
		expect(reviews.get(accepted.id)).toEqual([]);
		expect(reviews.get(missing)).toEqual([]);
		expect(reviews.get(draft.id)?.map((row) => row.designRevisionId)).toEqual([
			draft.id,
		]);
		expect(await readDesignReviewsForRevisions([])).toEqual(new Map());
		expect(await readLatestDesignRevision(missing)).toBeNull();
		expect(await readDesignBuildPlan(missing)).toBeNull();
	});
	it("refuses a disposition for an absent finding even when its review exists", async () => {
		const { draft } = await persistAcceptedRevision();
		const [review] = await readDesignReviews(draft.id);
		if (!review) throw new Error("Missing fixture review");
		const envelope = reseal(
			acceptedEnvelope(draft, review.artifactDigest, draft.envelope.payload),
			{ revision: 3 },
		);
		await expect(
			insertDesignRevision({
				envelope,
				lifecycle: "draft",
				runId: RUN_ID,
				dispositions: [
					{
						reviewId: review.id,
						disposition: {
							findingId: did(799),
							status: "rejected",
							rationale: "Invented finding.",
						},
					},
				],
			}),
		).rejects.toThrow(DesignArtifactStoreError);
		expect(await readDesignRevision(envelope.artifactId)).toBeNull();
		expect(await readDispositions(review.id)).toEqual([]);
	});
});

describe("stored finding dispositions", () => {
	it.each(["finding", "status"] as const)(
		"refuses relational %s disagreement on read",
		async (field) => {
			const pkg = makePackage();
			await insertDesignSourcePackage({ pkg, runId: RUN_ID });
			const draft = await insertDesignRevision({
				envelope: draftEnvelope(pkg),
				lifecycle: "draft",
				runId: RUN_ID,
			});
			const finding = {
				id: did(450),
				severity: "important" as const,
				dispositionClass: "design-correction" as const,
				claim: "Use worker terminology.",
				evidenceRefs: [messageRef()],
				affectedElementIds: [ids.rmPatients],
			};
			const review = await insertDesignReview({
				envelope: reviewEnvelope(draft, {
					...emptyReview(),
					findings: [finding],
				}),
				designRevisionId: draft.id,
				runId: RUN_ID,
			});
			const disposition = {
				findingId: finding.id,
				status: "rejected" as const,
				rationale: "The current terminology comes from the request.",
			};
			const revised = await insertDesignRevision({
				envelope: acceptedEnvelope(
					draft,
					review.artifactDigest,
					draft.envelope.payload,
				),
				lifecycle: "draft",
				runId: RUN_ID,
				dispositions: [{ reviewId: review.id, disposition }],
			});
			expect(await readDispositions(review.id)).toMatchObject([
				{ findingId: finding.id, resultingRevisionId: revised.id, disposition },
			]);
			if (field === "finding")
				await h
					.db()
					.updateTable("design_review_dispositions")
					.set({ finding_id: did(451) })
					.where("review_id", "=", review.id)
					.execute();
			else
				await h
					.db()
					.updateTable("design_review_dispositions")
					.set({ status: "accepted" })
					.where("review_id", "=", review.id)
					.execute();
			await expect(readDispositions(review.id)).rejects.toThrow(
				DesignArtifactStoreError,
			);
		},
	);
});
