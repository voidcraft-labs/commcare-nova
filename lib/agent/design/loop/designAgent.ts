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
	StepResultPerformance,
} from "ai";
import { ToolLoopAgent } from "ai";
import { askQuestionsTool } from "@/lib/agent/tools/askQuestions";
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
	/** A compact server-derived checkpoint appended immediately after a new
	 * provider compaction item. Durable workspace state, not the summarized
	 * model history, remains authoritative across the boundary. */
	readonly freshStateMessage: () => Promise<ModelMessage>;
	/** Completed model steps before the current stream attempt. The runner
	 * updates this at each transient redrive, keeping one budget per POST. */
	readonly stepsBeforeStream: () => number;
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
	const phaseTools = {
		askQuestions: {
			description: DESIGN_ASK_QUESTIONS_DESCRIPTION,
			inputSchema: askQuestionsTool.inputSchema,
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
			designStepBudgetReached(args.stepsBeforeStream(), steps.length) ||
			(phaseTerminal !== null &&
				steps.some((step) =>
					step.toolCalls.some((call) => call?.toolName === phaseTerminal),
				)),
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
			const providerOptions = reasoningProviderOptions(
				DESIGN_AUTHOR_REASONING.effort,
				{ promptCacheKey: args.promptCacheKey },
			);
			return {
				messages: withFreshState,
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
