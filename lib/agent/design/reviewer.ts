/**
 * The independent reviewer call — a stateless fresh-context critique of one
 * exact contract revision. Its inputs are EXACTLY the resolved source
 * package, the proposed contract payload, and the capability catalog: no
 * author reasoning, no prior reviewer prose, no tool authority (plan §7.1).
 * The cross-artifact grounding rules ride the schema factory, so an
 * ungrounded review is an invalid structured output.
 */

import {
	type ArtifactResult,
	toArtifactResult,
} from "@/lib/agent/design/artifactResult";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import {
	DESIGN_REVIEWER_SYSTEM,
	renderReviewPrompt,
	sourcePackageImages,
} from "@/lib/agent/design/prompts";
import {
	type DesignReview,
	designReviewSchemaFor,
} from "@/lib/agent/design/review";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import {
	DESIGN_MODEL,
	DESIGN_REVIEWER_REASONING,
	reasoningProviderOptions,
} from "@/lib/models";

export const DESIGN_REVIEWER_MAX_OUTPUT_TOKENS = 60_000;

export async function runDesignReviewer(
	ctx: StructuredModelRunContext,
	args: {
		pkg: DesignSourcePackage;
		contract: AppDesignContract;
		catalogText: string;
	},
	signal: AbortSignal,
	onProgress?: (deltaChars: number) => void,
): Promise<ArtifactResult<DesignReview>> {
	const result = await ctx.runStructured({
		schema: designReviewSchemaFor(args.contract, args.pkg),
		modelId: DESIGN_MODEL,
		system: DESIGN_REVIEWER_SYSTEM,
		prompt: renderReviewPrompt(args.pkg, args.contract, args.catalogText),
		images: sourcePackageImages(args.pkg),
		maxOutputTokens: DESIGN_REVIEWER_MAX_OUTPUT_TOKENS,
		providerOptions: reasoningProviderOptions(DESIGN_REVIEWER_REASONING.effort),
		signal,
		...(onProgress && { onProgress }),
	});
	return toArtifactResult(result, signal);
}
