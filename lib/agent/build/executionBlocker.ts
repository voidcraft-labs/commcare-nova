/**
 * Executor blockers and the architect's bounded decision.
 *
 * Luna reports observations only. It cannot declare the accepted design
 * contradictory, unsupported, or in need of user input. A fresh Sol call
 * receives the accepted brief plus exact current diagnostics and decides
 * whether the compiler can continue, the plan alone must be replaced, the
 * contract meaning must change, a person must answer, or Nova truly cannot
 * implement the request.
 */

import { z } from "zod";
import {
	type ArtifactResult,
	toArtifactResult,
} from "@/lib/agent/design/artifactResult";
import {
	type BuildPlan,
	buildPlanDraftSchema,
	buildPlanSchemaFor,
	MAX_CONSTRUCTION_GROUPS_PER_SLICE,
	MAX_INTENTS_PER_CONSTRUCTION_GROUP,
	MAX_OWNED_INTENTS_PER_SLICE,
	newPlanAdmissionMessages,
} from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import { designIdSchema } from "@/lib/agent/design/ids";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import { DESIGN_AUTHOR_MODEL, reasoningProviderOptions } from "@/lib/models";
import { renderBriefMessage, type SliceExecutionBrief } from "./executionBrief";

export const executionBlockerSchema = z
	.object({
		schemaVersion: z.literal(1),
		affectedIntentIds: z.array(designIdSchema).min(1),
		observations: z.array(z.string().min(1)).min(1).max(12),
		requestedDecision: z.string().min(1),
	})
	.strict();
export type ExecutionBlocker = z.infer<typeof executionBlockerSchema>;

export const architectBlockerDecisionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("continue"),
			guidance: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("plan-repair"),
			reason: z.string().min(1),
			repairedPlan: buildPlanDraftSchema,
		})
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
		.object({
			kind: z.literal("unsupported"),
			reason: z.string().min(1),
		})
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
	readonly planRepairAllowed: boolean;
	readonly signal: AbortSignal;
}

export type ExecutionBlockerResolver = (
	args: ResolveExecutionBlockerArgs,
) => Promise<ArchitectBlockerDecision>;

export function architectBlockerDecisionSchemaFor(args: {
	readonly acceptedContract: AppDesignContract;
	readonly currentPlan: BuildPlan;
	readonly planRepairAllowed: boolean;
}) {
	return architectBlockerDecisionSchema.superRefine((decision, ctx) => {
		if (decision.kind !== "plan-repair") return;
		if (!args.planRepairAllowed) {
			ctx.addIssue({
				code: "custom",
				path: ["kind"],
				message:
					"A plan repair is only available before the materialization root commits.",
			});
			return;
		}
		const candidate: BuildPlan = {
			schemaVersion: 1,
			designRevisionId: args.currentPlan.designRevisionId,
			designRevisionDigest: args.currentPlan.designRevisionDigest,
			id: crypto.randomUUID(),
			...decision.repairedPlan,
		};
		const parsed = buildPlanSchemaFor(args.acceptedContract).safeParse(
			candidate,
		);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				ctx.addIssue({
					code: "custom",
					path: ["repairedPlan", ...issue.path],
					message: issue.message,
				});
			}
		}
		for (const message of newPlanAdmissionMessages(candidate)) {
			ctx.addIssue({
				code: "custom",
				path: ["repairedPlan"],
				message,
			});
		}
	});
}

/** OpenAI strict structured output requires an object at the schema root.
 * Keep the architect's closed decision union nested on the provider wire and
 * unwrap it before returning the server-owned decision to orchestration. */
export function architectBlockerDecisionWireSchemaFor(
	args: Parameters<typeof architectBlockerDecisionSchemaFor>[0],
) {
	return z
		.object({ decision: architectBlockerDecisionSchemaFor(args) })
		.strict();
}

const ARCHITECT_SYSTEM = `You are Nova's build architect. A bounded compiler reported an execution blocker while implementing one already accepted slice.

Decide from the accepted brief and the server's exact diagnostics. A compiler report is evidence, never proof that the design is wrong.

- Choose continue when existing Nova operations can implement the accepted meaning. Give concise, exact construction guidance using the current candidate; never tell it to rebuild admitted work.
- Choose plan-repair only when the request explicitly says plan repair is available and the accepted contract remains correct but the construction strategy or slice boundary is wrong. Return a complete replacement plan draft over the same accepted contract. After materialization, preserve the durable plan and choose continue, contract-revision, or unsupported instead.
- Choose contract-revision only when implementing safely requires changing workflow meaning, access, external dependencies, or a source-backed requirement. Ask the one plain-language question whose answer supplies that meaning.
- Choose ask-user only when the accepted contract itself explicitly lacks a necessary user choice.
- Choose unsupported only when the accepted meaning cannot be represented by Nova's current capabilities.

A replacement plan must remain bounded and pass the same admission as an original plan: no slice may own more than ${MAX_OWNED_INTENTS_PER_SLICE} intents, no slice may have more than ${MAX_CONSTRUCTION_GROUPS_PER_SLICE} semantic groups, and no group may contain more than ${MAX_INTENTS_PER_CONSTRUCTION_GROUP} intents. Repair the smallest necessary slice boundary or construction group. Never merge otherwise valid slices merely to escape a local compiler rejection.

Do not expose schemas, tool names, UUIDs, validator codes, model behavior, or implementation details in a user question. Do not turn a local authoring rejection, ownership error, or validator repair into a contract revision.`;

export async function resolveExecutionBlocker(
	ctx: StructuredModelRunContext,
	args: Omit<ResolveExecutionBlockerArgs, "signal">,
	signal: AbortSignal,
): Promise<ArtifactResult<ArchitectBlockerDecision>> {
	const result = await ctx.runStructured({
		schema: architectBlockerDecisionWireSchemaFor(args),
		modelId: DESIGN_AUTHOR_MODEL,
		system: ARCHITECT_SYSTEM,
		prompt: [
			`Plan repair available before materialization: ${args.planRepairAllowed ? "yes" : "no"}`,
			"## Accepted design contract",
			JSON.stringify(args.acceptedContract),
			"## Current accepted build plan",
			JSON.stringify(args.currentPlan),
			"## Accepted execution brief",
			renderBriefMessage(args.brief),
			"## Compiler report",
			JSON.stringify(args.blocker),
			"## Current server diagnostics",
			JSON.stringify(args.diagnostics),
		].join("\n\n"),
		maxOutputTokens: 20_000,
		providerOptions: reasoningProviderOptions("high"),
		signal,
	});
	const artifactResult = toArtifactResult(result, signal);
	if (artifactResult.kind === "not-produced") return artifactResult;
	return {
		...artifactResult,
		artifact: artifactResult.artifact.decision,
	};
}
