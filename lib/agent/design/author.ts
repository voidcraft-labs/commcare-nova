/**
 * The design author call — source package in, draft Design Contract out.
 * The contract schema (graph proof included) IS the structured-output
 * schema, so an incoherent draft is an invalid structured output the
 * pipeline retries or surfaces — never an artifact.
 */

import {
	type ArtifactResult,
	toArtifactResult,
} from "@/lib/agent/design/artifactResult";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import {
	DESIGN_AUTHOR_SYSTEM,
	renderAuthorPrompt,
	sourcePackageImages,
} from "@/lib/agent/design/prompts";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import {
	DESIGN_AUTHOR_REASONING,
	DESIGN_MODEL,
	reasoningProviderOptions,
} from "@/lib/models";

/** Output ceiling for a full contract draft. */
export const DESIGN_AUTHOR_MAX_OUTPUT_TOKENS = 100_000;

export async function runDesignAuthor(
	ctx: StructuredModelRunContext,
	pkg: DesignSourcePackage,
	catalogText: string,
	signal: AbortSignal,
	onProgress?: (deltaChars: number) => void,
): Promise<ArtifactResult<AppDesignContract>> {
	const result = await ctx.runStructured({
		schema: appDesignContractSchema,
		modelId: DESIGN_MODEL,
		system: DESIGN_AUTHOR_SYSTEM,
		prompt: renderAuthorPrompt(pkg, catalogText),
		images: sourcePackageImages(pkg),
		maxOutputTokens: DESIGN_AUTHOR_MAX_OUTPUT_TOKENS,
		providerOptions: reasoningProviderOptions(DESIGN_AUTHOR_REASONING.effort),
		signal,
		...(onProgress && { onProgress }),
	});
	return toArtifactResult(result, signal);
}
