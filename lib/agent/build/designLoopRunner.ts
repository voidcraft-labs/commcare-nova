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
 * the dialogue, and the per-turn state message carries CONTENT the thread
 * may lack (the persisted contract, findings awaiting disposition): so a
 * redrive or a fresh-POST resume never re-produces committed work and never
 * re-creates the reviser-amnesia defect.
 */

import type {
	InferAgentUIMessage,
	ModelMessage,
	UIMessage,
	UIMessageChunk,
} from "ai";
import { convertToModelMessages, validateUIMessages } from "ai";
import type {
	DesignBuildPlanRecord,
	DesignRevisionRecord,
} from "@/lib/agent/design/artifactStore";
import { insertDesignSourcePackage } from "@/lib/agent/design/artifactStore";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "@/lib/agent/design/capabilityCatalog";
import type { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import {
	createDesignAgent,
	type DesignAgentStep,
} from "@/lib/agent/design/loop/designAgent";
import {
	type DesignGateState,
	DesignRepairTracker,
	evaluateDesignGates,
	loadDesignAncestry,
} from "@/lib/agent/design/loop/gates";
import { rebuildPackageForDigest } from "@/lib/agent/design/loop/packageRebuild";
import {
	applySourceProjection,
	projectPackageOntoMessages,
	renderDesignStateMessage,
} from "@/lib/agent/design/loop/packageRender";
import { createDesignLoopTools } from "@/lib/agent/design/loop/tools";
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
import { sanitizeHistoricalReasoningParts } from "@/lib/chat/sanitizeReasoningParts";
import { sanitizeHistoricalToolParts } from "@/lib/chat/sanitizeToolParts";
import { createOpenPartTracker } from "@/lib/chat/streamPartClosure";
import { DESIGN_MODEL } from "@/lib/models";
import type { OrchestratorStreamWriter } from "./orchestrator";
import type { OrchestrationHead } from "./orchestratorState";
import {
	CONTRACT_STEP_LABELS,
	createDesignPulseEmitter,
	createSubmissionStepNarrator,
	type DesignPulsePhase,
	PLAN_STEP_LABELS,
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
	let livePulsePhase: DesignPulsePhase = initialGates.verdicts.submitPlan.legal
		? "plan"
		: initialGates.verdicts.submitRevision.legal
			? "revise"
			: initialGates.verdicts.requestReview.legal
				? "review"
				: "design";
	const catalogText = renderCapabilityCatalog(buildCapabilityCatalog());
	const tools = createDesignLoopTools({
		designSessionId: args.designSessionId,
		runId: args.runId,
		authority,
		currentPkg: args.pkg,
		catalogText,
		ctx: args.designCtx,
		signal: args.signal,
		repair,
		loadAncestry,
		rebuildPackageForDigest: (digest) =>
			rebuildPackageForDigest({
				designSessionId: args.designSessionId,
				projectId: args.projectId,
				threadId: args.threadId,
				digest,
				messages: args.messages as BuildSourcePackageArgs["messages"],
				deps: args.packageDeps,
			}),
		onReviewActivity: (deltaChars) => pulse("review", deltaChars),
		...(args.onReviewerReasoning !== undefined && {
			onReviewerReasoning: args.onReviewerReasoning,
		}),
	});
	const agent = createDesignAgent({
		model: args.designCtx.model(DESIGN_MODEL),
		tools,
		catalogText,
		constraintsText: renderPlatformConstraintsSection(),
		instructions: DESIGN_AGENT_SYSTEM,
		promptCacheKey: `nova:design:${args.designSessionId}`,
		fatalError: () => repair.fatalError(),
		...(args.onAgentStep !== undefined && { onStepEnd: args.onAgentStep }),
	});

	/* History repair + source projection, exactly once per POST: drop tool
	 * parts the design tool set can't validate (a resumed thread routinely
	 * carries parts recorded under earlier deploys: the retired pipeline's
	 * synthesized rounds included; their content survives as seeded claims),
	 * drop historical reasoning per the wire contract, then replace each
	 * user message's text with its delimited, citable source rendering. */
	const sanitized = await sanitizeHistoricalToolParts(
		[...args.messages],
		agent.tools,
	);
	const repaired = sanitizeHistoricalReasoningParts(sanitized, DESIGN_MODEL);
	const projected = applySourceProjection(
		repaired,
		projectPackageOntoMessages(args.pkg, repaired),
	);
	const validated = await validateUIMessages<InferAgentUIMessage<typeof agent>>(
		{
			messages: projected,
			tools: agent.tools,
		},
	);
	const baseModelMessages = markStablePrefixBoundary(
		await convertToModelMessages(validated, { tools: agent.tools }),
	);

	const stateMessageFor = (gates: DesignGateState): ModelMessage => {
		const head = gates.head;
		const threadHoldsHead =
			head !== null && threadCarriesArtifact(validated, head.id);
		const openReviews =
			head !== null &&
			head.lifecycle === "draft" &&
			gates.headReviews.length > 0
				? gates.headReviews.filter(
						(review) => !threadCarriesArtifact(validated, review.id),
					)
				: [];
		return {
			role: "user",
			content: renderDesignStateMessage({
				gates,
				claims: args.pkg.claims,
				persistedContract:
					head !== null && !threadHoldsHead
						? {
								revision: head.revision,
								lifecycle: head.lifecycle,
								contractJson: JSON.stringify(head.envelope.payload, null, 1),
							}
						: null,
				openReviews:
					openReviews.length > 0
						? openReviews.map((review) => review.envelope.payload)
						: null,
			}),
		};
	};

	let turnRetries = 0;
	const openParts = createOpenPartTracker();
	let pausedOnQuestions = false;
	let failure: ClassifiedError | null = null;

	for (;;) {
		pausedOnQuestions = false;
		let sawFatalError = false;
		let pendingError: unknown;

		const gates = evaluateDesignGates(await loadAncestry());
		if (gates.plan !== null) break;
		const prompt = [...baseModelMessages, stateMessageFor(gates)];

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
		const trackPulse = (chunk: UIMessageChunk): void => {
			switch (chunk.type) {
				case "reasoning-delta":
				case "text-delta":
					pulse(livePulsePhase, chunk.delta.length);
					return;
				case "tool-input-start":
					toolNames.set(chunk.toolCallId, chunk.toolName);
					if (chunk.toolName === "submitContract") {
						narrator = createSubmissionStepNarrator(CONTRACT_STEP_LABELS);
						narratorPhase = "design";
						livePulsePhase = "design";
					} else if (chunk.toolName === "submitRevision") {
						narrator = createSubmissionStepNarrator(CONTRACT_STEP_LABELS);
						narratorPhase = "revise";
						livePulsePhase = "revise";
					} else if (chunk.toolName === "submitPlan") {
						narrator = createSubmissionStepNarrator(PLAN_STEP_LABELS);
						narratorPhase = "plan";
						livePulsePhase = "plan";
					} else if (chunk.toolName === "requestReview") {
						narrator = null;
						livePulsePhase = "review";
					} else {
						narrator = null;
					}
					return;
				case "tool-input-delta": {
					const step = narrator?.feed(chunk.inputTextDelta);
					pulse(narratorPhase, chunk.inputTextDelta.length, step);
					return;
				}
				case "tool-input-available":
					toolNames.set(chunk.toolCallId, chunk.toolName);
					narrator = null;
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
					if (toolName === "submitContract") {
						livePulsePhase = failed ? "design" : "review";
					} else if (toolName === "requestReview") {
						livePulsePhase = failed
							? "review"
							: output?.accepted === true
								? "plan"
								: "revise";
					} else if (toolName === "submitRevision") {
						livePulsePhase = failed
							? "revise"
							: output?.accepted === false
								? "review"
								: "plan";
					} else if (toolName === "submitPlan") {
						livePulsePhase = "plan";
					}
					pulse(livePulsePhase, 0);
					return;
				}
				default:
					return;
			}
		};
		for await (const chunk of result.toUIMessageStream({
			originalMessages: validated,
			generateMessageId: () => args.responseMessageId,
			onError: (error) => {
				pendingError = error;
				return error instanceof Error ? error.message : String(error);
			},
		})) {
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
		await drained;

		if (!sawFatalError || pausedOnQuestions) break;
		const classified = classifyError(
			pendingError ?? new Error("The design stream ended in an error."),
		);
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
	if (fatal !== undefined) {
		return {
			kind: "failed",
			errorType: "design-loop-budget",
			message: fatal.message,
			recoverable: true,
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
	return {
		kind: "failed",
		errorType: "design-loop-incomplete",
		message:
			"The design turn stopped before reaching a plan or a question for you. Nothing was lost; send your message again to continue from where it stopped.",
		recoverable: true,
	};
}

/** Does the validated thread already carry this artifact id in one of its
 *  design tool results? When it does, the state message skips re-inlining
 *  the content: the model's own context already holds it. */
function threadCarriesArtifact(
	messages: readonly UIMessage[],
	artifactId: string,
): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.parts) {
			if (typeof part !== "object" || part === null) continue;
			const type = (part as { type?: unknown }).type;
			if (
				type !== "tool-submitContract" &&
				type !== "tool-submitRevision" &&
				type !== "tool-requestReview"
			) {
				continue;
			}
			if ((part as { state?: unknown }).state !== "output-available") continue;
			const output = (part as { output?: unknown }).output as
				| {
						revisionId?: unknown;
						reviewId?: unknown;
						acceptedRevisionId?: unknown;
				  }
				| undefined;
			if (
				output?.revisionId === artifactId ||
				output?.reviewId === artifactId ||
				output?.acceptedRevisionId === artifactId
			) {
				return true;
			}
		}
	}
	return false;
}
