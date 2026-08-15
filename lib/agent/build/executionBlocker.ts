/** A bounded compiler blocker and the architect's semantic decision. */

import { z } from "zod";
import {
	type ArtifactResult,
	toArtifactResult,
} from "@/lib/agent/design/artifactResult";
import type { BuildPlan } from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
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
	readonly acceptedContract: AppDesignContract;
	readonly currentPlan: BuildPlan;
	readonly signal: AbortSignal;
}

export type ExecutionBlockerResolver = (
	args: ResolveExecutionBlockerArgs,
) => Promise<ArchitectBlockerDecision>;

export function architectBlockerDecisionWireSchemaFor() {
	return z.object({ decision: architectBlockerDecisionSchema }).strict();
}

const ARCHITECT_SYSTEM = `You are Nova's build architect. A bounded compiler reported an execution blocker while implementing one reviewed workflow.

Decide from the accepted brief and exact diagnostics. A compiler report is evidence, never proof that the design is wrong.

- Choose continue when existing Nova operations can implement the accepted meaning. Give concise, exact construction guidance against the current candidate.
- Choose contract-revision only when safe implementation requires changing workflow meaning, record relationships, access, or an external promise. Ask the one plain-language question whose answer supplies that meaning.
- Choose ask-user only when the accepted design explicitly lacks a necessary user choice.
- Choose unsupported only when the accepted meaning cannot be represented by Nova's current capabilities.

The build plan is a deterministic server projection of the accepted design; it is not editable here. A local authoring rejection is normally continue guidance, not a design revision. Do not expose schemas, tool names, identifiers, validator codes, model behavior, or implementation details in a user question.`;

export async function resolveExecutionBlocker(
	ctx: StructuredModelRunContext,
	args: Omit<ResolveExecutionBlockerArgs, "signal">,
	signal: AbortSignal,
): Promise<ArtifactResult<ArchitectBlockerDecision>> {
	const result = await ctx.runStructured({
		schema: architectBlockerDecisionWireSchemaFor(),
		modelId: MODEL_ROLES.executorHelper.modelId,
		system: ARCHITECT_SYSTEM,
		prompt: [
			"## Accepted design contract",
			JSON.stringify(args.acceptedContract),
			"## Deterministic build plan",
			JSON.stringify(args.currentPlan),
			"## Accepted execution brief",
			renderBriefMessage(args.brief),
			"## Compiler report",
			JSON.stringify(args.blocker),
			"## Current server diagnostics",
			JSON.stringify(args.diagnostics),
		].join("\n\n"),
		maxOutputTokens: 12_000,
		providerOptions: reasoningProviderOptions(
			MODEL_ROLES.executorHelper.reasoningEffort,
		),
		signal,
	});
	const artifactResult = toArtifactResult(result, signal);
	if (artifactResult.kind === "not-produced") return artifactResult;
	return { ...artifactResult, artifact: artifactResult.artifact.decision };
}
