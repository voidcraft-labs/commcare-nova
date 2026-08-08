/**
 * The reviser call — revised contract plus one disposition per
 * critical/important finding, closure proved inside the parse
 * (`designRevisionResultSchemaFor`). The revision-pair sensitivity rule is
 * checked here too: a quiet sensitivity downgrade makes the result an
 * invalid structured output rather than an artifact.
 */

import {
	type ArtifactResult,
	toArtifactResult,
} from "@/lib/agent/design/artifactResult";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import {
	DESIGN_REVISER_SYSTEM,
	renderRevisePrompt,
	sourcePackageImages,
} from "@/lib/agent/design/prompts";
import {
	type DesignReview,
	type DesignRevisionResult,
	designRevisionResultSchemaFor,
	validateSensitivityNotSilentlyLowered,
} from "@/lib/agent/design/review";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import { log } from "@/lib/logger";
import {
	DESIGN_MODEL,
	DESIGN_REVISER_REASONING,
	reasoningProviderOptions,
} from "@/lib/models";

export const DESIGN_REVISER_MAX_OUTPUT_TOKENS = 100_000;

export async function runDesignReviser(
	ctx: StructuredModelRunContext,
	args: {
		pkg: DesignSourcePackage;
		contract: AppDesignContract;
		reviews: readonly DesignReview[];
		catalogText: string;
	},
	signal: AbortSignal,
	onProgress?: (deltaChars: number) => void,
): Promise<ArtifactResult<DesignRevisionResult>> {
	const result = await ctx.runStructured({
		schema: designRevisionResultSchemaFor(args.reviews),
		modelId: DESIGN_MODEL,
		system: DESIGN_REVISER_SYSTEM,
		prompt: renderRevisePrompt(
			args.pkg,
			args.contract,
			args.reviews,
			args.catalogText,
		),
		images: sourcePackageImages(args.pkg),
		maxOutputTokens: DESIGN_REVISER_MAX_OUTPUT_TOKENS,
		providerOptions: reasoningProviderOptions(DESIGN_REVISER_REASONING.effort),
		signal,
		...(onProgress && { onProgress }),
	});
	const mapped = toArtifactResult(result, signal);
	if (mapped.kind !== "produced") return mapped;
	const violations = validateSensitivityNotSilentlyLowered(
		args.contract,
		mapped.artifact,
	);
	if (violations.length > 0) {
		/* Safe metadata only — the violation text names fact NAMES from the
		 * customer's design, so it stays out of the log line. */
		log.warn("[designReviser] revision quietly lowered fact sensitivity", {
			violationCount: violations.length,
		});
		return {
			kind: "not-produced",
			reason: "invalid-structured-output",
			usage: mapped.usage,
		};
	}
	return mapped;
}
