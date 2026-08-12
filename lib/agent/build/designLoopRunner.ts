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

import type {
	InferAgentUIMessage,
	ModelMessage,
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
import { openDesignArtifactWorkspace } from "@/lib/agent/design/artifactWorkspaceStore";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "@/lib/agent/design/capabilityCatalog";
import {
	appDesignContractSchema,
	designConstructionQuestions,
} from "@/lib/agent/design/contract";
import type { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import {
	createDesignAgent,
	type DesignAgentStep,
	requiredDesignQuestionBatchWasAnswered,
} from "@/lib/agent/design/loop/designAgent";
import {
	DESIGN_LOOP_STEP_BUDGET,
	type DesignGateState,
	DesignRepairTracker,
	type DesignSubmissionValidationStage,
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
} from "@/lib/agent/design/loop/tools";
import {
	DESIGN_AGENT_SYSTEM,
	renderPlatformConstraintsSection,
} from "@/lib/agent/design/prompts";
import type {
	BuildSourcePackageArgs,
	DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import {
	type ClassifiedError,
	classifyError,
} from "@/lib/agent/errorClassifier";
import { markStablePrefixBoundary } from "@/lib/agent/prompts";
import { shouldRetryTurn, turnRetryDelayMs } from "@/lib/agent/turnRetry";
import {
	isOpenAICompactionChunk,
	projectCompatibleCompactedHistory,
} from "@/lib/chat/compaction";
import { sanitizeHistoricalReasoningParts } from "@/lib/chat/sanitizeReasoningParts";
import { sanitizeHistoricalToolParts } from "@/lib/chat/sanitizeToolParts";
import { createOpenPartTracker } from "@/lib/chat/streamPartClosure";
import { DESIGN_AUTHOR_MODEL } from "@/lib/models";
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
}): Promise<readonly string[]> {
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
	return designConstructionQuestions(parsed.data) ?? [];
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

	/* Resume convergence: a session whose accepted design is already planned
	 * has no design work left: the loop never mounts, and the orchestrator
	 * continues at slice execution. */
	const initialGates = evaluateDesignGates(await loadAncestry());
	if (initialGates.plan !== null && initialGates.newestAccepted !== null) {
		return {
			kind: "planned",
			revision: initialGates.newestAccepted,
			plan: initialGates.plan,
		};
	}

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
		onReviewActivity: (deltaChars: number) => pulse("review", deltaChars),
		...(args.onReviewerReasoning !== undefined && {
			onReviewerReasoning: args.onReviewerReasoning,
		}),
	};
	const tools = createDesignLoopTools(toolDeps);
	const recoveredPlan = await ensureDerivedBuildPlan(toolDeps, initialGates);
	if (recoveredPlan !== null && initialGates.newestAccepted !== null) {
		return {
			kind: "planned",
			revision: initialGates.newestAccepted,
			plan: recoveredPlan,
		};
	}
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
		return {
			role: "user",
			content: renderDesignStateMessage({
				gates,
				claims: args.pkg.claims,
				openReviews:
					openReviews.length > 0
						? openReviews.map((review) => review.envelope.payload)
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
								candidate: workspace.candidate,
								sourceContract: workspace.sourceContract,
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
	let completedModelSteps = 0;

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
		if (completedModelSteps >= DESIGN_LOOP_STEP_BUDGET) break;
		const stepsBeforeStream = completedModelSteps;
		const agent = createDesignAgent({
			model: args.designCtx.model(DESIGN_AUTHOR_MODEL),
			tools,
			phase,
			catalogText,
			constraintsText: renderPlatformConstraintsSection(),
			instructions: DESIGN_AGENT_SYSTEM,
			promptCacheKey: `nova:design:${args.designSessionId}:${phase}`,
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
				return requiredDesignQuestionBatchWasAnswered(args.messages, questions)
					? []
					: questions;
			},
			freshStateMessage: async () =>
				stateMessageFor(evaluateDesignGates(await loadAncestry())),
			stepsBeforeStream,
			onStepEnd: (step) => {
				completedModelSteps += 1;
				args.onAgentStep?.(step);
			},
		});
		/* Each durable phase starts a fresh internal model context. Historical
		 * private tool parts from other phases are removed; the exact regenerated
		 * phase packet below is the authority. Visible conversation remains. */
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
		const baseModelMessages = markStablePrefixBoundary(
			await convertToModelMessages(validated, { tools: agent.tools }),
		);
		const prompt = [...baseModelMessages, await stateMessageFor(gates)];
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

		if (pausedOnQuestions) break;
		if (!sawFatalError) {
			const afterPhase = evaluateDesignGates(await loadAncestry());
			await ensureDerivedBuildPlan(toolDeps, afterPhase);
			const settled = evaluateDesignGates(await loadAncestry());
			if (settled.plan !== null) break;
			/* A legal terminal tool advances the durable phase. Continue with a
			 * fresh, phase-specific model context; a clean stream that did not
			 * advance is incomplete and is mapped below instead of spinning. */
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
			message: designLoopStopMessage(finalGates),
			recoverable: false,
		};
	}
	if (completedModelSteps >= DESIGN_LOOP_STEP_BUDGET) {
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
