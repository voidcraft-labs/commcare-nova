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
	type DesignGateState,
	DesignRepairTracker,
	type DesignSubmissionValidationStage,
	designLoopStepBudget,
	evaluateDesignGates,
	loadDesignAncestry,
} from "@/lib/agent/design/loop/gates";
import { rebuildPackageForDigest } from "@/lib/agent/design/loop/packageRebuild";
import {
	applySourceProjection,
	projectPackageOntoMessages,
	renderDesignStateMessage,
} from "@/lib/agent/design/loop/packageRender";
import {
	createDesignLoopTools,
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
import { DESIGN_AUTHOR_MODEL, MODEL_CONTEXT_VERSION } from "@/lib/models";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	appendDesignModelContext,
	completeDesignModelStep,
	openDesignModelContext,
	recordDesignModelStepEvent,
	recoverableCompletedModelSteps,
} from "./modelContextStore";
import type { OrchestratorStreamWriter } from "./orchestrator";
import type { OrchestrationHead } from "./orchestratorState";
import {
	CONTRACT_STEP_LABELS,
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
 * revision from the person's point of view even though immutable artifacts
 * require another `submitContract` call on the wire. */
export function contractSubmissionPulsePhase(
	hasPersistedContract: boolean,
): DesignPulsePhase {
	return hasPersistedContract ? "revise" : "design";
}

export function designToolPulsePhase(
	toolName: string,
	current: DesignPulsePhase,
	contractPhase: DesignPulsePhase,
): DesignPulsePhase {
	if (toolName === "stageContract" || toolName === "submitContract") {
		return contractPhase;
	}
	if (toolName === "requestReview") return "review";
	if (toolName === "stageRevision" || toolName === "submitRevision") {
		return "revise";
	}
	return current;
}

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

	const loadAncestry = () =>
		loadDesignAncestry(args.designSessionId, args.pkg.packageDigest);

	const initialGates = evaluateDesignGates(await loadAncestry());

	const repair = new DesignRepairTracker();
	const pulse = createDesignPulseEmitter(
		args.writer,
		args.designSessionId,
		args.head,
	);
	const contractPulsePhase = contractSubmissionPulsePhase(
		initialGates.head !== null,
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
	const tools = createDesignLoopTools(toolDeps);
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
								revision: workspace.workspace.revision,
								stepCount: workspace.operations.length,
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
	let modelContextId: string | null = null;
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
			modelId: DESIGN_AUTHOR_MODEL,
			promptVersion: DESIGN_PROMPT_VERSIONS.agent,
			toolsetDigest,
			contextVersion: MODEL_CONTEXT_VERSION,
			authority: modelContextAuthority,
		});
		modelContextId = persisted.id;
		modelContext = [...persisted.messages];
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
				DESIGN_AUTHOR_MODEL,
				{ step: true, phase: "design-author" },
			);
		}
	};
	await openAndRecoverModelContext();
	if (recoveredPlan !== null && initialGates.newestAccepted !== null) {
		return {
			kind: "planned",
			revision: initialGates.newestAccepted,
			plan: recoveredPlan,
		};
	}

	let turnRetries = 0;
	const openParts = createOpenPartTracker();
	let pausedOnQuestions = false;
	let failure: ClassifiedError | null = null;
	let protocolFailure: DesignLoopOutcome | null = null;

	for (;;) {
		pausedOnQuestions = false;
		let sawFatalError = false;
		let pendingError: unknown;

		const gates = evaluateDesignGates(await loadAncestry());
		if (gates.plan !== null) break;
		const phase = phaseFor(gates);
		if (modelStepsSpent >= designLoopStepBudget(modelContextGeneration)) break;
		const stepsBeforeStream = modelStepsSpent;
		/* One provider invocation identity. A replacement process or bounded
		 * stream redrive must never reuse the completed-event identity of a call
		 * whose response bytes were not durably observed by that process. */
		const modelAttemptId = randomUUID();
		const stepEventKeys = new Map<number, string>();
		let activeRequiredQuestionBatch: readonly OpenQuestion[] = [];
		let activeRequiredQuestionAuthorizationKey: string | null = null;
		const agent = createDesignAgent({
			model: args.designCtx.model(DESIGN_AUTHOR_MODEL),
			tools,
			phase,
			catalogText,
			constraintsText: renderPlatformConstraintsSection(),
			instructions: DESIGN_AGENT_SYSTEM,
			promptCacheKey: `nova:design:${args.designSessionId}`,
			fatalError: () => repair.fatalError(),
			requiredUserQuestions: async () => {
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
			},
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
				const responseKey =
					cardKey === null
						? `response:${stepKey}:${step.responseDigest}`
						: `${cardKey}:response:${stepKey}:${step.responseDigest}`;
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
			DESIGN_AUTHOR_MODEL,
		);
		const compacted = projectCompatibleCompactedHistory(
			repaired,
			DESIGN_AUTHOR_MODEL,
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
				case "tool-input-start":
					toolNames.set(chunk.toolCallId, chunk.toolName);
					toolStreams.set(chunk.toolCallId, {
						toolName: chunk.toolName,
						startedAt: Date.now(),
						inputChars: 0,
						inputAvailable: false,
						outcomeEmitted: false,
					});
					livePulsePhase = designToolPulsePhase(
						chunk.toolName,
						livePulsePhase,
						contractPulsePhase,
					);
					if (chunk.toolName === "stageContract") {
						narrator = createSubmissionStepNarrator(CONTRACT_STEP_LABELS);
						narratorPhase = contractPulsePhase;
					} else if (chunk.toolName === "stageRevision") {
						narrator = createSubmissionStepNarrator(CONTRACT_STEP_LABELS);
						narratorPhase = "revise";
					} else if (chunk.toolName === "requestReview") {
						narrator = null;
						pulse("review", 0);
					} else if (chunk.toolName === "submitRevision") {
						narrator = null;
						pulse("revise", 0);
					} else if (chunk.toolName === "submitContract") {
						narrator = null;
						pulse(contractPulsePhase, 0);
					} else {
						narrator = null;
					}
					return;
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
					if (toolName === "submitContract") {
						livePulsePhase = failed ? contractPulsePhase : "review";
					} else if (toolName === "requestReview") {
						livePulsePhase = failed
							? "review"
							: output?.accepted === true
								? "review"
								: "revise";
					} else if (toolName === "submitRevision") {
						livePulsePhase = failed
							? "revise"
							: output?.accepted === false
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
		const bufferedRequiredQuestionChunks = new Map<string, UIMessageChunk[]>();
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
			/* A required question card is server-authored protocol. Buffer its
			 * streamed input until the complete call proves byte-for-byte semantic
			 * equality with the authorized batch. A subset or paraphrase is repaired
			 * internally and never becomes a user-facing pause. */
			if (
				chunk.type === "tool-input-start" &&
				chunk.toolName === "askQuestions" &&
				activeRequiredQuestionBatch.length > 0
			) {
				bufferedRequiredQuestionChunks.set(chunk.toolCallId, [chunk]);
				continue;
			}
			const bufferedQuestion =
				"toolCallId" in chunk
					? bufferedRequiredQuestionChunks.get(chunk.toolCallId)
					: undefined;
			if (bufferedQuestion !== undefined) {
				bufferedQuestion.push(chunk);
				if (
					chunk.type === "tool-input-available" &&
					chunk.toolName === "askQuestions"
				) {
					bufferedRequiredQuestionChunks.delete(chunk.toolCallId);
					if (
						isExactRequiredDesignQuestionCall(
							chunk.input,
							activeRequiredQuestionBatch,
						)
					) {
						pausedOnQuestions = true;
						for (const bufferedChunk of bufferedQuestion) {
							openParts.observe(bufferedChunk);
							try {
								args.writer.write(bufferedChunk);
							} catch {
								break;
							}
						}
					} else {
						rejectedRequiredQuestionCall = {
							toolCallId: chunk.toolCallId,
							input: chunk.input,
						};
						noteToolOutcome(
							chunk.toolCallId,
							"rejected",
							"required-question-mismatch",
						);
					}
				} else if (chunk.type === "tool-input-error") {
					bufferedRequiredQuestionChunks.delete(chunk.toolCallId);
					rejectedRequiredQuestionCall = {
						toolCallId: chunk.toolCallId,
						input: null,
					};
				}
				continue;
			}
			if (
				chunk.type === "tool-input-available" &&
				chunk.toolName === "askQuestions"
			) {
				pausedOnQuestions = true;
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

		if (pausedOnQuestions) break;
		if (
			!sawFatalError &&
			activeRequiredQuestionBatch.length > 0 &&
			activeRequiredQuestionAuthorizationKey !== null
		) {
			/* Stable tool choice intentionally remains automatic for cache reuse. A
			 * clean response that simply omitted the required client pause is repaired
			 * inside this same run instead of making the user resend the turn. */
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
			 * appending its new authoritative state to this same context; a clean
			 * stream that did not advance is incomplete and is mapped below. */
			if (phaseFor(settled) !== phase) continue;
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

	/* Terminal mapping: a turn must end in a RECOGNIZED terminal. A loop
	 * that simply stopped emitting (no pause, no plan, no error) is a
	 * retriable design-session error, never a silent success or a
	 * forever-designing hang. */
	const fatal = repair.fatalError();
	if (protocolFailure !== null) return protocolFailure;
	const finalGates = evaluateDesignGates(await loadAncestry());
	if (finalGates.plan !== null && finalGates.newestAccepted !== null) {
		return {
			kind: "planned",
			revision: finalGates.newestAccepted,
			plan: finalGates.plan,
		};
	}
	if (pausedOnQuestions) {
		return {
			kind: "awaiting-input",
			headRevisionId: finalGates.head?.id ?? null,
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
		errorType: "design-loop-incomplete",
		message:
			"The design turn stopped before reaching a plan or a question for you. Nothing was lost; send your message again to continue from where it stopped.",
		recoverable: true,
	};
}
