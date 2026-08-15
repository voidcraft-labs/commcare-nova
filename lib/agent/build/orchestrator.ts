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
	commitDesignChangeSet,
	readCommittedSliceReceipt,
	readCommittedSliceReceiptsForPlan,
} from "@/lib/agent/change-set/commit";
import {
	materializeAppFromGenesis,
	readMaterializedGenesisReceipt,
} from "@/lib/agent/change-set/materializeGenesis";
import {
	beginAppEditChangeSet,
	beginGenesisChangeSet,
	loadChangeSet,
} from "@/lib/agent/change-set/store";
import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import {
	ChangeSetMutationWorkspace,
	type ChangeSetWorkspaceHost,
} from "@/lib/agent/change-set/workspace";
import {
	type DesignBuildPlanRecord,
	type DesignRevisionRecord,
	readDesignBuildPlan,
	readDesignReviews,
	readDesignRevision,
} from "@/lib/agent/design/artifactStore";
import type { BuildPlan, BuildSlice } from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
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
import {
	readToolLookupCatalog,
	readToolLookupDefinitions,
} from "@/lib/agent/lookupContext";
import {
	meterDurableSubGenerationUsage,
	type SubGenerationUsageMeter,
} from "@/lib/agent/modelRunContext";
import {
	finalizeInitialBuildLocalization,
	type InitialBuildLocalizationArgs,
	initialBuildHasLocalizationFinalizer,
	LocalizationBuildError,
	productionInitialBuildLocalizationDeps,
} from "@/lib/agent/translation/finalizer";
import {
	type DesignLocalizationReceipt,
	readLocalizationReceipt,
} from "@/lib/agent/translation/store";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { resolveAuthorizedAppSnapshot } from "@/lib/db/appAccess";
import type { AppMaterializationReceipt } from "@/lib/db/appGenesis";
import { refreshBuildLiveness, setAwaitingInput } from "@/lib/db/apps";
import {
	loadDesignSession,
	refreshDesignSessionLiveness,
	setDesignSessionActiveArtifacts,
	setDesignSessionAwaitingInput,
} from "@/lib/db/designSessions";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { log } from "@/lib/logger";
import { MODEL_CONTEXT_VERSION, MODEL_ROLES } from "@/lib/models";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	assertExactCommittedSliceReceipts,
	BuildCompletionVerificationError,
	refuseBuildCompletion,
} from "./authoritativeCompletion";
import { budgetForSlice, remainingWallClockMs } from "./budgets";
import {
	type DesignLoopOutcome,
	type DesignToolOutcomeEvent,
	runDesignAgentLoop,
} from "./designLoopRunner";
import {
	type ExecutionBlockerResolver,
	resolveExecutionBlocker,
} from "./executionBlocker";
import {
	briefDigest,
	deriveSliceExecutionBrief,
	type SliceExecutionBrief,
} from "./executionBrief";
import {
	buildExecutorTools,
	type ExecutorConversationContext,
	type ExecutorStepFn,
	type ExecutorToolOutcomeEvent,
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
	appendDesignModelContext,
	completeDesignModelStep,
	openDesignModelContext,
	recordDesignModelStepEvent,
	recoverableCompletedModelSteps,
} from "./modelContextStore";
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
	beginSliceAttemptOutcomeCollection,
	bindSliceAttemptChangeSet,
	claimSliceAttemptBudget,
	countSliceRebaseAttempts,
	finishSliceAttemptOutcomeCollection,
	markSliceAttempt,
	recordSliceAttemptDiagnostic,
	type SliceAttempt,
	supersedeSliceAttempt,
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
			readonly finalBlueprint: PersistableDoc;
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
	readonly resolveBlocker: ExecutionBlockerResolver;
	readonly materialize: typeof materializeAppFromGenesis;
	readonly commitSlice: typeof commitDesignChangeSet;
	readonly finalizeLocalization: (
		args: InitialBuildLocalizationArgs,
	) => Promise<DesignLocalizationReceipt | null>;
	/** Step fan-out for the design agent's loop (usage accounting,
	 *  conversation events, the awaiting-input latch); the route wires
	 *  `GenerationContext.handleAgentStep`. */
	readonly onAgentStep?: (step: DesignAgentStep) => void;
	/** Display-safe reasoning summaries from the calls that never touch a
	 *  thread (the independent reviewer, each executor step) → the run
	 *  event log. */
	readonly onReasoningSummary?: (text: string) => void;
	/** Payload-free private design-tool lifecycle annotations. */
	readonly onDesignToolOutcome?: (event: DesignToolOutcomeEvent) => void;
	/** Payload-free private-compiler outcome annotations for run inspection. */
	readonly onExecutorToolOutcome?: (
		event: ExecutorToolOutcomeEvent,
	) => void | Promise<void>;
	/** A transient design-turn failure being redriven, rendered as a
	 *  recoverable warning with the real classified type. */
	readonly onRecoverableRetry?: (classified: ClassifiedError) => void;
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
	/** The route-owned lifecycle tail. It converges case-store schemas and
	 * then atomically exact-sequence-CASes the app to complete, settles the
	 * charge, and appends the durable `finished` event. A transient throw leaves
	 * the frozen plan resumable. */
	readonly finalizeCompletion: (args: {
		readonly appId: string;
		readonly expectedSeq: number;
		readonly expectedHead: OrchestrationHead | null;
	}) => Promise<{
		readonly blueprint: PersistableDoc;
		readonly head: OrchestrationHead;
	}>;
	readonly deps?: Partial<BuildOrchestrationDeps>;
	/** The bound app when this session already materialized (a resumed or
	 *  multi-slice build); null pre-app. */
	readonly materializedAppId: string | null;
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
			messageMetadata: {
				model: MODEL_ROLES.designAuthor.modelId,
				contextVersion: MODEL_CONTEXT_VERSION,
			},
		});
		let head = await readOrchestrationHead(args.designSessionId);
		const session = await loadDesignSession(args.designSessionId);
		let accepted: {
			revision: DesignRevisionRecord;
			plan: DesignBuildPlanRecord;
		} | null = null;
		if (
			session?.active_design_revision_id !== null &&
			session?.active_design_revision_id !== undefined &&
			session.active_build_plan_id !== null
		) {
			const [revision, plan] = await Promise.all([
				readDesignRevision(session.active_design_revision_id),
				readDesignBuildPlan(session.active_build_plan_id),
			]);
			if (
				revision === null ||
				plan === null ||
				revision.designSessionId !== args.designSessionId ||
				plan.designSessionId !== args.designSessionId ||
				plan.designRevisionId !== revision.id ||
				plan.designRevisionDigest !== revision.artifactDigest
			) {
				throw new Error(
					"The design session's frozen accepted contract and plan do not share exact lineage.",
				);
			}
			accepted = { revision, plan };
		}

		/* ── Design ─────────────────────────────────────────────────── */
		if (accepted === null) {
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
				usagePhase: "design-review",
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
				...(deps.onAgentStep !== undefined && {
					onAgentStep: deps.onAgentStep,
				}),
				...(deps.onReasoningSummary !== undefined && {
					onReviewerReasoning: deps.onReasoningSummary,
				}),
				...(deps.onDesignToolOutcome !== undefined && {
					onToolOutcome: deps.onDesignToolOutcome,
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
			accepted = { revision, plan };
		}
		const { revision, plan } = accepted;
		await emitDesignSummaries(args, head, revision, plan);
		if (
			head === null ||
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
		const modelContextAuthority = {
			actorUserId: args.actorUserId,
			runId: args.runId,
			holderNonce: args.holderNonce,
			expectedProjectId: args.projectId,
		};
		const openExecutorContext = async (
			semanticScopeKey: string,
		): Promise<ExecutorConversationContext> => {
			const persisted = await openDesignModelContext({
				designSessionId: args.designSessionId,
				kind: "executor",
				modelId: MODEL_ROLES.buildExecutor.modelId,
				promptVersion: EXECUTOR_PROMPT_VERSION,
				toolsetDigest: canonicalJsonDigest(buildExecutorTools()),
				contextVersion: MODEL_CONTEXT_VERSION,
				semanticScopeKey,
				authority: modelContextAuthority,
			});
			/* Usage is read across the immutable generation chain and admitted by
			 * durable (context, step) identity. Reopening the same attempt or opening
			 * the next slice therefore cannot double-charge a paid response. */
			if (args.meter !== undefined) {
				for (const completed of recoverableCompletedModelSteps(
					persisted.completedSteps,
					args.runId,
				)) {
					meterDurableSubGenerationUsage(
						args.meter,
						{
							contextId: completed.contextId,
							stepKey: completed.stepKey,
						},
						completed.usage,
						{
							step: true,
							model: MODEL_ROLES.buildExecutor.modelId,
							phase: "build-executor",
						},
					);
				}
			}
			return {
				contextId: persisted.id,
				messages: [...persisted.messages],
				items: persisted.items.map((item) => ({ ...item })),
				appendKeys: new Set(persisted.appendKeys),
				completedStepKeys: new Set(persisted.completedStepKeys),
				append: async (appendKey, messages) => {
					await appendDesignModelContext({
						designSessionId: args.designSessionId,
						contextId: persisted.id,
						appendKey,
						messages,
						authority: modelContextAuthority,
					});
				},
				recordStep: async (stepKey, event) => {
					await recordDesignModelStepEvent({
						designSessionId: args.designSessionId,
						contextId: persisted.id,
						stepKey,
						event,
						authority: modelContextAuthority,
					});
				},
				completeStep: async (completion) => {
					await completeDesignModelStep({
						designSessionId: args.designSessionId,
						contextId: persisted.id,
						...completion,
						authority: modelContextAuthority,
					});
				},
			};
		};
		for (;;) {
			const ordered = orderSlicesForExecution(plan.envelope.payload);
			const committedSlices = await committedSliceIds(plan.id);
			let lastSeq = 1;
			for (const slice of ordered) {
				if (committedSlices.has(slice.id as string)) continue;
				const budget = budgetForSlice(slice);
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
						detail: { sliceId: slice.id },
					});
					return {
						kind: "failed",
						appId,
						errorType: "external-action-required",
						message:
							"A required external prerequisite is still outstanding. Complete it before continuing this build.",
						recoverable: true,
					};
				}
				let rebaseAttempts = await countSliceRebaseAttempts({
					designSessionId: args.designSessionId,
					buildPlanId: plan.id,
					sliceId: slice.id as string,
				});
				for (;;) {
					const isGenesis = appId === null;
					const { attempt } = await beginOrRecoverSliceAttempt({
						designSessionId: args.designSessionId,
						actorUserId: args.actorUserId,
						runId: args.runId,
						holderNonce: args.holderNonce,
						expectedProjectId: args.projectId,
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
						executorModel: MODEL_ROLES.buildExecutor.modelId,
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
					const executorContext = await openExecutorContext(attempt.id);
					args.writer.write({
						type: "data-build-slice-started",
						data: progressEnvelope(args.designSessionId, head, {
							sliceId: slice.id,
							sliceName: slice.name,
						}),
						transient: true,
					});
					if (
						head === null ||
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
						contract,
						plan: plan.envelope.payload,
						isGenesis,
						appId,
						budget,
						executorContext,
					});
					heartbeat();
					if (outcome.kind === "committed") {
						const receipt = outcome.receipt;
						if (isGenesis) {
							const materialization = receipt as AppMaterializationReceipt;
							appId = materialization.appId;
							lastSeq = 1;
							/* Genesis is a canonical slice commit too. Project it through
							 * the same progress vocabulary as every later slice before the
							 * strict activation receipt transfers the UI to app scope. */
							args.writer.write({
								type: "data-build-slice-committed",
								data: progressEnvelope(args.designSessionId, head, {
									sliceId: slice.id,
									sliceName: slice.name,
									seq: 1,
								}),
								transient: true,
							});
							args.writer.write({
								type: "data-app-materialized",
								data: materialization,
								transient: true,
							});
						} else {
							const sliceReceipt = receipt as CommittedSliceReceipt;
							lastSeq = sliceReceipt.seq;
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
						break;
					}
					if (
						outcome.kind === "rebase-conflict" ||
						outcome.kind === "read-set-stale"
					) {
						rebaseAttempts += 1;
						if (rebaseAttempts <= budget.maxRebaseAttempts) {
							await supersedeSliceAttempt({
								designSessionId: args.designSessionId,
								attemptId: attempt.id,
								failureCode: outcome.kind,
								actorUserId: args.actorUserId,
								runId: args.runId,
								holderNonce: args.holderNonce,
								expectedProjectId: args.projectId,
							});
							continue;
						}
						await markSliceAttempt({
							designSessionId: args.designSessionId,
							attemptId: attempt.id,
							to: "failed",
							failureCode:
								outcome.kind === "read-set-stale"
									? "external-read-change-budget-exhausted"
									: "rebase-budget-exhausted",
							actorUserId: args.actorUserId,
							runId: args.runId,
							holderNonce: args.holderNonce,
							expectedProjectId: args.projectId,
						});
						head = await appendFailure(args, head, {
							errorType:
								outcome.kind === "read-set-stale"
									? "external-read-change-budget-exhausted"
									: "rebase-budget-exhausted",
							recoverable: false,
							detail: { sliceId: slice.id, attemptId: attempt.id },
						});
						return {
							kind: "failed",
							appId,
							errorType:
								outcome.kind === "read-set-stale"
									? "external-read-change-budget-exhausted"
									: "rebase-budget-exhausted",
							message:
								"This workflow's underlying app or Project data kept changing, so Nova stopped before saving an unsafe revision. Everything already added is intact.",
							recoverable: false,
						};
					}
					if (outcome.kind === "architect-decision") {
						await markSliceAttempt({
							designSessionId: args.designSessionId,
							attemptId: attempt.id,
							to: "failed",
							failureCode: `architect-${outcome.decision.kind}`,
							actorUserId: args.actorUserId,
							runId: args.runId,
							holderNonce: args.holderNonce,
							expectedProjectId: args.projectId,
						});
						const errorType =
							outcome.decision.kind === "ask-user" ||
							outcome.decision.kind === "contract-revision"
								? "accepted-design-not-executable"
								: `architect-${outcome.decision.kind}`;
						head = await appendFailure(args, head, {
							errorType,
							recoverable: false,
							detail: {
								sliceId: slice.id,
								attemptId: attempt.id,
								decisionKind: outcome.decision.kind,
							},
						});
						return {
							kind: "failed",
							appId,
							errorType,
							message:
								"The accepted workflow could not be compiled without changing its frozen design. Nova stopped and recorded an internal build defect; it did not ask you to redesign or reduce scope.",
							recoverable: false,
						};
					}
					/* budget-exhausted / protocol-failure */
					await markSliceAttempt({
						designSessionId: args.designSessionId,
						attemptId: attempt.id,
						to: "failed",
						failureCode:
							outcome.kind === "budget-exhausted"
								? "budget-exhausted"
								: outcome.code,
						actorUserId: args.actorUserId,
						runId: args.runId,
						holderNonce: args.holderNonce,
						expectedProjectId: args.projectId,
					});
					head = await appendFailure(args, head, {
						errorType:
							outcome.kind === "budget-exhausted"
								? "execution-budget-exhausted"
								: outcome.code,
						recoverable: false,
						detail: {
							sliceId: slice.id,
							attemptId: attempt.id,
							...(outcome.kind === "budget-exhausted"
								? {
										modelStepsSpent: outcome.spent.modelSteps,
										modelStepsLimit: budget.maxModelSteps,
										mutationCallsSpent: outcome.spent.mutationCalls,
										mutationCallsLimit: budget.maxMutationCalls,
									}
								: { protocolCode: outcome.code }),
						},
					});
					return {
						kind: "failed",
						appId,
						errorType:
							outcome.kind === "budget-exhausted"
								? "execution-budget-exhausted"
								: outcome.code,
						message:
							outcome.kind === "budget-exhausted"
								? "This workflow needed more correction rounds than a build allows, so Nova stopped before saving it. Everything already added is intact."
								: outcome.message,
						recoverable: false,
					};
				}
			}

			/* ── Finished ───────────────────────────────────────────────── */
			if (appId === null) {
				throw new Error(
					"The build plan committed no materialization root, so no app exists.",
				);
			}
			try {
				const existingLocalizationReceipt = await readLocalizationReceipt(
					plan.id,
				);
				const hasLocalizationFinalizer =
					initialBuildHasLocalizationFinalizer(contract);
				if (existingLocalizationReceipt !== null && !hasLocalizationFinalizer) {
					refuseBuildCompletion(
						"Build completion refused: this accepted contract has no localization finalizer but its plan carries a localization receipt.",
					);
				}
				const source = await assertAuthoritativePlanSource({
					appId,
					actorUserId: args.actorUserId,
					designSessionId: args.designSessionId,
					revision,
					plan,
					localizationReceipt: existingLocalizationReceipt,
				});
				lastSeq = source.sourceSeq;
				let localizationReceipt = existingLocalizationReceipt;
				if (hasLocalizationFinalizer) {
					if (head?.state.kind !== "translating") {
						head = await appendOrchestrationEvent({
							designSessionId: args.designSessionId,
							runId: args.runId,
							holderNonce: args.holderNonce,
							actorUserId: args.actorUserId,
							expectedProjectId: args.projectId,
							state: {
								kind: "translating",
								designRevisionId: revision.id,
								buildPlanId: plan.id,
								appId,
								sourceSeq: source.sourceSeq,
							},
							expectedHead: head,
						});
					}
					localizationReceipt = await deps.finalizeLocalization({
						lineage: {
							designSessionId: args.designSessionId,
							designRevisionId: revision.id,
							designRevisionDigest: revision.artifactDigest,
							buildPlanId: plan.id,
							buildPlanDigest: plan.artifactDigest,
							appId,
						},
						authority: {
							actorUserId: args.actorUserId,
							projectId: args.projectId,
							runId: args.runId,
							holderNonce: args.holderNonce,
						},
						contract,
						sourceBlueprint: source.blueprint,
						sourceSeq: source.sourceSeq,
						meter: args.meter,
						signal: args.signal,
						onLanguage: (language) => {
							if (head === null) return;
							args.writer.write({
								type: "data-build-localization-progress",
								data: progressEnvelope(args.designSessionId, head, {
									languageCode: language.code,
									languageName: language.name,
									batch: language.batch,
									batchCount: language.batchCount,
								}),
								transient: true,
							});
						},
					});
					if (localizationReceipt === null) {
						throw new Error(
							"The accepted localization intent completed without a receipt.",
						);
					}
					lastSeq = localizationReceipt.seq;
				}
				lastSeq = await assertAuthoritativePlanCompletion({
					appId,
					actorUserId: args.actorUserId,
					designSessionId: args.designSessionId,
					revision,
					plan,
					localizationReceipt,
				});
			} catch (error) {
				if (error instanceof LocalizationBuildError) {
					/* The exact failed protocol row remains terminal, so an unchanged
					 * retry cannot purchase another random sample. Keep the enclosing
					 * build resumable so a deployed model/prompt/schema generation can
					 * append its permitted replacement and finish the frozen app. */
					head = await appendFailure(args, head, {
						errorType: error.code,
						recoverable: true,
					});
					return {
						kind: "failed",
						appId,
						errorType: error.code,
						message: error.message,
						recoverable: true,
					};
				}
				if (!(error instanceof BuildCompletionVerificationError)) throw error;
				log.error("design_build_final_verification_failed", error, {
					designSessionId: args.designSessionId,
					buildPlanId: plan.id,
				});
				head = await appendFailure(args, head, {
					errorType: "final-verification-failed",
					recoverable: false,
				});
				return {
					kind: "failed",
					appId,
					errorType: "final-verification-failed",
					message:
						"Every workflow must commit and the final app must validate and compile before Nova can mark this build complete.",
					recoverable: false,
				};
			}
			/* The route owns schema convergence and the lifecycle/credit tail. Its
			 * final database decision keeps the exact holder live until the status,
			 * charge, and durable terminal event commit together. */
			const finalized = await args.finalizeCompletion({
				appId,
				expectedSeq: lastSeq,
				expectedHead: head,
			});
			head = finalized.head;
			args.writer.write({
				type: "data-build-completion",
				data: progressEnvelope(args.designSessionId, head, {
					appId,
					appSeq: lastSeq,
					plannedSlices: ordered.length,
				}),
				transient: true,
			});
			return {
				kind: "completed",
				appId,
				finalSeq: lastSeq,
				finalBlueprint: finalized.blueprint,
			};
		}
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
	const executorContext = new DesignGenerationContext({
		apiKey: args.apiKey,
		userId: args.actorUserId,
		projectId: args.projectId,
		runId: args.runId,
		designSessionId: args.designSessionId,
		...(args.meter !== undefined && { meter: args.meter }),
		usagePhase: "build-executor",
	});
	const translationContext = new DesignGenerationContext({
		apiKey: args.apiKey,
		userId: args.actorUserId,
		projectId: args.projectId,
		runId: args.runId,
		designSessionId: args.designSessionId,
	});
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
		...(overrides.onDesignToolOutcome !== undefined && {
			onDesignToolOutcome: overrides.onDesignToolOutcome,
		}),
		...(overrides.onExecutorToolOutcome !== undefined && {
			onExecutorToolOutcome: overrides.onExecutorToolOutcome,
		}),
		...(overrides.onRecoverableRetry !== undefined && {
			onRecoverableRetry: overrides.onRecoverableRetry,
		}),
		executorStep:
			overrides.executorStep ??
			productionExecutorStep(
				executorContext.model(MODEL_ROLES.buildExecutor.modelId),
				MODEL_ROLES.buildExecutor.reasoningEffort,
				`nova:design-executor:${args.designSessionId}`,
			),
		resolveBlocker:
			overrides.resolveBlocker ??
			(async (blockerArgs) => {
				const result = await resolveExecutionBlocker(
					executorContext,
					blockerArgs,
					blockerArgs.signal,
				);
				if (result.kind !== "produced") {
					throw new Error(
						`The architect did not produce a blocker decision (${result.reason}).`,
					);
				}
				if (result.reasoningText) {
					overrides.onReasoningSummary?.(result.reasoningText);
				}
				return result.artifact;
			}),
		materialize: overrides.materialize ?? materializeAppFromGenesis,
		commitSlice: overrides.commitSlice ?? commitDesignChangeSet,
		finalizeLocalization:
			overrides.finalizeLocalization ??
			((localizationArgs) =>
				finalizeInitialBuildLocalization(
					localizationArgs,
					productionInitialBuildLocalizationDeps(translationContext),
				)),
	};
}

async function appendFailure(
	args: RunBuildOrchestrationArgs,
	head: OrchestrationHead | null,
	failure: {
		errorType: string;
		recoverable: boolean;
		/** Machine context for the operational log line: opaque ids, stable
		 * codes, and aggregate counters only — never customer-authored text. */
		detail?: Record<string, string | number | boolean>;
	},
): Promise<OrchestrationHead> {
	/* Every terminal build failure passes through here, so this is the one
	 * line that must account for the failure without a database visit: the
	 * stable errorType plus the ids and counters that explain it. Recoverable
	 * failures are expected external states (a prerequisite the person still
	 * owes), so they log as warn and stay out of Sentry. */
	const cause = {
		designSessionId: args.designSessionId,
		runId: args.runId,
		errorType: failure.errorType,
		recoverable: failure.recoverable,
		...failure.detail,
	};
	if (failure.recoverable) log.warn("design_build_failed", cause);
	else log.error("design_build_failed", undefined, cause);
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

interface CompletionLineageArgs {
	readonly appId: string;
	readonly actorUserId: string;
	readonly designSessionId: string;
	readonly revision: DesignRevisionRecord;
	readonly plan: DesignBuildPlanRecord;
}

async function assertAuthoritativeCommittedSlices(
	args: CompletionLineageArgs,
): Promise<CommittedSliceReceipt> {
	const expectedSlices = orderSlicesForExecution(args.plan.envelope.payload);
	const receipts = await readCommittedSliceReceiptsForPlan(args.plan.id);
	assertExactCommittedSliceReceipts({
		expectedSlices,
		receipts,
		lineage: {
			designSessionId: args.designSessionId,
			designRevisionId: args.revision.id,
			designRevisionDigest: args.revision.artifactDigest,
			buildPlanId: args.plan.id,
			buildPlanDigest: args.plan.artifactDigest,
			appId: args.appId,
		},
	});

	const db = await getAppDb();
	const attempts = await db
		.selectFrom("design_slice_attempts")
		.select(["id", "slice_id", "change_set_id", "status"])
		.where("design_session_id", "=", args.designSessionId)
		.where("build_plan_id", "=", args.plan.id)
		.execute();
	for (const receipt of receipts) {
		const attempt = attempts.find(
			(candidate) => candidate.id === receipt.attemptId,
		);
		if (
			attempt?.status !== "committed" ||
			attempt.slice_id !== receipt.sliceId ||
			attempt.change_set_id !== receipt.changeSetId
		) {
			refuseBuildCompletion(
				`Build completion refused: slice ${receipt.sliceId} has no matching committed execution attempt.`,
			);
		}
	}
	const finalReceipt = receipts.at(-1);
	if (finalReceipt === undefined) {
		refuseBuildCompletion(
			"Build completion refused: the accepted plan has no final committed slice receipt.",
		);
	}
	return finalReceipt;
}

function assertLocalizationReceiptFollowsSlices(
	args: CompletionLineageArgs,
	sliceReceipt: CommittedSliceReceipt,
	localizationReceipt: DesignLocalizationReceipt,
): void {
	if (
		localizationReceipt.designSessionId !== args.designSessionId ||
		localizationReceipt.designRevisionId !== args.revision.id ||
		localizationReceipt.designRevisionDigest !== args.revision.artifactDigest ||
		localizationReceipt.buildPlanId !== args.plan.id ||
		localizationReceipt.buildPlanDigest !== args.plan.artifactDigest ||
		localizationReceipt.appId !== args.appId ||
		localizationReceipt.sourceSeq !== sliceReceipt.seq ||
		localizationReceipt.sourceSnapshotDigest !==
			sliceReceipt.committedSnapshotDigest
	) {
		refuseBuildCompletion(
			"Build completion refused: the localization receipt does not descend from the final planned slice under the same accepted lineage.",
		);
	}
}

async function assertAuthoritativePlanSource(
	args: CompletionLineageArgs & {
		readonly localizationReceipt: DesignLocalizationReceipt | null;
	},
): Promise<{ readonly sourceSeq: number; readonly blueprint: PersistableDoc }> {
	const finalReceipt = await assertAuthoritativeCommittedSlices(args);
	const access = await resolveAuthorizedAppSnapshot(
		args.appId,
		args.actorUserId,
		"view",
	);
	if (args.localizationReceipt !== null) {
		assertLocalizationReceiptFollowsSlices(
			args,
			finalReceipt,
			args.localizationReceipt,
		);
		return { sourceSeq: finalReceipt.seq, blueprint: access.app.blueprint };
	}
	if (
		finalReceipt.seq !== access.baseSeq ||
		finalReceipt.committedSnapshotDigest !==
			canonicalJsonDigest(access.app.blueprint)
	) {
		refuseBuildCompletion(
			"Build completion refused: the canonical app head no longer matches the final planned slice receipt.",
		);
	}
	return { sourceSeq: finalReceipt.seq, blueprint: access.app.blueprint };
}

async function assertAuthoritativePlanCompletion(
	args: CompletionLineageArgs & {
		readonly localizationReceipt: DesignLocalizationReceipt | null;
	},
): Promise<number> {
	const finalReceipt = await assertAuthoritativeCommittedSlices(args);

	const access = await resolveAuthorizedAppSnapshot(
		args.appId,
		args.actorUserId,
		"view",
	);
	if (args.localizationReceipt !== null) {
		assertLocalizationReceiptFollowsSlices(
			args,
			finalReceipt,
			args.localizationReceipt,
		);
	}
	const authoritativeReceipt = args.localizationReceipt ?? finalReceipt;
	if (
		authoritativeReceipt.seq !== access.baseSeq ||
		authoritativeReceipt.committedSnapshotDigest !==
			canonicalJsonDigest(access.app.blueprint)
	) {
		refuseBuildCompletion(
			"Build completion refused: the canonical app head no longer matches the final planned slice receipt.",
		);
	}
	const boundary = await prepareExportBoundary({
		mode: "ccz",
		access: {
			projectId: access.projectId,
			role: access.role,
			actorUserId: access.actorUserId,
		},
		doc: hydratePersistedBlueprint(access.app.blueprint),
		compiledAtSeq: access.baseSeq,
	});
	if (!boundary.ok) {
		refuseBuildCompletion(
			`Build completion refused: final export validation reported ${boundary.violations.length} finding(s).`,
		);
	}
	const { doc, assets, compiledAtSeq, lookupWire } = boundary.prepared;
	try {
		const hqJson = expandDoc(doc, {
			assets,
			...(lookupWire && { lookupNaming: lookupWire.naming }),
		});
		compileCcz(hqJson, doc.appName, doc, {
			assets,
			compiledAtSeq,
			...(lookupWire && { lookup: lookupWire }),
		});
	} catch (error) {
		throw new BuildCompletionVerificationError(
			`Build completion refused: final wire compilation failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		);
	}
	return access.baseSeq;
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
					attemptAuthority: {
						holderNonce: args.holderNonce,
						expectedProjectId: args.projectId,
					},
				})
			: await beginAppEditChangeSet({
					appId:
						attempt.baseTarget.kind === "app" ? attempt.baseTarget.appId : "",
					expectedProjectId: args.projectId,
					lineage,
					ownerUserId: args.actorUserId,
					ownerRunId: args.runId,
					attemptAuthority: {
						holderNonce: args.holderNonce,
						expectedProjectId: args.projectId,
					},
				});
		await bindSliceAttemptChangeSet({
			designSessionId: args.designSessionId,
			attemptId: attempt.id,
			changeSetId: changeSet.id,
			actorUserId: args.actorUserId,
			runId: args.runId,
			holderNonce: args.holderNonce,
			expectedProjectId: args.projectId,
		});
		return changeSet.id;
	} catch (error) {
		/* The one-open-set-per-attempt fence names a reopenable set: recover
		 * it by attempt id. */
		const db = await getAppDb();
		const openRow = await db
			.selectFrom("design_change_sets")
			.select(["id"])
			.where("attempt_id", "=", attempt.id)
			.where("status", "=", "open")
			.executeTakeFirst();
		const open =
			openRow === undefined ? undefined : await loadChangeSet(openRow.id, db);
		if (
			open !== undefined &&
			open.designSessionId === lineage.designSessionId &&
			open.designRevisionId === lineage.designRevisionId &&
			open.designRevisionDigest === lineage.designRevisionDigest &&
			open.buildPlanId === lineage.buildPlanId &&
			open.buildPlanDigest === lineage.buildPlanDigest &&
			open.sliceId === lineage.sliceId &&
			open.attemptId === lineage.attemptId &&
			open.ownerUserId === args.actorUserId &&
			open.ownerRunId === args.runId &&
			open.baseProjectId === args.projectId &&
			(isGenesis
				? open.kind === "genesis" &&
					open.proposedAppId === args.proposedAppId &&
					open.baseSnapshotDigest ===
						emptyGenesisBase(args.proposedAppId).digest
				: open.kind === "app-edit" &&
					attempt.baseTarget.kind === "app" &&
					open.appId === attempt.baseTarget.appId &&
					open.baseSeq === attempt.baseTarget.seq &&
					open.baseSnapshotDigest === attempt.baseTarget.digest)
		) {
			await bindSliceAttemptChangeSet({
				designSessionId: args.designSessionId,
				attemptId: attempt.id,
				changeSetId: open.id,
				actorUserId: args.actorUserId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				expectedProjectId: args.projectId,
			});
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
		contract: AppDesignContract;
		plan: BuildPlan;
		isGenesis: boolean;
		appId: string | null;
		budget: ReturnType<typeof budgetForSlice>;
		executorContext: ExecutorConversationContext;
	},
): Promise<SliceExecutionOutcome> {
	const lookupScope = {
		projectId: args.projectId,
		actorId: args.actorUserId,
		role: args.projectRole,
	};
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
		lookupDefinitions: (tableIds) =>
			readToolLookupDefinitions(lookupScope, tableIds),
		lookupCatalog: () => readToolLookupCatalog(lookupScope),
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
			deadlineAt,
		});
		return outcome;
	};
	const attemptAuthority = {
		designSessionId: args.designSessionId,
		attemptId: slice.attempt.id,
		actorUserId: args.actorUserId,
		runId: args.runId,
		holderNonce: args.holderNonce,
		expectedProjectId: args.projectId,
	};
	await beginSliceAttemptOutcomeCollection(attemptAuthority);
	let outcomePersistenceFailed = false;
	try {
		return await runSliceExecutor({
			workspace,
			brief: slice.brief,
			budget: slice.budget,
			context: slice.executorContext,
			contextScopeKey: slice.attempt.id,
			step: deps.executorStep,
			resolveBlocker: (blockerArgs) =>
				deps.resolveBlocker({
					...blockerArgs,
					acceptedContract: slice.contract,
					currentPlan: slice.plan,
				}),
			commit,
			reconcileCommit: async () => {
				if (slice.isGenesis) {
					const receipt = await readMaterializedGenesisReceipt({
						changeSetId: slice.changeSetId,
						actorUserId: args.actorUserId,
					});
					return receipt === null ? null : { kind: "committed", receipt };
				}
				const receipt = await readCommittedSliceReceipt(slice.changeSetId);
				return receipt === null ? null : { kind: "committed", receipt };
			},
			budgetLedger: {
				/* The wall-clock budget grants what the attempt has not actively
				 * spent — never elapsed time since the original start. A
				 * process-death recovery can only run after the build liveness
				 * horizon lapses, so an absolute deadline would arrive already
				 * burned and fail every recovered attempt unexecuted. */
				deadlineAt:
					Date.now() +
					remainingWallClockMs(
						slice.budget,
						slice.attempt.wallClockMsUsed,
						slice.attempt.budgetSpent.blockerReports,
					),
				spent: slice.attempt.budgetSpent,
				claim: (counter, limit, claimKey) =>
					claimSliceAttemptBudget({
						designSessionId: args.designSessionId,
						attemptId: slice.attempt.id,
						counter,
						limit,
						claimKey,
						actorUserId: args.actorUserId,
						runId: args.runId,
						holderNonce: args.holderNonce,
						expectedProjectId: args.projectId,
					}),
			},
			signal: args.signal,
			...(args.meter !== undefined && {
				onUsage: (usage, identity) =>
					meterDurableSubGenerationUsage(
						args.meter as SubGenerationUsageMeter,
						identity,
						usage,
						{
							step: true,
							model: MODEL_ROLES.buildExecutor.modelId,
							phase: "build-executor",
						},
					),
			}),
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
			onToolCall: (call) => {
				log.info("[buildExecutor] model tool", {
					designSessionId: args.designSessionId,
					sliceId: slice.slice.id,
					...call,
				});
			},
			onToolOutcome: async (event) => {
				if (
					event.outcome === "wire-invalid" ||
					event.outcome === "mutation-rejected" ||
					event.outcome === "validator-repair"
				) {
					try {
						await recordSliceAttemptDiagnostic({
							...attemptAuthority,
							outcome: event.outcome,
						});
					} catch (error) {
						outcomePersistenceFailed = true;
						throw error;
					}
				}
				log.info("[buildExecutor] tool outcome", {
					designSessionId: args.designSessionId,
					sliceId: slice.slice.id,
					...event,
				});
				await deps.onExecutorToolOutcome?.(event);
			},
		});
	} finally {
		if (!outcomePersistenceFailed) {
			await finishSliceAttemptOutcomeCollection(attemptAuthority);
		}
	}
}
