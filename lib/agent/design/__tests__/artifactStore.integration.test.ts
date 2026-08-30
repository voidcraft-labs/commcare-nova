/**
 * Artifact-store integrity against a real Postgres: insert-only rows,
 * digest binding on write AND read, predecessor proofs, disposition
 * closure at the persistence boundary, and fail-closed unknown dialects.
 */

import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DesignArtifactStoreError,
	type DesignArtifactWriteAuthority,
	type DesignBuildPlanRecord,
	type DesignRevisionRecord,
	insertDesignBuildPlan as insertDesignBuildPlanAuthorized,
	insertDesignReview as insertDesignReviewAuthorized,
	insertDesignRevision as insertDesignRevisionAuthorized,
	insertDesignSourcePackage as insertDesignSourcePackageAuthorized,
	readDesignBuildPlan,
	readDesignReviews,
	readDesignRevision,
	readDesignSourcePackage,
	readDispositions,
	readLatestAcceptedDesignRevision,
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
	computeSourcePackageDigest,
	type DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	did,
	ids,
	makeBuildPlan,
	makeContract,
	makeLookupContract,
	messageRef,
} from "./fixtures";

const h = setupAppStateTestDb("design_artifacts_");

const RUN_ID = "run-unit-c-test";
const ACTOR = "owner-test";
const PROJECT = "proj-1";
const NONCE = "6a0a35a4-1111-4222-8333-944445555667";
let sessionId: string;

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
	const unsealed: Omit<DesignSourcePackage, "packageDigest"> = {
		schemaVersion: 1,
		designSessionId: sessionId,
		projectId: "proj-1",
		request: {
			blocks: [
				{ ref: messageRef(), text: "Track CHW visits.", truncated: false },
			],
		},
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: [],
		sources: [{ ref: messageRef() }],
	};
	return {
		...unsealed,
		packageDigest: computeSourcePackageDigest(unsealed),
	};
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
	return sealArtifactEnvelope({
		artifactType: "design-review",
		artifactSchemaVersion: 1,
		artifactId: crypto.randomUUID(),
		designSessionId: sessionId,
		revision: draft.revision,
		parentArtifactId: draft.id,
		sourcePackageDigest: draft.sourcePackageDigest,
		inputArtifactDigests: [draft.artifactDigest],
		promptVersion: "design-reviewer-v1",
		producer: { provider: "openai", modelId: "gpt-test", finishReason: "stop" },
		createdAt: new Date().toISOString(),
		payload: review,
	});
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
	const payload: BuildPlan = {
		...(plan ?? makeBuildPlan()),
		designRevisionId: accepted.id,
		designRevisionDigest: accepted.artifactDigest,
	};
	return sealArtifactEnvelope({
		artifactType: "design-build-plan",
		artifactSchemaVersion: payload.schemaVersion,
		artifactId: crypto.randomUUID(),
		designSessionId: sessionId,
		revision: accepted.revision,
		parentArtifactId: accepted.id,
		sourcePackageDigest: accepted.sourcePackageDigest,
		inputArtifactDigests: [
			accepted.artifactDigest,
			...(payload.lookupMaterialization !== null
				? [payload.lookupMaterialization.resultDigest]
				: []),
		],
		promptVersion: "design-planner-v1",
		producer: { provider: "openai", modelId: "gpt-test", finishReason: "stop" },
		createdAt: new Date().toISOString(),
		payload,
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

	it("accepts through a review, lands dispositions atomically, and surfaces the latest accepted", async () => {
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
		const accepted = await insertDesignRevision({
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
		});
		expect(accepted.lifecycle).toBe("accepted");
		expect(accepted.parentRevisionId).toBe(draft.id);

		const latest = await readLatestAcceptedDesignRevision(sessionId);
		expect(latest?.id).toBe(accepted.id);

		const dispositions = await readDispositions(review.id);
		expect(dispositions).toHaveLength(1);
		expect(dispositions[0]?.resultingRevisionId).toBe(accepted.id);
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
		const attemptId = crypto.randomUUID();
		const changeSetId = crypto.randomUUID();
		const proposedAppId = crypto.randomUUID();
		const digest = "a".repeat(64);
		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				await tx
					.updateTable("design_sessions")
					.set({ proposed_app_id: proposedAppId })
					.where("id", "=", sessionId)
					.execute();
				await tx
					.insertInto("design_slice_attempts")
					.values({
						id: attemptId,
						design_session_id: sessionId,
						design_revision_id: accepted.id,
						design_revision_digest: accepted.artifactDigest,
						build_plan_id: storedPlan.id,
						build_plan_digest: storedPlan.artifactDigest,
						slice_id: slice.id,
						attempt: 1,
						base_kind: "empty-genesis",
						base_app_id: null,
						base_proposed_app_id: proposedAppId,
						base_seq: null,
						base_snapshot_digest: digest,
						change_set_id: null,
						executor_model: "gpt-test",
						prompt_version: "build-executor-v1",
						brief_digest: digest,
						status: "running",
						failure_code: null,
					})
					.execute();
				await tx
					.insertInto("design_change_sets")
					.values({
						id: changeSetId,
						design_session_id: sessionId,
						design_revision_id: accepted.id,
						design_revision_digest: accepted.artifactDigest,
						build_plan_id: storedPlan.id,
						build_plan_digest: storedPlan.artifactDigest,
						slice_id: slice.id,
						attempt_id: attemptId,
						kind: "genesis",
						app_id: null,
						proposed_app_id: proposedAppId,
						base_seq: null,
						base_project_id: PROJECT,
						base_snapshot_digest: digest,
						exclusive_kind: null,
						owner_user_id: ACTOR,
						owner_run_id: RUN_ID,
						status: "open",
						committed_seq: null,
						committed_batch_id: null,
						committed_snapshot_digest: null,
					})
					.execute();
				await tx
					.updateTable("design_slice_attempts")
					.set({ change_set_id: changeSetId })
					.where("id", "=", attemptId)
					.execute();
			});

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
		const read = (await readDesignBuildPlan(
			stored.id,
		)) as DesignBuildPlanRecord;
		expect(read.designRevisionDigest).toBe(accepted.artifactDigest);
		expect(read.envelope.payload.slices).toHaveLength(2);
	});

	it("normalizes an omitted additive plan member only after verifying its sealed body", async () => {
		const { accepted } = await persistAcceptedRevision();
		const currentPlan: BuildPlan = {
			...makeBuildPlan(),
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

		const read = (await readDesignBuildPlan(
			storedPayload.id,
		)) as DesignBuildPlanRecord;
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
				...makeBuildPlan(),
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
		expect(stored.envelope.payload.schemaVersion).toBe(1);
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
