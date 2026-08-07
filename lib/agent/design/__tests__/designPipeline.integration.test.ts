/**
 * The bounded design pipeline against the real artifact store, with a
 * SCRIPTED model context — offline, no provider, no spend. The fake
 * `runStructured` parses every scripted fixture through the REAL schema it
 * was handed (the same rejection surface the SDK gives the pipeline), so
 * these tests also prove the factory schemas accept what the pipeline
 * persists.
 *
 * What must hold (plan §7.1, §7.3, §19.2 Unit C acceptance):
 *  - clean path: draft → review → accepted (inputs bind the review digest)
 *    → plan, one call each, nothing extra;
 *  - findings path: the reviser's dispositions land beside the accepted
 *    revision;
 *  - a failed review leaves the draft persisted and UNREVIEWED — no review
 *    row, no acceptance, and the outcome names the review stage;
 *  - resume converges: a rerun after a failure re-produces nothing that
 *    already committed (the author never runs twice for one package);
 *  - an accepted revision with blocking questions returns awaiting-input
 *    and no plan;
 *  - a planner draft that fails plan validation persists nothing and names
 *    the plan stage; the rerun plans without re-authoring or re-reviewing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	insertDesignReview,
	insertDesignRevision,
	insertDesignSourcePackage,
	readDesignReviews,
	readDispositions,
	readLatestAcceptedDesignRevision,
	readLatestDesignRevision,
} from "@/lib/agent/design/artifactStore";
import type { BuildPlanDraft } from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import { sealArtifactEnvelope } from "@/lib/agent/design/envelope";
import { runDesignPipeline } from "@/lib/agent/design/pipeline";
import {
	DESIGN_AUTHOR_SYSTEM,
	DESIGN_PLANNER_SYSTEM,
	DESIGN_REVIEWER_SYSTEM,
	DESIGN_REVISER_SYSTEM,
} from "@/lib/agent/design/prompts";
import type {
	DesignReview,
	DesignRevisionResult,
} from "@/lib/agent/design/review";
import {
	computeSourcePackageDigest,
	type DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import type {
	StructuredModelRunArgs,
	StructuredModelRunContext,
} from "@/lib/agent/modelRunContext";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	cloneContract,
	did,
	ids,
	makeBuildPlan,
	makeContract,
	messageRef,
} from "./fixtures";

const h = setupAppStateTestDb("design_pipeline_");

let sessionId: string;
beforeEach(async () => {
	/* The design_sessions FK landed with the design-session unit: every
	 * artifact row's session id must reference a real session row. */
	sessionId = await h.seedDesignSession();
});

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
	return { ...unsealed, packageDigest: computeSourcePackageDigest(unsealed) };
}

type StageName = "author" | "review" | "revise" | "plan";

interface ScriptedContext extends StructuredModelRunContext {
	calls: Record<StageName, number>;
}

/**
 * A scripted run context: each stage's fixture (or `null` for a failed
 * structured output) parses through the REAL schema the pipeline handed in,
 * so an unparseable fixture behaves exactly like an unparseable model
 * response.
 */
function scriptedCtx(script: {
	author?: () => AppDesignContract | null;
	review?: () => DesignReview | null;
	revise?: () => DesignRevisionResult | null;
	plan?: () => BuildPlanDraft | null;
}): ScriptedContext {
	const calls: Record<StageName, number> = {
		author: 0,
		review: 0,
		revise: 0,
		plan: 0,
	};
	const stageOf = (system: string): StageName => {
		if (system === DESIGN_AUTHOR_SYSTEM) return "author";
		if (system === DESIGN_REVIEWER_SYSTEM) return "review";
		if (system === DESIGN_REVISER_SYSTEM) return "revise";
		if (system === DESIGN_PLANNER_SYSTEM) return "plan";
		throw new Error("unknown system prompt in scripted context");
	};
	return {
		userId: "user-1",
		projectId: "proj-1",
		runId: "run-pipeline-test",
		target: { kind: "design-session", designSessionId: "unused" },
		model() {
			throw new Error("scripted context resolves no models");
		},
		trackSubGeneration() {},
		calls,
		async runStructured<T>(args: StructuredModelRunArgs<T>) {
			const stage = stageOf(args.system);
			calls[stage] += 1;
			const produce = script[stage];
			const fixture = produce ? produce() : null;
			if (fixture === null) {
				return {
					object: null,
					usage: undefined,
					warnings: undefined,
					finishReason: "stop" as const,
				};
			}
			const parsed = args.schema.safeParse(fixture);
			return {
				object: parsed.success ? parsed.data : null,
				usage: undefined,
				warnings: undefined,
				finishReason: "stop" as const,
			};
		},
	};
}

function cleanReview(): DesignReview {
	return {
		schemaVersion: 1,
		id: did(400),
		summary: "Coherent and complete against the sources.",
		findings: [],
	};
}

function criticalReview(): DesignReview {
	return {
		schemaVersion: 1,
		id: did(400),
		summary: "The visit summary is captured but never read back.",
		findings: [
			{
				id: did(401),
				category: "read-write-coherence",
				severity: "important",
				basis: "source-supported",
				claim: "visit_summary has no reader — captured data nobody sees.",
				evidenceRefs: [messageRef()],
				affectedIntentIds: [ids.factVisitSummary],
				confidence: 0.9,
			},
		],
	};
}

function resolvingRevision(): DesignRevisionResult {
	const revised = cloneContract(makeContract());
	revised.facts
		.find((fact) => fact.id === ids.factVisitSummary)
		?.readerIds.push(ids.rmPatients);
	return {
		contract: revised,
		dispositions: [
			{
				findingId: did(401),
				status: "accepted",
				rationale: "The patient queue's detail view now shows the summary.",
				resultingIntentIds: [ids.factVisitSummary],
			},
		],
	} as DesignRevisionResult;
}

function planDraft(): BuildPlanDraft {
	const { slices, externalActions, intentOwnership } = makeBuildPlan();
	return { slices, externalActions, intentOwnership };
}

describe("runDesignPipeline", () => {
	it("clean path: draft → review → accepted (review-bound) → plan, one call each", async () => {
		const ctx = scriptedCtx({
			author: makeContract,
			review: cleanReview,
			plan: planDraft,
		});
		const outcome = await runDesignPipeline({
			ctx,
			pkg: makePackage(),
			signal: new AbortController().signal,
		});
		if (outcome.kind !== "accepted") {
			throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
		}
		expect(ctx.calls).toEqual({ author: 1, review: 1, revise: 0, plan: 1 });
		expect(outcome.revision.lifecycle).toBe("accepted");
		expect(outcome.plan.designRevisionDigest).toBe(
			outcome.revision.artifactDigest,
		);
		expect(outcome.revision.envelope.complexity?.depth).toBe("standard");

		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		expect(accepted?.id).toBe(outcome.revision.id);
		const draftReviews = await readDesignReviews(
			accepted?.parentRevisionId ?? "",
		);
		expect(draftReviews).toHaveLength(1);
		// Acceptance binds the review artifact it descends from.
		expect(accepted?.envelope.inputArtifactDigests).toContain(
			draftReviews[0]?.artifactDigest,
		);
	});

	it("a revised acceptance also binds the review digest in its inputs", async () => {
		const ctx = scriptedCtx({
			author: makeContract,
			review: criticalReview,
			revise: resolvingRevision,
			plan: planDraft,
		});
		const outcome = await runDesignPipeline({
			ctx,
			pkg: makePackage(),
			signal: new AbortController().signal,
		});
		if (outcome.kind !== "accepted") {
			throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
		}
		const reviews = await readDesignReviews(
			outcome.revision.parentRevisionId ?? "",
		);
		expect(outcome.revision.envelope.inputArtifactDigests).toContain(
			reviews[0]?.artifactDigest,
		);
	});

	it("findings path: dispositions land beside the accepted revision", async () => {
		const ctx = scriptedCtx({
			author: makeContract,
			review: criticalReview,
			revise: resolvingRevision,
			plan: planDraft,
		});
		const outcome = await runDesignPipeline({
			ctx,
			pkg: makePackage(),
			signal: new AbortController().signal,
		});
		if (outcome.kind !== "accepted") {
			throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
		}
		expect(ctx.calls).toEqual({ author: 1, review: 1, revise: 1, plan: 1 });

		const reviews = await readDesignReviews(
			outcome.revision.parentRevisionId ?? "",
		);
		const dispositions = await readDispositions(reviews[0]?.id ?? "");
		expect(dispositions).toHaveLength(1);
		expect(dispositions[0]?.resultingRevisionId).toBe(outcome.revision.id);
		expect(dispositions[0]?.disposition.status).toBe("accepted");
	});

	it("a failed review leaves the draft persisted and UNREVIEWED", async () => {
		const ctx = scriptedCtx({ author: makeContract, review: () => null });
		const outcome = await runDesignPipeline({
			ctx,
			pkg: makePackage(),
			signal: new AbortController().signal,
		});
		expect(outcome).toEqual({
			kind: "not-produced",
			stage: "review",
			reason: "invalid-structured-output",
		});
		const draft = await readLatestDesignRevision(sessionId);
		expect(draft?.lifecycle).toBe("draft");
		expect(await readDesignReviews(draft?.id ?? "")).toHaveLength(0);
		expect(await readLatestAcceptedDesignRevision(sessionId)).toBeNull();
	});

	it("resume after a clean review converges on acceptance — no reviser call", async () => {
		// Simulate a run that died BETWEEN the review insert and the
		// acceptance insert: persist the draft and its clean review directly
		// through the store, then rerun the pipeline. The rerun must take
		// the live path's route — accept the reviewed content — and never
		// fire a reviser call the live path would not make (the scripted
		// context has no reviser, so a wrong route fails the run).
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, runId: "run-pipeline-test" });
		const draftEnvelope = sealArtifactEnvelope({
			artifactType: "design-contract" as const,
			artifactSchemaVersion: 1,
			artifactId: crypto.randomUUID(),
			designSessionId: sessionId,
			revision: 1,
			parentArtifactId: null,
			sourcePackageDigest: pkg.packageDigest,
			inputArtifactDigests: [],
			promptVersion: "design-author-v1",
			producer: {
				provider: "openai",
				modelId: "gpt-test",
				finishReason: "stop",
			},
			createdAt: new Date().toISOString(),
			payload: makeContract(),
		});
		const draft = await insertDesignRevision({
			envelope: draftEnvelope,
			lifecycle: "draft",
			runId: "run-pipeline-test",
		});
		await insertDesignReview({
			envelope: sealArtifactEnvelope({
				artifactType: "design-review" as const,
				artifactSchemaVersion: 1,
				artifactId: crypto.randomUUID(),
				designSessionId: sessionId,
				revision: draft.revision,
				parentArtifactId: draft.id,
				sourcePackageDigest: draft.sourcePackageDigest,
				inputArtifactDigests: [draft.artifactDigest],
				promptVersion: "design-reviewer-v1",
				producer: {
					provider: "openai",
					modelId: "gpt-test",
					finishReason: "stop",
				},
				createdAt: new Date().toISOString(),
				payload: cleanReview(),
			}),
			designRevisionId: draft.id,
			runId: "run-pipeline-test",
		});

		const resumed = scriptedCtx({ plan: planDraft });
		const outcome = await runDesignPipeline({
			ctx: resumed,
			pkg,
			signal: new AbortController().signal,
		});
		expect(outcome.kind).toBe("accepted");
		expect(resumed.calls).toEqual({ author: 0, review: 0, revise: 0, plan: 1 });
		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		// The resumed acceptance carries the SAME reviewed content and binds
		// the persisted review's digest.
		expect(accepted?.contractDigest).toBe(draft.contractDigest);
	});

	it("resume with a persisted GATED review goes to the reviser, not a re-review", async () => {
		const pkg = makePackage();
		// First run: draft + gated review persist; the reviser fails, so the
		// run ends with the review on disk and no revision.
		const first = scriptedCtx({
			author: makeContract,
			review: criticalReview,
			revise: () => null,
		});
		const firstOutcome = await runDesignPipeline({
			ctx: first,
			pkg,
			signal: new AbortController().signal,
		});
		expect(firstOutcome).toEqual({
			kind: "not-produced",
			stage: "revise",
			reason: "invalid-structured-output",
		});

		const second = scriptedCtx({ revise: resolvingRevision, plan: planDraft });
		const outcome = await runDesignPipeline({
			ctx: second,
			pkg,
			signal: new AbortController().signal,
		});
		expect(outcome.kind).toBe("accepted");
		expect(second.calls).toEqual({ author: 0, review: 0, revise: 1, plan: 1 });
	});

	it("resume after a failed review re-produces nothing already committed", async () => {
		const pkg = makePackage();
		const first = scriptedCtx({ author: makeContract, review: () => null });
		await runDesignPipeline({
			ctx: first,
			pkg,
			signal: new AbortController().signal,
		});

		const second = scriptedCtx({
			review: cleanReview,
			plan: planDraft,
		});
		const outcome = await runDesignPipeline({
			ctx: second,
			pkg,
			signal: new AbortController().signal,
		});
		expect(outcome.kind).toBe("accepted");
		// The author never ran on the resume — the persisted draft is the
		// durable state the rerun converged on.
		expect(second.calls).toEqual({ author: 0, review: 1, revise: 0, plan: 1 });
	});

	it("an accepted revision with blocking questions awaits input and plans nothing", async () => {
		const withBlocking = () => {
			const contract = cloneContract(makeContract());
			contract.openQuestions.push({
				id: did(500),
				question: "Are supervisor approvals required before a visit closes?",
				structuralImpact: "architecture",
				blocking: true,
				relatedIntentIds: [ids.taskVisit],
			});
			return contract;
		};
		const ctx = scriptedCtx({
			author: withBlocking,
			review: cleanReview,
			plan: planDraft,
		});
		const outcome = await runDesignPipeline({
			ctx,
			pkg: makePackage(),
			signal: new AbortController().signal,
		});
		if (outcome.kind !== "awaiting-input") {
			throw new Error(`expected awaiting-input, got ${outcome.kind}`);
		}
		expect(outcome.blockingQuestions).toHaveLength(1);
		expect(ctx.calls.plan).toBe(0);
	});

	it("an invalid plan draft persists nothing; the rerun plans without re-review", async () => {
		const pkg = makePackage();
		const badPlan = (): BuildPlanDraft => {
			const draft = planDraft();
			// Two materialization roots — fails validateSlicePlan.
			const second = draft.slices[1];
			if (second) second.role = "materialization-root";
			return draft;
		};
		const first = scriptedCtx({
			author: makeContract,
			review: cleanReview,
			plan: badPlan,
		});
		const firstOutcome = await runDesignPipeline({
			ctx: first,
			pkg,
			signal: new AbortController().signal,
		});
		expect(firstOutcome).toEqual({
			kind: "not-produced",
			stage: "plan",
			reason: "invalid-structured-output",
		});

		const second = scriptedCtx({ plan: planDraft });
		const outcome = await runDesignPipeline({
			ctx: second,
			pkg,
			signal: new AbortController().signal,
		});
		expect(outcome.kind).toBe("accepted");
		expect(second.calls).toEqual({ author: 0, review: 0, revise: 0, plan: 1 });
	});
});
