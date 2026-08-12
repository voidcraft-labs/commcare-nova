/**
 * The design agent: ONE `ToolLoopAgent` that asks, drafts, dispositions,
 * and plans, on the same machinery the SA runs on. The server gates every
 * phase transition (`gates.ts` via the tools); this factory owns prompt
 * composition, tool registration, and the provider options that make the
 * loop cacheable: one growing context under a per-session `promptCacheKey`,
 * giving the provider the same exact prefix to reuse across steps and a
 * same-thread resume within its cache TTL.
 */

import type {
	CallWarning,
	FinishReason,
	LanguageModel,
	LanguageModelUsage,
	ModelMessage,
	StepResultPerformance,
	UIMessage,
} from "ai";
import { ToolLoopAgent, zodSchema } from "ai";
import type { OpenQuestion } from "@/lib/agent/design/contract";
import { durableModelValueDigest } from "@/lib/agent/modelMessagePersistence";
import { askQuestionsInputSchema } from "@/lib/agent/tools/askQuestions";
import {
	modelMessagesContainCompaction,
	projectModelHistoryFromNewestCompaction,
} from "@/lib/chat/compaction";
import type { DurableUsageIdentity } from "@/lib/db/usage";
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
	 * remaining construction decisions. The next SDK step receives those exact
	 * questions, while server gates refuse design writes until they are answered. */
	readonly requiredUserQuestions: () =>
		| readonly OpenQuestion[]
		| Promise<readonly OpenQuestion[]>;
	/** A compact server-derived checkpoint appended immediately after a new
	 * provider compaction item. Durable workspace state, not the summarized
	 * model history, remains authoritative across the boundary. */
	readonly freshStateMessage: () => Promise<ModelMessage>;
	/** Persist a server state packet before the provider can observe a step that
	 * follows a new compaction boundary. The durable context stays append-only;
	 * this callback records the packet that the SDK's projected view inserts. */
	readonly onCompactionState?: (state: {
		readonly boundaryDigest: string;
		readonly message: ModelMessage;
	}) => Promise<void>;
	/** Fixed count of durable provider-call starts before this stream began. The
	 * runner snapshots one POST-wide counter so SDK stop evaluation cannot
	 * double-count the completed steps already represented in this stream. */
	readonly stepsBeforeStream: number;
	readonly onStepPrepared?: (step: {
		readonly stepNumber: number;
		readonly requestDigest: string;
	}) => Promise<void>;
	readonly onStepCompleted?: (step: {
		readonly stepNumber: number;
		readonly responseDigest: string;
		readonly responseMessages: readonly ModelMessage[];
		readonly toolCalls: readonly {
			readonly toolCallId: string;
			readonly toolName: string;
			readonly input: unknown;
		}[];
		readonly usage?: Record<string, unknown>;
	}) => Promise<DurableUsageIdentity | undefined>;
	readonly onStepEnd?: (step: DesignAgentStep) => void;
}

/** The step-finish surface the loop consumes, mirroring the SA's normalized
 *  `AgentStep` mapping so the shared handler stays SDK-version stable. */
export interface DesignAgentStep {
	usage?: LanguageModelUsage;
	durableUsageIdentity?: DurableUsageIdentity;
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
export const REQUIRED_DESIGN_QUESTION_AUTHORIZATION_PREFIX =
	"required-question-v4:";
export const REQUIRED_DESIGN_QUESTION_CARD_PREFIX =
	"required-question-card-v1:";

function normalizedRequiredDesignQuestions(
	questions: readonly OpenQuestion[],
): OpenQuestion[] {
	const byId = new Map<string, OpenQuestion>();
	for (const question of questions) {
		if (!question.question.trim()) continue;
		byId.set(question.id, { ...question, question: question.question.trim() });
	}
	return [...byId.values()];
}

function requiredDesignQuestionDigest(question: OpenQuestion): string {
	return durableModelValueDigest({
		id: question.id,
		question: question.question.trim(),
		structuralImpact: question.structuralImpact,
		relatedElementIds: question.relatedElementIds,
	});
}

export function requiredDesignQuestionBatch(
	questions: readonly OpenQuestion[],
): readonly OpenQuestion[] {
	return normalizedRequiredDesignQuestions(questions).slice(
		0,
		MAX_REQUIRED_DESIGN_QUESTIONS_PER_ROUND,
	);
}

/** Durable server provenance for one exact question batch. The key lives in
 * the private context-item ledger; customer transcript text cannot mint it. */
export function requiredDesignQuestionAuthorizationKey(
	questions: readonly OpenQuestion[],
): string {
	const normalized = normalizedRequiredDesignQuestions(questions);
	const batchHashes = normalized
		.slice(0, MAX_REQUIRED_DESIGN_QUESTIONS_PER_ROUND)
		.map(requiredDesignQuestionDigest)
		.join(":");
	const tailDigest = durableModelValueDigest(
		normalized
			.slice(MAX_REQUIRED_DESIGN_QUESTIONS_PER_ROUND)
			.map(requiredDesignQuestionDigest),
	);
	return `${REQUIRED_DESIGN_QUESTION_AUTHORIZATION_PREFIX}${batchHashes}:${tailDigest}`;
}

/** Provenance for the exact accepted client-side card. It is encoded into the
 * durable response append key, so answer matching can bind both the tool-call
 * identity and the identity-scoped question authorization without adding a
 * model-visible protocol message. */
export function requiredDesignQuestionCardAuthorizationKey(args: {
	readonly toolCallId: string;
	readonly authorizationKey: string;
	readonly input: unknown;
}): string {
	return `${REQUIRED_DESIGN_QUESTION_CARD_PREFIX}${durableModelValueDigest(args)}`;
}

interface AuthorizedQuestionBatch {
	readonly authorizationKey: string;
	readonly batchHashes: readonly string[];
	readonly tailDigest: string;
}

function authorizedQuestionBatches(
	authorizedAppendKeys: ReadonlySet<string>,
): AuthorizedQuestionBatch[] {
	return [...authorizedAppendKeys].flatMap((key) => {
		if (!key.startsWith(REQUIRED_DESIGN_QUESTION_AUTHORIZATION_PREFIX)) {
			return [];
		}
		const hashes = key
			.slice(REQUIRED_DESIGN_QUESTION_AUTHORIZATION_PREFIX.length)
			.split(":");
		const batchHashes = hashes.slice(0, -1);
		const tailDigest = hashes.at(-1);
		return batchHashes.length > 0 &&
			batchHashes.length <= MAX_REQUIRED_DESIGN_QUESTIONS_PER_ROUND &&
			tailDigest !== undefined &&
			hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))
			? [{ authorizationKey: key, batchHashes, tailDigest }]
			: [];
	});
}

/** The question tool's provider schema is immutable. Exact required questions
 * ride an appended server message and are validated by the pause protocol,
 * never by changing the tool definition underneath a cached context. */
export function requiredDesignQuestionInputSchema(
	_questions: readonly OpenQuestion[] = [],
) {
	return zodSchema(askQuestionsInputSchema);
}

/** Required-question calls are a server protocol, not free-form model output.
 * Keep the provider schema stable for caching, then authorize the exact input
 * before any question card is exposed to the user. */
export function isExactRequiredDesignQuestionCall(
	input: unknown,
	questions: readonly OpenQuestion[],
): boolean {
	const parsed = askQuestionsInputSchema.safeParse(input);
	if (!parsed.success) return false;
	const batch = requiredDesignQuestionBatch(questions);
	return (
		batch.length > 0 &&
		parsed.data.header === REQUIRED_DESIGN_QUESTIONS_HEADER &&
		parsed.data.questions.length === batch.length &&
		parsed.data.questions.every(
			(question, index) =>
				question.question.trim() === batch[index]?.question &&
				question.options.length === 0,
		)
	);
}

export function requiredDesignQuestionBatchWasAnswered(
	messages: readonly UIMessage[],
	questions: readonly OpenQuestion[],
	authorizedAppendKeys: ReadonlySet<string>,
): boolean {
	const pendingQuestions = normalizedRequiredDesignQuestions(questions);
	const pendingHashes = pendingQuestions.map(requiredDesignQuestionDigest);
	const authorizations = authorizedQuestionBatches(authorizedAppendKeys);
	if (pendingQuestions.length === 0) return false;
	for (const message of [...messages].reverse()) {
		if (message.role !== "assistant") continue;
		for (const part of [...message.parts].reverse()) {
			if (part.type !== "tool-askQuestions") continue;
			const shaped = part as unknown as {
				state?: unknown;
				input?: {
					header?: unknown;
					questions?: Array<{ question?: unknown; options?: unknown }>;
				};
				output?: Record<string, unknown>;
			};
			const asked = shaped.input?.questions;
			const requiredBatch =
				shaped.input?.header === REQUIRED_DESIGN_QUESTIONS_HEADER &&
				Array.isArray(asked) &&
				asked.length > 0 &&
				asked.length <= MAX_REQUIRED_DESIGN_QUESTIONS_PER_ROUND &&
				asked.every(
					(question) =>
						typeof question.question === "string" &&
						question.question.trim().length > 0 &&
						Array.isArray(question.options) &&
						question.options.length === 0,
				);
			if (!requiredBatch) continue;
			/* One answered round authorizes every bounded stage needed to apply its
			 * answers. The durable authorization key proves the card was the exact
			 * server-derived batch; transcript text alone cannot make that claim. After
			 * a bounded stage removes an answered prefix, the remaining suffix of that
			 * same card must be the current pending prefix. Once the suffix is empty, a
			 * later batch needs its own authorization and answer. */
			const representsCurrentBatch = authorizations.some((authorization) => {
				if (typeof part.toolCallId !== "string") return false;
				const cardKey = requiredDesignQuestionCardAuthorizationKey({
					toolCallId: part.toolCallId,
					authorizationKey: authorization.authorizationKey,
					input: shaped.input,
				});
				if (
					![...authorizedAppendKeys].some(
						(key) => key === cardKey || key.startsWith(`${cardKey}:response:`),
					)
				) {
					return false;
				}
				const firstPendingIndex = authorization.batchHashes.indexOf(
					pendingHashes[0] as string,
				);
				if (firstPendingIndex < 0) return false;
				const batchSuffix = authorization.batchHashes.slice(firstPendingIndex);
				return (
					batchSuffix.every((hash, index) => hash === pendingHashes[index]) &&
					durableModelValueDigest(
						pendingQuestions
							.slice(batchSuffix.length)
							.map(requiredDesignQuestionDigest),
					) === authorization.tailDigest
				);
			});
			if (!representsCurrentBatch) {
				/* A newer required-question-shaped card without matching durable
				 * provenance must not fall through to an older answered card. */
				return false;
			}
			return (
				shaped.state === "output-available" &&
				asked.every(
					(_question, index) =>
						typeof shaped.output?.[String(index)] === "string" &&
						(shaped.output[String(index)] as string).trim().length > 0,
				)
			);
		}
	}
	return false;
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
	questions: readonly OpenQuestion[],
): ModelMessage {
	const batch = requiredDesignQuestionBatch(questions);
	return {
		role: "user",
		content: [
			REQUIRED_QUESTION_HEADING,
			`Finalization proved that these decisions require the user. Call askQuestions now with header "${REQUIRED_DESIGN_QUESTIONS_HEADER}" and every exact question below, in order, using an empty options list for free-text answers. Do not stage more design, submit again, assume answers, remove workflows, or reinterpret their scope.`,
			...batch.map((question) => `- ${question.question}`),
		].join("\n"),
	};
}

export function requiredDesignQuestionStep(questions: readonly OpenQuestion[]) {
	const batch = requiredDesignQuestionBatch(questions);
	return batch.length === 0
		? null
		: {
				message: requiredDesignQuestionMessage(batch),
			};
}

export async function projectDesignStepMessages(
	messages: readonly ModelMessage[],
	freshStateMessage: () => Promise<ModelMessage>,
	onCompactionState?: (state: {
		readonly boundaryDigest: string;
		readonly message: ModelMessage;
	}) => Promise<void>,
): Promise<ModelMessage[]> {
	const containedCompaction = modelMessagesContainCompaction(messages);
	const projected = projectModelHistoryFromNewestCompaction(messages);
	if (!containedCompaction) return projected;
	/* The provider checkpoint is the only legal prefix replacement. If this
	 * compacted suffix has not yet received an authoritative state update,
	 * append one without deleting or replacing any retained item. */
	if (projected.some(isDesignStateMessage)) return projected;
	const message = await freshStateMessage();
	await onCompactionState?.({
		boundaryDigest: durableModelValueDigest(projected),
		message,
	});
	return [...projected, message];
}

export function createDesignAgent(args: DesignAgentArgs) {
	const stableTools = {
		askQuestions: {
			description: DESIGN_ASK_QUESTIONS_DESCRIPTION,
			inputSchema: requiredDesignQuestionInputSchema(),
			strict: false,
		},
		stageContract: args.tools.stageContract,
		inspectDesignWorkspace: args.tools.inspectDesignWorkspace,
		submitContract: args.tools.submitContract,
		requestReview: args.tools.requestReview,
		stageRevision: args.tools.stageRevision,
		submitRevision: args.tools.submitRevision,
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
		prepareStep: async ({ messages, stepNumber }) => {
			const fatal = args.fatalError();
			if (fatal !== undefined) throw fatal;
			const withFreshState = await projectDesignStepMessages(
				messages,
				args.freshStateMessage,
				args.onCompactionState,
			);
			const requiredQuestions = await args.requiredUserQuestions();
			const requiredQuestionStep =
				requiredDesignQuestionStep(requiredQuestions);
			const requiredQuestionMessage = requiredQuestionStep?.message;
			const preparedMessages =
				requiredQuestionMessage === undefined ||
				withFreshState.some(
					(message) =>
						isRequiredQuestionMessage(message) &&
						JSON.stringify(message) === JSON.stringify(requiredQuestionMessage),
				)
					? withFreshState
					: [...withFreshState, requiredQuestionMessage];
			const providerOptions = reasoningProviderOptions(
				DESIGN_AUTHOR_REASONING.effort,
				{ promptCacheKey: args.promptCacheKey },
			);
			await args.onStepPrepared?.({
				stepNumber: args.stepsBeforeStream + stepNumber + 1,
				requestDigest: durableModelValueDigest(preparedMessages),
			});
			return {
				messages: preparedMessages,
				providerOptions: {
					openai: { ...providerOptions.openai, parallelToolCalls: false },
				},
			};
		},
		onStepEnd: async (step) => {
			const normalizedStep: DesignAgentStep = {
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
			};
			/* The completion callback durably binds response bytes and usage before
			 * the run accumulator sees them. Its returned identity lets every process
			 * register the same paid call while the summary transaction counts it once. */
			const durableUsageIdentity = await args.onStepCompleted?.({
				stepNumber: args.stepsBeforeStream + step.stepNumber + 1,
				responseDigest: durableModelValueDigest(step.response.messages),
				responseMessages: step.response.messages,
				toolCalls: step.toolCalls
					.filter((call) => call !== undefined)
					.map((call) => ({
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						input: call.input,
					})),
				usage: JSON.parse(JSON.stringify(step.usage)) as Record<
					string,
					unknown
				>,
			});
			args.onStepEnd?.({
				...normalizedStep,
				...(durableUsageIdentity !== undefined && { durableUsageIdentity }),
			});
		},
		tools: stableTools,
	});
}
