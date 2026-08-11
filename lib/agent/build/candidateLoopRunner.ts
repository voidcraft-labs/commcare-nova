/**
 * Durable reviewed-candidate loop. One Solutions Architect authors the real
 * private Blueprint, a fresh-context reviewer critiques that exact digest,
 * and (only when needed) the architect edits the same workspace before a
 * focused verification. The transcript is presentation; the workspace and
 * checkpoints are recovery authority.
 */

import type {
	InferAgentUIMessage,
	ModelMessage,
	UIMessage,
	UIMessageChunk,
} from "ai";
import { convertToModelMessages, validateUIMessages } from "ai";
import { emptyGenesisBase } from "@/lib/agent/change-set/baseLoader";
import { beginDesignCandidateChangeSet } from "@/lib/agent/change-set/store";
import {
	ChangeSetMutationWorkspace,
	type ChangeSetWorkspaceHost,
} from "@/lib/agent/change-set/workspace";
import { insertDesignSourcePackage } from "@/lib/agent/design/artifactStore";
import {
	type CandidateReview,
	candidateReviewBlocksAcceptance,
} from "@/lib/agent/design/candidate";
import {
	CANDIDATE_AGENT_STEP_BUDGET,
	CANDIDATE_STATE_HEADING,
	type CandidateAgentStep,
	createCandidateAgent,
	projectCandidateText,
} from "@/lib/agent/design/candidateAgent";
import {
	CANDIDATE_AUTHOR_SYSTEM,
	renderCandidateRevisionInstructions,
} from "@/lib/agent/design/candidatePrompt";
import {
	CANDIDATE_REVIEW_PROMPT_VERSION,
	runCandidateReviewer,
} from "@/lib/agent/design/candidateReviewer";
import {
	type CandidateAuthority,
	type CandidateCheckpoint,
	checkpointCandidate,
	insertCandidateReview,
	readActiveCandidateState,
	readCandidateReviewForCheckpoint,
	resumeBlockedCandidateRevision,
} from "@/lib/agent/design/candidateStore";
import type { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import {
	applySourceProjection,
	projectPackageOntoMessages,
} from "@/lib/agent/design/loop/packageRender";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { classifyError } from "@/lib/agent/errorClassifier";
import {
	readToolLookupCatalog,
	readToolLookupDefinitions,
} from "@/lib/agent/lookupContext";
import { markStablePrefixBoundary } from "@/lib/agent/prompts";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { shouldRetryTurn, turnRetryDelayMs } from "@/lib/agent/turnRetry";
import {
	isOpenAICompactionChunk,
	projectCompatibleCompactedHistory,
} from "@/lib/chat/compaction";
import { sanitizeHistoricalReasoningParts } from "@/lib/chat/sanitizeReasoningParts";
import { sanitizeHistoricalToolParts } from "@/lib/chat/sanitizeToolParts";
import { log } from "@/lib/logger";
import { DESIGN_AUTHOR_MODEL, DESIGN_REVIEWER_MODEL } from "@/lib/models";
import type { OrchestratorStreamWriter } from "./orchestrator";
import type { DesignPulsePhase } from "./progress";

export type CandidateLoopOutcome =
	| { readonly kind: "accepted"; readonly checkpoint: CandidateCheckpoint }
	| { readonly kind: "awaiting-input" }
	| {
			readonly kind: "failed";
			readonly errorType: string;
			readonly message: string;
			readonly recoverable: boolean;
	  };

export interface CandidateToolOutcomeEvent {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly inputChars: number;
	readonly durationMs: number;
	readonly outcome: "accepted" | "rejected" | "wire-invalid" | "incomplete";
	readonly code: string;
}

export interface CandidateLoopRunnerArgs {
	readonly designSessionId: string;
	readonly proposedAppId: string;
	readonly projectId: string;
	readonly projectRole: string;
	readonly runId: string;
	readonly actorUserId: string;
	readonly holderNonce: string;
	readonly responseMessageId: string;
	readonly messages: readonly UIMessage[];
	readonly pkg: DesignSourcePackage;
	readonly designCtx: DesignGenerationContext;
	readonly writer: OrchestratorStreamWriter;
	readonly signal: AbortSignal;
	readonly allowBlockedResume: boolean;
	readonly onAgentStep?: (step: CandidateAgentStep) => void;
	readonly onReviewerReasoning?: (text: string) => void;
	readonly onToolOutcome?: (event: CandidateToolOutcomeEvent) => void;
	readonly onPhase?: (phase: DesignPulsePhase) => Promise<void>;
}

interface CandidatePhase {
	readonly kind: "author" | "revision";
	readonly parent: CandidateCheckpoint | null;
	readonly review: CandidateReview | null;
}

function candidateHost(args: CandidateLoopRunnerArgs): ChangeSetWorkspaceHost {
	const lookupScope = {
		projectId: args.projectId,
		actorId: args.actorUserId,
		role: args.projectRole,
	};
	return {
		actorUserId: args.actorUserId,
		runId: args.runId,
		chatRunHolder: {
			mode: "build",
			runId: args.runId,
			nonce: args.holderNonce,
			source: "chat",
		},
		conversionImpact: async () => {
			throw new Error(
				"A new app has no saved case rows, so there is no conversion impact to preview.",
			);
		},
		lookupDefinitions: (tableIds) =>
			readToolLookupDefinitions(lookupScope, tableIds),
		lookupCatalog: () => readToolLookupCatalog(lookupScope),
	};
}

async function candidateStateMessage(
	workspace: ChangeSetMutationWorkspace,
	phase: CandidatePhase,
): Promise<ModelMessage> {
	const diagnostics = await workspace.inspect();
	return {
		role: "user",
		content: [
			CANDIDATE_STATE_HEADING,
			`Phase: ${phase.kind}.`,
			"",
			"## Exact current app",
			projectCandidateText(
				summarizeBlueprint(workspace.currentSnapshot().doc),
				workspace,
			),
			...(diagnostics.allFindings.length > 0
				? [
						"",
						"## Current validation findings to resolve before finishing",
						...diagnostics.allFindings.map((finding) => `- ${finding.message}`),
					]
				: []),
			...(phase.review !== null
				? [
						"",
						"## Independent review",
						renderCandidateRevisionInstructions(phase.review),
					]
				: []),
		].join("\n"),
	};
}

async function runAuthorPhase(args: {
	readonly request: CandidateLoopRunnerArgs;
	readonly workspace: ChangeSetMutationWorkspace;
	readonly authority: CandidateAuthority;
	readonly phase: CandidatePhase;
}): Promise<
	| { readonly kind: "checkpoint"; readonly checkpoint: CandidateCheckpoint }
	| { readonly kind: "awaiting-input" }
	| {
			readonly kind: "failed";
			readonly error: ReturnType<typeof classifyError>;
	  }
> {
	let checkpoint: CandidateCheckpoint | null = null;
	let pendingError: unknown;
	const agent = createCandidateAgent({
		model: args.request.designCtx.model(DESIGN_AUTHOR_MODEL),
		workspace: args.workspace,
		instructions: CANDIDATE_AUTHOR_SYSTEM,
		designSessionId: args.request.designSessionId,
		sourcePackageDigest: args.request.pkg.packageDigest,
		authority: args.authority,
		...(args.phase.parent !== null && {
			parentCheckpointId: args.phase.parent.id,
		}),
		promptCacheKey: `nova:reviewed-candidate:${args.request.designSessionId}`,
		allowQuestions: args.phase.kind === "author" && args.phase.parent === null,
		freshStateMessage: () => candidateStateMessage(args.workspace, args.phase),
		onCheckpoint: (created) => {
			checkpoint = created;
		},
		...(args.request.onAgentStep !== undefined && {
			onStepEnd: args.request.onAgentStep,
		}),
	});
	const sanitized = await sanitizeHistoricalToolParts(
		[...args.request.messages],
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
		projectPackageOntoMessages(args.request.pkg, compacted),
	);
	const validated = await validateUIMessages<InferAgentUIMessage<typeof agent>>(
		{
			messages: projected,
			tools: agent.tools,
		},
	);
	const prompt = [
		...markStablePrefixBoundary(
			await convertToModelMessages(validated, { tools: agent.tools }),
		),
		await candidateStateMessage(args.workspace, args.phase),
	];
	const result = await agent.stream({ prompt });
	const drained = Promise.resolve(result.consumeStream()).catch(() => {});
	const privateCalls = new Set<string>();
	const tracked = new Map<
		string,
		{
			toolName: string;
			startedAt: number;
			inputChars: number;
			outcomeEmitted: boolean;
		}
	>();
	let awaitingInput = false;
	let fatal = false;
	let organizing = false;
	const noteOutcome = (
		toolCallId: string,
		outcome: CandidateToolOutcomeEvent["outcome"],
		code: string,
	): void => {
		const item = tracked.get(toolCallId);
		if (item === undefined || item.outcomeEmitted) return;
		item.outcomeEmitted = true;
		args.request.onToolOutcome?.({
			toolCallId,
			toolName: item.toolName,
			inputChars: item.inputChars,
			durationMs: Math.max(0, Date.now() - item.startedAt),
			outcome,
			code,
		});
	};

	for await (const chunk of result.toUIMessageStream({
		originalMessages: validated,
		generateMessageId: () => args.request.responseMessageId,
		onError: (error) => {
			pendingError = error;
			return error instanceof Error ? error.message : String(error);
		},
	})) {
		if (isOpenAICompactionChunk(chunk)) {
			organizing = true;
			args.request.writer.write({
				type: "data-context-activity",
				data: { phase: "start" },
				transient: true,
			});
			continue;
		}
		if (
			organizing &&
			(chunk.type === "reasoning-start" ||
				chunk.type === "text-start" ||
				chunk.type === "tool-input-start")
		) {
			organizing = false;
			args.request.writer.write({
				type: "data-context-activity",
				data: { phase: "done" },
				transient: true,
			});
		}
		if (chunk.type === "error") {
			fatal = true;
			continue;
		}
		if (chunk.type === "tool-input-start") {
			tracked.set(chunk.toolCallId, {
				toolName: chunk.toolName,
				startedAt: Date.now(),
				inputChars: 0,
				outcomeEmitted: false,
			});
			if (chunk.toolName !== "askQuestions") {
				privateCalls.add(chunk.toolCallId);
			}
		}
		if (chunk.type === "tool-input-delta") {
			const item = tracked.get(chunk.toolCallId);
			if (item !== undefined) item.inputChars += chunk.inputTextDelta.length;
		}
		if (chunk.type === "tool-input-available") {
			const item = tracked.get(chunk.toolCallId);
			if (item !== undefined && item.inputChars === 0) {
				item.inputChars = JSON.stringify(chunk.input)?.length ?? 0;
			}
			if (chunk.toolName === "askQuestions") awaitingInput = true;
		}
		if (chunk.type === "tool-input-error") {
			noteOutcome(chunk.toolCallId, "wire-invalid", "tool-input-invalid");
		}
		if (chunk.type === "tool-output-available") {
			const failed =
				typeof chunk.output === "object" &&
				chunk.output !== null &&
				"error" in chunk.output;
			noteOutcome(
				chunk.toolCallId,
				failed ? "rejected" : "accepted",
				failed ? "tool-refused" : "tool-completed",
			);
		}
		if (chunk.type === "tool-output-error") {
			noteOutcome(chunk.toolCallId, "rejected", "tool-execution-error");
		}
		if (chunk.type === "start" || chunk.type === "finish") continue;
		const callId = "toolCallId" in chunk ? chunk.toolCallId : undefined;
		if (callId !== undefined && privateCalls.has(callId)) continue;
		args.request.writer.write(chunk as UIMessageChunk);
	}
	if (organizing) {
		args.request.writer.write({
			type: "data-context-activity",
			data: { phase: "done" },
			transient: true,
		});
	}
	await drained;
	for (const [toolCallId, item] of tracked) {
		if (!item.outcomeEmitted && item.toolName !== "askQuestions") {
			noteOutcome(toolCallId, "incomplete", "tool-call-incomplete");
		}
	}
	if (awaitingInput) return { kind: "awaiting-input" };
	if (checkpoint !== null) {
		return { kind: "checkpoint", checkpoint };
	}
	return {
		kind: "failed",
		error: classifyError(
			pendingError ??
				new Error(
					fatal
						? "The candidate stream ended in an error."
						: `The candidate author stopped before finishing within ${CANDIDATE_AGENT_STEP_BUDGET} steps.`,
				),
		),
	};
}

async function waitForTransientRetry(
	retryNumber: number,
	signal: AbortSignal,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(done, turnRetryDelayMs(retryNumber));
		function done() {
			signal.removeEventListener("abort", aborted);
			resolve();
		}
		function aborted() {
			clearTimeout(timer);
			reject(signal.reason);
		}
		signal.addEventListener("abort", aborted, { once: true });
	});
}

async function runAuthorPhaseWithTransientRetry(args: {
	readonly request: CandidateLoopRunnerArgs;
	readonly workspace: ChangeSetMutationWorkspace;
	readonly authority: CandidateAuthority;
	readonly phase: CandidatePhase;
}): ReturnType<typeof runAuthorPhase> {
	let retries = 0;
	for (;;) {
		const outcome = await runAuthorPhase(args);
		if (outcome.kind !== "failed" || !shouldRetryTurn(outcome.error, retries)) {
			return outcome;
		}
		retries += 1;
		log.warn("[reviewedCandidate] transient author retry", {
			designSessionId: args.request.designSessionId,
			phase: args.phase.kind,
			errorType: outcome.error.type,
			retryNumber: retries,
		});
		await waitForTransientRetry(retries, args.request.signal);
	}
}

type CandidateReviewerResult = Awaited<ReturnType<typeof runCandidateReviewer>>;

async function runReviewerWithTransientRetry(args: {
	readonly request: CandidateLoopRunnerArgs;
	readonly draft: CandidateCheckpoint;
	readonly workspace: ChangeSetMutationWorkspace;
	readonly kind: "full" | "verification";
	readonly priorFindings?: CandidateReview["findings"];
}): Promise<
	| { readonly kind: "reviewed"; readonly result: CandidateReviewerResult }
	| {
			readonly kind: "failed";
			readonly error: ReturnType<typeof classifyError>;
	  }
> {
	let retries = 0;
	for (;;) {
		try {
			return {
				kind: "reviewed",
				result: await runCandidateReviewer(
					args.request.designCtx,
					{
						pkg: args.request.pkg,
						candidateSummary: JSON.stringify(
							args.workspace.currentSnapshot().doc,
							null,
							1,
						),
						candidateDigest: args.draft.candidateDigest,
						brief: args.draft.brief,
						kind: args.kind,
						...(args.kind === "verification"
							? { priorFindings: args.priorFindings ?? [] }
							: {}),
					},
					args.request.signal,
				),
			};
		} catch (error) {
			const classified = classifyError(error);
			if (!shouldRetryTurn(classified, retries)) {
				return { kind: "failed", error: classified };
			}
			retries += 1;
			log.warn("[reviewedCandidate] transient reviewer retry", {
				designSessionId: args.request.designSessionId,
				kind: args.kind,
				errorType: classified.type,
				retryNumber: retries,
			});
			await waitForTransientRetry(retries, args.request.signal);
		}
	}
}

export async function runCandidateLoop(
	args: CandidateLoopRunnerArgs,
): Promise<CandidateLoopOutcome> {
	const authority: CandidateAuthority = {
		actorUserId: args.actorUserId,
		runId: args.runId,
		holderNonce: args.holderNonce,
		expectedProjectId: args.projectId,
	};
	await insertDesignSourcePackage({ pkg: args.pkg, authority });
	const changeSet = await beginDesignCandidateChangeSet({
		designSessionId: args.designSessionId,
		proposedAppId: args.proposedAppId,
		projectId: args.projectId,
		baseSnapshotDigest: emptyGenesisBase(args.proposedAppId).digest,
		ownerUserId: args.actorUserId,
		ownerRunId: args.runId,
		holderNonce: args.holderNonce,
	});
	if (changeSet.purpose !== "design-candidate") {
		throw new Error("The reviewed build opened a non-candidate change set.");
	}
	const workspace = await ChangeSetMutationWorkspace.open(
		candidateHost(args),
		changeSet.id,
	);
	const active = await readActiveCandidateState(args.designSessionId);
	if (active.checkpoint?.lifecycle === "accepted") {
		if (active.checkpoint.sourcePackageDigest !== args.pkg.packageDigest) {
			return {
				kind: "failed",
				errorType: "candidate-source-changed-after-acceptance",
				message:
					"The request no longer matches the reviewed app design, so Nova stopped before publishing the wrong version.",
				recoverable: false,
			};
		}
		return { kind: "accepted", checkpoint: active.checkpoint };
	}

	let draft = active.checkpoint;
	if (draft === null) {
		await args.onPhase?.("design");
		const authored = await runAuthorPhaseWithTransientRetry({
			request: args,
			workspace,
			authority,
			phase: { kind: "author", parent: null, review: null },
		});
		if (authored.kind === "awaiting-input") return authored;
		if (authored.kind === "failed") {
			return {
				kind: "failed",
				errorType: authored.error.type,
				message:
					"Nova stopped before the app design was complete. The completed work is saved and can resume from this exact point.",
				recoverable: true,
			};
		}
		draft = authored.checkpoint;
	}
	if (draft.sourcePackageDigest !== args.pkg.packageDigest) {
		return {
			kind: "failed",
			errorType: "candidate-source-changed-after-checkpoint",
			message:
				"The request changed after this app design was checkpointed, so Nova stopped before publishing the wrong version.",
			recoverable: false,
		};
	}

	const blockedCheckpointAtStart =
		active.phase === "blocked" && active.checkpoint?.id === draft.id;
	let blockedResumeConsumed = false;
	let revisionFindings: CandidateReview["findings"] | undefined;
	if (draft.parentCheckpointId !== null) {
		const parentReview =
			(await readCandidateReviewForCheckpoint(
				draft.parentCheckpointId,
				"verification",
			)) ??
			(await readCandidateReviewForCheckpoint(
				draft.parentCheckpointId,
				"full",
			));
		if (parentReview === null) {
			throw new Error(
				"A corrected candidate is missing the review that required it.",
			);
		}
		revisionFindings = parentReview.review.findings;
	}
	for (;;) {
		const reviewKind =
			draft.parentCheckpointId === null ? "full" : "verification";
		let reviewRecord =
			active.review?.kind === reviewKind &&
			active.review.checkpointId === draft.id
				? active.review
				: await readCandidateReviewForCheckpoint(draft.id, reviewKind);
		if (reviewRecord === null) {
			await args.onPhase?.("review");
			const reviewAttempt = await runReviewerWithTransientRetry({
				request: args,
				draft,
				workspace,
				kind: reviewKind,
				...(reviewKind === "verification"
					? { priorFindings: revisionFindings ?? [] }
					: {}),
			});
			if (reviewAttempt.kind === "failed") {
				return {
					kind: "failed",
					errorType: reviewAttempt.error.type,
					message:
						reviewKind === "full"
							? "Nova saved the complete app design, but its independent review did not finish."
							: "Nova saved the corrected app design, but could not finish checking the corrections.",
					recoverable: true,
				};
			}
			const reviewed = reviewAttempt.result;
			if (reviewed.kind !== "produced") {
				return {
					kind: "failed",
					errorType: `candidate-${reviewKind}-${reviewed.reason}`,
					message:
						reviewKind === "full"
							? "Nova saved the complete app design, but its independent review did not finish."
							: "Nova saved the corrected app design, but could not finish checking the corrections.",
					recoverable: true,
				};
			}
			if (reviewed.reasoningText) {
				args.onReviewerReasoning?.(reviewed.reasoningText);
			}
			reviewRecord = await insertCandidateReview({
				checkpoint: draft,
				kind: reviewKind,
				review: reviewed.artifact,
				producerModel: DESIGN_REVIEWER_MODEL,
				promptVersion: CANDIDATE_REVIEW_PROMPT_VERSION,
				authority,
			});
		}
		if (!candidateReviewBlocksAcceptance(reviewRecord.review)) break;
		revisionFindings = reviewRecord.review.findings;

		if (reviewKind === "verification") {
			if (
				!args.allowBlockedResume ||
				!blockedCheckpointAtStart ||
				blockedResumeConsumed
			) {
				return {
					kind: "failed",
					errorType: "candidate-verification-blocked",
					message:
						"The app design still has a material issue after review, so Nova did not publish an incomplete app.",
					recoverable: true,
				};
			}
			await resumeBlockedCandidateRevision({
				checkpoint: draft,
				review: reviewRecord,
				authority,
			});
			blockedResumeConsumed = true;
		}

		await args.onPhase?.("revise");
		const revised = await runAuthorPhaseWithTransientRetry({
			request: args,
			workspace,
			authority,
			phase: { kind: "revision", parent: draft, review: reviewRecord.review },
		});
		if (revised.kind === "awaiting-input") return revised;
		if (revised.kind === "failed") {
			return {
				kind: "failed",
				errorType: revised.error.type,
				message:
					"Nova saved the app design and review, but stopped before finishing the corrections.",
				recoverable: true,
			};
		}
		draft = revised.checkpoint;
	}

	const accepted = await checkpointCandidate({
		workspace,
		designSessionId: args.designSessionId,
		sourcePackageDigest: args.pkg.packageDigest,
		brief: draft.brief,
		lifecycle: "accepted",
		parentCheckpointId: draft.id,
		authority,
	});
	return { kind: "accepted", checkpoint: accepted };
}
