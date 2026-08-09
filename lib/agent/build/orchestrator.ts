/**
 * The build orchestrator — the server-owned method behind a chat build
 * (§13.1): source resolution, the server-gated design agent loop
 * (`designLoopRunner.ts`), accepted-artifact selection, slice sequencing,
 * user questions, and completion policy. The model never decides whether
 * review happened, which revision is accepted, whether a slice may commit,
 * or whether the build is complete — every transition is a durable
 * orchestration event, and every slice's only completion authority is its
 * committed receipt (genesis: the materialization receipt).
 *
 * The design agent speaks for itself in the transcript (its chunks stream
 * through the loop runner); the orchestrator still narrates the SLICE
 * phase with synthetic UIMessage chunks (deterministic statements derived
 * from real artifacts; §15.5), plus the §15.4 progress frames, each a
 * projection of a durable row.
 *
 * Every model-facing seam (source-package deps, the design loop, the
 * executor step) is injectable so the whole orchestration is testable
 * offline; the production defaults wire the real loop and executor.
 */

import type { UIMessage, UIMessageChunk } from "ai";
import { emptyGenesisBase } from "@/lib/agent/change-set/baseLoader";
import {
	type CommittedStageEnvelope,
	commitDesignChangeSet,
	committedStageEnvelopes,
} from "@/lib/agent/change-set/commit";
import { materializeAppFromGenesis } from "@/lib/agent/change-set/materializeGenesis";
import {
	beginAppEditChangeSet,
	beginGenesisChangeSet,
	loadChangeSet,
	loadChangeSetSteps,
} from "@/lib/agent/change-set/store";
import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import {
	ChangeSetMutationWorkspace,
	type ChangeSetWorkspaceHost,
} from "@/lib/agent/change-set/workspace";
import type {
	DesignBuildPlanRecord,
	DesignRevisionRecord,
} from "@/lib/agent/design/artifactStore";
import { readDesignReviews } from "@/lib/agent/design/artifactStore";
import type { BuildPlan, BuildSlice } from "@/lib/agent/design/buildPlan";
import { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import { asDesignId } from "@/lib/agent/design/ids";
import { seedClaimsFromAnsweredRounds } from "@/lib/agent/design/loop/claimSeeding";
import type { DesignAgentStep } from "@/lib/agent/design/loop/designAgent";
import type {
	DesignSourcePackage,
	SourceClaimSeed,
} from "@/lib/agent/design/sourcePackage";
import { buildDesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { productionSourcePackageDeps } from "@/lib/agent/design/sourcePackageDeps";
import { createExtractionCondenser } from "@/lib/agent/documentExtraction";
import type { ClassifiedError } from "@/lib/agent/errorClassifier";
import type { SubGenerationUsageMeter } from "@/lib/agent/modelRunContext";
import type { AppMaterializationReceipt } from "@/lib/db/appGenesis";
import { refreshBuildLiveness, setAwaitingInput } from "@/lib/db/apps";
import {
	refreshDesignSessionLiveness,
	setDesignSessionActiveArtifacts,
	setDesignSessionAwaitingInput,
} from "@/lib/db/designSessions";
import { getAppDb } from "@/lib/db/pg";
import { log } from "@/lib/logger";
import { DESIGN_MODEL, SA_BUILD_MODEL } from "@/lib/models";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { budgetForSlice } from "./budgets";
import { type DesignLoopOutcome, runDesignAgentLoop } from "./designLoopRunner";
import {
	briefDigest,
	deriveSliceExecutionBrief,
	type SliceExecutionBrief,
} from "./executionBrief";
import {
	type ExecutorStepFn,
	productionExecutorStep,
	runSliceExecutor,
	type SliceExecutionOutcome,
} from "./executorLoop";
import { EXECUTOR_PROMPT_VERSION } from "./executorPrompt";
import {
	assertRequiredExternalActionsSatisfied,
	ExternalActionRequiredError,
} from "./externalActions";
import {
	appendOrchestrationEvent,
	type OrchestrationHead,
	readOrchestrationHead,
} from "./orchestratorState";
import {
	deriveBuildPlanSummary,
	deriveDesignOutline,
	progressEnvelope,
} from "./progress";
import {
	beginOrRecoverSliceAttempt,
	bindSliceAttemptChangeSet,
	countDesignIssueAttempts,
	markSliceAttempt,
	type SliceAttempt,
} from "./sliceAttempts";

// ── Public contract ────────────────────────────────────────────────

/** Structurally the DurableStreamWriter — everything the orchestrator emits
 *  rides the run's one write choke point. */
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
			/** The materialized app when the failure struck AFTER the first
			 * workflow committed (the run's holder lives on the app row then);
			 * null while the failure left no app. */
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
	readonly runDesignLoop: typeof runDesignAgentLoop;
	readonly executorStep: ExecutorStepFn;
	readonly materialize: typeof materializeAppFromGenesis;
	readonly commitSlice: typeof commitDesignChangeSet;
	/** Item 18's event-log seam: the route hands the app LogWriter's
	 *  emission in; the orchestrator calls it once per committed LATER slice
	 *  with the stored per-stage envelopes (genesis steps are provenance,
	 *  never app history). */
	readonly logCommittedStages: (
		receipt: CommittedSliceReceipt,
		envelopes: readonly CommittedStageEnvelope[],
	) => void;
	/** Step fan-out for the design agent's loop (usage accounting,
	 *  conversation events, the awaiting-input latch); the route wires
	 *  `GenerationContext.handleAgentStep`. */
	readonly onAgentStep?: (step: DesignAgentStep) => void;
	/** Display-safe reasoning summaries from the calls that never touch a
	 *  thread (the independent reviewer, each executor step) → the run
	 *  event log. */
	readonly onReasoningSummary?: (text: string) => void;
	/** A transient design-turn failure being redriven, rendered as a
	 *  recoverable warning with the real classified type. */
	readonly onRecoverableRetry?: (classified: ClassifiedError) => void;
}

export interface RunBuildOrchestrationArgs {
	readonly designSessionId: string;
	readonly proposedAppId: string;
	readonly projectId: string;
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
	/** The bound app when this session already materialized (a resumed or
	 *  multi-slice build); null pre-app. */
	readonly materializedAppId: string | null;
}

// ── Narrative chunks ───────────────────────────────────────────────

/** One narrated step: start-step → text → finish-step. The transcript's
 *  assistant message accumulates these as ordinary steps, so the barrier
 *  fold persists each at its own boundary. */
function narrate(writer: OrchestratorStreamWriter, text: string): void {
	const id = crypto.randomUUID();
	writer.write({ type: "start-step" });
	writer.write({ type: "text-start", id });
	writer.write({ type: "text-delta", id, delta: text });
	writer.write({ type: "text-end", id });
	writer.write({ type: "finish-step" });
}

/** One blocking question the pause presents: a design revision's open
 *  question (free text, no options) or a missing-information escalation's
 *  single decision with its proposed choices. */
interface PauseQuestion {
	readonly id: string;
	readonly question: string;
	readonly options: readonly string[];
}

/** The blocking-question pause: the standard askQuestions tool part the
 *  chat client already renders and answers. */
function emitQuestions(
	writer: OrchestratorStreamWriter,
	questions: readonly PauseQuestion[],
): void {
	const toolCallId = crypto.randomUUID();
	const input = {
		header: "A few decisions shape this app's structure",
		questions: questions.map((question) => ({
			question: question.question,
			options: [...question.options],
		})),
	};
	writer.write({ type: "start-step" });
	writer.write({
		type: "tool-input-start",
		toolCallId,
		toolName: "askQuestions",
	});
	writer.write({
		type: "tool-input-available",
		toolCallId,
		toolName: "askQuestions",
		input,
	});
	writer.write({ type: "finish-step" });
}

// ── Slice ordering ─────────────────────────────────────────────────

/** Topological order with the materialization root first. A root with
 *  prerequisite SLICES is a plan defect (nothing can commit before the
 *  app exists) and fails loudly. */
export function orderSlicesForExecution(plan: BuildPlan): BuildSlice[] {
	const root = plan.slices.find(
		(slice) => slice.role === "materialization-root",
	);
	if (root === undefined) {
		throw new Error("The build plan carries no materialization root.");
	}
	if (root.prerequisiteSliceIds.length > 0) {
		throw new Error(
			"The materialization root names prerequisite slices, but no slice can commit before the app exists.",
		);
	}
	const byId = new Map(plan.slices.map((slice) => [slice.id as string, slice]));
	const ordered: BuildSlice[] = [];
	const placed = new Set<string>([root.id as string]);
	ordered.push(root);
	const remaining = plan.slices.filter((slice) => slice !== root);
	let progressed = true;
	while (remaining.length > 0 && progressed) {
		progressed = false;
		for (let index = 0; index < remaining.length; index += 1) {
			const slice = remaining[index];
			if (slice?.prerequisiteSliceIds.every((id) => placed.has(id as string))) {
				ordered.push(slice);
				placed.add(slice.id as string);
				remaining.splice(index, 1);
				progressed = true;
				index -= 1;
			}
		}
	}
	if (remaining.length > 0) {
		throw new Error(
			`The build plan's prerequisite graph did not resolve for slice(s) ${remaining
				.map((slice) => slice.name)
				.join(", ")}.`,
		);
	}
	return ordered.filter((slice) => byId.has(slice.id as string));
}

// ── The orchestration ──────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 60_000;

export async function runBuildOrchestration(
	args: RunBuildOrchestrationArgs,
): Promise<BuildOrchestrationOutcome> {
	const deps = productionDeps(args);
	let appId: string | null = args.materializedAppId;

	/* Wall-clock liveness heartbeat: the session's lease pre-materialization,
	 * the app's build liveness after. Unref'd; always cleared. */
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
		/* The turn's assistant message opens here: one identity plus the
		 * producing model, carried by the start chunk upstream of the durable
		 * tee. The design agent's own start chunk is dropped by the loop
		 * runner, so this stamp is what `sanitizeHistoricalReasoningParts`
		 * reads on later turns. */
		args.writer.write({
			type: "start",
			messageId: args.responseMessageId,
			messageMetadata: { model: DESIGN_MODEL },
		});
		let head = await readOrchestrationHead(args.designSessionId);

		/* ── Design ─────────────────────────────────────────────────── */
		const claims = seedClaimsFromAnsweredRounds(args.threadId, args.messages);
		if (head !== null && appId !== null) {
			narrate(
				args.writer,
				"Picking this build back up from where it left off.",
			);
		}
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
			head.state.kind === "awaiting-user-questions"
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
		});
		const loopOutcome: DesignLoopOutcome = await deps.runDesignLoop({
			designSessionId: args.designSessionId,
			projectId: args.projectId,
			threadId: args.threadId,
			runId: args.runId,
			actorUserId: args.actorUserId,
			holderNonce: args.holderNonce,
			responseMessageId: args.responseMessageId,
			messages: args.messages,
			pkg,
			designCtx,
			writer: args.writer,
			signal: args.signal,
			head: () => head,
			packageDeps: productionSourcePackageDeps(createExtractionCondenser()),
			...(deps.onAgentStep !== undefined && { onAgentStep: deps.onAgentStep }),
			...(deps.onReasoningSummary !== undefined && {
				onReviewerReasoning: deps.onReasoningSummary,
			}),
			...(deps.onRecoverableRetry !== undefined && {
				onRecoverableRetry: deps.onRecoverableRetry,
			}),
		});
		heartbeat();

		if (loopOutcome.kind === "failed") {
			head = await appendFailure(args, head, {
				errorType: loopOutcome.errorType,
				recoverable: loopOutcome.recoverable,
			});
			return {
				kind: "failed",
				appId,
				errorType: loopOutcome.errorType,
				message: loopOutcome.message,
				recoverable: loopOutcome.recoverable,
			};
		}

		if (loopOutcome.kind === "awaiting-input") {
			/* The agent's own askQuestions round already streamed through the
			 * loop; only the durable pause remains: the event arm the stage
			 * fold reads, and the awaiting-input flag on whichever row holds
			 * the run. */
			await appendOrchestrationEvent({
				designSessionId: args.designSessionId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				actorUserId: args.actorUserId,
				expectedProjectId: args.projectId,
				state: {
					kind: "awaiting-user-questions",
					designSessionId: args.designSessionId,
					designRevisionId: loopOutcome.headRevisionId,
				},
				expectedHead: head,
			});
			const pause =
				appId === null
					? await setDesignSessionAwaitingInput(
							args.designSessionId,
							args.runId,
							args.holderNonce,
							true,
							args.actorUserId,
							args.projectId,
						)
					: await setAwaitingInput(
							appId,
							args.runId,
							args.holderNonce,
							"build",
							true,
							args.actorUserId,
							args.projectId,
						);
			return { kind: "awaiting-input", pauseOwned: pause === "owned" };
		}

		const { revision, plan } = loopOutcome;
		await setDesignSessionActiveArtifacts({
			designSessionId: args.designSessionId,
			actorUserId: args.actorUserId,
			runId: args.runId,
			holderNonce: args.holderNonce,
			expectedProjectId: args.projectId,
			activeDesignRevisionId: revision.id,
			activeBuildPlanId: plan.id,
		});
		await emitDesignSummaries(args, head, revision, plan);
		if (
			head.state.kind !== "planning" ||
			head.state.designRevisionId !== revision.id
		) {
			head = await appendOrchestrationEvent({
				designSessionId: args.designSessionId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				actorUserId: args.actorUserId,
				expectedProjectId: args.projectId,
				state: {
					kind: "planning",
					designRevisionId: revision.id,
					designRevisionDigest: revision.artifactDigest,
				},
				expectedHead: head,
			});
		}

		/* ── Execute slices ─────────────────────────────────────────── */
		const contract = revision.envelope.payload;
		const ordered = orderSlicesForExecution(plan.envelope.payload);
		const committedSlices = await committedSliceIds(plan.id);
		let lastSeq = 1;
		for (const slice of ordered) {
			if (committedSlices.has(slice.id as string)) continue;
			const isGenesis = appId === null;
			const budget = budgetForSlice(slice);
			const priorDesignIssues = await countDesignIssueAttempts({
				designSessionId: args.designSessionId,
				buildPlanId: plan.id,
				sliceId: slice.id as string,
			});
			if (priorDesignIssues >= budget.maxDesignIssueEscalations) {
				head = await appendFailure(args, head, {
					errorType: "design-issue-budget-exhausted",
					recoverable: true,
				});
				return {
					kind: "failed",
					appId,
					errorType: "internal",
					message:
						"This slice reached its persisted design-issue limit and needs a revised design plan before execution can continue.",
					recoverable: true,
				};
			}
			narrate(
				args.writer,
				isGenesis
					? `Building ${slice.name}. This first workflow becomes your app.`
					: `Adding ${slice.name}.`,
			);
			const brief = deriveSliceExecutionBrief({
				contract,
				revision: { id: revision.id, digest: revision.artifactDigest },
				plan: plan.envelope.payload,
				planDigest: plan.artifactDigest,
				sliceId: slice.id,
			});
			const digest = briefDigest(brief);
			try {
				await assertRequiredExternalActionsSatisfied({
					designSessionId: args.designSessionId,
					projectId: args.projectId,
					appId,
					plan: plan.envelope.payload,
					slice,
				});
			} catch (error) {
				if (!(error instanceof ExternalActionRequiredError)) throw error;
				head = await appendFailure(args, head, {
					errorType: "external-action-required",
					recoverable: true,
				});
				return {
					kind: "failed",
					appId,
					errorType: "internal",
					message:
						"A required external prerequisite is still outstanding. Complete it before continuing this build.",
					recoverable: true,
				};
			}
			const { attempt } = await beginOrRecoverSliceAttempt({
				designSessionId: args.designSessionId,
				designRevisionId: revision.id,
				designRevisionDigest: revision.artifactDigest,
				buildPlanId: plan.id,
				buildPlanDigest: plan.artifactDigest,
				sliceId: slice.id as string,
				baseTarget: isGenesis
					? {
							kind: "empty-genesis",
							proposedAppId: args.proposedAppId,
							digest: emptyGenesisBase(args.proposedAppId).digest,
						}
					: await appBaseTarget(appId as string),
				executorModel: SA_BUILD_MODEL,
				promptVersion: EXECUTOR_PROMPT_VERSION,
				briefDigest: digest,
			});
			const changeSetId = await ensureChangeSet(
				args,
				attempt,
				revision,
				plan,
				isGenesis,
			);
			args.writer.write({
				type: "data-build-slice-started",
				data: progressEnvelope(args.designSessionId, head, {
					sliceId: slice.id,
					sliceName: slice.name,
				}),
				transient: true,
			});
			if (
				head.state.kind !== "executing-slice" ||
				head.state.changeSetId !== changeSetId
			) {
				head = await appendOrchestrationEvent({
					designSessionId: args.designSessionId,
					runId: args.runId,
					holderNonce: args.holderNonce,
					actorUserId: args.actorUserId,
					expectedProjectId: args.projectId,
					state: {
						kind: "executing-slice",
						designRevisionId: revision.id,
						buildPlanId: plan.id,
						sliceId: slice.id,
						changeSetId,
						attempt: attempt.attempt,
					},
					expectedHead: head,
				});
			}

			const outcome = await executeOneSlice(args, deps, {
				attempt,
				changeSetId,
				brief,
				slice,
				isGenesis,
				appId,
				budget,
			});
			heartbeat();
			if (outcome.kind === "committed") {
				const receipt = outcome.receipt;
				if (isGenesis) {
					const materialization = receipt as AppMaterializationReceipt;
					appId = materialization.appId;
					lastSeq = 1;
					args.writer.write({
						type: "data-app-materialized",
						data: materialization,
						transient: true,
					});
					narrate(
						args.writer,
						`Your app is live. ${slice.name} is real and ready to try in the preview.`,
					);
				} else {
					const sliceReceipt = receipt as CommittedSliceReceipt;
					lastSeq = sliceReceipt.seq;
					const steps = await loadChangeSetSteps(sliceReceipt.changeSetId);
					deps.logCommittedStages(sliceReceipt, committedStageEnvelopes(steps));
					args.writer.write({
						type: "data-build-slice-committed",
						data: progressEnvelope(args.designSessionId, head, {
							sliceId: slice.id,
							sliceName: slice.name,
							seq: sliceReceipt.seq,
						}),
						transient: true,
					});
				}
				continue;
			}
			if (outcome.kind === "design-issue") {
				await markSliceAttempt(
					attempt.id,
					"design-issue",
					outcome.issue.category,
				);
				if (outcome.issue.category === "missing-information") {
					/* One decision, one question: the explanation is what needs
					 * answering and the proposed options are its choices. */
					return await pauseOnQuestions(args, head, revision, appId, [
						{
							id: outcome.issue.id as string,
							question: outcome.issue.explanation,
							options: outcome.issue.proposedOptions,
						},
					]);
				}
				head = await appendFailure(args, head, {
					errorType: `design-issue-${outcome.issue.category}`,
					recoverable: true,
				});
				return {
					kind: "failed",
					appId,
					errorType: "internal",
					message: `Building ${slice.name} surfaced a design gap (${outcome.issue.category}): ${outcome.issue.explanation} Nothing invalid was saved; adjust the request and try again.`,
					recoverable: true,
				};
			}
			/* budget-exhausted / protocol-failure */
			await markSliceAttempt(
				attempt.id,
				"failed",
				outcome.kind === "budget-exhausted" ? "budget-exhausted" : outcome.code,
			);
			head = await appendFailure(args, head, {
				errorType:
					outcome.kind === "budget-exhausted"
						? "execution-budget-exhausted"
						: outcome.code,
				recoverable: true,
			});
			return {
				kind: "failed",
				appId,
				errorType: "internal",
				message:
					outcome.kind === "budget-exhausted"
						? `Building ${slice.name} ran past its execution budget. Everything already committed is safe; send your message again to continue from there.`
						: outcome.message,
				recoverable: true,
			};
		}

		/* ── Finished ───────────────────────────────────────────────── */
		if (appId === null) {
			throw new Error(
				"The build plan committed no materialization root, so no app exists.",
			);
		}
		/* The final sequence is the APP's, not this run's: a resumed
		 * orchestration that found every slice already committed advanced
		 * nothing locally, and reporting seq 1 would stamp a wrong durable
		 * record and let the case-store sweep skip later slices' schemas. */
		lastSeq = Math.max(lastSeq, await currentAppSeq(appId));
		head = await appendOrchestrationEvent({
			designSessionId: args.designSessionId,
			runId: args.runId,
			holderNonce: args.holderNonce,
			actorUserId: args.actorUserId,
			expectedProjectId: args.projectId,
			state: { kind: "finished", appId, appSeq: lastSeq },
			expectedHead: head,
		});
		args.writer.write({
			type: "data-build-completion",
			data: progressEnvelope(args.designSessionId, head, {
				appId,
				appSeq: lastSeq,
				plannedSlices: ordered.length,
			}),
			transient: true,
		});
		narrate(
			args.writer,
			"That's every planned workflow in place. Take it for a spin in the preview, and tell me what you'd like to adjust.",
		);
		return { kind: "completed", appId, finalSeq: lastSeq };
	} finally {
		clearInterval(heartbeatTimer);
		args.writer.write({ type: "finish" });
	}
}

// ── Internals ──────────────────────────────────────────────────────

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
		runDesignLoop: overrides.runDesignLoop ?? runDesignAgentLoop,
		...(overrides.onAgentStep !== undefined && {
			onAgentStep: overrides.onAgentStep,
		}),
		...(overrides.onReasoningSummary !== undefined && {
			onReasoningSummary: overrides.onReasoningSummary,
		}),
		...(overrides.onRecoverableRetry !== undefined && {
			onRecoverableRetry: overrides.onRecoverableRetry,
		}),
		executorStep:
			overrides.executorStep ??
			productionExecutorStep(
				new DesignGenerationContext({
					apiKey: args.apiKey,
					userId: args.actorUserId,
					projectId: args.projectId,
					runId: args.runId,
					designSessionId: args.designSessionId,
					...(args.meter !== undefined && { meter: args.meter }),
				}).model(SA_BUILD_MODEL),
			),
		materialize: overrides.materialize ?? materializeAppFromGenesis,
		commitSlice: overrides.commitSlice ?? commitDesignChangeSet,
		logCommittedStages: overrides.logCommittedStages ?? (() => {}),
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

async function pauseOnQuestions(
	args: RunBuildOrchestrationArgs,
	head: OrchestrationHead | null,
	revision: DesignRevisionRecord,
	/** The run's current app: null pre-materialization. The run HOLDER lives
	 *  on the session row before the transfer and on the app row after, so
	 *  the pause must stamp whichever row actually carries it — the session
	 *  writer answers "released" for a materialized session, which the route
	 *  would surface as a lost pause and a clawed-back question round. */
	appId: string | null,
	questions: readonly PauseQuestion[],
): Promise<BuildOrchestrationOutcome> {
	if (questions.length === 0) {
		/* An empty round is unpresentable AND unpersistable (the event schema
		 * requires at least one blocking id) — refuse before either write. */
		throw new Error(
			"A blocking-question pause was requested with no questions to ask.",
		);
	}
	narrate(
		args.writer,
		"A few decisions genuinely change how this app should be structured. Your answers will shape the design.",
	);
	emitQuestions(args.writer, questions);
	await appendOrchestrationEvent({
		designSessionId: args.designSessionId,
		runId: args.runId,
		holderNonce: args.holderNonce,
		actorUserId: args.actorUserId,
		expectedProjectId: args.projectId,
		state: {
			kind: "awaiting-user",
			designSessionId: args.designSessionId,
			designRevisionId: revision.id,
			blockingQuestionIds: questions.map((question) => asDesignId(question.id)),
		},
		expectedHead: head,
	});
	const pause =
		appId === null
			? await setDesignSessionAwaitingInput(
					args.designSessionId,
					args.runId,
					args.holderNonce,
					true,
					args.actorUserId,
					args.projectId,
				)
			: await setAwaitingInput(
					appId,
					args.runId,
					args.holderNonce,
					"build",
					true,
					args.actorUserId,
					args.projectId,
				);
	return { kind: "awaiting-input", pauseOwned: pause === "owned" };
}

async function emitDesignSummaries(
	args: RunBuildOrchestrationArgs,
	head: OrchestrationHead | null,
	revision: DesignRevisionRecord,
	plan: DesignBuildPlanRecord,
): Promise<void> {
	const reviews = await readDesignReviews(
		revision.parentRevisionId ?? revision.id,
	);
	const outline = deriveDesignOutline(
		revision.envelope.payload,
		reviews.map((review) => review.envelope.payload),
	);
	args.writer.write({
		type: "data-design-outline",
		data: progressEnvelope(args.designSessionId, head, outline),
		transient: true,
	});
	args.writer.write({
		type: "data-build-plan-summary",
		data: progressEnvelope(
			args.designSessionId,
			head,
			deriveBuildPlanSummary(plan.envelope.payload),
		),
		transient: true,
	});
	/* No templated narration here: the design agent already spoke for
	 * itself in the transcript, and these frames feed the outline card. */
}

async function committedSliceIds(planId: string): Promise<Set<string>> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("design_committed_slices")
		.select(["slice_id"])
		.where("build_plan_id", "=", planId)
		.execute();
	return new Set(rows.map((row) => row.slice_id));
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

async function appBaseTarget(appId: string) {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select(["mutation_seq"])
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	const { loadCanonicalBlueprintAtSequence } = await import(
		"@/lib/agent/change-set/baseLoader"
	);
	const seq = safePersistedSequence(row.mutation_seq, "apps.mutation_seq");
	const folded = await loadCanonicalBlueprintAtSequence(db, {
		appId,
		seq,
		expectedDigest: null,
	});
	return { kind: "app" as const, appId, seq, digest: folded.digest };
}

async function ensureChangeSet(
	args: RunBuildOrchestrationArgs,
	attempt: SliceAttempt,
	revision: DesignRevisionRecord,
	plan: DesignBuildPlanRecord,
	isGenesis: boolean,
): Promise<string> {
	if (attempt.changeSetId !== null) return attempt.changeSetId;
	const lineage = {
		designSessionId: args.designSessionId,
		designRevisionId: revision.id,
		designRevisionDigest: revision.artifactDigest,
		buildPlanId: plan.id,
		buildPlanDigest: plan.artifactDigest,
		sliceId: attempt.sliceId as never,
		attemptId: attempt.id,
	};
	try {
		const changeSet = isGenesis
			? await beginGenesisChangeSet({
					proposedAppId: args.proposedAppId,
					projectId: args.projectId,
					baseSnapshotDigest: emptyGenesisBase(args.proposedAppId).digest,
					lineage,
					ownerUserId: args.actorUserId,
					ownerRunId: args.runId,
				})
			: await beginAppEditChangeSet({
					appId:
						attempt.baseTarget.kind === "app" ? attempt.baseTarget.appId : "",
					expectedProjectId: args.projectId,
					lineage,
					ownerUserId: args.actorUserId,
					ownerRunId: args.runId,
				});
		await bindSliceAttemptChangeSet(attempt.id, changeSet.id);
		return changeSet.id;
	} catch (error) {
		/* The one-open-set-per-attempt fence names a reopenable set: recover
		 * it by attempt id. */
		const db = await getAppDb();
		const open = await db
			.selectFrom("design_change_sets")
			.select(["id"])
			.where("attempt_id", "=", attempt.id)
			.where("status", "=", "open")
			.executeTakeFirst();
		if (open !== undefined) {
			await bindSliceAttemptChangeSet(attempt.id, open.id);
			return open.id;
		}
		throw error;
	}
}

async function executeOneSlice(
	args: RunBuildOrchestrationArgs,
	deps: BuildOrchestrationDeps,
	slice: {
		attempt: SliceAttempt;
		changeSetId: string;
		brief: SliceExecutionBrief;
		slice: BuildSlice;
		isGenesis: boolean;
		appId: string | null;
		budget: ReturnType<typeof budgetForSlice>;
	},
): Promise<SliceExecutionOutcome> {
	const host: ChangeSetWorkspaceHost = {
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
				"A conversion-impact preview needs saved case rows, and a build slice runs before any exist for its new structure.",
			);
		},
	};
	const workspace = await ChangeSetMutationWorkspace.open(
		host,
		slice.changeSetId,
	);
	const commit = async (signal: AbortSignal, deadlineAt: number) => {
		if (signal.aborted || Date.now() >= deadlineAt) {
			return {
				kind: "gate-rejected" as const,
				message: "The slice execution deadline expired before commit.",
			};
		}
		const fresh = await loadChangeSet(slice.changeSetId);
		if (fresh === undefined) {
			throw new Error("This change set no longer exists.");
		}
		if (signal.aborted || Date.now() >= deadlineAt) {
			return {
				kind: "gate-rejected" as const,
				message: "The slice execution deadline expired before commit.",
			};
		}
		if (slice.isGenesis) {
			const outcome = await deps.materialize({
				changeSetId: slice.changeSetId,
				actorUserId: args.actorUserId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				expectedProjectId: args.projectId,
				expectedRevision: fresh.revision,
				owningIntentIds: slice.slice.ownedIntentIds,
				deadlineAt,
			});
			if (outcome.kind === "materialized") {
				return { kind: "committed" as const, receipt: outcome.receipt };
			}
			return outcome;
		}
		const outcome = await deps.commitSlice({
			changeSetId: slice.changeSetId,
			actorUserId: args.actorUserId,
			runId: args.runId,
			chatRunHolder: {
				mode: "build",
				runId: args.runId,
				nonce: args.holderNonce,
				source: "chat",
			},
			kind: "chat",
			expectedRevision: fresh.revision,
			owningIntentIds: slice.slice.ownedIntentIds,
			deadlineAt,
		});
		return outcome;
	};
	return runSliceExecutor({
		workspace,
		brief: slice.brief,
		budget: slice.budget,
		step: deps.executorStep,
		commit,
		signal: args.signal,
		onProgress: (phase) => {
			log.info("[buildOrchestrator] slice progress", {
				designSessionId: args.designSessionId,
				sliceId: slice.slice.id,
				phase,
			});
		},
		...(deps.onReasoningSummary !== undefined && {
			onReasoning: deps.onReasoningSummary,
		}),
	});
}
