/**
 * Envelope construction and round-policy predicates for the design loop's
 * submit tools: the artifact-sealing half the retired pipeline owned.
 * Everything here is pure; persistence stays in `artifactStore`.
 */

import type {
	DesignReviewRecord,
	DesignRevisionRecord,
} from "@/lib/agent/design/artifactStore";
import type { BuildPlan } from "@/lib/agent/design/buildPlan";
import { computeDesignComplexity } from "@/lib/agent/design/complexity";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import {
	type DesignArtifactEnvelope,
	sealArtifactEnvelope,
} from "@/lib/agent/design/envelope";
import { DESIGN_PROMPT_VERSIONS } from "@/lib/agent/design/prompts";
import type {
	DesignReview,
	DesignRevisionResult,
	FindingDisposition,
} from "@/lib/agent/design/review";
import { DESIGN_AUTHOR_MODEL, DESIGN_REVIEWER_MODEL } from "@/lib/models";

function producer(modelId: string, finishReason: string | null | undefined) {
	return {
		provider: "openai",
		modelId,
		finishReason: finishReason ?? null,
	};
}

export function contractEnvelope(args: {
	designSessionId: string;
	packageDigest: string;
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
		designSessionId: args.designSessionId,
		revision: args.revision,
		parentArtifactId: args.parentId,
		sourcePackageDigest: args.packageDigest,
		inputArtifactDigests: args.inputDigests,
		promptVersion: args.promptVersion,
		producer: producer(DESIGN_AUTHOR_MODEL, args.finishReason),
		createdAt: new Date().toISOString(),
		complexity: computeDesignComplexity(args.contract),
		payload: args.contract,
	});
}

/** The review binds the DRAFT's package digest: the store proves the
 *  reviewer received the same source package the draft was authored from. */
export function reviewEnvelope(args: {
	draft: DesignRevisionRecord;
	review: DesignReview;
	finishReason: string | undefined;
}): DesignArtifactEnvelope<DesignReview> {
	return sealArtifactEnvelope({
		artifactType: "design-review",
		artifactSchemaVersion: 1,
		artifactId: crypto.randomUUID(),
		designSessionId: args.draft.designSessionId,
		revision: args.draft.revision,
		parentArtifactId: args.draft.id,
		sourcePackageDigest: args.draft.sourcePackageDigest,
		inputArtifactDigests: [args.draft.artifactDigest],
		promptVersion: DESIGN_PROMPT_VERSIONS.reviewer,
		producer: producer(DESIGN_REVIEWER_MODEL, args.finishReason),
		createdAt: new Date().toISOString(),
		payload: args.review,
	});
}

export function planEnvelope(args: {
	accepted: DesignRevisionRecord;
	packageDigest: string;
	plan: BuildPlan;
	finishReason: string | null | undefined;
}): DesignArtifactEnvelope<BuildPlan> {
	return sealArtifactEnvelope({
		artifactType: "design-build-plan",
		artifactSchemaVersion: 1,
		artifactId: crypto.randomUUID(),
		designSessionId: args.accepted.designSessionId,
		revision: args.accepted.revision,
		parentArtifactId: args.accepted.id,
		sourcePackageDigest: args.packageDigest,
		inputArtifactDigests: [args.accepted.artifactDigest],
		promptVersion: DESIGN_PROMPT_VERSIONS.planner,
		producer: {
			provider: "nova",
			modelId: "deterministic-build-planner-v1",
			finishReason: null,
		},
		createdAt: new Date().toISOString(),
		payload: args.plan,
	});
}

/* ------------------------------------------------------------------ */
/* §7.3 policy predicates (unchanged from the pipeline)                */
/* ------------------------------------------------------------------ */

/** "The first revision leaves a critical finding": a CRITICAL finding whose
 *  disposition did not resolve it by change: deferred, or rejected (the
 *  agent overriding the reviewer on a critical deserves the second
 *  independent look). */
export function leavesCriticalFinding(
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

/** Count the highest-severity findings that justified revision work. Review
 * depth by itself is not evidence that a second independent pass will add
 * value; the first pass's actual findings are. */
export function criticalFindingCount(reviews: readonly DesignReview[]): number {
	return reviews.reduce(
		(total, review) =>
			total +
			review.findings.filter((finding) => finding.severity === "critical")
				.length,
		0,
	);
}

/** Whether critical corrections changed the app boundary, record model,
 * workflow effects, or access semantics enough to warrant another review. */
export function changesArchitecture(
	before: AppDesignContract,
	after: AppDesignContract,
): boolean {
	const project = (contract: AppDesignContract) => ({
		charter: contract.charter,
		records: contract.records.map((record) => ({
			id: record.id,
			parentRecordId: record.parentRecordId,
			properties: record.properties.map((property) => ({
				id: property.id,
				dataShape: property.dataShape,
				sensitivity: property.sensitivity,
			})),
		})),
		workflows: contract.workflows.map((workflow) => ({
			id: workflow.id,
			contextRecordId: workflow.contextRecordId,
			prerequisiteWorkflowIds: workflow.prerequisiteWorkflowIds,
			recordEffects: workflow.recordEffects,
		})),
		access: contract.access,
	});
	return JSON.stringify(project(before)) !== JSON.stringify(project(after));
}

/** Map each disposition to the review row whose finding it closes. Closure
 *  (exactly one disposition per critical/important finding, no unknowns)
 *  was proved inside the submission parse; this is pure bookkeeping. */
export function mapDispositionsToReviews(
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
