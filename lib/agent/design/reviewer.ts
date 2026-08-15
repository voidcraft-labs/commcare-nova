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
import type { DesignReview } from "@/lib/agent/design/review";
import { designReviewSchemaFor } from "@/lib/agent/design/reviewerSchema";
import type { ReviewHandleBinding } from "@/lib/agent/design/reviewVocabulary";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import { MODEL_ROLES, reasoningProviderOptions } from "@/lib/models";

export const DESIGN_REVIEWER_MAX_OUTPUT_TOKENS = 60_000;

export async function runDesignReviewer(
	ctx: StructuredModelRunContext,
	args: {
		pkg: DesignSourcePackage;
		contract: AppDesignContract;
		catalogText: string;
		/** The session's durable identity-handle ledger. ONE value feeds both
		 *  the prompt rendering and the output schema, so the symbols the
		 *  model reads and the symbols the schema resolves cannot drift. */
		bindings: readonly ReviewHandleBinding[];
	},
	signal: AbortSignal,
	onProgress?: (deltaChars: number) => void,
): Promise<ArtifactResult<DesignReview>> {
	const result = await ctx.runStructured({
		schema: designReviewSchemaFor({
			contract: args.contract,
			pkg: args.pkg,
			bindings: args.bindings,
		}),
		modelId: MODEL_ROLES.designReviewer.modelId,
		system: DESIGN_REVIEWER_SYSTEM,
		prompt: renderReviewPrompt(
			args.pkg,
			args.contract,
			args.catalogText,
			args.bindings,
		),
		images: sourcePackageImages(args.pkg),
		maxOutputTokens: DESIGN_REVIEWER_MAX_OUTPUT_TOKENS,
		providerOptions: reasoningProviderOptions(
			MODEL_ROLES.designReviewer.reasoningEffort,
		),
		signal,
		...(onProgress && { onProgress }),
	});
	return toArtifactResult(result, signal);
}
