/** A bounded repair decision grounded in the accepted task and current app. */

import { z } from "zod";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import {
	type ArtifactResult,
	toArtifactResult,
} from "@/lib/agent/design/artifactResult";
import type { BlueprintImplementation } from "@/lib/agent/design/projection/blueprint";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import { MODEL_ROLES, reasoningProviderOptions } from "@/lib/models";
import { renderBriefMessage, type SliceExecutionBrief } from "./executionBrief";

export const executionBlockerSchema = z
	.object({
		schemaVersion: z.literal(1),
		observations: z.array(z.string().min(1)).min(1).max(12),
		requestedDecision: z.string().min(1),
	})
	.strict();
export type ExecutionBlocker = z.infer<typeof executionBlockerSchema>;

export const architectBlockerDecisionSchema = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("continue"), guidance: z.string().min(1) })
		.strict(),
	z
		.object({
			kind: z.literal("contract-revision"),
			reason: z.string().min(1),
			question: z.string().min(1),
			options: z.array(z.string().min(1)).max(3),
		})
		.strict(),
	z
		.object({
			kind: z.literal("ask-user"),
			question: z.string().min(1),
			options: z.array(z.string().min(1)).max(3),
		})
		.strict(),
	z
		.object({ kind: z.literal("unsupported"), reason: z.string().min(1) })
		.strict(),
]);
export type ArchitectBlockerDecision = z.infer<
	typeof architectBlockerDecisionSchema
>;

export interface ResolveExecutionBlockerArgs {
	readonly blocker: ExecutionBlocker;
	readonly brief: SliceExecutionBrief;
	readonly diagnostics: unknown;
	readonly candidate: {
		readonly revision: number;
		readonly implementation: BlueprintImplementation;
	};
	readonly signal: AbortSignal;
}

export type ExecutionBlockerResolver = (
	args: ResolveExecutionBlockerArgs,
) => Promise<ArchitectBlockerDecision>;

export function architectBlockerDecisionWireSchemaFor() {
	return z.object({ decision: architectBlockerDecisionSchema }).strict();
}

/** The helper's decision is a short structured object; this bounds the
 * reasoning-inclusive output one blocker resolution may spend. */
export const ARCHITECT_MAX_OUTPUT_TOKENS = 12_000;

export const ARCHITECT_SYSTEM = `You help Nova resolve a problem while building a CommCare app.

The brief describes the accepted workflow. The candidate shows what exists now, and the diagnostics identify problems found by Nova. The builder's report may be mistaken. Check it against that evidence and the available operations before recommending a repair.

- continue: describe the smallest repair that preserves the accepted behavior. Identify the affected objects and the available operations; the builder can inspect their argument shapes.
- contract-revision: implementation would change the workflow's meaning, relationships, access, or an external promise. Explain the choice that needs resolving.
- ask-user: the accepted design explicitly leaves a necessary user choice open.
- unsupported: the available capabilities cannot implement the accepted behavior.

The candidate is private work, not a published app. Its field actions describe configured writes, not executed submissions. Unreadable sections are unknown, not missing. External records, deployment readiness and translated wording are outside this inspection. Do not invent a reset, edit operation, or runtime guarantee. A user question should describe the workflow choice in ordinary language.`;

export function renderBlockerPrompt(
	args: Omit<ResolveExecutionBlockerArgs, "signal">,
) {
	const operations = [
		...args.brief.toolProfile.readTools,
		...args.brief.toolProfile.mutationTools,
	].map((name) => {
		const entry = CHANGE_SET_TOOL_REGISTRY.get(name);
		if (!entry) throw new Error(`Unknown repair operation: ${name}.`);
		return `${name}: ${entry.tool.description}`;
	});
	return [
		"## Accepted workflow",
		renderBriefMessage(args.brief),
		"## Current candidate",
		JSON.stringify(args.candidate),
		"## Builder report",
		JSON.stringify(args.blocker),
		"## Server diagnostics",
		JSON.stringify(args.diagnostics),
		"## Operation reference",
		operations.join("\n"),
	].join("\n\n");
}

export async function resolveExecutionBlocker(
	ctx: StructuredModelRunContext,
	args: Omit<ResolveExecutionBlockerArgs, "signal">,
	signal: AbortSignal,
): Promise<ArtifactResult<ArchitectBlockerDecision>> {
	const result = await ctx.runStructured({
		schema: architectBlockerDecisionWireSchemaFor(),
		modelId: MODEL_ROLES.executorHelper.modelId,
		system: ARCHITECT_SYSTEM,
		prompt: renderBlockerPrompt(args),
		maxOutputTokens: ARCHITECT_MAX_OUTPUT_TOKENS,
		providerOptions: reasoningProviderOptions(
			MODEL_ROLES.executorHelper.reasoningEffort,
		),
		signal,
	});
	const artifactResult = toArtifactResult(result, signal);
	if (artifactResult.kind === "not-produced") return artifactResult;
	return { ...artifactResult, artifact: artifactResult.artifact.decision };
}
