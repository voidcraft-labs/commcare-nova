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
	type DesignRevisionRecord,
	insertDesignBuildPlan,
	insertDesignReview,
	insertDesignRevision,
	insertDesignSourcePackage,
	readDesignReviews,
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

export interface DesignPipelineArgs {
	ctx: StructuredModelRunContext;
	pkg: DesignSourcePackage;
	signal: AbortSignal;
}

export async function runDesignPipeline(
	args: DesignPipelineArgs,
): Promise<DesignPipelineOutcome> {
	const { ctx, pkg, signal } = args;
	await insertDesignSourcePackage({ pkg, runId: ctx.runId });

	/* ---- resume: converge on what already exists --------------------- */
	const latest = await readLatestDesignRevision(pkg.designSessionId);
	if (latest && latest.sourcePackageDigest === pkg.packageDigest) {
		if (latest.lifecycle === "accepted") {
			return finishFromAccepted(ctx, pkg, latest, signal);
		}
		/* A reviser-produced draft is round 2's re-review — resuming must not
		 * grant it another full round, or the bound breaks. */
		const round: 1 | 2 =
			latest.envelope.promptVersion === DESIGN_PROMPT_VERSIONS.reviser ? 2 : 1;
		const priorReviews = await readDesignReviews(latest.id);
		if (priorReviews.length === 0) {
			return reviewRound(ctx, pkg, latest, round, signal);
		}
		return reviseRound(ctx, pkg, latest, [], round, signal);
	}

	/* ---- author ------------------------------------------------------ */
	const authored = await runDesignAuthor(ctx, pkg, signal);
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
	return reviewRound(ctx, pkg, draft, 1, signal);
}

/* ------------------------------------------------------------------ */
/* Rounds                                                              */
/* ------------------------------------------------------------------ */

async function reviewRound(
	ctx: StructuredModelRunContext,
	pkg: DesignSourcePackage,
	draft: DesignRevisionRecord,
	round: 1 | 2,
	signal: AbortSignal,
): Promise<DesignPipelineOutcome> {
	const catalogText = renderCapabilityCatalog(buildCapabilityCatalog());
	const reviewed = await runDesignReviewer(
		ctx,
		{ pkg, contract: draft.envelope.payload, catalogText },
		signal,
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
	const gated = reviewed.artifact.findings.filter(
		(finding) =>
			finding.severity === "critical" || finding.severity === "important",
	);
	if (gated.length === 0) {
		/* Nothing to revise: acceptance re-issues the SAME contract content
		 * as a new accepted revision whose inputs bind the review. */
		const accepted = await insertDesignRevision({
			envelope: contractEnvelope({
				pkg,
				contract: draft.envelope.payload,
				revision: draft.revision + 1,
				parentId: draft.id,
				inputDigests: [draft.artifactDigest, review.artifactDigest],
				promptVersion: draft.envelope.promptVersion,
				finishReason: draft.envelope.producer.finishReason,
			}),
			lifecycle: "accepted",
			runId: ctx.runId,
			dispositions: [],
		});
		return finishFromAccepted(ctx, pkg, accepted, signal);
	}
	return reviseRound(
		ctx,
		pkg,
		draft,
		[reviewedRecordShim(review.envelope)],
		round,
		signal,
		[review.id],
	);
}

async function reviseRound(
	ctx: StructuredModelRunContext,
	pkg: DesignSourcePackage,
	draft: DesignRevisionRecord,
	reviews: readonly DesignReview[],
	round: 1 | 2,
	signal: AbortSignal,
	reviewIds?: readonly string[],
): Promise<DesignPipelineOutcome> {
	/* A resume path loads persisted review records; a live path passes the
	 * fresh payloads. Normalize both to payloads + row ids. */
	let reviewPayloads = reviews;
	let reviewRowIds = reviewIds;
	if (reviewRowIds === undefined) {
		const records = await readDesignReviews(draft.id);
		reviewPayloads = records.map((record) => record.envelope.payload);
		reviewRowIds = records.map((record) => record.id);
	}

	const revised = await runDesignReviser(
		ctx,
		{ pkg, contract: draft.envelope.payload, reviews: reviewPayloads },
		signal,
	);
	if (revised.kind === "not-produced") {
		return { kind: "not-produced", stage: "revise", reason: revised.reason };
	}
	const result = revised.artifact;
	const dispositions = mapDispositionsToReviews(
		result,
		reviewPayloads,
		reviewRowIds,
	);

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
			inputDigests: [draft.artifactDigest],
			promptVersion: DESIGN_PROMPT_VERSIONS.reviser,
			finishReason: revised.finishReason,
		}),
		lifecycle,
		runId: ctx.runId,
		dispositions,
	});
	if (lifecycle === "accepted") {
		return finishFromAccepted(ctx, pkg, revisionRecord, signal);
	}
	log.info("[designPipeline] second review round", {
		designSessionId: pkg.designSessionId,
		revision: revisionRecord.revision,
		depth,
	});
	return reviewRound(ctx, pkg, revisionRecord, 2, signal);
}

async function finishFromAccepted(
	ctx: StructuredModelRunContext,
	pkg: DesignSourcePackage,
	accepted: DesignRevisionRecord,
	signal: AbortSignal,
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
	reviews: readonly DesignReview[],
	reviewRowIds: readonly string[],
): Array<{ reviewId: string; disposition: FindingDisposition }> {
	const reviewIdByFinding = new Map<string, string>();
	reviews.forEach((review, index) => {
		const rowId = reviewRowIds[index];
		if (rowId === undefined) return;
		for (const finding of review.findings) {
			reviewIdByFinding.set(finding.id, rowId);
		}
	});
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

/** A live review round already holds the payload; the shim keeps one code
 *  path for the reviser call. */
function reviewedRecordShim(
	envelope: DesignArtifactEnvelope<DesignReview>,
): DesignReview {
	return envelope.payload;
}
