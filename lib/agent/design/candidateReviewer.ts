import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import {
	DESIGN_REVIEWER_MODEL,
	DESIGN_REVIEWER_REASONING,
	reasoningProviderOptions,
} from "@/lib/models";
import { type ArtifactResult, toArtifactResult } from "./artifactResult";
import {
	type CandidateReview,
	candidateReviewSchema,
	type DesignBriefV1,
} from "./candidate";
import { CANDIDATE_REVIEWER_SYSTEM } from "./candidatePrompt";
import { renderSourcePackage, sourcePackageImages } from "./prompts";
import type { DesignSourcePackage } from "./sourcePackage";

export const CANDIDATE_REVIEW_PROMPT_VERSION = "v1";

export async function runCandidateReviewer(
	ctx: StructuredModelRunContext,
	args: {
		readonly pkg: DesignSourcePackage;
		readonly candidateSummary: string;
		readonly candidateDigest: string;
		readonly brief: DesignBriefV1;
		readonly kind: "full" | "verification";
		readonly priorFindings?: CandidateReview["findings"];
	},
	signal: AbortSignal,
): Promise<ArtifactResult<CandidateReview>> {
	const prompt = [
		renderSourcePackage(args.pkg),
		"",
		`# Exact private Blueprint candidate (${args.candidateDigest})`,
		args.candidateSummary,
		"",
		"# Design brief",
		JSON.stringify(args.brief, null, 1),
		...(args.kind === "verification"
			? [
					"",
					"# Focused verification",
					"Verify that these prior blocking findings are resolved and report only remaining or newly introduced material problems.",
					JSON.stringify(args.priorFindings ?? [], null, 1),
				]
			: ["", "Review the complete candidate once."]),
	].join("\n");
	const result = await ctx.runStructured({
		schema: candidateReviewSchema,
		modelId: DESIGN_REVIEWER_MODEL,
		system: CANDIDATE_REVIEWER_SYSTEM,
		prompt,
		images: sourcePackageImages(args.pkg),
		maxOutputTokens: 24_000,
		providerOptions: reasoningProviderOptions(DESIGN_REVIEWER_REASONING.effort),
		signal,
	});
	return toArtifactResult(result, signal);
}
