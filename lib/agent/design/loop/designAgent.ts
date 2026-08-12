/**
 * The design agent: ONE `ToolLoopAgent` that asks, drafts, dispositions,
 * and plans, on the same machinery the SA runs on. The server gates every
 * phase transition (`gates.ts` via the tools); this factory owns prompt
 * composition, tool registration, and the provider options that make the
 * loop cheap: one growing context under a per-session `promptCacheKey`, so
 * every step past the first cache-reads the whole prefix, and a same-thread
 * resume within the provider's TTL replays it as a read instead of a
 * re-design.
 */

import type {
	CallWarning,
	FinishReason,
	LanguageModel,
	LanguageModelUsage,
	ModelMessage,
	Schema,
	StepResultPerformance,
	UIMessage,
} from "ai";
import { jsonSchema, ToolLoopAgent, zodSchema } from "ai";
import {
	type AskQuestionsInput,
	askQuestionsInputSchema,
} from "@/lib/agent/tools/askQuestions";
import {
	modelMessagesContainCompaction,
	projectModelHistoryFromNewestCompaction,
} from "@/lib/chat/compaction";
import {
	DESIGN_AUTHOR_REASONING,
	reasoningProviderOptions,
} from "@/lib/models";
import { DESIGN_LOOP_STEP_BUDGET } from "./gates";
import { DESIGN_STATE_MESSAGE_HEADING } from "./packageRender";
import type { createDesignLoopTools } from "./tools";

/** The design registration of the client pause tool: same schema, same
 *  client contract, re-described to explicitly invite option-less free-text
 *  questions (the SA description's "2-4 answer options" framing would bend
 *  real design questions into invented multiple choice). */
export const DESIGN_ASK_QUESTIONS_DESCRIPTION =
	"Ask the user clarifying questions; execution pauses for their answers. Always available, any number of rounds. A question may be free text (an empty options list) or carry 2-4 options when real alternatives exist. Assume only what the user would not want to be asked.";

export interface DesignAgentArgs {
	readonly model: LanguageModel;
	readonly tools: ReturnType<typeof createDesignLoopTools>;
	readonly phase: "author" | "review" | "revision" | "awaiting-input";
	/** Static instruction suffix: the capability catalog plus the citable
	 *  platform constraints, byte-identical across a deploy's sessions. */
	readonly catalogText: string;
	readonly constraintsText: string;
	readonly instructions: string;
	/** Per-session prompt-cache affinity (`nova:design:<sessionId>`). */
	readonly promptCacheKey: string;
	/** The gates' latched budget error: thrown from `prepareStep` so an
	 *  exhausted repair or sequence budget ends the turn instead of asking
	 *  the model for another step. */
	readonly fatalError: () => Error | undefined;
	/** A finalization proof may establish that only the user can supply the
	 * remaining construction decisions. The next SDK step is then constrained
	 * to the client-side question tool instead of permitting another mutation
	 * or submission attempt. */
	readonly requiredUserQuestions: () =>
		| readonly string[]
		| Promise<readonly string[]>;
	/** A compact server-derived checkpoint appended immediately after a new
	 * provider compaction item. Durable workspace state, not the summarized
	 * model history, remains authoritative across the boundary. */
	readonly freshStateMessage: () => Promise<ModelMessage>;
	/** Fixed count of completed model steps before this stream began. The
	 * runner snapshots one POST-wide counter so SDK stop evaluation cannot
	 * double-count the steps that `onStepEnd` just recorded. */
	readonly stepsBeforeStream: number;
	readonly onStepEnd?: (step: DesignAgentStep) => void;
}

/** The step-finish surface the loop consumes, mirroring the SA's normalized
 *  `AgentStep` mapping so the shared handler stays SDK-version stable. */
export interface DesignAgentStep {
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
	toolEventMode?: "full" | "metadata-only";
}

export function designStepBudgetReached(
	stepsBeforeStream: number,
	stepsInCurrentStream: number,
): boolean {
	return stepsBeforeStream + stepsInCurrentStream >= DESIGN_LOOP_STEP_BUDGET;
}

interface DesignStopStep {
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
}

function isSuccessfulToolOutput(output: unknown): boolean {
	return (
		typeof output === "object" &&
		output !== null &&
		"ok" in output &&
		(output as { readonly ok?: unknown }).ok === true
	);
}

/** A finalizer ends a phase only after its tool result confirms that the
 * durable phase advanced. A rejected finalizer stays in the same SDK loop so
 * the model receives and repairs the exact diagnostics without a user retry. */
export function designPhaseTerminalSucceeded(
	steps: readonly DesignStopStep[],
	terminalToolName: string,
): boolean {
	const terminalCallIds = new Set(
		steps.flatMap((step) =>
			step.toolCalls.flatMap((call) =>
				call?.toolName === terminalToolName ? [call.toolCallId] : [],
			),
		),
	);
	return steps.some((step) =>
		step.toolResults.some(
			(result) =>
				result !== undefined &&
				terminalCallIds.has(result.toolCallId) &&
				isSuccessfulToolOutput(result.output),
		),
	);
}

function isDesignStateMessage(message: ModelMessage): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") {
		return message.content.startsWith(DESIGN_STATE_MESSAGE_HEADING);
	}
	return message.content.some(
		(part) =>
			part.type === "text" &&
			part.text.startsWith(DESIGN_STATE_MESSAGE_HEADING),
	);
}

const REQUIRED_QUESTION_HEADING =
	"# Required design questions (server-derived)";
export const REQUIRED_DESIGN_QUESTIONS_HEADER = "Required design decisions";
export const MAX_REQUIRED_DESIGN_QUESTIONS_PER_ROUND = 5;

export function requiredDesignQuestionBatch(
	questions: readonly string[],
): readonly string[] {
	return [
		...new Set(questions.map((question) => question.trim()).filter(Boolean)),
	].slice(0, MAX_REQUIRED_DESIGN_QUESTIONS_PER_ROUND);
}

/** A lazy tool schema calls this for both provider projection and SDK input
 * validation on each step. In a forced round it admits only the exact
 * server-derived batch, in order, with free-text answers; an ordinary design
 * question round retains the shared askQuestions schema. */
export function requiredDesignQuestionInputSchema(
	questions: readonly string[],
): Schema<AskQuestionsInput> {
	const batch = requiredDesignQuestionBatch(questions);
	if (batch.length === 0) return zodSchema(askQuestionsInputSchema);
	return jsonSchema<AskQuestionsInput>(
		{
			type: "object",
			additionalProperties: false,
			required: ["header", "questions"],
			properties: {
				header: {
					type: "string",
					const: REQUIRED_DESIGN_QUESTIONS_HEADER,
				},
				questions: {
					type: "array",
					minItems: batch.length,
					maxItems: batch.length,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["question", "options"],
						properties: {
							question: { type: "string", enum: [...batch] },
							options: {
								type: "array",
								maxItems: 0,
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										label: { type: "string" },
										description: { type: "string" },
									},
									required: ["label"],
								},
							},
						},
					},
				},
			},
		},
		{
			validate: (value) => {
				const parsed = askQuestionsInputSchema.safeParse(value);
				const exact =
					parsed.success &&
					parsed.data.header === REQUIRED_DESIGN_QUESTIONS_HEADER &&
					parsed.data.questions.length === batch.length &&
					parsed.data.questions.every(
						(question, index) =>
							question.question === batch[index] &&
							question.options.length === 0,
					);
				return exact
					? { success: true as const, value: parsed.data }
					: {
							success: false as const,
							error: new Error(
								"The forced question round must contain the exact server-derived questions.",
							),
						};
			},
		},
	);
}

export function requiredDesignQuestionBatchWasAnswered(
	messages: readonly UIMessage[],
	questions: readonly string[],
): boolean {
	const batch = requiredDesignQuestionBatch(questions);
	if (batch.length === 0) return false;
	const last = messages.at(-1);
	if (last?.role !== "assistant") return false;
	let lastStepStart = -1;
	last.parts.forEach((part, index) => {
		if (part.type === "step-start") lastStepStart = index;
	});
	return last.parts.slice(lastStepStart + 1).some((part) => {
		if (part.type !== "tool-askQuestions") return false;
		const shaped = part as unknown as {
			state?: unknown;
			input?: {
				header?: unknown;
				questions?: Array<{ question?: unknown; options?: unknown }>;
			};
			output?: Record<string, unknown>;
		};
		const asked = shaped.input?.questions;
		return (
			shaped.state === "output-available" &&
			shaped.input?.header === REQUIRED_DESIGN_QUESTIONS_HEADER &&
			Array.isArray(asked) &&
			asked.length === batch.length &&
			asked.every(
				(question, index) =>
					question.question === batch[index] &&
					Array.isArray(question.options) &&
					question.options.length === 0 &&
					typeof shaped.output?.[String(index)] === "string" &&
					(shaped.output[String(index)] as string).trim().length > 0,
			)
		);
	});
}

function isRequiredQuestionMessage(message: ModelMessage): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string")
		return message.content.startsWith(REQUIRED_QUESTION_HEADING);
	return message.content.some(
		(part) =>
			part.type === "text" && part.text.startsWith(REQUIRED_QUESTION_HEADING),
	);
}

export function requiredDesignQuestionMessage(
	questions: readonly string[],
): ModelMessage {
	const batch = requiredDesignQuestionBatch(questions);
	return {
		role: "user",
		content: [
			REQUIRED_QUESTION_HEADING,
			`Finalization proved that these decisions require the user. Call askQuestions now with header "${REQUIRED_DESIGN_QUESTIONS_HEADER}" and every exact question below, in order, using an empty options list for free-text answers. Do not stage more design, submit again, assume answers, remove workflows, or reinterpret their scope.`,
			...batch.map((question) => `- ${question}`),
		].join("\n"),
	};
}

export function requiredDesignQuestionStep(questions: readonly string[]) {
	const batch = requiredDesignQuestionBatch(questions);
	return batch.length === 0
		? null
		: {
				activeTools: ["askQuestions"] as const,
				toolChoice: {
					type: "tool" as const,
					toolName: "askQuestions" as const,
				},
				message: requiredDesignQuestionMessage(batch),
			};
}

export async function projectDesignStepMessages(
	messages: readonly ModelMessage[],
	freshStateMessage: () => Promise<ModelMessage>,
): Promise<ModelMessage[]> {
	const containedCompaction = modelMessagesContainCompaction(messages);
	const projected = projectModelHistoryFromNewestCompaction(messages);
	if (!containedCompaction) return projected;
	/* The provider may retain a recent but stale state packet beside its opaque
	 * checkpoint. Remove every old copy and install one exact server packet. */
	return [
		...projected.filter((message) => !isDesignStateMessage(message)),
		await freshStateMessage(),
	];
}

export function createDesignAgent(args: DesignAgentArgs) {
	let activeRequiredQuestions: readonly string[] = [];
	const phaseTools = {
		askQuestions: {
			description: DESIGN_ASK_QUESTIONS_DESCRIPTION,
			inputSchema: () =>
				requiredDesignQuestionInputSchema(activeRequiredQuestions),
			strict: false,
		},
		...(args.phase === "author" && {
			stageContract: args.tools.stageContract,
			inspectDesignWorkspace: args.tools.inspectDesignWorkspace,
			submitContract: args.tools.submitContract,
		}),
		...(args.phase === "review" && {
			requestReview: args.tools.requestReview,
		}),
		...(args.phase === "revision" && {
			stageRevision: args.tools.stageRevision,
			inspectDesignWorkspace: args.tools.inspectDesignWorkspace,
			submitRevision: args.tools.submitRevision,
		}),
	};
	const phaseTerminal =
		args.phase === "author"
			? "submitContract"
			: args.phase === "review"
				? "requestReview"
				: args.phase === "revision"
					? "submitRevision"
					: null;
	return new ToolLoopAgent({
		model: args.model,
		instructions: [
			args.instructions,
			"",
			args.catalogText,
			"",
			args.constraintsText,
		].join("\n"),
		stopWhen: ({ steps }) =>
			designStepBudgetReached(args.stepsBeforeStream, steps.length) ||
			(phaseTerminal !== null &&
				designPhaseTerminalSucceeded(steps, phaseTerminal)),
		/* Establishment-level provider retries, matching the SA's patience;
		 * mid-stream failures are the loop runner's bounded redrive. */
		maxRetries: 4,
		prepareStep: async ({ messages }) => {
			const fatal = args.fatalError();
			if (fatal !== undefined) throw fatal;
			const withFreshState = await projectDesignStepMessages(
				messages,
				args.freshStateMessage,
			);
			const requiredQuestions = await args.requiredUserQuestions();
			activeRequiredQuestions = requiredQuestions;
			const requiredQuestionStep =
				requiredDesignQuestionStep(requiredQuestions);
			const preparedMessages =
				requiredQuestionStep === null
					? withFreshState
					: [
							...withFreshState.filter(
								(message) => !isRequiredQuestionMessage(message),
							),
							requiredQuestionStep.message,
						];
			const providerOptions = reasoningProviderOptions(
				DESIGN_AUTHOR_REASONING.effort,
				{ promptCacheKey: args.promptCacheKey },
			);
			return {
				messages: preparedMessages,
				...(requiredQuestionStep !== null && {
					activeTools: requiredQuestionStep.activeTools,
					toolChoice: requiredQuestionStep.toolChoice,
				}),
				providerOptions: {
					openai: { ...providerOptions.openai, parallelToolCalls: false },
				},
			};
		},
		onStepEnd: (step) => {
			args.onStepEnd?.({
				usage: step.usage,
				text: step.text,
				reasoningText: step.reasoningText,
				toolCalls: step.toolCalls
					.filter((tc) => tc !== undefined)
					.map((tc) => ({
						toolCallId: tc.toolCallId,
						toolName: tc.toolName,
						input: tc.input,
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
		tools: phaseTools,
	});
}
