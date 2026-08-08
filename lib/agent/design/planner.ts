/**
 * The build-slice planner call — accepted contract + capability catalog in,
 * a plan DRAFT out (slices, external actions, intent ownership). The
 * pipeline stamps server identity (plan id, revision id/digest) and parses
 * the composed plan through `buildPlanSchemaFor(contract)` — the model
 * never chooses server identity, and an incoherent plan never persists.
 */

import {
	type ArtifactResult,
	toArtifactResult,
} from "@/lib/agent/design/artifactResult";
import {
	type BuildPlanDraft,
	buildPlanDraftSchema,
} from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import {
	DESIGN_PLANNER_SYSTEM,
	renderPlanPrompt,
} from "@/lib/agent/design/prompts";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import {
	DESIGN_MODEL,
	DESIGN_PLANNER_REASONING,
	reasoningProviderOptions,
} from "@/lib/models";

export const DESIGN_PLANNER_MAX_OUTPUT_TOKENS = 60_000;

export async function runDesignPlanner(
	ctx: StructuredModelRunContext,
	args: { contract: AppDesignContract; catalogText: string },
	signal: AbortSignal,
	onProgress?: (deltaChars: number) => void,
): Promise<ArtifactResult<BuildPlanDraft>> {
	const result = await ctx.runStructured({
		schema: buildPlanDraftSchema,
		modelId: DESIGN_MODEL,
		system: DESIGN_PLANNER_SYSTEM,
		prompt: renderPlanPrompt(args.contract, args.catalogText),
		maxOutputTokens: DESIGN_PLANNER_MAX_OUTPUT_TOKENS,
		providerOptions: reasoningProviderOptions(DESIGN_PLANNER_REASONING.effort),
		signal,
		...(onProgress && { onProgress }),
	});
	return toArtifactResult(result, signal);
}
