/**
 * The server-owned reviewed-build method. One Solutions Architect authors the
 * real app in a private durable Blueprint workspace, one independent reviewer
 * checks that exact candidate, and the accepted revision materializes as the
 * app's complete sequence-one snapshot. There is no intermediate design
 * contract, build plan, slice compiler, or model-authored commit protocol.
 */

import type { UIMessage, UIMessageChunk } from "ai";
import { materializeAppFromGenesis } from "@/lib/agent/change-set/materializeGenesis";
import type { CandidateAgentStep } from "@/lib/agent/design/candidateAgent";
import { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import { seedClaimsFromAnsweredRounds } from "@/lib/agent/design/loop/claimSeeding";
import type {
	DesignSourcePackage,
	SourceClaimSeed,
} from "@/lib/agent/design/sourcePackage";
import { buildDesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { productionSourcePackageDeps } from "@/lib/agent/design/sourcePackageDeps";
import { createExtractionCondenser } from "@/lib/agent/documentExtraction";
import type { SubGenerationUsageMeter } from "@/lib/agent/modelRunContext";
import { refreshBuildLiveness } from "@/lib/db/apps";
import {
	refreshDesignSessionLiveness,
	setDesignSessionAwaitingInput,
} from "@/lib/db/designSessions";
import { getAppDb } from "@/lib/db/pg";
import { DESIGN_AUTHOR_MODEL, MODEL_CONTEXT_VERSION } from "@/lib/models";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	type CandidateLoopRunnerArgs,
	type CandidateToolOutcomeEvent,
	runCandidateLoop,
} from "./candidateLoopRunner";
import {
	appendOrchestrationEvent,
	type OrchestrationHead,
	readOrchestrationHead,
} from "./orchestratorState";
import { progressEnvelope } from "./progress";

export interface OrchestratorStreamWriter {
	write(
		chunk:
			| UIMessageChunk
			| { type: string; data: unknown; transient?: boolean },
	): void;
}

export type BuildOrchestrationOutcome =
	| {
			readonly kind: "completed";
			readonly appId: string;
			readonly finalSeq: number;
	  }
	| { readonly kind: "awaiting-input"; readonly pauseOwned: boolean }
	| {
			readonly kind: "failed";
			readonly errorType: string;
			readonly message: string;
			readonly recoverable: boolean;
			readonly appId: string | null;
	  };

export interface BuildOrchestrationDeps {
	readonly buildPackage: (args: {
		designSessionId: string;
		projectId: string;
		threadId: string;
		messages: readonly UIMessage[];
		claims: readonly SourceClaimSeed[];
	}) => Promise<DesignSourcePackage>;
	readonly runCandidateLoop: typeof runCandidateLoop;
	readonly materialize: typeof materializeAppFromGenesis;
	readonly onAgentStep?: (step: CandidateAgentStep) => void;
	readonly onReasoningSummary?: (text: string) => void;
	readonly onDesignToolOutcome?: (event: CandidateToolOutcomeEvent) => void;
}

export interface RunBuildOrchestrationArgs {
	readonly designSessionId: string;
	readonly proposedAppId: string;
	readonly projectId: string;
	readonly projectRole: string;
	readonly actorUserId: string;
	readonly runId: string;
	readonly holderNonce: string;
	readonly threadId: string;
	readonly messages: readonly UIMessage[];
	readonly responseMessageId: string;
	readonly writer: OrchestratorStreamWriter;
	readonly apiKey: string;
	readonly meter: SubGenerationUsageMeter | undefined;
	readonly signal: AbortSignal;
	readonly deps?: Partial<BuildOrchestrationDeps>;
	readonly materializedAppId: string | null;
	/** True only for the explicit Continue build control. */
	readonly redrive: boolean;
}

const HEARTBEAT_INTERVAL_MS = 60_000;

function candidateLoopArgs(
	args: RunBuildOrchestrationArgs,
	deps: BuildOrchestrationDeps,
	pkg: DesignSourcePackage,
	designCtx: DesignGenerationContext,
	onPhase: CandidateLoopRunnerArgs["onPhase"],
): CandidateLoopRunnerArgs {
	return {
		designSessionId: args.designSessionId,
		proposedAppId: args.proposedAppId,
		projectId: args.projectId,
		projectRole: args.projectRole,
		runId: args.runId,
		actorUserId: args.actorUserId,
		holderNonce: args.holderNonce,
		responseMessageId: args.responseMessageId,
		messages: args.messages,
		pkg,
		designCtx,
		writer: args.writer,
		signal: args.signal,
		allowBlockedResume: args.redrive,
		onPhase,
		...(deps.onAgentStep !== undefined && {
			onAgentStep: deps.onAgentStep,
		}),
		...(deps.onReasoningSummary !== undefined && {
			onReviewerReasoning: deps.onReasoningSummary,
		}),
		...(deps.onDesignToolOutcome !== undefined && {
			onToolOutcome: deps.onDesignToolOutcome,
		}),
	};
}

export async function runBuildOrchestration(
	args: RunBuildOrchestrationArgs,
): Promise<BuildOrchestrationOutcome> {
	const deps = productionDeps(args);
	let appId = args.materializedAppId;
	const heartbeat = () => {
		void (
			appId === null
				? refreshDesignSessionLiveness(
						args.designSessionId,
						args.runId,
						args.holderNonce,
					)
				: refreshBuildLiveness(appId, args.runId, args.holderNonce)
		).catch(() => {});
	};
	const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref?.();

	try {
		args.writer.write({
			type: "start",
			messageId: args.responseMessageId,
			messageMetadata: {
				model: DESIGN_AUTHOR_MODEL,
				contextVersion: MODEL_CONTEXT_VERSION,
			},
		});
		let head = await readOrchestrationHead(args.designSessionId);

		/* A crash after materialization resumes from the authoritative app and
		 * closes presentation state. It never authors or reviews another app. */
		if (appId !== null) {
			const finalSeq = await currentAppSeq(appId);
			if (
				head?.state.kind !== "finished" ||
				head.state.appId !== appId ||
				head.state.appSeq !== finalSeq
			) {
				head = await appendOrchestrationEvent({
					designSessionId: args.designSessionId,
					runId: args.runId,
					holderNonce: args.holderNonce,
					actorUserId: args.actorUserId,
					expectedProjectId: args.projectId,
					state: { kind: "finished", appId, appSeq: finalSeq },
					expectedHead: head,
				});
			}
			args.writer.write({
				type: "data-build-completion",
				data: progressEnvelope(args.designSessionId, head, {
					appId,
					appSeq: finalSeq,
					plannedSlices: 1,
				}),
				transient: true,
			});
			return { kind: "completed", appId, finalSeq };
		}

		const claims = seedClaimsFromAnsweredRounds(args.threadId, args.messages);
		const pkg = await deps.buildPackage({
			designSessionId: args.designSessionId,
			projectId: args.projectId,
			threadId: args.threadId,
			messages: args.messages,
			claims,
		});
		if (
			head === null ||
			head.state.kind === "awaiting-user" ||
			head.state.kind === "awaiting-user-questions" ||
			head.state.kind === "failed"
		) {
			head = await appendOrchestrationEvent({
				designSessionId: args.designSessionId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				actorUserId: args.actorUserId,
				expectedProjectId: args.projectId,
				state: {
					kind: "designing",
					designSessionId: args.designSessionId,
					sourcePackageDigest: pkg.packageDigest,
				},
				expectedHead: head,
			});
		}

		const designCtx = new DesignGenerationContext({
			apiKey: args.apiKey,
			userId: args.actorUserId,
			projectId: args.projectId,
			runId: args.runId,
			designSessionId: args.designSessionId,
			...(args.meter !== undefined && { meter: args.meter }),
			usagePhase: "design-review",
		});
		const outcome = await deps.runCandidateLoop(
			candidateLoopArgs(args, deps, pkg, designCtx, async (phase) => {
				const durableKind =
					phase === "review"
						? "reviewing-candidate"
						: phase === "revise"
							? "revising-candidate"
							: phase === "build"
								? "publishing-candidate"
								: "designing";
				if (head?.state.kind !== durableKind) {
					head = await appendOrchestrationEvent({
						designSessionId: args.designSessionId,
						runId: args.runId,
						holderNonce: args.holderNonce,
						actorUserId: args.actorUserId,
						expectedProjectId: args.projectId,
						state:
							durableKind === "designing"
								? {
										kind: "designing",
										designSessionId: args.designSessionId,
										sourcePackageDigest: pkg.packageDigest,
									}
								: {
										kind: durableKind,
										designSessionId: args.designSessionId,
									},
						expectedHead: head,
					});
				}
				args.writer.write({
					type: "data-design-pulse",
					data: progressEnvelope(args.designSessionId, head, {
						phase,
						chars: 0,
					}),
					transient: true,
				});
			}),
		);
		heartbeat();

		if (outcome.kind === "awaiting-input") {
			head = await appendOrchestrationEvent({
				designSessionId: args.designSessionId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				actorUserId: args.actorUserId,
				expectedProjectId: args.projectId,
				state: {
					kind: "awaiting-user-questions",
					designSessionId: args.designSessionId,
					designRevisionId: null,
				},
				expectedHead: head,
			});
			const pause = await setDesignSessionAwaitingInput(
				args.designSessionId,
				args.runId,
				args.holderNonce,
				true,
				args.actorUserId,
				args.projectId,
			);
			return { kind: "awaiting-input", pauseOwned: pause === "owned" };
		}
		if (outcome.kind === "failed") {
			await appendFailure(args, head, {
				errorType: outcome.errorType,
				recoverable: outcome.recoverable,
			});
			return { ...outcome, appId: null };
		}

		if (head?.state.kind !== "publishing-candidate") {
			head = await appendOrchestrationEvent({
				designSessionId: args.designSessionId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				actorUserId: args.actorUserId,
				expectedProjectId: args.projectId,
				state: {
					kind: "publishing-candidate",
					designSessionId: args.designSessionId,
				},
				expectedHead: head,
			});
		}
		args.writer.write({
			type: "data-design-pulse",
			data: progressEnvelope(args.designSessionId, head, {
				phase: "build",
				chars: 0,
			}),
			transient: true,
		});

		const materialized = await deps.materialize({
			changeSetId: outcome.checkpoint.changeSetId,
			actorUserId: args.actorUserId,
			runId: args.runId,
			holderNonce: args.holderNonce,
			expectedProjectId: args.projectId,
			expectedRevision: outcome.checkpoint.workspaceRevision,
		});
		if (materialized.kind !== "materialized") {
			const errorType =
				materialized.kind === "read-set-stale"
					? "candidate-read-set-stale"
					: "candidate-publish-rejected";
			await appendFailure(args, head, {
				errorType,
				recoverable: materialized.kind === "read-set-stale",
			});
			return {
				kind: "failed",
				appId: null,
				errorType,
				message:
					materialized.kind === "read-set-stale"
						? "Project data changed while Nova was finishing the app. The saved design can be checked again against the latest data."
						: "Nova found an issue while preparing the app, so it stopped before making an incomplete version available.",
				recoverable: materialized.kind === "read-set-stale",
			};
		}

		appId = materialized.receipt.appId;
		args.writer.write({
			type: "data-app-materialized",
			data: materialized.receipt,
			transient: true,
		});
		head = await appendOrchestrationEvent({
			designSessionId: args.designSessionId,
			runId: args.runId,
			holderNonce: args.holderNonce,
			actorUserId: args.actorUserId,
			expectedProjectId: args.projectId,
			state: { kind: "finished", appId, appSeq: 1 },
			expectedHead: head,
		});
		args.writer.write({
			type: "data-build-completion",
			data: progressEnvelope(args.designSessionId, head, {
				appId,
				appSeq: 1,
				plannedSlices: 1,
			}),
			transient: true,
		});
		return { kind: "completed", appId, finalSeq: 1 };
	} finally {
		clearInterval(heartbeatTimer);
		args.writer.write({ type: "finish" });
	}
}

function productionDeps(
	args: RunBuildOrchestrationArgs,
): BuildOrchestrationDeps {
	const overrides = args.deps ?? {};
	return {
		buildPackage:
			overrides.buildPackage ??
			(async (packageArgs) =>
				buildDesignSourcePackage({
					...packageArgs,
					messages: packageArgs.messages as Parameters<
						typeof buildDesignSourcePackage
					>[0]["messages"],
					deps: productionSourcePackageDeps(createExtractionCondenser()),
				})),
		runCandidateLoop: overrides.runCandidateLoop ?? runCandidateLoop,
		materialize: overrides.materialize ?? materializeAppFromGenesis,
		...(overrides.onAgentStep !== undefined && {
			onAgentStep: overrides.onAgentStep,
		}),
		...(overrides.onReasoningSummary !== undefined && {
			onReasoningSummary: overrides.onReasoningSummary,
		}),
		...(overrides.onDesignToolOutcome !== undefined && {
			onDesignToolOutcome: overrides.onDesignToolOutcome,
		}),
	};
}

async function appendFailure(
	args: RunBuildOrchestrationArgs,
	head: OrchestrationHead | null,
	failure: { errorType: string; recoverable: boolean },
): Promise<OrchestrationHead> {
	return appendOrchestrationEvent({
		designSessionId: args.designSessionId,
		runId: args.runId,
		holderNonce: args.holderNonce,
		actorUserId: args.actorUserId,
		expectedProjectId: args.projectId,
		state: {
			kind: "failed",
			failureId: crypto.randomUUID(),
			recoverable: failure.recoverable,
			errorType: failure.errorType,
		},
		expectedHead: head,
	});
}

async function currentAppSeq(appId: string): Promise<number> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select(["mutation_seq"])
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	return safePersistedSequence(row.mutation_seq, "apps.mutation_seq");
}
