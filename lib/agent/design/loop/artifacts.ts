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
import { MODEL_ROLES } from "@/lib/models";

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
		artifactSchemaVersion: args.contract.schemaVersion,
		artifactId: crypto.randomUUID(),
		designSessionId: args.designSessionId,
		revision: args.revision,
		parentArtifactId: args.parentId,
		sourcePackageDigest: args.packageDigest,
		inputArtifactDigests: args.inputDigests,
		promptVersion: args.promptVersion,
		producer: producer(MODEL_ROLES.designAuthor.modelId, args.finishReason),
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
		producer: producer(MODEL_ROLES.designReviewer.modelId, args.finishReason),
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
		artifactSchemaVersion: args.plan.schemaVersion,
		artifactId: crypto.randomUUID(),
		designSessionId: args.accepted.designSessionId,
		revision: args.accepted.revision,
		parentArtifactId: args.accepted.id,
		sourcePackageDigest: args.packageDigest,
		inputArtifactDigests: [
			args.accepted.artifactDigest,
			...(args.plan.lookupMaterialization !== null
				? [args.plan.lookupMaterialization.resultDigest]
				: []),
		],
		promptVersion: DESIGN_PROMPT_VERSIONS.planner,
		producer: {
			provider: "nova",
			modelId: "deterministic-build-planner-v2",
			finishReason: null,
		},
		createdAt: new Date().toISOString(),
		payload: args.plan,
	});
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
