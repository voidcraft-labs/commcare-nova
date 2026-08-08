/**
 * The design pipeline — the SERVER-OWNED bounded state machine over the
 * author/reviewer/reviser/planner calls (plan §7.1, §7.3, §7.4).
 *
 * Models produce typed artifacts; they never decide whether required phases
 * occur. Every transition is durable through the artifact store before the
 * next call runs:
 *
 *   source package accepted → draft persisted → review persisted →
 *   dispositions + accepted revision persisted → build plan persisted
 *
 * No later state exists without its exact predecessor and digest (the store
 * proves the bindings on every insert), and a model response advances
 * nothing until it parsed, graph-validated, and committed.
 *
 * The loop is BOUNDED (§7.3): one author call; one review; one revision
 * when critical/important findings exist; one second review + revision only
 * when the first revision leaves a critical finding or changes architecture
 * (extended depth always takes the second review — its impacted-scenario
 * re-review); no third loop. Depth is the deterministic complexity score
 * (§7.4), computed after the draft validates and persisted with it.
 *
 * Failure honesty: a failed or unavailable review leaves the draft
 * persisted and UNREVIEWED — the outcome names the stage, and nothing here
 * can label it reviewed. Provider/network failures THROW (retriable
 * design-session error for the caller); a terminal system failure never
 * manufactures a user question.
 *
 * Resume: rerunning the pipeline with the same source package converges —
 * an existing draft resumes at review, reviewed drafts resume at revision,
 * an accepted revision skips to planning, and an existing plan returns
 * outright. Artifacts already committed are never re-produced.
 */

import {
	type DesignBuildPlanRecord,
	type DesignReviewRecord,
	type DesignRevisionRecord,
	insertDesignBuildPlan,
	insertDesignReview,
	insertDesignRevision,
	insertDesignSourcePackage,
	readDesignReviews,
	readDesignRevision,
	readLatestDesignBuildPlanForRevision,
	readLatestDesignRevision,
} from "@/lib/agent/design/artifactStore";
import { runDesignAuthor } from "@/lib/agent/design/author";
import {
	type BuildPlan,
	type BuildPlanDraft,
	buildPlanSchemaFor,
} from "@/lib/agent/design/buildPlan";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "@/lib/agent/design/capabilityCatalog";
import { computeDesignComplexity } from "@/lib/agent/design/complexity";
import type {
	AppDesignContract,
	OpenQuestion,
} from "@/lib/agent/design/contract";
import {
	type DesignArtifactEnvelope,
	sealArtifactEnvelope,
} from "@/lib/agent/design/envelope";
import { runDesignPlanner } from "@/lib/agent/design/planner";
import { DESIGN_PROMPT_VERSIONS } from "@/lib/agent/design/prompts";
import type {
	DesignReview,
	DesignRevisionResult,
	FindingDisposition,
} from "@/lib/agent/design/review";
import { runDesignReviewer } from "@/lib/agent/design/reviewer";
import { runDesignReviser } from "@/lib/agent/design/reviser";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import { log } from "@/lib/logger";
import { DESIGN_MODEL } from "@/lib/models";

export type DesignPipelineStage = "author" | "review" | "revise" | "plan";

export type DesignPipelineOutcome =
	| {
			kind: "accepted";
			revision: DesignRevisionRecord;
			plan: DesignBuildPlanRecord;
	  }
	| {
			kind: "awaiting-input";
			revision: DesignRevisionRecord;
			blockingQuestions: OpenQuestion[];
	  }
	| {
			kind: "not-produced";
			stage: DesignPipelineStage;
			reason: "length" | "invalid-structured-output" | "cancelled";
	  };

/** Live model-call activity: which pipeline phase is streaming, and how many
 *  characters (reasoning + output) its call has just delivered. Fires per
 *  streamed chunk; the caller owns throttling and any wire projection. */
export type PipelineActivity = (
	stage: DesignPipelineStage,
	deltaChars: number,
) => void;

export interface DesignPipelineArgs {
	ctx: StructuredModelRunContext;
	pkg: DesignSourcePackage;
	signal: AbortSignal;
	onModelActivity?: PipelineActivity;
}

export async function runDesignPipeline(
	args: DesignPipelineArgs,
): Promise<DesignPipelineOutcome> {
	const { ctx, pkg, signal, onModelActivity } = args;
	await insertDesignSourcePackage({ pkg, runId: ctx.runId });

	/* ---- resume: converge on what already exists --------------------- */
	const latest = await readLatestDesignRevision(pkg.designSessionId);
	if (latest && latest.sourcePackageDigest === pkg.packageDigest) {
		if (latest.lifecycle === "accepted") {
			return finishFromAccepted(ctx, pkg, latest, signal, onModelActivity);
		}
		const round = await deriveRound(latest);
		const priorReviews = await readDesignReviews(latest.id);
		if (priorReviews.length === 0) {
			return reviewRound(ctx, pkg, latest, round, signal, onModelActivity);
		}
		return continueFromReviews(
			ctx,
			pkg,
			latest,
			priorReviews,
			round,
			signal,
			onModelActivity,
		);
	}

	/* ---- author ------------------------------------------------------ */
	const authored = await runDesignAuthor(
		ctx,
		pkg,
		renderCapabilityCatalog(buildCapabilityCatalog()),
		signal,
		phaseActivity(onModelActivity, "author"),
	);
	if (authored.kind === "not-produced") {
		return { kind: "not-produced", stage: "author", reason: authored.reason };
	}
	const draft = await insertDesignRevision({
		envelope: contractEnvelope({
			pkg,
			contract: authored.artifact,
			revision: (latest?.revision ?? 0) + 1,
			parentId: latest?.id ?? null,
			inputDigests: latest ? [latest.artifactDigest] : [],
			promptVersion: DESIGN_PROMPT_VERSIONS.author,
			finishReason: authored.finishReason,
		}),
		lifecycle: "draft",
		runId: ctx.runId,
	});
	return reviewRound(ctx, pkg, draft, 1, signal, onModelActivity);
}

/** Bind the shared activity callback to one phase's model call. */
function phaseActivity(
	activity: PipelineActivity | undefined,
	stage: DesignPipelineStage,
): ((deltaChars: number) => void) | undefined {
	return activity && ((deltaChars) => activity(stage, deltaChars));
}

/* ------------------------------------------------------------------ */
/* Rounds                                                              */
/* ------------------------------------------------------------------ */

/**
 * The round a resumed draft sits in, derived from DURABLE ancestry — never
 * from prompt versions, which move under in-flight sessions on a deploy.
 * Only the reviser produces a draft whose parent (in the SAME source-package
 * lineage) carries reviews, and that draft is round 2's re-reviewable
 * revision; a fresh author draft's parent is either absent or a prior
 * package's head.
 */
async function deriveRound(draft: DesignRevisionRecord): Promise<1 | 2> {
	if (draft.parentRevisionId === null) return 1;
	const parent = await readDesignRevision(draft.parentRevisionId);
	if (!parent || parent.sourcePackageDigest !== draft.sourcePackageDigest) {
		return 1;
	}
	const parentReviews = await readDesignReviews(parent.id);
	return parentReviews.length > 0 ? 2 : 1;
}

async function reviewRound(
	ctx: StructuredModelRunContext,
	pkg: DesignSourcePackage,
	draft: DesignRevisionRecord,
	round: 1 | 2,
	signal: AbortSignal,
	activity: PipelineActivity | undefined,
): Promise<DesignPipelineOutcome> {
	const catalogText = renderCapabilityCatalog(buildCapabilityCatalog());
	const reviewed = await runDesignReviewer(
		ctx,
		{ pkg, contract: draft.envelope.payload, catalogText },
		signal,
		phaseActivity(activity, "review"),
	);
	if (reviewed.kind === "not-produced") {
		/* The draft stays persisted and UNREVIEWED — nothing may label it
		 * reviewed, and the caller retries or surfaces the failure. */
		return { kind: "not-produced", stage: "review", reason: reviewed.reason };
	}
	const review = await insertDesignReview({
		envelope: reviewEnvelope({
			pkg,
			draft,
			review: reviewed.artifact,
			finishReason: reviewed.finishReason,
		}),
		designRevisionId: draft.id,
		runId: ctx.runId,
	});
	return continueFromReviews(
		ctx,
		pkg,
		draft,
		[review],
		round,
		signal,
		activity,
	);
}

/**
 * One decision point for a reviewed draft — live path and resume path
 * alike, over the PERSISTED review records: a clean review accepts the
 * draft's exact content, a gated one goes to the reviser. A resumed rerun
 * therefore takes the same route (and bills the same calls) as the run it
 * resumes.
 */
async function continueFromReviews(
	ctx: StructuredModelRunContext,
	pkg: DesignSourcePackage,
	draft: DesignRevisionRecord,
	reviews: readonly DesignReviewRecord[],
	round: 1 | 2,
	signal: AbortSignal,
	activity: PipelineActivity | undefined,
): Promise<DesignPipelineOutcome> {
	const gated = reviews
		.flatMap((review) => review.envelope.payload.findings)
		.filter(
			(finding) =>
				finding.severity === "critical" || finding.severity === "important",
		);
	if (gated.length === 0) {
		/* Nothing to revise: acceptance re-issues the SAME contract content
		 * as a new accepted revision whose inputs bind every review. */
		const accepted = await insertDesignRevision({
			envelope: contractEnvelope({
				pkg,
				contract: draft.envelope.payload,
				revision: draft.revision + 1,
				parentId: draft.id,
				inputDigests: [
					draft.artifactDigest,
					...reviews.map((review) => review.artifactDigest),
				],
				promptVersion: draft.envelope.promptVersion,
				finishReason: draft.envelope.producer.finishReason,
			}),
			lifecycle: "accepted",
			runId: ctx.runId,
			dispositions: [],
		});
		return finishFromAccepted(ctx, pkg, accepted, signal, activity);
	}
	return reviseRound(ctx, pkg, draft, reviews, round, signal, activity);
}

async function reviseRound(
	ctx: StructuredModelRunContext,
	pkg: DesignSourcePackage,
	draft: DesignRevisionRecord,
	reviews: readonly DesignReviewRecord[],
	round: 1 | 2,
	signal: AbortSignal,
	activity: PipelineActivity | undefined,
): Promise<DesignPipelineOutcome> {
	const reviewPayloads = reviews.map((review) => review.envelope.payload);
	const revised = await runDesignReviser(
		ctx,
		{
			pkg,
			contract: draft.envelope.payload,
			reviews: reviewPayloads,
			catalogText: renderCapabilityCatalog(buildCapabilityCatalog()),
		},
		signal,
		phaseActivity(activity, "revise"),
	);
	if (revised.kind === "not-produced") {
		return { kind: "not-produced", stage: "revise", reason: revised.reason };
	}
	const result = revised.artifact;
	const dispositions = mapDispositionsToReviews(result, reviews);

	const depth = draft.envelope.complexity?.depth ?? "standard";
	const secondRoundWarranted =
		round === 1 &&
		depth !== "compact" &&
		(depth === "extended" ||
			leavesCriticalFinding(result, reviewPayloads) ||
			changesArchitecture(draft.envelope.payload, result.contract));

	const lifecycle = secondRoundWarranted ? "draft" : "accepted";
	const revisionRecord = await insertDesignRevision({
		envelope: contractEnvelope({
			pkg,
			contract: result.contract,
			revision: draft.revision + 1,
			parentId: draft.id,
			inputDigests: [
				draft.artifactDigest,
				...reviews.map((review) => review.artifactDigest),
			],
			promptVersion: DESIGN_PROMPT_VERSIONS.reviser,
			finishReason: revised.finishReason,
		}),
		lifecycle,
		runId: ctx.runId,
		dispositions,
	});
	if (lifecycle === "accepted") {
		return finishFromAccepted(ctx, pkg, revisionRecord, signal, activity);
	}
	log.info("[designPipeline] second review round", {
		designSessionId: pkg.designSessionId,
		revision: revisionRecord.revision,
		depth,
	});
	return reviewRound(ctx, pkg, revisionRecord, 2, signal, activity);
}

async function finishFromAccepted(
	ctx: StructuredModelRunContext,
	pkg: DesignSourcePackage,
	accepted: DesignRevisionRecord,
	signal: AbortSignal,
	activity: PipelineActivity | undefined,
): Promise<DesignPipelineOutcome> {
	const contract = accepted.envelope.payload;
	const blockingQuestions = contract.openQuestions.filter(
		(question) => question.blocking,
	);
	if (blockingQuestions.length > 0) {
		/* No plan over an unanswered architecture question — the caller asks
		 * the user through the existing question protocol; a new answer
		 * arrives as a new source package. */
		return { kind: "awaiting-input", revision: accepted, blockingQuestions };
	}

	const existing = await readLatestDesignBuildPlanForRevision(accepted.id);
	if (existing) return { kind: "accepted", revision: accepted, plan: existing };

	const catalogText = renderCapabilityCatalog(buildCapabilityCatalog());
	const planned = await runDesignPlanner(
		ctx,
		{ contract, catalogText },
		signal,
		phaseActivity(activity, "plan"),
	);
	if (planned.kind === "not-produced") {
		return { kind: "not-produced", stage: "plan", reason: planned.reason };
	}
	const composed = composePlan(accepted, planned.artifact);
	const parsed = buildPlanSchemaFor(contract).safeParse(composed);
	if (!parsed.success) {
		log.warn("[designPipeline] planner output failed plan validation", {
			designSessionId: pkg.designSessionId,
			issueCount: parsed.error.issues.length,
		});
		return {
			kind: "not-produced",
			stage: "plan",
			reason: "invalid-structured-output",
		};
	}
	const plan = await insertDesignBuildPlan({
		envelope: planEnvelope({
			pkg,
			accepted,
			plan: parsed.data,
			finishReason: planned.finishReason,
		}),
		runId: ctx.runId,
	});
	return { kind: "accepted", revision: accepted, plan };
}

/* ------------------------------------------------------------------ */
/* Policy predicates                                                   */
/* ------------------------------------------------------------------ */

/** "The first revision leaves a critical finding": a CRITICAL finding whose
 *  disposition did not resolve it by change — deferred, or rejected (the
 *  reviser overriding the reviewer on a critical deserves the second
 *  independent look). */
function leavesCriticalFinding(
	result: DesignRevisionResult,
	reviews: readonly DesignReview[],
): boolean {
	const criticalIds = new Set(
		reviews.flatMap((review) =>
			review.findings
				.filter((finding) => finding.severity === "critical")
				.map((finding) => finding.id),
		),
	);
	return result.dispositions.some(
		(disposition) =>
			criticalIds.has(disposition.findingId) &&
			disposition.status !== "accepted",
	);
}

/** "…or changes architecture": the revision added/removed a decision or
 *  selected a different option. */
function changesArchitecture(
	before: AppDesignContract,
	after: AppDesignContract,
): boolean {
	const selectionsBefore = new Map(
		before.decisions.map((decision) => [
			decision.id,
			decision.selectedOptionId,
		]),
	);
	if (after.decisions.length !== before.decisions.length) return true;
	return after.decisions.some(
		(decision) =>
			selectionsBefore.get(decision.id) !== decision.selectedOptionId,
	);
}

/** Map each disposition to the review row whose finding it closes. Closure
 *  (exactly one disposition per critical/important finding, no unknowns)
 *  was proved inside the reviser parse; this is pure bookkeeping. */
function mapDispositionsToReviews(
	result: DesignRevisionResult,
	reviews: readonly DesignReviewRecord[],
): Array<{ reviewId: string; disposition: FindingDisposition }> {
	const reviewIdByFinding = new Map<string, string>();
	for (const review of reviews) {
		for (const finding of review.envelope.payload.findings) {
			reviewIdByFinding.set(finding.id, review.id);
		}
	}
	return result.dispositions.flatMap((disposition) => {
		const reviewId = reviewIdByFinding.get(disposition.findingId);
		return reviewId === undefined ? [] : [{ reviewId, disposition }];
	});
}

/* ------------------------------------------------------------------ */
/* Envelope builders                                                   */
/* ------------------------------------------------------------------ */

function producer(finishReason: string | undefined) {
	return {
		provider: "openai",
		modelId: DESIGN_MODEL,
		finishReason: finishReason ?? null,
	};
}

function contractEnvelope(args: {
	pkg: DesignSourcePackage;
	contract: AppDesignContract;
	revision: number;
	parentId: string | null;
	inputDigests: string[];
	promptVersion: string;
	finishReason: string | null | undefined;
}): DesignArtifactEnvelope<AppDesignContract> {
	return sealArtifactEnvelope({
		artifactType: "design-contract",
		artifactSchemaVersion: 1,
		artifactId: crypto.randomUUID(),
		designSessionId: args.pkg.designSessionId,
		revision: args.revision,
		parentArtifactId: args.parentId,
		sourcePackageDigest: args.pkg.packageDigest,
		inputArtifactDigests: args.inputDigests,
		promptVersion: args.promptVersion,
		producer: producer(args.finishReason ?? undefined),
		createdAt: new Date().toISOString(),
		complexity: computeDesignComplexity(args.contract),
		payload: args.contract,
	});
}

function reviewEnvelope(args: {
	pkg: DesignSourcePackage;
	draft: DesignRevisionRecord;
	review: DesignReview;
	finishReason: string | undefined;
}): DesignArtifactEnvelope<DesignReview> {
	return sealArtifactEnvelope({
		artifactType: "design-review",
		artifactSchemaVersion: 1,
		artifactId: crypto.randomUUID(),
		designSessionId: args.pkg.designSessionId,
		revision: args.draft.revision,
		parentArtifactId: args.draft.id,
		sourcePackageDigest: args.pkg.packageDigest,
		inputArtifactDigests: [args.draft.artifactDigest],
		promptVersion: DESIGN_PROMPT_VERSIONS.reviewer,
		producer: producer(args.finishReason),
		createdAt: new Date().toISOString(),
		payload: args.review,
	});
}

function composePlan(
	accepted: DesignRevisionRecord,
	draft: BuildPlanDraft,
): BuildPlan {
	return {
		schemaVersion: 2,
		designRevisionId: accepted.id,
		designRevisionDigest: accepted.artifactDigest,
		id: crypto.randomUUID(),
		slices: draft.slices,
		externalActions: draft.externalActions,
		intentOwnership: draft.intentOwnership,
	};
}

function planEnvelope(args: {
	pkg: DesignSourcePackage;
	accepted: DesignRevisionRecord;
	plan: BuildPlan;
	finishReason: string | undefined;
}): DesignArtifactEnvelope<BuildPlan> {
	return sealArtifactEnvelope({
		artifactType: "design-build-plan",
		artifactSchemaVersion: 1,
		artifactId: crypto.randomUUID(),
		designSessionId: args.pkg.designSessionId,
		revision: args.accepted.revision,
		parentArtifactId: args.accepted.id,
		sourcePackageDigest: args.pkg.packageDigest,
		inputArtifactDigests: [args.accepted.artifactDigest],
		promptVersion: DESIGN_PROMPT_VERSIONS.planner,
		producer: producer(args.finishReason),
		createdAt: new Date().toISOString(),
		payload: args.plan,
	});
}
