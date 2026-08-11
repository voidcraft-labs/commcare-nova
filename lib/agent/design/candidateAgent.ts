/**
 * The reviewed-build author edits the executable private Blueprint directly.
 * It receives the same high-level Nova tools as the normal Solutions
 * Architect, with change-set handles replacing model-authored UUIDs. There is
 * no contract, build plan, slice, mutation envelope, or commit protocol in
 * the model vocabulary.
 */

import type {
	CallWarning,
	FinishReason,
	LanguageModel,
	LanguageModelUsage,
	ModelMessage,
	StepResultPerformance,
} from "ai";
import { ToolLoopAgent } from "ai";
import type { JSONSchema7 } from "json-schema";
import type { z } from "zod";
import { executorWireToolSchema } from "@/lib/agent/build/executorWireSchemas";
import { ChangeSetStagingRejectedError } from "@/lib/agent/change-set/errors";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import type { ChangeSetMutationWorkspace } from "@/lib/agent/change-set/workspace";
import { askQuestionsTool } from "@/lib/agent/tools/askQuestions";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import {
	modelMessagesContainCompaction,
	projectModelHistoryFromNewestCompaction,
} from "@/lib/chat/compaction";
import {
	DESIGN_AUTHOR_REASONING,
	reasoningProviderOptions,
} from "@/lib/models";
import { designBriefV1Schema } from "./candidate";
import {
	type CandidateAuthority,
	type CandidateCheckpoint,
	checkpointCandidate,
} from "./candidateStore";

export const CANDIDATE_STATE_HEADING =
	"# Private app candidate state (server-derived)";

export const CANDIDATE_AGENT_STEP_BUDGET = 80;

export interface CandidateAgentStep {
	usage?: LanguageModelUsage;
	text?: string;
	reasoningText?: string;
	toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
	toolResults?: Array<{ toolCallId: string; output: unknown }>;
	toolErrors?: Array<{ toolCallId: string; error: unknown }>;
	warnings?: CallWarning[];
	finishReason?: FinishReason;
	rawFinishReason?: string;
	performance?: StepResultPerformance;
	toolEventMode: "metadata-only";
}

interface ToolCallOptionsLike {
	readonly toolCallId?: string;
}

interface CandidateAgentArgs {
	readonly model: LanguageModel;
	readonly workspace: ChangeSetMutationWorkspace;
	readonly instructions: string;
	readonly designSessionId: string;
	readonly sourcePackageDigest: string;
	readonly authority: CandidateAuthority;
	readonly parentCheckpointId?: string;
	readonly promptCacheKey: string;
	readonly allowQuestions: boolean;
	readonly freshStateMessage: () => Promise<ModelMessage>;
	readonly onCheckpoint: (checkpoint: CandidateCheckpoint) => void;
	readonly onStepEnd?: (step: CandidateAgentStep) => void;
}

type CandidateHandleBinding = {
	readonly handle: string;
	readonly uuid: string;
};

function projectKnownIdentities(
	value: unknown,
	bindings: readonly CandidateHandleBinding[],
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => projectKnownIdentities(entry, bindings));
	}
	if (typeof value === "string") {
		const exact = bindings.find((binding) => binding.uuid === value);
		if (exact !== undefined) return { handle: exact.handle };
		return bindings.reduce(
			(text, binding) => text.replaceAll(binding.uuid, binding.handle),
			value,
		);
	}
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
			key,
			projectKnownIdentities(entry, bindings),
		]),
	);
}

export function projectCandidateText(
	text: string,
	workspace: ChangeSetMutationWorkspace,
): string {
	const projected = projectKnownIdentities(
		text,
		workspace.currentExecutionCheckpoint().handles,
	);
	return typeof projected === "string" ? projected : text;
}

function projectToolResult(
	value: unknown,
	workspace: ChangeSetMutationWorkspace,
): unknown {
	if (value === null || typeof value !== "object") return value;
	const envelope = value as {
		kind?: unknown;
		result?: unknown;
		data?: unknown;
	};
	const bindings = workspace.currentExecutionCheckpoint().handles;
	if (envelope.kind === "read") {
		return projectKnownIdentities(envelope.data, bindings);
	}
	if (envelope.kind !== "mutate") return value;
	const inner = envelope.result;
	if (inner === null || typeof inner !== "object") return inner;
	const { summary: _summary, ...rest } = inner as Record<string, unknown>;
	return projectKnownIdentities(rest, bindings);
}

const REQUIRED_CANDIDATE_IDENTITY_PROPERTIES: Readonly<
	Record<string, readonly string[]>
> = {
	createModule: [
		"moduleUuid",
		"formUuid",
		"fieldUuid",
		"optionUuid",
		"columnUuid",
	],
	createForm: ["formUuid", "fieldUuid", "optionUuid"],
	addFields: ["fieldUuid", "optionUuid"],
	addCaseListColumns: ["columnUuid"],
	addSearchInputs: ["searchInputUuid"],
	addCaseOperations: ["operationUuid"],
	addUserProperties: ["userPropertyUuid"],
	addUserTypes: ["userTypeUuid"],
	addPersonas: ["personaUuid"],
	addOrganizationLevels: ["uuid"],
	addLocationProperties: ["locationPropertyUuid"],
	addAutomations: ["uuid"],
	editField: ["optionUuid"],
	setFieldOptionsSource: ["optionUuid"],
};

function requireIdentityProperty(value: unknown, property: string): number {
	if (Array.isArray(value)) {
		return value.reduce(
			(count, entry) => count + requireIdentityProperty(entry, property),
			0,
		);
	}
	if (value === null || typeof value !== "object") return 0;
	const node = value as Record<string, unknown>;
	let count = 0;
	const properties = node.properties;
	if (
		properties !== null &&
		typeof properties === "object" &&
		!Array.isArray(properties) &&
		property in properties
	) {
		const required = Array.isArray(node.required)
			? node.required.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [];
		node.required = [...new Set([...required, property])];
		count += 1;
	}
	for (const entry of Object.values(node)) {
		count += requireIdentityProperty(entry, property);
	}
	return count;
}

/** Candidate authors must name every identity they create. The name is a
 * private handle; the workspace resolves it to a server-minted UUID before
 * the canonical tool schema and implementation run. */
export function candidateWireToolSchema(
	name: string,
	zodSchema: z.ZodType,
): JSONSchema7 {
	const schema = executorWireToolSchema(name, zodSchema);
	const properties = REQUIRED_CANDIDATE_IDENTITY_PROPERTIES[name];
	if (properties === undefined) return schema;
	for (const property of properties) {
		if (requireIdentityProperty(schema, property) === 0) {
			throw new Error(
				`The candidate cannot require the authored identity ${name}.${property}.`,
			);
		}
	}
	return schema;
}

function isCandidateStateMessage(message: ModelMessage): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") {
		return message.content.startsWith(CANDIDATE_STATE_HEADING);
	}
	return message.content.some(
		(part) =>
			part.type === "text" && part.text.startsWith(CANDIDATE_STATE_HEADING),
	);
}

export async function projectCandidateStepMessages(
	messages: readonly ModelMessage[],
	freshStateMessage: () => Promise<ModelMessage>,
): Promise<ModelMessage[]> {
	const compacted = modelMessagesContainCompaction(messages);
	const projected = projectModelHistoryFromNewestCompaction(messages);
	if (!compacted) return projected;
	return [
		...projected.filter((message) => !isCandidateStateMessage(message)),
		await freshStateMessage(),
	];
}

function successfulCheckpoint(
	steps: readonly {
		readonly toolCalls: readonly (
			| {
					readonly toolCallId: string;
					readonly toolName: string;
			  }
			| undefined
		)[];
		readonly toolResults: readonly (
			| {
					readonly toolCallId: string;
					readonly output: unknown;
			  }
			| undefined
		)[];
	}[],
): boolean {
	const callIds = new Set(
		steps.flatMap((step) =>
			step.toolCalls.flatMap((call) =>
				call?.toolName === "finishCandidate" ? [call.toolCallId] : [],
			),
		),
	);
	return steps.some((step) =>
		step.toolResults.some(
			(result) =>
				result !== undefined &&
				callIds.has(result.toolCallId) &&
				typeof result.output === "object" &&
				result.output !== null &&
				(result.output as { ok?: unknown }).ok === true,
		),
	);
}

/** Mount only complete, ordinary Nova tools. The two granular staging tools
 * deliberately stay private to legacy migration code: a reviewed candidate
 * is built with valid-by-construction semantic operations. */
export function createCandidateAgent(args: CandidateAgentArgs) {
	const tools = Object.fromEntries(
		[...CHANGE_SET_TOOL_REGISTRY.values()]
			.filter(
				(entry) => entry.name !== "stageModule" && entry.name !== "stageForm",
			)
			.map((entry) => [
				entry.name,
				{
					description: entry.tool.description,
					inputSchema: candidateWireToolSchema(
						entry.name,
						entry.tool.inputSchema,
					),
					strict: false,
					execute: async (input: unknown, options?: ToolCallOptionsLike) => {
						try {
							const dispatched = await args.workspace.stageDispatch({
								toolName: entry.name,
								requestId: options?.toolCallId ?? crypto.randomUUID(),
								input,
								intentIds: [],
							});
							return projectToolResult(dispatched.result, args.workspace);
						} catch (error) {
							if (error instanceof ChangeSetStagingRejectedError) {
								return { error: error.message };
							}
							throw error;
						}
					},
				},
			]),
	);

	return new ToolLoopAgent({
		model: args.model,
		instructions: args.instructions,
		stopWhen: ({ steps }) =>
			steps.length >= CANDIDATE_AGENT_STEP_BUDGET ||
			successfulCheckpoint(steps),
		maxRetries: 4,
		prepareStep: async ({ messages }) => ({
			messages: await projectCandidateStepMessages(
				messages,
				args.freshStateMessage,
			),
			providerOptions: {
				openai: {
					...reasoningProviderOptions(DESIGN_AUTHOR_REASONING.effort, {
						promptCacheKey: args.promptCacheKey,
					}).openai,
					parallelToolCalls: false,
				},
			},
		}),
		onStepEnd: (step) => {
			args.onStepEnd?.({
				usage: step.usage,
				text: step.text,
				reasoningText: step.reasoningText,
				toolCalls: step.toolCalls
					.filter((call) => call !== undefined)
					.map((call) => ({
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						input: call.input,
					})),
				toolResults: step.toolResults
					.filter((result) => result !== undefined)
					.map((result) => ({
						toolCallId: result.toolCallId,
						output: result.output,
					})),
				toolErrors: step.content.flatMap((part) =>
					part.type === "tool-error"
						? [{ toolCallId: part.toolCallId, error: part.error }]
						: [],
				),
				warnings: step.warnings,
				finishReason: step.finishReason,
				rawFinishReason: step.rawFinishReason,
				performance: step.performance,
				toolEventMode: "metadata-only",
			});
		},
		tools: {
			...(args.allowQuestions
				? {
						askQuestions: {
							description:
								"Ask only a genuinely blocking user question. Use free text unless real alternatives exist; the build pauses for the answer.",
							inputSchema: wireToolSchema(askQuestionsTool.inputSchema),
							strict: false,
						},
					}
				: {}),
			...tools,
			finishCandidate: {
				description:
					"Finish only after the complete requested app exists in the private candidate and all validation findings are resolved. Record the short user-facing design brief; do not restate the Blueprint.",
				inputSchema: designBriefV1Schema,
				strict: false,
				execute: async (brief: z.infer<typeof designBriefV1Schema>) => {
					const checkpoint = await checkpointCandidate({
						workspace: args.workspace,
						designSessionId: args.designSessionId,
						sourcePackageDigest: args.sourcePackageDigest,
						brief,
						lifecycle: "draft",
						...(args.parentCheckpointId !== undefined && {
							parentCheckpointId: args.parentCheckpointId,
						}),
						authority: args.authority,
					});
					args.onCheckpoint(checkpoint);
					return {
						ok: true,
					};
				},
			},
		},
	});
}
