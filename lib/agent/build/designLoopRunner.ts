/**
 * The design-loop runner: mounts the design agent (`lib/agent/design/loop`)
 * on the chat build's stream and maps its terminal states onto the
 * orchestrator's vocabulary. This module is the design phase's writer
 * layer: the loop package stays pure (prompt, tools, gates, parsers), and
 * everything that touches the durable stream, the sanitizers, the redrive
 * policy, or progress frames lives here.
 *
 * Resume is by ANCESTRY plus thread, never by digest convergence: the
 * persisted artifacts decide what is legal (`gates.ts`), the thread carries
 * the dialogue, and the per-turn state message carries findings plus the
 * durable workspace checkpoint the thread may lack. Exact candidate/source
 * content remains available through bounded inspection, so a redrive,
 * compaction, or fresh-POST resume never re-produces committed work.
 */

import { randomUUID } from "node:crypto";
import type {
	InferAgentUIMessage,
	ModelMessage,
	ToolSet,
	UIMessage,
	UIMessageChunk,
} from "ai";
import { convertToModelMessages, validateUIMessages } from "ai";
import type {
	DesignArtifactWriteAuthority,
	DesignBuildPlanRecord,
	DesignRevisionRecord,
} from "@/lib/agent/design/artifactStore";
import { insertDesignSourcePackage } from "@/lib/agent/design/artifactStore";
import {
	type DesignArtifactKind,
	designWorkspaceCandidateSummary,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	openDesignArtifactWorkspace,
	readDesignIdentityHandleBindings,
} from "@/lib/agent/design/artifactWorkspaceStore";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "@/lib/agent/design/capabilityCatalog";
import {
	appDesignContractSchema,
	designConstructionQuestionRequirements,
	type OpenQuestion,
} from "@/lib/agent/design/contract";
import type { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import {
	createDesignAgent,
	DESIGN_WAIT_FOR_INPUT_TOOL,
	type DesignAgentStep,
	isExactRequiredDesignQuestionCall,
	REQUIRED_DESIGN_QUESTIONS_HEADER,
	requiredDesignQuestionAuthorizationKey,
	requiredDesignQuestionBatch,
	requiredDesignQuestionBatchWasAnswered,
	requiredDesignQuestionCardAuthorizationKey,
	requiredDesignQuestionMessage,
	unansweredRequiredDesignQuestions,
} from "@/lib/agent/design/loop/designAgent";
import {
	createMemoizedAncestryLoader,
	DESIGN_TERMINAL_CORRECTION_STEP_ALLOWANCE,
	type DesignGateState,
	DesignRepairTracker,
	type DesignSubmissionValidationStage,
	designLoopStepBudget,
	evaluateDesignGates,
} from "@/lib/agent/design/loop/gates";
import { rebuildPackageForDigest } from "@/lib/agent/design/loop/packageRebuild";
import {
	applySourceProjection,
	projectPackageOntoMessages,
	renderDesignStateMessage,
} from "@/lib/agent/design/loop/packageRender";
import {
	createDesignLoopTools,
	createDesignToolExecutionQueue,
	designWorkspaceLineageForGates,
	ensureDerivedBuildPlan,
	projectDesignIdentityHandles,
} from "@/lib/agent/design/loop/tools";
import {
	DESIGN_AGENT_SYSTEM,
	DESIGN_PROMPT_VERSIONS,
	renderPlatformConstraintsSection,
} from "@/lib/agent/design/prompts";
import { deriveFindingHandleBindings } from "@/lib/agent/design/reviewVocabulary";
import type {
	BuildSourcePackageArgs,
	DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import {
	type ClassifiedError,
	classifyError,
} from "@/lib/agent/errorClassifier";
import { durableModelValueDigest } from "@/lib/agent/modelMessagePersistence";
import { shouldRetryTurn, turnRetryDelayMs } from "@/lib/agent/turnRetry";
import {
	isOpenAICompactionChunk,
	projectCompatibleCompactedHistory,
} from "@/lib/chat/compaction";
import { sanitizeHistoricalReasoningParts } from "@/lib/chat/sanitizeReasoningParts";
import { sanitizeHistoricalToolParts } from "@/lib/chat/sanitizeToolParts";
import { createOpenPartTracker } from "@/lib/chat/streamPartClosure";
import { MODEL_CONTEXT_VERSION, MODEL_ROLES } from "@/lib/models";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	appendDesignModelContext,
	completeDesignModelStep,
	type DesignModelContextItem,
	openDesignModelContext,
	recordDesignModelStepEvent,
	recoverableCompletedModelSteps,
} from "./modelContextStore";
import type { OrchestratorStreamWriter } from "./orchestrator";
import type { OrchestrationHead } from "./orchestratorState";
import {
	createDesignPulseEmitter,
	createSubmissionStepNarrator,
	type DesignPulsePhase,
	type SubmissionStepNarrator,
} from "./progress";

export type DesignLoopOutcome =
	| {
			readonly kind: "planned";
			readonly revision: DesignRevisionRecord;
			readonly plan: DesignBuildPlanRecord;
	  }
	| {
			readonly kind: "awaiting-input";
			readonly headRevisionId: string | null;
	  }
	| {
			readonly kind: "failed";
			readonly errorType: string;
			readonly message: string;
			readonly recoverable: boolean;
	  };

export interface DesignToolOutcomeEvent {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly inputChars: number;
	readonly durationMs: number;
	readonly outcome:
		| "accepted"
		| "needs-input"
		| "rejected"
		| "wire-invalid"
		| "incomplete";
	readonly code: string;
	readonly validationStage?: DesignSubmissionValidationStage | "partial";
	readonly issueCount?: number;
}

export function designLoopStopMessage(gates: DesignGateState): string {
	if (gates.head === null)
		return "Nova preserved the unfinished design workspace, but couldn't produce an executable design. No design, plan, or app was accepted.";
	if (gates.head.lifecycle === "draft")
		return gates.headReviews.length > 0
			? "Nova preserved the reviewed draft, but couldn't resolve its remaining design requirements. No plan or app was accepted."
			: "Nova preserved the draft design, but couldn't finish checking it. No plan or app was accepted.";
	return "Nova preserved the accepted design, but couldn't derive its exact construction plan. No app was created.";
}

function readDesignToolDiagnostic(output: Record<string, unknown> | null): {
	readonly code: string;
	readonly validationStage?: DesignSubmissionValidationStage | "partial";
	readonly issueCount?: number;
} | null {
	const value = output?.diagnostic;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const diagnostic = value as Record<string, unknown>;
	if (typeof diagnostic.code !== "string" || diagnostic.code.length === 0)
		return null;
	const validationStage = diagnostic.validationStage;
	const issueCount = diagnostic.issueCount;
	return {
		code: diagnostic.code,
		...(validationStage === "partial" ||
		validationStage === "schema" ||
		validationStage === "construction" ||
		validationStage === "sensitivity"
			? { validationStage }
			: {}),
		...(typeof issueCount === "number" &&
		Number.isInteger(issueCount) &&
		issueCount >= 0
			? { issueCount }
			: {}),
	};
}

/** A fresh contract is being designed; replacing any persisted contract is a
 * revision from the person's point of view even though the same semantic
 * `finishDesign` call closes both kinds of workspace. */
export function contractSubmissionPulsePhase(
	hasPersistedContract: boolean,
): DesignPulsePhase {
	return hasPersistedContract ? "revise" : "design";
}

export function designToolPulsePhase(
	toolName: string,
	current: DesignPulsePhase,
): DesignPulsePhase {
	if (toolName === "requestReview") return "review";
	return current;
}

const DESIGN_UPDATE_STEP_LABELS: Readonly<Record<string, string>> = {
	setDesignRoot: "Setting the app direction",
	updateActors: "Understanding who does what",
	updateRecords: "Working out the records",
	updateWorkflows: "Shaping the workflows",
	updateLists: "Designing the worklists",
	updateAccess: "Setting who sees what",
	updateNavigation: "Laying out navigation",
	updateModuleCompositions: "Composing the menus",
	updateFormCompositions: "Composing the forms",
	updateExternalRequirements: "Checking what needs setup",
	updateDecisions: "Weighing the choices",
	updateAssumptions: "Recording assumptions",
	updateOpenQuestions: "Noting open questions",
	updateFindingDispositions: "Resolving review findings",
};

function modelToolPartIds(
	messages: readonly ModelMessage[],
	type: "tool-call" | "tool-result",
): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === type) ids.add(part.toolCallId);
		}
	}
	return ids;
}

function successfulDesignWaitOutput(output: unknown): boolean {
	const value =
		typeof output === "object" &&
		output !== null &&
		"type" in output &&
		output.type === "json" &&
		"value" in output
			? output.value
			: output;
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		value.ok === true &&
		"awaitingInput" in value &&
		value.awaitingInput === true
	);
}

export interface SuccessfulDesignWait {
	readonly toolCallId: string;
	readonly input: unknown;
	readonly output: { readonly ok: true; readonly awaitingInput: true };
}

/** A completed wait is durable in the private model ledger before the outer
 * orchestration pause is recorded. Read only the latest provider step: a later
 * ordinary user message or provider response supersedes this terminal. The
 * first provider-ordered valid input terminal wins: an earlier valid
 * askQuestions call therefore prevents a later wait from replacing its card,
 * while an invalid call yields to that wait and an earlier successful wait
 * prevents a later question from becoming visible. */
export function trailingSuccessfulDesignWait(
	messages: readonly ModelMessage[],
): SuccessfulDesignWait | null {
	const successfulWaits = new Map<string, SuccessfulDesignWait["output"]>();
	const erroredToolCalls = new Set<string>();
	let sawToolResults = false;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "tool" && Array.isArray(message.content)) {
			sawToolResults = true;
			for (const part of message.content) {
				if (part.type !== "tool-result") continue;
				if (
					part.output.type === "error-text" ||
					part.output.type === "error-json"
				) {
					erroredToolCalls.add(part.toolCallId);
				}
				if (
					part.toolName === DESIGN_WAIT_FOR_INPUT_TOOL &&
					successfulDesignWaitOutput(part.output)
				) {
					successfulWaits.set(part.toolCallId, {
						ok: true,
						awaitingInput: true,
					});
				}
			}
			continue;
		}
		if (message?.role === "assistant") {
			if (!sawToolResults || !Array.isArray(message.content)) return null;
			for (const part of message.content) {
				if (part.type !== "tool-call") continue;
				if (
					part.toolName === "askQuestions" &&
					!erroredToolCalls.has(part.toolCallId)
				) {
					return null;
				}
				const output = successfulWaits.get(part.toolCallId);
				if (
					part.toolName === DESIGN_WAIT_FOR_INPUT_TOOL &&
					output !== undefined
				) {
					return {
						toolCallId: part.toolCallId,
						input: part.input,
						output,
					};
				}
			}
			return null;
		}
		return null;
	}
	return null;
}

export function designModelContextTrailsSuccessfulWait(
	messages: readonly ModelMessage[],
): boolean {
	return trailingSuccessfulDesignWait(messages) !== null;
}

export function designWaitResponsePrefix(args: {
	readonly turnProvenanceId: string;
}): string {
	return `design-wait:${args.turnProvenanceId}:`;
}

export function designWaitResponseAppendKey(args: {
	readonly turnProvenanceId: string;
	readonly stepKey: string;
	readonly responseDigest: string;
}): string {
	return `${designWaitResponsePrefix(args)}${args.stepKey}:${args.responseDigest}`;
}

/** Recover a predecessor-generation wait only when its immutable response key
 * binds it to this exact logical input. A fresh user message changes the turn
 * provenance, so re-seeding a new provider context cannot accidentally treat
 * an older wait as the terminal for the new instruction. */
export function trailingSuccessfulDesignWaitForTurn(
	items: readonly DesignModelContextItem[],
	args: Parameters<typeof designWaitResponsePrefix>[0],
): SuccessfulDesignWait | null {
	/* Server-owned receipts may follow a provider response (for example, the
	 * closure for a question suppressed by an earlier wait). Find the latest
	 * provider response group so those receipts neither hide a committed wait
	 * nor let an older wait survive a genuinely newer provider response. */
	const latestResponseKey = items.findLast((item) =>
		isDesignProviderResponseAppendKey(item.appendKey),
	)?.appendKey;
	if (
		latestResponseKey === undefined ||
		!latestResponseKey.startsWith(designWaitResponsePrefix(args))
	) {
		return null;
	}
	return trailingSuccessfulDesignWait(
		items
			.filter((item) => item.appendKey === latestResponseKey)
			.map((item) => item.message),
	);
}

function isDesignProviderResponseAppendKey(appendKey: string): boolean {
	return (
		appendKey.startsWith("response:design:") ||
		appendKey.startsWith("design-wait:") ||
		appendKey.includes(":response:design:")
	);
}

export function recoverableDesignWaitForTurn(args: {
	readonly currentMessages: readonly ModelMessage[];
	readonly predecessorItems: readonly DesignModelContextItem[];
	readonly currentGenerationHasCompletedStep: boolean;
	readonly turnProvenanceId: string;
}): SuccessfulDesignWait | null {
	return (
		trailingSuccessfulDesignWait(args.currentMessages) ??
		(args.currentGenerationHasCompletedStep
			? null
			: trailingSuccessfulDesignWaitForTurn(args.predecessorItems, {
					turnProvenanceId: args.turnProvenanceId,
				}))
	);
}

export function recoveredDesignWaitChunks(
	wait: SuccessfulDesignWait,
): readonly UIMessageChunk[] {
	return [
		{
			type: "tool-input-start",
			toolCallId: wait.toolCallId,
			toolName: DESIGN_WAIT_FOR_INPUT_TOOL,
		},
		{
			type: "tool-input-available",
			toolCallId: wait.toolCallId,
			toolName: DESIGN_WAIT_FOR_INPUT_TOOL,
			input: wait.input,
		},
		{
			type: "tool-output-available",
			toolCallId: wait.toolCallId,
			output: wait.output,
		},
	];
}

function uiMessagesContainCompletedDesignWait(
	messages: readonly UIMessage[],
	toolCallId: string,
): boolean {
	return messages.some((message) =>
		message.parts.some((part) => {
			const candidate = part as {
				type?: unknown;
				toolCallId?: unknown;
				state?: unknown;
				output?: unknown;
			};
			return (
				candidate.type === "tool-waitForInput" &&
				candidate.toolCallId === toolCallId &&
				candidate.state === "output-available" &&
				successfulDesignWaitOutput(candidate.output)
			);
		}),
	);
}

function unansweredDesignQuestionCalls(
	messages: readonly ModelMessage[],
): Array<{ readonly toolCallId: string; readonly toolName: "askQuestions" }> {
	const answered = modelToolPartIds(messages, "tool-result");
	const calls: Array<{
		readonly toolCallId: string;
		readonly toolName: "askQuestions";
	}> = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const part of message.content) {
			if (
				part.type === "tool-call" &&
				part.toolName === "askQuestions" &&
				!answered.has(part.toolCallId)
			) {
				calls.push({
					toolCallId: part.toolCallId,
					toolName: "askQuestions",
				});
			}
		}
	}
	return calls;
}

/** Reconcile the one piece of a paused design conversation that arrives on a
 * later POST: the user's answer to a client-side askQuestions call. The
 * original assistant call normally already lives in the private transcript;
 * after a crash it may not, so this projects the exact final UI step and
 * appends whichever call/result items are actually missing. */
export async function projectAnsweredDesignContinuation(args: {
	readonly uiMessages: readonly UIMessage[];
	readonly modelContext: readonly ModelMessage[];
	readonly tools: ToolSet;
}): Promise<ModelMessage[]> {
	const callIds = modelToolPartIds(args.modelContext, "tool-call");
	const resultIds = modelToolPartIds(args.modelContext, "tool-result");
	const unansweredQuestions = unansweredDesignQuestionCalls(args.modelContext);
	const continuation: ModelMessage[] = [];
	/* A later user turn can follow an interrupted answered-question round. Scan
	 * the whole durable UI transcript in order so that missing answers are
	 * restored before that later user turn enters the private context. */
	for (const message of args.uiMessages) {
		if (message.role !== "assistant") continue;
		for (const part of message.parts) {
			if (
				part.type !== "tool-askQuestions" ||
				part.state !== "output-available" ||
				resultIds.has(part.toolCallId)
			) {
				continue;
			}
			const projected = await convertToModelMessages(
				[{ ...message, parts: [part] }] as UIMessage[],
				{ tools: args.tools },
			);
			for (const projectedMessage of projected) {
				if (!Array.isArray(projectedMessage.content)) {
					continuation.push(projectedMessage);
					continue;
				}
				if (projectedMessage.role === "assistant") {
					const content = projectedMessage.content.filter(
						(projectedPart) =>
							projectedPart.type !== "tool-call" ||
							!callIds.has(projectedPart.toolCallId),
					);
					if (content.length > 0) {
						continuation.push({ ...projectedMessage, content });
						for (const projectedPart of content) {
							if (projectedPart.type === "tool-call") {
								callIds.add(projectedPart.toolCallId);
							}
						}
					}
					continue;
				}
				if (projectedMessage.role === "tool") {
					const content = projectedMessage.content.filter(
						(projectedPart) =>
							projectedPart.type !== "tool-result" ||
							!resultIds.has(projectedPart.toolCallId),
					);
					if (content.length > 0) {
						continuation.push({ ...projectedMessage, content });
						for (const projectedPart of content) {
							if (projectedPart.type === "tool-result") {
								resultIds.add(projectedPart.toolCallId);
							}
						}
					}
				}
			}
		}
	}
	/* A paid askQuestions response can reach the private model ledger before its
	 * client card reaches the thread row. Dead-run redrive deliberately removes
	 * that partial assistant message. Close the now-orphaned function call before
	 * another provider request; the error grants no answer and lets the server
	 * derive and ask the still-current question batch again. */
	for (const call of unansweredQuestions) {
		if (resultIds.has(call.toolCallId)) continue;
		continuation.push({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					output: {
						type: "json",
						value: {
							error:
								"The question card was interrupted before a durable user answer. Re-evaluate the current required questions and ask them again if they remain necessary.",
						},
					},
				},
			],
		});
		resultIds.add(call.toolCallId);
	}
	return continuation;
}

export function designModelStepKey(args: {
	readonly attemptId: string;
	readonly stepNumber: number;
	readonly requestDigest: string;
}): string {
	return `design:${args.attemptId}:${args.stepNumber}:${args.requestDigest}`;
}

export function designTerminalOmissionCorrectionPrefix(args: {
	readonly turnProvenanceId: string;
}): string {
	return `design-terminal-omission:${args.turnProvenanceId}:`;
}

/** The one correction allowance is durable across process replacement. The
 * key binds to the incoming turn, not its replaceable assistant response: a
 * dead response can be regenerated under a new id, while the user message (or
 * answered question message) that authorized the work stays the same. */
export function designTerminalOmissionCanCorrect(
	appendKeys: ReadonlySet<string>,
	args: Parameters<typeof designTerminalOmissionCorrectionPrefix>[0],
): boolean {
	const prefix = designTerminalOmissionCorrectionPrefix(args);
	return ![...appendKeys].some((key) => key.startsWith(prefix));
}

/** Recover the one runner-owned provider step when its correction message was
 * committed at the ordinary ceiling but the process died before recording a
 * new provider-call start. The numeric suffix is the durable started-step
 * count at correction time, so equality proves the allowance is still unused. */
export function pendingDesignTerminalCorrectionStepAllowance(args: {
	readonly appendKeys: ReadonlySet<string>;
	readonly turnProvenanceId: string;
	readonly modelStepsSpent: number;
	readonly ordinaryStepBudget: number;
}): number {
	const prefix = designTerminalOmissionCorrectionPrefix({
		turnProvenanceId: args.turnProvenanceId,
	});
	for (const key of args.appendKeys) {
		if (!key.startsWith(prefix)) continue;
		const suffix = key.slice(prefix.length);
		if (!/^\d+$/.test(suffix)) continue;
		const correctedAt = Number.parseInt(suffix, 10);
		if (
			Number.isSafeInteger(correctedAt) &&
			correctedAt >= args.ordinaryStepBudget &&
			correctedAt === args.modelStepsSpent
		) {
			return DESIGN_TERMINAL_CORRECTION_STEP_ALLOWANCE;
		}
	}
	return 0;
}

/** Stable identity of the input that opened this logical design turn. A plain
 * send uses its user-message id. Answered question rounds share one assistant
 * message, so each uses the latest answered call plus a digest of its answer;
 * that distinguishes consecutive rounds and a deliberate re-answer while
 * remaining stable across response regeneration. */
export function designTurnProvenanceId(
	messages: readonly UIMessage[],
	fallbackResponseMessageId: string,
): string {
	const trailing = messages.at(-1);
	if (trailing === undefined) return fallbackResponseMessageId;
	if (trailing.role !== "assistant") return trailing.id;
	for (let index = trailing.parts.length - 1; index >= 0; index -= 1) {
		const part = trailing.parts[index];
		if (
			part?.type === "tool-askQuestions" &&
			part.state === "output-available"
		) {
			return `${trailing.id}:answer:${canonicalJsonDigest({
				toolCallId: part.toolCallId,
				output: part.output,
			})}`;
		}
	}
	return trailing.id;
}

/** A conversational wait may only become terminal when the server has no
 * mandatory question batch for the person. */
export function designWaitForInputCanPause(
	requiredQuestionCount: number,
): boolean {
	return requiredQuestionCount === 0;
}

/** Append every ordinary user turn that is absent from an already-open private
 * design context. The initial seed is one atomic append whose `seed-through`
 * key proves every UI message through that id was included; later turns carry
 * their own stable id. Scanning the whole transcript closes a process-death
 * gap even when more than one newer browser turn has since arrived. */
export async function projectMissingDesignUserContinuations(args: {
	readonly uiMessages: readonly UIMessage[];
	readonly appendKeys: ReadonlySet<string>;
	readonly tools: ToolSet;
}): Promise<
	Array<{
		readonly appendKey: string;
		readonly messages: readonly ModelMessage[];
	}>
> {
	let seededThrough = -1;
	for (const appendKey of args.appendKeys) {
		if (!appendKey.startsWith("seed-through:")) continue;
		const messageId = appendKey.slice("seed-through:".length);
		const index = args.uiMessages.findIndex(
			(message) => message.id === messageId,
		);
		if (index > seededThrough) seededThrough = index;
	}
	const continuations: Array<{
		appendKey: string;
		messages: readonly ModelMessage[];
	}> = [];
	for (let index = 0; index < args.uiMessages.length; index++) {
		const message = args.uiMessages[index];
		if (message?.role !== "user" || index <= seededThrough) continue;
		const appendKey = `ui-turn:${message.id}`;
		if (args.appendKeys.has(appendKey)) continue;
		continuations.push({
			appendKey,
			messages: await convertToModelMessages([message], { tools: args.tools }),
		});
	}
	return continuations;
}

function activeWorkspaceKind(
	gates: DesignGateState,
): DesignArtifactKind | null {
	if (gates.verdicts.submitRevision.legal) return "revision";
	if (gates.verdicts.submitContract.legal) return "contract";
	return null;
}

/** Recover a forced-question requirement from durable workspace state. This
 * closes the process-death gap between a finalizer proving the questions and
 * the client-side question card being emitted. */
export async function readRequiredDesignQuestionsFromWorkspace(args: {
	readonly designSessionId: string;
	readonly gates: DesignGateState;
	readonly authority: DesignArtifactWriteAuthority;
}): Promise<readonly OpenQuestion[]> {
	if (args.gates.head?.lifecycle === "accepted") {
		return args.gates.head.envelope.payload.openQuestions.filter(
			(question) => question.blocking,
		);
	}
	const kind = activeWorkspaceKind(args.gates);
	if (kind === null) return [];
	const workspace = await openDesignArtifactWorkspace({
		designSessionId: args.designSessionId,
		lineage: designWorkspaceLineageForGates(kind, args.gates),
		authority: args.authority,
	});
	const { dispositions: _dispositions, ...contractCandidate } =
		workspace.candidate;
	const parsed = appDesignContractSchema.safeParse(contractCandidate);
	if (!parsed.success) return [];
	return designConstructionQuestionRequirements(parsed.data) ?? [];
}

export interface DesignLoopRunnerArgs {
	readonly designSessionId: string;
	readonly projectId: string;
	readonly threadId: string;
	readonly runId: string;
	readonly actorUserId: string;
	readonly holderNonce: string;
	readonly responseMessageId: string;
	readonly messages: readonly UIMessage[];
	readonly pkg: DesignSourcePackage;
	readonly designCtx: DesignGenerationContext;
	readonly writer: OrchestratorStreamWriter;
	readonly signal: AbortSignal;
	readonly head: () => OrchestrationHead | null;
	/** The package builder's resource seams, for the reviewer's
	 *  point-in-time package re-render. */
	readonly packageDeps: BuildSourcePackageArgs["deps"];
	/** Step fan-out (usage, events, tool-call accounting): the route wires
	 *  `GenerationContext.handleAgentStep`. */
	readonly onAgentStep?: (step: DesignAgentStep) => void;
	/** The reviewer's display-safe reasoning summary → run event log. */
	readonly onReviewerReasoning?: (text: string) => void;
	/** Payload-free lifecycle facts for private design tools. Raw candidate
	 * content and validation prose stay out of the event log. */
	readonly onToolOutcome?: (event: DesignToolOutcomeEvent) => void;
	/** A transient mid-stream failure is being redriven: the route renders
	 *  it as a recoverable warning with the real classified type. */
	readonly onRecoverableRetry?: (classified: ClassifiedError) => void;
}

export async function runDesignAgentLoop(
	args: DesignLoopRunnerArgs,
): Promise<DesignLoopOutcome> {
	const authority = {
		actorUserId: args.actorUserId,
		runId: args.runId,
		holderNonce: args.holderNonce,
		expectedProjectId: args.projectId,
	};
	await insertDesignSourcePackage({ pkg: args.pkg, authority });

	const { loadAncestry, ancestryChanged } = createMemoizedAncestryLoader(
		args.designSessionId,
		args.pkg.packageDigest,
	);

	const initialGates = evaluateDesignGates(await loadAncestry());

	const repair = new DesignRepairTracker();
	const pulse = createDesignPulseEmitter(
		args.writer,
		args.designSessionId,
		args.head,
	);
	let livePulsePhase: DesignPulsePhase = initialGates.verdicts.submitRevision
		.legal
		? "revise"
		: initialGates.verdicts.requestReview.legal
			? "review"
			: "design";
	const catalogText = renderCapabilityCatalog(buildCapabilityCatalog());
	/* Declared before tool construction because a recovered workspace can ask
	 * the server gate about question provenance before the model context opens.
	 * Until its durable append keys load, no answered card is authorized. */
	let modelContextAppendKeys = new Set<string>();
	let modelContextProtocolKeys = new Set<string>();
	const turnProvenanceId = designTurnProvenanceId(
		args.messages,
		args.responseMessageId,
	);
	const toolDeps = {
		designSessionId: args.designSessionId,
		runId: args.runId,
		authority,
		currentPkg: args.pkg,
		catalogText,
		ctx: args.designCtx,
		signal: args.signal,
		repair,
		loadAncestry,
		ancestryChanged,
		rebuildPackageForDigest: (digest: string) =>
			rebuildPackageForDigest({
				designSessionId: args.designSessionId,
				projectId: args.projectId,
				threadId: args.threadId,
				digest,
				messages: args.messages as BuildSourcePackageArgs["messages"],
				deps: args.packageDeps,
			}),
		requiredQuestionsWereAnswered: (questions: readonly OpenQuestion[]) =>
			requiredDesignQuestionBatchWasAnswered(
				args.messages,
				questions,
				modelContextProtocolKeys,
			),
		onReviewActivity: (deltaChars: number) => pulse("review", deltaChars),
		...(args.onReviewerReasoning !== undefined && {
			onReviewerReasoning: args.onReviewerReasoning,
		}),
	};
	const toolExecutionQueue = createDesignToolExecutionQueue();
	const tools = createDesignLoopTools(toolDeps, toolExecutionQueue);
	const recoveredPlan = await ensureDerivedBuildPlan(toolDeps, initialGates);
	const stateMessageFor = async (
		gates: DesignGateState,
	): Promise<ModelMessage> => {
		const head = gates.head;
		const openReviews =
			head !== null &&
			head.lifecycle === "draft" &&
			gates.headReviews.length > 0
				? gates.headReviews
				: [];
		const workspaceKind = activeWorkspaceKind(gates);
		const workspace =
			workspaceKind === null
				? null
				: await openDesignArtifactWorkspace({
						designSessionId: args.designSessionId,
						lineage: designWorkspaceLineageForGates(workspaceKind, gates),
						authority,
					});
		/* The ledger read stands alone so open findings project through the
		 * session's handles even before any revision workspace exists — the
		 * workspace-bundled copy is the same session-scoped rows. */
		const ledgerBindings =
			workspace?.handleBindings ??
			(openReviews.length > 0
				? await readDesignIdentityHandleBindings({
						designSessionId: args.designSessionId,
						authority,
					})
				: []);
		return {
			role: "user",
			content: renderDesignStateMessage({
				gates,
				claims: args.pkg.claims,
				openReviews:
					openReviews.length > 0
						? (() => {
								/* The SAME positional numbering the requestReview result
								 * printed: continuous across the head's reviews in ordinal
								 * order. */
								const projectionBindings = [
									...ledgerBindings,
									...deriveFindingHandleBindings(
										openReviews.map((entry) => entry.envelope.payload),
									),
								];
								return openReviews.map((review) => ({
									summary: review.envelope.payload.summary,
									findings: projectDesignIdentityHandles(
										review.envelope.payload.findings,
										projectionBindings,
									),
								}));
							})()
						: null,
				workspace:
					workspace === null || workspaceKind === null
						? null
						: {
								artifactKind: workspaceKind,
								...designWorkspaceCandidateSummary(
									workspaceKind,
									workspace.candidate,
								),
								candidate: projectDesignIdentityHandles(
									workspace.candidate,
									workspace.handleBindings,
								) as Record<string, unknown>,
								sourceContract: projectDesignIdentityHandles(
									workspace.sourceContract,
									workspace.handleBindings,
								) as Record<string, unknown> | null,
							},
			}),
		};
	};

	type InternalPhase = "author" | "review" | "revision" | "awaiting-input";
	const phaseFor = (gates: DesignGateState): InternalPhase =>
		gates.verdicts.submitRevision.legal
			? "revision"
			: gates.verdicts.requestReview.legal
				? "review"
				: gates.verdicts.submitContract.legal
					? "author"
					: "awaiting-input";
	let modelStepsSpent = 0;
	/** The durable context's generation: each rollover (a real deployment
	 * change) raises the step ceiling by the capped allowance, so steps a
	 * since-fixed harness consumed cannot starve the corrected retry. */
	let modelContextGeneration = 0;
	/* One model-visible context for the whole design attempt. Durable phase
	 * transitions append state and tool receipts to this sequence; they never
	 * reconstruct a phase-local prompt. Provider compaction inside
	 * `prepareStep` is the sole legal prefix replacement. */
	let modelContext: ModelMessage[] | null = null;
	let modelContextPredecessorItems: readonly DesignModelContextItem[] = [];
	let modelContextGenerationHasCompletedStep = false;
	let modelContextId: string | null = null;
	let terminalCorrectionStepAllowance = 0;
	const modelContextAuthority = {
		actorUserId: args.actorUserId,
		runId: args.runId,
		holderNonce: args.holderNonce,
		expectedProjectId: args.projectId,
	};
	const appendContext = async (
		appendKey: string,
		messages: readonly ModelMessage[],
	): Promise<void> => {
		if (messages.length === 0 || modelContextAppendKeys.has(appendKey)) return;
		if (modelContextId === null) {
			throw new Error("The durable design model context is not open.");
		}
		await appendDesignModelContext({
			designSessionId: args.designSessionId,
			contextId: modelContextId,
			appendKey,
			messages,
			authority: modelContextAuthority,
		});
		modelContextAppendKeys.add(appendKey);
		modelContextProtocolKeys.add(appendKey);
	};
	const openAndRecoverModelContext = async (): Promise<void> => {
		if (modelContextId !== null) return;
		const toolsetDigest = canonicalJsonDigest(
			await Promise.all(
				Object.entries(tools).map(async ([name, definition]) => ({
					name,
					description: definition.description,
					strict: definition.strict,
					inputSchema: await definition.inputSchema.jsonSchema,
				})),
			),
		);
		const persisted = await openDesignModelContext({
			designSessionId: args.designSessionId,
			kind: "design",
			modelId: MODEL_ROLES.designAuthor.modelId,
			promptVersion: DESIGN_PROMPT_VERSIONS.agent,
			toolsetDigest,
			contextVersion: MODEL_CONTEXT_VERSION,
			authority: modelContextAuthority,
		});
		modelContextId = persisted.id;
		modelContext = [...persisted.messages];
		modelContextPredecessorItems = persisted.predecessorItems;
		modelContextGenerationHasCompletedStep =
			persisted.completedStepKeys.size > 0;
		modelContextAppendKeys = new Set(persisted.appendKeys);
		modelContextProtocolKeys = new Set(persisted.lineageAppendKeys);
		modelStepsSpent = persisted.totalStartedStepCount;
		modelContextGeneration = persisted.generation;
		/* Re-register every usage-bearing response from this long-lived run in
		 * the exact-once meter only. Recovered steps are historical evidence, not
		 * fresh model activity, so they must never re-enter `onAgentStep` and emit
		 * duplicate step-usage/tool/reasoning conversation events. */
		for (const completed of recoverableCompletedModelSteps(
			persisted.completedSteps,
			args.runId,
		)) {
			args.designCtx.trackDurableSubGeneration(
				completed.usage,
				{
					contextId: completed.contextId,
					stepKey: completed.stepKey,
				},
				MODEL_ROLES.designAuthor.modelId,
				{ step: true, phase: "design-author" },
			);
		}
	};
	await openAndRecoverModelContext();
	terminalCorrectionStepAllowance =
		pendingDesignTerminalCorrectionStepAllowance({
			appendKeys: modelContextProtocolKeys,
			turnProvenanceId,
			modelStepsSpent,
			ordinaryStepBudget: designLoopStepBudget(modelContextGeneration),
		});
	const openParts = createOpenPartTracker();
	const replayRecoveredWait = (wait: SuccessfulDesignWait): void => {
		if (uiMessagesContainCompletedDesignWait(args.messages, wait.toolCallId)) {
			return;
		}
		for (const chunk of recoveredDesignWaitChunks(wait)) {
			openParts.observe(chunk);
			args.writer.write(chunk);
		}
	};
	const recoveredWaitForCurrentTurn = (): SuccessfulDesignWait | null =>
		recoverableDesignWaitForTurn({
			currentMessages: modelContext ?? [],
			predecessorItems: modelContextPredecessorItems,
			currentGenerationHasCompletedStep: modelContextGenerationHasCompletedStep,
			turnProvenanceId,
		});
	if (recoveredPlan !== null && initialGates.newestAccepted !== null) {
		const recoveredWait = recoveredWaitForCurrentTurn();
		if (recoveredWait !== null) {
			replayRecoveredWait(recoveredWait);
			return {
				kind: "awaiting-input",
				headRevisionId: initialGates.head?.id ?? null,
			};
		}
		return {
			kind: "planned",
			revision: initialGates.newestAccepted,
			plan: recoveredPlan,
		};
	}

	let turnRetries = 0;
	let pausedOnQuestions = false;
	let pausedForMoreInput = false;
	let failure: ClassifiedError | null = null;
	let protocolFailure: DesignLoopOutcome | null = null;

	for (;;) {
		pausedOnQuestions = false;
		pausedForMoreInput = false;
		let sawFatalError = false;
		let pendingError: unknown;

		const gates = evaluateDesignGates(await loadAncestry());
		if (gates.plan !== null) break;
		const phase = phaseFor(gates);
		const stepBudgetAllowance = terminalCorrectionStepAllowance;
		const stepsBeforeStream = modelStepsSpent;
		/* One provider invocation identity. A replacement process or bounded
		 * stream redrive must never reuse the completed-event identity of a call
		 * whose response bytes were not durably observed by that process. */
		const modelAttemptId = randomUUID();
		const stepEventKeys = new Map<number, string>();
		let activeRequiredQuestionBatch: readonly OpenQuestion[] = [];
		let activeRequiredQuestionAuthorizationKey: string | null = null;
		const requiredUserQuestions = async (): Promise<
			readonly OpenQuestion[]
		> => {
			const pending = repair.requiredUserQuestions();
			const questions =
				pending.length > 0
					? pending
					: await readRequiredDesignQuestionsFromWorkspace({
							designSessionId: args.designSessionId,
							gates: evaluateDesignGates(await loadAncestry()),
							authority,
						});
			/* An answer binds to the exact question identity, so a question the
			 * user already answered is never demanded again; only genuinely new
			 * or re-authored questions come back to them. */
			const unanswered = unansweredRequiredDesignQuestions(
				args.messages,
				questions,
				modelContextProtocolKeys,
			);
			if (unanswered.length === 0) {
				activeRequiredQuestionBatch = [];
				activeRequiredQuestionAuthorizationKey = null;
				return [];
			}
			activeRequiredQuestionBatch = requiredDesignQuestionBatch(unanswered);
			const authorizationKey =
				requiredDesignQuestionAuthorizationKey(unanswered);
			activeRequiredQuestionAuthorizationKey = authorizationKey;
			if (!modelContextAppendKeys.has(authorizationKey)) {
				const authorization = requiredDesignQuestionMessage(unanswered);
				await appendContext(authorizationKey, [authorization]);
				modelContext = [...(modelContext ?? []), authorization];
			}
			return unanswered;
		};
		const agent = createDesignAgent({
			model: args.designCtx.model(MODEL_ROLES.designAuthor.modelId),
			tools,
			toolExecutionQueue,
			phase,
			catalogText,
			constraintsText: renderPlatformConstraintsSection(),
			instructions: DESIGN_AGENT_SYSTEM,
			promptCacheKey: `nova:design:${args.designSessionId}`,
			fatalError: () => repair.fatalError(),
			requiredUserQuestions,
			freshStateMessage: async () =>
				stateMessageFor(evaluateDesignGates(await loadAncestry())),
			onCompactionState: async ({ boundaryDigest, message }) => {
				const appendKey = `compaction-state:${boundaryDigest}:${durableModelValueDigest(message)}`;
				if (modelContextAppendKeys.has(appendKey)) return;
				await appendContext(appendKey, [message]);
				modelContext = [...(modelContext ?? []), message];
			},
			stepsBeforeStream,
			contextGeneration: modelContextGeneration,
			stepBudgetAllowance,
			onStepEnd: (step) => args.onAgentStep?.(step),
			onStepPrepared: async (step) => {
				if (modelContextId === null) {
					throw new Error("The durable design model context is not open.");
				}
				const stepKey = designModelStepKey({
					attemptId: modelAttemptId,
					stepNumber: step.stepNumber,
					requestDigest: step.requestDigest,
				});
				stepEventKeys.set(step.stepNumber, stepKey);
				await recordDesignModelStepEvent({
					designSessionId: args.designSessionId,
					contextId: modelContextId,
					stepKey,
					event: {
						eventKind: "started",
						requestDigest: step.requestDigest,
					},
					authority: modelContextAuthority,
				});
				/* The started event is written before the provider request. Once that
				 * succeeds, this call owns one unit of the session budget even if the
				 * response is interrupted and never reaches onStepEnd. */
				modelStepsSpent += 1;
			},
			onStepCompleted: async (step) => {
				if (modelContextId === null) {
					throw new Error("The durable design model context is not open.");
				}
				const stepKey = stepEventKeys.get(step.stepNumber);
				if (stepKey === undefined) {
					throw new Error(
						"The completed design model step has no started event key.",
					);
				}
				const requiredQuestionCall = step.toolCalls.find(
					(call) =>
						call.toolName === "askQuestions" &&
						activeRequiredQuestionAuthorizationKey !== null &&
						isExactRequiredDesignQuestionCall(
							call.input,
							activeRequiredQuestionBatch,
						),
				);
				const cardKey =
					requiredQuestionCall === undefined ||
					activeRequiredQuestionAuthorizationKey === null
						? null
						: requiredDesignQuestionCardAuthorizationKey({
								toolCallId: requiredQuestionCall.toolCallId,
								authorizationKey: activeRequiredQuestionAuthorizationKey,
								input: requiredQuestionCall.input,
							});
				const completedWait = trailingSuccessfulDesignWait(
					step.responseMessages,
				);
				const responseKey =
					cardKey !== null
						? `${cardKey}:response:${stepKey}:${step.responseDigest}`
						: completedWait !== null
							? designWaitResponseAppendKey({
									turnProvenanceId,
									stepKey,
									responseDigest: step.responseDigest,
								})
							: `response:${stepKey}:${step.responseDigest}`;
				await completeDesignModelStep({
					designSessionId: args.designSessionId,
					contextId: modelContextId,
					appendKey: responseKey,
					messages: step.responseMessages,
					stepKey,
					responseDigest: step.responseDigest,
					...(step.usage !== undefined && { usage: step.usage }),
					authority: modelContextAuthority,
				});
				if (!modelContextAppendKeys.has(responseKey)) {
					modelContextAppendKeys.add(responseKey);
					modelContextProtocolKeys.add(responseKey);
					modelContext = [...(modelContext ?? []), ...step.responseMessages];
				}
				modelContextGenerationHasCompletedStep = true;
				return { contextId: modelContextId, stepKey };
			},
		});
		/* Deploy-compatibility projection happens once, when this logical context
		 * is first seeded. Every later phase uses the exact growing ModelMessage
		 * sequence captured below. */
		const sanitized = await sanitizeHistoricalToolParts(
			[...args.messages],
			agent.tools,
		);
		const repaired = sanitizeHistoricalReasoningParts(
			sanitized,
			MODEL_ROLES.designAuthor.modelId,
		);
		const compacted = projectCompatibleCompactedHistory(
			repaired,
			MODEL_ROLES.designAuthor.modelId,
		);
		const projected = applySourceProjection(
			compacted,
			projectPackageOntoMessages(args.pkg, compacted),
		);
		const validated = await validateUIMessages<
			InferAgentUIMessage<typeof agent>
		>({
			messages: projected,
			tools: agent.tools,
		});
		if (modelContext === null) {
			modelContext = [];
		}
		if (modelContext.length === 0) {
			const seed = await convertToModelMessages(validated, {
				tools: agent.tools,
			});
			modelContext = [...seed];
			const lastMessage = validated.at(-1);
			await appendContext(
				lastMessage === undefined
					? `seed:${args.pkg.packageDigest}`
					: `seed-through:${lastMessage.id}`,
				seed,
			);
		} else {
			const continuation = await projectAnsweredDesignContinuation({
				uiMessages: args.messages,
				modelContext,
				tools: agent.tools,
			});
			if (continuation.length > 0) {
				const answerKey = `answer:${canonicalJsonDigest(continuation)}`;
				if (!modelContextAppendKeys.has(answerKey)) {
					modelContext = [...modelContext, ...continuation];
					await appendContext(answerKey, continuation);
				}
			}
			const userContinuations = await projectMissingDesignUserContinuations({
				uiMessages: validated,
				appendKeys: modelContextAppendKeys,
				tools: agent.tools,
			});
			for (const userContinuation of userContinuations) {
				modelContext = [...modelContext, ...userContinuation.messages];
				await appendContext(
					userContinuation.appendKey,
					userContinuation.messages,
				);
			}
		}
		/* A process may die after the provider step and exact response commit but
		 * before the orchestrator records its pause. Re-establish that terminal
		 * from the latest durable response unless this POST appended newer user
		 * input. Re-run the post-step question proof before honoring it. */
		const recoveredWait = recoveredWaitForCurrentTurn();
		if (recoveredWait !== null) {
			const requiredAfterRecovery = await requiredUserQuestions();
			if (designWaitForInputCanPause(requiredAfterRecovery.length)) {
				replayRecoveredWait(recoveredWait);
				pausedForMoreInput = true;
				break;
			}
		}
		/* A completed response is already paid work and its input terminal wins
		 * even when it consumed the final permitted step. Apply the ceiling only
		 * after giving that durable response its recovery path. */
		if (
			modelStepsSpent >=
			designLoopStepBudget(modelContextGeneration) + stepBudgetAllowance
		) {
			break;
		}
		terminalCorrectionStepAllowance = 0;
		const stateMessage = await stateMessageFor(gates);
		const stateKey = `state:${canonicalJsonDigest(stateMessage)}`;
		if (!modelContextAppendKeys.has(stateKey)) {
			modelContext = [...modelContext, stateMessage];
			await appendContext(stateKey, [stateMessage]);
		}
		const prompt = modelContext;
		const result = await agent.stream({ prompt });
		const drained = Promise.resolve(result.consumeStream()).catch(() => {});

		/* Forward chunks into the run's one write choke point. The
		 * orchestrator owns the outer `start`/`finish` chunk pair (its start
		 * already stamped the message id and producing model), so the agent
		 * stream's own are dropped; a retried attempt appends to the same
		 * message after its dangling parts are closed. */
		let narrator: SubmissionStepNarrator | null = null;
		let narratorPhase: DesignPulsePhase = "design";
		const toolNames = new Map<string, string>();
		const toolStreams = new Map<
			string,
			{
				toolName: string;
				startedAt: number;
				inputChars: number;
				inputAvailable: boolean;
				outcomeEmitted: boolean;
				phase: DesignPulsePhase;
			}
		>();
		const noteToolOutcome = (
			toolCallId: string,
			outcome: DesignToolOutcomeEvent["outcome"],
			code: string,
			diagnostic?: ReturnType<typeof readDesignToolDiagnostic>,
		): void => {
			const tracked = toolStreams.get(toolCallId);
			if (tracked === undefined || tracked.outcomeEmitted) return;
			tracked.outcomeEmitted = true;
			args.onToolOutcome?.({
				toolCallId,
				toolName: tracked.toolName,
				inputChars: tracked.inputChars,
				durationMs: Math.max(0, Date.now() - tracked.startedAt),
				outcome,
				code: diagnostic?.code ?? code,
				...(diagnostic?.validationStage !== undefined && {
					validationStage: diagnostic.validationStage,
				}),
				...(diagnostic?.issueCount !== undefined && {
					issueCount: diagnostic.issueCount,
				}),
			});
		};
		const trackPulse = (chunk: UIMessageChunk): void => {
			switch (chunk.type) {
				case "reasoning-delta":
				case "text-delta":
					pulse(livePulsePhase, chunk.delta.length);
					return;
				case "tool-input-start": {
					toolNames.set(chunk.toolCallId, chunk.toolName);
					toolStreams.set(chunk.toolCallId, {
						toolName: chunk.toolName,
						startedAt: Date.now(),
						inputChars: 0,
						inputAvailable: false,
						outcomeEmitted: false,
						phase: livePulsePhase,
					});
					livePulsePhase = designToolPulsePhase(chunk.toolName, livePulsePhase);
					const updateLabel = DESIGN_UPDATE_STEP_LABELS[chunk.toolName];
					if (updateLabel !== undefined) {
						narrator = createSubmissionStepNarrator([
							[
								chunk.toolName === "setDesignRoot" ? "charter" : "upserts",
								updateLabel,
							],
						]);
						narratorPhase = livePulsePhase;
					} else if (chunk.toolName === "requestReview") {
						narrator = null;
						pulse("review", 0);
					} else if (chunk.toolName === "finishDesign") {
						narrator = null;
						pulse(livePulsePhase, 0);
					} else {
						narrator = null;
					}
					return;
				}
				case "tool-input-delta": {
					const tracked = toolStreams.get(chunk.toolCallId);
					if (tracked !== undefined) {
						tracked.inputChars += chunk.inputTextDelta.length;
					}
					const step = narrator?.feed(chunk.inputTextDelta);
					if (narrator !== null) {
						pulse(narratorPhase, chunk.inputTextDelta.length, step);
					}
					return;
				}
				case "tool-input-available":
					toolNames.set(chunk.toolCallId, chunk.toolName);
					{
						const tracked = toolStreams.get(chunk.toolCallId);
						if (tracked !== undefined) {
							tracked.inputAvailable = true;
							if (tracked.inputChars === 0) {
								tracked.inputChars = JSON.stringify(chunk.input)?.length ?? 0;
							}
						}
					}
					narrator = null;
					return;
				case "tool-input-error":
					noteToolOutcome(
						chunk.toolCallId,
						"wire-invalid",
						"tool-input-invalid",
					);
					return;
				case "tool-output-available": {
					const toolName = toolNames.get(chunk.toolCallId);
					const output =
						chunk.output !== null &&
						typeof chunk.output === "object" &&
						!Array.isArray(chunk.output)
							? (chunk.output as Record<string, unknown>)
							: null;
					const failed = typeof output?.error === "string";
					const needsInput =
						typeof output?.needsUserInput === "object" &&
						output.needsUserInput !== null;
					const diagnostic = readDesignToolDiagnostic(output);
					noteToolOutcome(
						chunk.toolCallId,
						needsInput ? "needs-input" : failed ? "rejected" : "accepted",
						failed ? "tool-refused" : "tool-completed",
						diagnostic,
					);
					if (toolName === "finishDesign") {
						const calledFrom = toolStreams.get(chunk.toolCallId)?.phase;
						livePulsePhase = failed
							? (calledFrom ?? livePulsePhase)
							: calledFrom === "revise" && output?.accepted !== false
								? "revise"
								: "review";
					} else if (toolName === "requestReview") {
						livePulsePhase = failed
							? "review"
							: output?.accepted === true
								? "review"
								: "revise";
					}
					pulse(livePulsePhase, 0);
					return;
				}
				case "tool-output-error":
					noteToolOutcome(chunk.toolCallId, "rejected", "tool-execution-error");
					return;
				default:
					return;
			}
		};
		let contextActivityActive = false;
		type BufferedInputTerminal = {
			readonly toolCallId: string;
			readonly toolName: "askQuestions" | typeof DESIGN_WAIT_FOR_INPUT_TOOL;
			readonly chunks: UIMessageChunk[];
			input: unknown;
			inputAvailable: boolean;
			inputErrored: boolean;
			waitSucceeded: boolean;
		};
		const bufferedInputTerminals = new Map<string, BufferedInputTerminal>();
		const inputTerminalOrder: string[] = [];
		let rejectedRequiredQuestionCall: {
			toolCallId: string;
			input: unknown;
		} | null = null;
		for await (const chunk of result.toUIMessageStream({
			originalMessages: validated,
			generateMessageId: () => args.responseMessageId,
			onError: (error) => {
				pendingError = error;
				return error instanceof Error ? error.message : String(error);
			},
		})) {
			if (isOpenAICompactionChunk(chunk)) {
				contextActivityActive = true;
				args.writer.write({
					type: "data-context-activity",
					data: { phase: "start" },
					transient: true,
				});
			} else if (
				contextActivityActive &&
				(chunk.type === "reasoning-start" ||
					chunk.type === "text-start" ||
					chunk.type === "tool-input-start")
			) {
				contextActivityActive = false;
				args.writer.write({
					type: "data-context-activity",
					data: { phase: "done" },
					transient: true,
				});
			}
			/* Only the terminal `error` chunk is fatal; tool-level error chunks
			 * are the loop's own repair path (`app/api/chat/streamFailure.ts`
			 * documents the trap). */
			if (chunk.type === "error") {
				sawFatalError = true;
				continue;
			}
			if (chunk.type === "start" || chunk.type === "finish") continue;
			trackPulse(chunk);
			if (
				chunk.type === "tool-input-start" &&
				(chunk.toolName === "askQuestions" ||
					chunk.toolName === DESIGN_WAIT_FOR_INPUT_TOOL)
			) {
				bufferedInputTerminals.set(chunk.toolCallId, {
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					chunks: [chunk],
					input: null,
					inputAvailable: false,
					inputErrored: false,
					waitSucceeded: false,
				});
				inputTerminalOrder.push(chunk.toolCallId);
				continue;
			}
			const bufferedTerminal =
				"toolCallId" in chunk
					? bufferedInputTerminals.get(chunk.toolCallId)
					: undefined;
			if (bufferedTerminal !== undefined) {
				bufferedTerminal.chunks.push(chunk);
				if (chunk.type === "tool-input-available") {
					bufferedTerminal.input = chunk.input;
					bufferedTerminal.inputAvailable = true;
				} else if (chunk.type === "tool-input-error") {
					bufferedTerminal.input = chunk.input;
					bufferedTerminal.inputErrored = true;
				} else if (
					chunk.type === "tool-output-available" &&
					bufferedTerminal.toolName === DESIGN_WAIT_FOR_INPUT_TOOL
				) {
					bufferedTerminal.waitSucceeded = successfulDesignWaitOutput(
						chunk.output,
					);
				}
				continue;
			}
			openParts.observe(chunk);
			try {
				args.writer.write(chunk);
			} catch {
				break;
			}
		}
		if (contextActivityActive) {
			args.writer.write({
				type: "data-context-activity",
				data: { phase: "done" },
				transient: true,
			});
		}
		await drained;
		const incomplete = [...toolStreams.entries()].find(
			([, tracked]) => !tracked.inputAvailable && !tracked.outcomeEmitted,
		);
		if (incomplete !== undefined) {
			const [toolCallId] = incomplete;
			noteToolOutcome(toolCallId, "incomplete", "tool-input-incomplete");
			for (const closure of openParts.closures(
				"Nova stopped before this private design step was complete.",
			)) {
				args.writer.write(closure);
			}
			protocolFailure = {
				kind: "failed",
				errorType: "design-submission-incomplete",
				message:
					"Nova saved the completed parts of your design, but one design step stopped before it was ready. Nothing incomplete was accepted.",
				recoverable: true,
			};
			break;
		}
		let selectedInputTerminal: BufferedInputTerminal | null = null;
		for (const toolCallId of inputTerminalOrder) {
			const candidate = bufferedInputTerminals.get(toolCallId);
			if (candidate === undefined) continue;
			if (candidate.toolName === "askQuestions") {
				if (candidate.inputErrored) {
					if (activeRequiredQuestionBatch.length > 0) {
						rejectedRequiredQuestionCall = {
							toolCallId: candidate.toolCallId,
							input: candidate.input,
						};
					}
					continue;
				}
				if (!candidate.inputAvailable) continue;
				if (
					activeRequiredQuestionBatch.length > 0 &&
					!isExactRequiredDesignQuestionCall(
						candidate.input,
						activeRequiredQuestionBatch,
					)
				) {
					rejectedRequiredQuestionCall = {
						toolCallId: candidate.toolCallId,
						input: candidate.input,
					};
					noteToolOutcome(
						candidate.toolCallId,
						"rejected",
						"required-question-mismatch",
					);
					break;
				}
				selectedInputTerminal = candidate;
				break;
			}
			if (candidate.waitSucceeded) {
				selectedInputTerminal = candidate;
				break;
			}
		}
		if (rejectedRequiredQuestionCall !== null) {
			const rejection: ModelMessage = {
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: rejectedRequiredQuestionCall.toolCallId,
						toolName: "askQuestions",
						output: {
							type: "json",
							value: {
								error:
									"The call did not match the exact server-authorized required question batch. Repeat the supplied batch exactly.",
							},
						},
					},
				],
			};
			const rejectionKey = `required-question-rejection:${rejectedRequiredQuestionCall.toolCallId}:${durableModelValueDigest(rejectedRequiredQuestionCall.input)}`;
			modelContext = [...(modelContext ?? []), rejection];
			await appendContext(rejectionKey, [rejection]);
			continue;
		}
		if (selectedInputTerminal !== null) {
			const selectedIndex = inputTerminalOrder.indexOf(
				selectedInputTerminal.toolCallId,
			);
			/* Client-side question calls have no execute callback, so close every
			 * provider-later card that lost terminal arbitration. It never reaches
			 * the transcript and can never inherit a user answer on recovery. */
			for (const toolCallId of inputTerminalOrder.slice(selectedIndex + 1)) {
				const suppressed = bufferedInputTerminals.get(toolCallId);
				if (
					suppressed?.toolName !== "askQuestions" ||
					!suppressed.inputAvailable
				) {
					continue;
				}
				const rejection: ModelMessage = {
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: suppressed.toolCallId,
							toolName: "askQuestions",
							output: {
								type: "json",
								value: {
									error:
										"An earlier input terminal already ended this response. Ask again after the person's next message only if the question is still needed.",
									diagnostic: {
										code: "design-input-pause-terminal",
									},
								},
							},
						},
					],
				};
				const rejectionKey = `input-terminal-rejection:${suppressed.toolCallId}:${durableModelValueDigest(suppressed.input)}`;
				modelContext = [...(modelContext ?? []), rejection];
				await appendContext(rejectionKey, [rejection]);
			}
		}
		if (selectedInputTerminal?.toolName === DESIGN_WAIT_FOR_INPUT_TOOL) {
			/* Tool execution in this SAME provider step may have discovered a
			 * mandatory question after prepareStep took its snapshot. Decide the
			 * wait only against the post-step durable repair/workspace state. */
			const requiredAfterStep = await requiredUserQuestions();
			pausedForMoreInput = designWaitForInputCanPause(requiredAfterStep.length);
		} else if (selectedInputTerminal?.toolName === "askQuestions") {
			pausedOnQuestions = true;
		}
		if (pausedOnQuestions || pausedForMoreInput) {
			for (const bufferedChunk of selectedInputTerminal?.chunks ?? []) {
				openParts.observe(bufferedChunk);
				try {
					args.writer.write(bufferedChunk);
				} catch {
					break;
				}
			}
		}

		if (pausedOnQuestions || pausedForMoreInput) break;
		if (
			!sawFatalError &&
			activeRequiredQuestionBatch.length > 0 &&
			activeRequiredQuestionAuthorizationKey !== null
		) {
			/* The next prepared step forces askQuestions. Keep this durable correction
			 * in context so the model also knows why it may not resume design work. */
			const omission: ModelMessage = {
				role: "user",
				content: [
					"# Required question protocol correction (server-derived)",
					`The previous response omitted the required askQuestions call. Call askQuestions now with header "${REQUIRED_DESIGN_QUESTIONS_HEADER}" and the exact authorized questions already supplied. Do not continue design work or answer them yourself.`,
				].join("\n"),
			};
			const omissionKey = `required-question-omission:${durableModelValueDigest(activeRequiredQuestionAuthorizationKey)}:${modelStepsSpent}`;
			await appendContext(omissionKey, [omission]);
			modelContext = [...(modelContext ?? []), omission];
			continue;
		}
		if (!sawFatalError) {
			const afterPhase = evaluateDesignGates(await loadAncestry());
			await ensureDerivedBuildPlan(toolDeps, afterPhase);
			const settled = evaluateDesignGates(await loadAncestry());
			if (settled.plan !== null) break;
			/* A legal terminal tool advances the durable phase. Continue by
			 * appending its new authoritative state to this same context. */
			if (phaseFor(settled) !== phase) continue;
			/* AI SDK stops a ToolLoopAgent as soon as the provider returns a
			 * non-tool finish, before stopWhen can ask for another step. Give the
			 * model one durable, exact correction inside this turn. A second clean
			 * omission is a bounded harness defect, not a reason to make the person
			 * resend the same instruction repeatedly. */
			const correctionPrefix = designTerminalOmissionCorrectionPrefix({
				turnProvenanceId,
			});
			if (
				designTerminalOmissionCanCorrect(modelContextProtocolKeys, {
					turnProvenanceId,
				})
			) {
				const correction: ModelMessage = {
					role: "user",
					content: [
						"# Design terminal correction (server-derived)",
						"The previous response ended without advancing the design or choosing a legal pause. If the person's latest message explicitly says more requirements or source material are coming, or asks you not to begin yet, call waitForInput. If you need a material answer, call askQuestions. Otherwise continue the current design phase and reach its legal terminal. Do not end with conversational text alone.",
					].join("\n"),
				};
				const correctionKey = `${correctionPrefix}${modelStepsSpent}`;
				await appendContext(correctionKey, [correction]);
				modelContext = [...(modelContext ?? []), correction];
				if (modelStepsSpent >= designLoopStepBudget(modelContextGeneration)) {
					terminalCorrectionStepAllowance =
						DESIGN_TERMINAL_CORRECTION_STEP_ALLOWANCE;
				}
				continue;
			}
			protocolFailure = {
				kind: "failed",
				errorType: "design-terminal-omission",
				message:
					"Nova couldn't complete this design turn. Everything already decided is saved, and this design can continue after Nova's design behavior is updated.",
				recoverable: true,
			};
			break;
		}
		const classified = classifyError(
			pendingError ?? new Error("The design stream ended in an error."),
		);
		/* A latched protocol/convergence defect is terminal for this run. The
		 * provider retry loop cannot change its deterministic gate state. */
		if (repair.fatalError() !== undefined) {
			failure = classified;
			break;
		}
		if (!shouldRetryTurn(classified, turnRetries)) {
			failure = classified;
			break;
		}
		turnRetries += 1;
		for (const closure of openParts.closures()) {
			args.writer.write(closure);
		}
		args.onRecoverableRetry?.(classified);
		await new Promise((resolve) =>
			setTimeout(resolve, turnRetryDelayMs(turnRetries)),
		);
	}

	/* Terminal mapping: a turn must end in a recognized terminal. */
	const fatal = repair.fatalError();
	if (protocolFailure !== null) return protocolFailure;
	const finalGates = evaluateDesignGates(await loadAncestry());
	if (pausedOnQuestions || pausedForMoreInput) {
		return {
			kind: "awaiting-input",
			headRevisionId: finalGates.head?.id ?? null,
		};
	}
	if (finalGates.plan !== null && finalGates.newestAccepted !== null) {
		return {
			kind: "planned",
			revision: finalGates.newestAccepted,
			plan: finalGates.plan,
		};
	}
	if (fatal !== undefined) {
		return {
			kind: "failed",
			errorType: fatal.code,
			message: `${designLoopStopMessage(finalGates)} Everything already decided is saved; send a message to run that phase again.`,
			/* The repair tracker is PER-TURN accounting: its stop seals this
			 * turn's budget, never the durable artifacts. A fresh chargeable
			 * turn re-enters the same phase with a fresh budget — which is
			 * also how a deployed harness correction reaches a preserved
			 * draft. Only the session-wide step budget below is a genuinely
			 * unrecoverable stop. */
			recoverable: true,
		};
	}
	if (modelStepsSpent >= designLoopStepBudget(modelContextGeneration)) {
		return {
			kind: "failed",
			errorType: "design-step-budget",
			message: designLoopStopMessage(finalGates),
			recoverable: false,
		};
	}
	if (failure !== null) {
		return {
			kind: "failed",
			errorType: failure.type,
			message:
				"The design step didn't come back usable this time. Everything already decided is saved; send your message again to continue from there.",
			recoverable: true,
		};
	}
	return {
		kind: "failed",
		errorType: "design-terminal-omission",
		message:
			"Nova couldn't complete this design turn. Everything already decided is saved, and this design can continue after Nova's design behavior is updated.",
		recoverable: true,
	};
}
