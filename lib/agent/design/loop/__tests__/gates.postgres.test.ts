/** Artifact-state legality from actual admitted, sealed PostgreSQL rows.
 * Scripted review content controls findings; no model judgment is claimed. */
import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type DesignArtifactWriteAuthority,
	type DesignRevisionRecord,
	insertDesignBuildPlan,
	insertDesignReview,
	insertDesignRevision,
	insertDesignSourcePackage,
} from "@/lib/agent/design/artifactStore";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { buildDesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	did,
	FIXTURE_THREAD_ID,
	ids,
	makeContract,
} from "../../__tests__/fixtures";
import {
	persistAcceptedDesignFixture,
	persistAcceptedRevisionFixture,
} from "../../__tests__/persistedFixtures";
import { contractEnvelope, planEnvelope, reviewEnvelope } from "../artifacts";
import {
	createMemoizedAncestryLoader,
	type DesignGateState,
	evaluateDesignGates,
	loadDesignAncestry,
} from "../gates";
import { renderDesignStateMessage } from "../packageRender";

const h = setupAppStateTestDb("design_gate_ancestry_");
const authority: DesignArtifactWriteAuthority = {
	actorUserId: "gate-owner",
	runId: "gate-run",
	holderNonce: "00000000-0000-4000-8000-000000009234",
	expectedProjectId: "gate-project",
};
let designSessionId: string;
beforeEach(async () => {
	designSessionId = await h.seedDesignSession({
		owner_user_id: authority.actorUserId,
		project_id: authority.expectedProjectId,
		run_id: authority.runId,
		run_holder_nonce: authority.holderNonce,
		run_actor_user_id: authority.actorUserId,
		run_lease_expires_at: new Date(Date.now() + 60_000),
	});
});

async function source(text = "Track patients and their visits.") {
	const pkg = await buildDesignSourcePackage({
		designSessionId,
		projectId: authority.expectedProjectId,
		threadId: FIXTURE_THREAD_ID,
		messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }],
		deps: {
			loadAssets: async (ids) => {
				if (ids.length) throw new Error("Text fixture requested assets");
				return [];
			},
			readExtract: async () => {
				throw new Error("Text fixture requested extraction");
			},
			loadImage: async () => {
				throw new Error("Text fixture requested images");
			},
		},
	});
	await insertDesignSourcePackage({ pkg, authority });
	return pkg;
}

async function draft(packageDigest: string, parent?: DesignRevisionRecord) {
	return insertDesignRevision({
		envelope: contractEnvelope({
			designSessionId,
			packageDigest,
			contract: appDesignContractSchema.parse(makeContract()),
			revision: (parent?.revision ?? 0) + 1,
			parentId: parent?.id ?? null,
			inputDigests: parent ? [parent.artifactDigest] : [],
			promptVersion: "gate-fixture-v1",
			finishReason: "stop",
		}),
		lifecycle: "draft",
		authority,
	});
}

function legality(gates: DesignGateState) {
	return Object.fromEntries(
		Object.entries(gates.verdicts).map(([name, verdict]) => [
			name,
			verdict.legal,
		]),
	);
}
const AUTHOR = {
	submitContract: true,
	requestReview: false,
	submitRevision: false,
};
const REVIEW = {
	submitContract: false,
	requestReview: true,
	submitRevision: false,
};
const CORRECT = {
	submitContract: false,
	requestReview: false,
	submitRevision: true,
};
const DONE = {
	submitContract: false,
	requestReview: false,
	submitRevision: false,
};

async function state(digest: string) {
	return evaluateDesignGates(await loadDesignAncestry(designSessionId, digest));
}

describe("durable design gate transitions", () => {
	it("loads every lineage stage and never accepts by counting historical reviews", async () => {
		const pkg = await source();
		const start = await state(pkg.packageDigest);
		expect(start).toMatchObject({
			head: null,
			newestAccepted: null,
			headReviews: [],
			plan: null,
			blockingQuestions: [],
			supersedesPlanExecution: false,
		});
		expect(legality(start)).toEqual(AUTHOR);
		let head = await draft(pkg.packageDigest);
		for (let round = 0; round < 4; round += 1) {
			const unreviewed = await state(pkg.packageDigest);
			expect(unreviewed.head).toEqual(head);
			expect(unreviewed.headReviews).toEqual([]);
			expect(unreviewed.newestAccepted).toBeNull();
			expect(legality(unreviewed)).toEqual(REVIEW);
			const review = await insertDesignReview({
				envelope: reviewEnvelope({
					draft: head,
					finishReason: "stop",
					review: {
						schemaVersion: 1,
						id: did(9200 + round),
						summary: "A controlled correction.",
						findings: [
							{
								id: did(9300 + round),
								severity: "important",
								dispositionClass: "design-correction",
								claim: "Review the patient queue wording.",
								evidenceRefs: [],
								affectedElementIds: [ids.rmPatients],
							},
						],
					},
				}),
				designRevisionId: head.id,
				authority,
			});
			const reviewed = await state(pkg.packageDigest);
			expect(reviewed.headReviews).toEqual([review]);
			expect(legality(reviewed)).toEqual(CORRECT);
			const old = head;
			head = await insertDesignRevision({
				envelope: contractEnvelope({
					designSessionId,
					packageDigest: pkg.packageDigest,
					contract: old.envelope.payload,
					revision: old.revision + 1,
					parentId: old.id,
					inputDigests: [old.artifactDigest, review.artifactDigest],
					promptVersion: "gate-fixture-v1",
					finishReason: "stop",
				}),
				lifecycle: "draft",
				authority,
				dispositions: [
					{
						reviewId: review.id,
						disposition: {
							findingId: did(9300 + round),
							status: "rejected",
							rationale: "Preserve the workers' stated vocabulary.",
						},
					},
				],
			});
		}
		const fresh = await state(pkg.packageDigest);
		expect(legality(fresh)).toEqual(REVIEW);
		expect(fresh.newestAccepted).toBeNull();
		expect(fresh.plan).toBeNull();
	});

	it.each([false, true])(
		"new source can supersede an unreviewed draft, while a reviewed draft keeps disposition authority: reviewed=%s",
		async (reviewed) => {
			const pkg = await source();
			const head = await draft(pkg.packageDigest);
			if (reviewed)
				await insertDesignReview({
					envelope: reviewEnvelope({
						draft: head,
						finishReason: "stop",
						review: {
							schemaVersion: 1,
							id: did(9400),
							summary: "Controlled clean review.",
							findings: [],
						},
					}),
					designRevisionId: head.id,
					authority,
				});
			const newer = await source(
				"Track patients and their visits. The first queue is follow-up visits.",
			);
			expect(newer.packageDigest).not.toBe(pkg.packageDigest);
			const gates = await state(newer.packageDigest);
			expect(gates.head).toEqual(head);
			expect(legality(gates)).toEqual(
				reviewed ? CORRECT : { ...REVIEW, submitContract: true },
			);
			expect(gates.supersedesPlanExecution).toBe(false);
		},
	);

	it("loads the newest accepted plan, deactivates it for new sources, and keeps it inactive behind a later draft", async () => {
		const { accepted, pkg, plan } = await persistAcceptedDesignFixture({
			designSessionId,
			authority,
		});
		const current = await state(pkg.packageDigest);
		expect(current.head).toEqual(accepted);
		expect(current.newestAccepted).toEqual(accepted);
		expect(current.plan).toEqual(plan);
		expect(current.headReviews).toEqual([]);
		expect(legality(current)).toEqual(DONE);
		expect(current.supersedesPlanExecution).toBe(false);
		const newer = await source(
			"Track patients and their visits. Also prioritize follow-up visits.",
		);
		const reopened = await state(newer.packageDigest);
		expect(legality(reopened)).toEqual(AUTHOR);
		expect(reopened.plan).toBeNull();
		expect(reopened.supersedesPlanExecution).toBe(true);
		const next = await draft(newer.packageDigest, accepted);
		const after = await state(newer.packageDigest);
		expect(after.head).toEqual(next);
		expect(after.newestAccepted).toEqual(accepted);
		expect(after.plan).toBeNull();
		expect(after.supersedesPlanExecution).toBe(false);
		expect(legality(after)).toEqual(REVIEW);
		const replay = await loadDesignAncestry(
			designSessionId,
			newer.packageDigest,
		);
		expect(replay.plan).toEqual(plan);
		expect(replay.revisions.map((row) => row.id)).toEqual([
			current.newestAccepted?.parentRevisionId,
			accepted.id,
			next.id,
		]);
	});

	it("keeps an accepted design without a plan waiting for deterministic planning", async () => {
		const { pkg, accepted } = await persistAcceptedRevisionFixture({
			designSessionId,
			authority,
		});
		const before = await state(pkg.packageDigest);
		expect(legality(before)).toEqual(DONE);
		expect(before.plan).toBeNull();
		const plan = deriveBuildPlan({
			contract: accepted.envelope.payload,
			revision: { id: accepted.id, digest: accepted.artifactDigest },
		});
		const stored = await insertDesignBuildPlan({
			envelope: planEnvelope({
				accepted,
				packageDigest: pkg.packageDigest,
				plan,
				finishReason: null,
			}),
			authority,
		});
		expect((await state(pkg.packageDigest)).plan).toEqual(stored);
	});

	it("directs a newly answered accepted question back into authoring, preserving the old question as context", async () => {
		const contract = makeContract();
		contract.openQuestions.push({
			id: did(9500),
			question: "Which queue should open first?",
			blocking: true,
			relatedElementIds: [ids.taskVisit],
		});
		const { pkg, accepted } = await persistAcceptedRevisionFixture({
			designSessionId,
			authority,
			contract,
		});
		const waiting = await state(pkg.packageDigest);
		expect(waiting.blockingQuestions).toEqual([
			"Which queue should open first?",
		]);
		expect(legality(waiting)).toEqual(DONE);
		const newer = await source(
			"Track patients and their visits. Open the follow-up queue first.",
		);
		const answered = await state(newer.packageDigest);
		expect(answered.head).toEqual(accepted);
		expect(legality(answered)).toEqual(AUTHOR);
		expect(answered.blockingQuestions).toEqual(waiting.blockingQuestions);
		expect(answered.expectedNext).toBe(
			"Continue the implicit workspace with native semantic design calls, then call finishDesign. Several known updates may be emitted in one response. askQuestions remains available.",
		);
		const rendered = renderDesignStateMessage({
			gates: answered,
			claims: [],
			openReviews: null,
			workspace: null,
		});
		expect(rendered.split("\n").slice(0, 3)).toEqual([
			"# Design session state (server-derived)",
			"",
			answered.expectedNext,
		]);
	});
});

describe("memoized native ancestry loading", () => {
	it("coalesces callers, holds one snapshot until invalidation, and then loads the actual committed revision", async () => {
		const pkg = await source();
		const loader = createMemoizedAncestryLoader(
			designSessionId,
			pkg.packageDigest,
		);
		const first = loader.loadAncestry();
		expect(loader.loadAncestry()).toBe(first);
		expect((await first).revisions).toEqual([]);
		const written = await draft(pkg.packageDigest);
		expect(loader.loadAncestry()).toBe(first);
		expect((await loader.loadAncestry()).revisions).toEqual([]);
		loader.ancestryChanged();
		const next = loader.loadAncestry();
		expect(next).not.toBe(first);
		expect(loader.loadAncestry()).toBe(next);
		expect((await next).revisions).toEqual([written]);
	});

	it("evicts a rejected read so restoring corrupted storage permits a fresh verified read", async () => {
		const pkg = await source();
		const written = await draft(pkg.packageDigest);
		const loader = createMemoizedAncestryLoader(
			designSessionId,
			pkg.packageDigest,
		);
		const corrupt = structuredClone(written.envelope);
		corrupt.payload.charter.appName = "Tampered without resealing";
		await sql`update design_revisions set envelope = ${JSON.stringify(corrupt)}::jsonb where id = ${written.id}`.execute(
			h.db(),
		);
		const rejected = loader.loadAncestry();
		await expect(rejected).rejects.toMatchObject({
			name: "DesignArtifactIntegrityError",
		});
		await sql`update design_revisions set envelope = ${JSON.stringify(written.envelope)}::jsonb where id = ${written.id}`.execute(
			h.db(),
		);
		const recovered = loader.loadAncestry();
		expect(recovered).not.toBe(rejected);
		expect((await recovered).revisions).toEqual([written]);
	});
});
