import "server-only";
import { randomUUID } from "node:crypto";
import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";
import { AgentRunContext } from "@/lib/agent/agentRunContext";
import {
	AuthoringInputError,
	ReadProjectionError,
} from "@/lib/agent/authoring/errors";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { ChangeSetStagingRejectedError } from "@/lib/agent/change-set/errors";
import { classifyError } from "@/lib/agent/errorClassifier";
import type { AgentStep } from "@/lib/agent/generationContext";
import { durableModelValueDigest } from "@/lib/agent/modelMessagePersistence";
import type { SubGenerationUsageMeter } from "@/lib/agent/modelRunContext";
import {
	type AgentModelStep,
	type AgentModelStepFn,
	productionModelStep,
} from "@/lib/agent/modelStep";
import { PlanConflictError } from "@/lib/agent/planning/plan";
import {
	activePlanReview,
	beginPlanReview,
	finishPlanReview,
	latestPlanReview,
	type PlanWriter,
	readAppPlan,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import {
	buildArchitectPeerPrompt,
	buildArchitectPrompt,
} from "@/lib/agent/prompts";
import {
	loadSourceMaterial,
	readSource,
	type SourceMaterialDeps,
	SourceMaterialError,
	sourceAttachmentsMessage,
} from "@/lib/agent/sources";
import { productionSourceMaterialDeps } from "@/lib/agent/sources.server";
import { askQuestionsInputSchema } from "@/lib/agent/tools/askQuestions";
import { translateLanguage } from "@/lib/agent/translation/translateLanguage";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import { loadApp, refreshBuildLiveness, setAwaitingInput } from "@/lib/db/apps";
import {
	loadDesignSession,
	refreshDesignSessionLiveness,
	setDesignSessionAwaitingInput,
} from "@/lib/db/designSessions";
import { withAppTx } from "@/lib/db/pg";
import type { PersistableDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import { MODEL_CONTEXT_VERSION, MODEL_ROLES } from "@/lib/models";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	ARCHITECT_MAX_STEPS,
	type ArchitectToolCall,
	describeModelTools,
	PEER_MAX_STEPS,
	runArchitectLoop,
} from "./architectLoop";
import { AuthoringSession } from "./authoringSession";
import {
	architectToolDefinitions,
	editPlanInputSchema,
	reviewInputSchema,
	translateLanguageInputSchema,
	writePlanInputSchema,
} from "./authoringTools";
import {
	appendOrchestrationEvent,
	type BuildOrchestratorState,
	type OrchestrationHead,
	readOrchestrationHead,
} from "./orchestratorState";
import { authoringStage } from "./progress";

export interface OrchestratorStreamWriter {
	write(
		chunk:
			| UIMessageChunk
			| { type: string; data: unknown; transient?: boolean },
	): void;
}
export type BuildOrchestrationOutcome =
	| {
			kind: "completed";
			appId: string;
			finalSeq: number;
			finalBlueprint: PersistableDoc;
	  }
	| { kind: "awaiting-input"; pauseOwned: boolean }
	| {
			kind: "failed";
			errorType: string;
			message: string;
			recoverable: boolean;
			appId: string | null;
	  };
export interface BuildOrchestrationDeps {
	readonly modelStep: AgentModelStepFn;
	readonly peerStep: AgentModelStepFn;
	readonly translationStep: AgentModelStepFn;
	readonly sourceDeps: SourceMaterialDeps;
	readonly onToolResult?: (
		role: "architect" | "peer" | "translator",
		call: ArchitectToolCall,
		output: unknown,
	) => void;
	readonly onAgentStep?: (
		step: AgentStep,
		role: "architect" | "peer" | "translator",
	) => void | Promise<void>;
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
	readonly materializedAppId: string | null;
	readonly deps?: Partial<BuildOrchestrationDeps>;
	readonly finalizeCompletion: (args: {
		appId: string;
		expectedSeq: number;
		expectedHead: OrchestrationHead | null;
	}) => Promise<{ blueprint: PersistableDoc; head: OrchestrationHead }>;
}

/** The architect carries the conversation from the request through the saved
 * app. The peer temporarily edits the same plan. Code owns durable effects. */
export async function runBuildOrchestration(
	args: RunBuildOrchestrationArgs,
): Promise<BuildOrchestrationOutcome> {
	const authority = {
		sessionId: args.designSessionId,
		actorUserId: args.actorUserId,
		projectId: args.projectId,
		runId: args.runId,
		holderNonce: args.holderNonce,
	};
	const context = new AgentRunContext({
		apiKey: args.apiKey,
		userId: args.actorUserId,
		projectId: args.projectId,
		runId: args.runId,
		designSessionId: args.designSessionId,
		meter: args.meter,
	});
	const runtime = new AuthoringSession(
		authority,
		args.proposedAppId,
		(receipt) => {
			args.writer.write({
				type: "data-app-materialized",
				data: receipt,
				transient: true,
			});
		},
	);
	let head: OrchestrationHead | null = null;
	let heartbeatTask: Promise<void> | undefined;
	const heartbeatTimer = setInterval(() => {
		if (heartbeatTask) return;
		heartbeatTask = (
			runtime.appId
				? refreshBuildLiveness(runtime.appId, args.runId, args.holderNonce)
				: refreshDesignSessionLiveness(
						args.designSessionId,
						args.runId,
						args.holderNonce,
					)
		)
			.catch((error: unknown) => {
				log.warn("authoring_liveness_failed", {
					runId: args.runId,
					errorType: error instanceof Error ? error.name : "unknown",
				});
			})
			.finally(() => {
				heartbeatTask = undefined;
			});
	}, 60_000);
	heartbeatTimer.unref();
	const emitState = async (state: BuildOrchestratorState) => {
		if (head && canonicalJsonDigest(head.state) === canonicalJsonDigest(state))
			return;
		head = await appendOrchestrationEvent({
			designSessionId: args.designSessionId,
			runId: args.runId,
			holderNonce: args.holderNonce,
			actorUserId: args.actorUserId,
			expectedProjectId: args.projectId,
			expectedHead: head,
			state,
		});
		args.writer.write({
			type: "data-authoring-progress",
			data: {
				sessionId: args.designSessionId,
				revision: head.revision,
				stage: authoringStage(state),
			},
			transient: true,
		});
	};
	const emitPlan = async () => {
		const plan = await readAppPlan(authority);
		if (plan)
			args.writer.write({
				type: "data-authoring-plan",
				data: {
					sessionId: args.designSessionId,
					plan: {
						revision: plan.revision,
						markdown: plan.markdown,
						reviewedRevision: plan.reviewedRevision,
					},
				},
				transient: true,
			});
	};
	const emitText = (id: string, text: string) => {
		if (!text.trim()) return;
		args.writer.write({ type: "text-start", id });
		args.writer.write({ type: "text-delta", id, delta: text });
		args.writer.write({ type: "text-end", id });
	};
	try {
		args.signal.throwIfAborted();
		head = await readOrchestrationHead(args.designSessionId);
		if (head?.state.kind === "finished") {
			const finished = head.state;
			const saved = await withAppTx(async (tx) => {
				const scope = await resolveAppScopeInTransaction(
					tx,
					finished.appId,
					args.actorUserId,
				);
				if (scope.projectId !== args.projectId)
					throw new PlanConflictError("The app has moved to another Project.");
				return loadCanonicalBlueprintAtSequence(tx, {
					appId: finished.appId,
					seq: finished.appSeq,
					expectedDigest: null,
				});
			});
			return {
				kind: "completed",
				appId: head.state.appId,
				finalSeq: head.state.appSeq,
				finalBlueprint: saved.snapshot,
			};
		}
		await runtime.initialize();
		await emitPlan();
		args.writer.write({
			type: "start",
			messageId: args.responseMessageId,
			messageMetadata: {
				model: MODEL_ROLES.architect.modelId,
				contextVersion: MODEL_CONTEXT_VERSION,
			},
		});
		const sourceDeps =
			args.deps?.sourceDeps ??
			productionSourceMaterialDeps({
				extractDocumentStructured: async (options) => {
					const result = await context.runStructured({
						...options,
						prompt: options.prompt ?? options.instruction,
						modelId: MODEL_ROLES.documentExtractor.modelId,
						maxOutputTokens: options.maxOutputTokens ?? 128_000,
						signal: args.signal,
					});
					return {
						object: result.object,
						truncated: result.finishReason === "length",
					};
				},
			});
		const source = await loadSourceMaterial({
			projectId: args.projectId,
			messages: args.messages as NovaUIMessage[],
			deps: sourceDeps,
		});
		const attachmentMessage = sourceAttachmentsMessage(source);
		const sourceMessages = [
			...source.requests,
			...(attachmentMessage
				? [
						{
							key: `attachments:${durableModelValueDigest(attachmentMessage)}`,
							message: attachmentMessage,
						},
					]
				: []),
		];
		const turnId = source.requests.at(-1)?.key ?? args.responseMessageId;
		const roleConfig = {
			architect: MODEL_ROLES.architect,
			peer: MODEL_ROLES.peer,
			translator: MODEL_ROLES.translator,
		};
		const modelSteps = {
			translator:
				args.deps?.translationStep ??
				productionModelStep(
					context.model(roleConfig.translator.modelId),
					roleConfig.translator.reasoningEffort,
					`nova:translator:${args.designSessionId}`,
				),
			architect:
				args.deps?.modelStep ??
				productionModelStep(
					context.model(roleConfig.architect.modelId),
					roleConfig.architect.reasoningEffort,
					`nova:architect:${args.designSessionId}`,
				),
			peer:
				args.deps?.peerStep ??
				productionModelStep(
					context.model(roleConfig.peer.modelId),
					roleConfig.peer.reasoningEffort,
					`nova:peer:${args.designSessionId}`,
				),
		};
		const phaseFor = (role: "architect" | "peer" | "translator") =>
			role === "architect"
				? "design-author"
				: role === "peer"
					? "design-review"
					: "translation";
		const commonLoop = (role: "architect" | "peer" | "translator") => ({
			signal: args.signal,
			modelStep: modelSteps[role],
			maxSteps: role === "architect" ? ARCHITECT_MAX_STEPS : PEER_MAX_STEPS,
			onReasoning: (
				part: Parameters<
					NonNullable<Parameters<AgentModelStepFn>[0]["onReasoning"]>
				>[0],
				identity: { contextId: string; stepKey: string },
			) => {
				if (role !== "architect") return;
				const id = `${identity.contextId}:${identity.stepKey}:${part.id}`;
				if (part.type === "reasoning-delta")
					args.writer.write({ type: part.type, id, delta: part.text ?? "" });
				else if (part.type === "reasoning-start")
					args.writer.write({ type: "reasoning-start", id });
				else args.writer.write({ type: "reasoning-end", id });
			},
			onToolResult: (call: ArchitectToolCall, output: unknown) =>
				args.deps?.onToolResult?.(role, call, output),
			onStep: async (
				step: AgentModelStep,
				identity: { contextId: string; stepKey: string },
			) => {
				context.trackDurableSubGeneration(
					step.usage,
					identity,
					roleConfig[role].modelId,
					{
						step: true,
						phase: phaseFor(role),
					},
				);
				await args.deps?.onAgentStep?.(
					{
						...step,
						toolCalls: [...step.toolCalls],
						durableUsageIdentity: identity,
					},
					role,
				);
				if (role === "architect" && step.toolCalls.length > 0 && step.text)
					emitText(`${identity.contextId}:${identity.stepKey}:text`, step.text);
			},
			onRecoveredUsage: (
				usage: Parameters<AgentRunContext["trackDurableSubGeneration"]>[0],
				identity: { contextId: string; stepKey: string },
			) => {
				context.trackDurableSubGeneration(
					usage,
					identity,
					roleConfig[role].modelId,
					{
						step: true,
						phase: phaseFor(role),
					},
				);
			},
		});
		const spec = async (
			role: "architect" | "peer",
			contextVersion: string,
			system: string,
		) => ({
			designSessionId: args.designSessionId,
			kind: role,
			modelId: roleConfig[role].modelId,
			promptVersion: canonicalJsonDigest(system),
			contextVersion,
			toolsetDigest: canonicalJsonDigest(
				await describeModelTools(
					architectToolDefinitions({
						role,
						building: runtime.building,
						hasApp: runtime.appId !== null,
					}),
				),
			),
			authority: {
				actorUserId: args.actorUserId,
				runId: args.runId,
				holderNonce: args.holderNonce,
				expectedProjectId: args.projectId,
			},
		});
		const planTool = async (call: ArchitectToolCall, writer: PlanWriter) => {
			if (call.toolName === "readPlan") {
				const plan = await readAppPlan(authority);
				return {
					revision: plan?.revision ?? 0,
					markdown: plan?.markdown ?? null,
				};
			}
			const change =
				call.toolName === "writePlan"
					? writePlanInputSchema.parse(call.input)
					: editPlanInputSchema.parse(call.input);
			const plan = await writeAppPlan({
				authority,
				writer,
				requestId: call.toolCallId,
				change,
			});
			await emitPlan();
			return { revision: plan.revision };
		};
		const question = (call: ArchitectToolCall) => {
			const input = askQuestionsInputSchema.parse(call.input);
			for (const message of args.messages)
				for (const part of message.parts) {
					if (
						part.type !== "tool-askQuestions" ||
						part.toolCallId !== call.toolCallId
					)
						continue;
					if (part.state === "output-available") {
						if (canonicalJsonDigest(part.input) !== canonicalJsonDigest(input))
							throw new PlanConflictError(
								"The answered question card no longer matches this question.",
							);
						const answers = z.record(z.string(), z.string()).parse(part.output);
						if (
							input.questions.some(
								(_, index) => !answers[String(index)]?.trim(),
							)
						)
							throw new PlanConflictError(
								"The question card is missing an answer.",
							);
						return { kind: "result" as const, output: answers };
					}
				}
			args.writer.write({
				type: "tool-input-available",
				toolCallId: call.toolCallId,
				toolName: "askQuestions",
				input,
			});
			return { kind: "awaiting-input" as const };
		};
		const recoverableToolError = (error: unknown) => {
			if (error instanceof z.ZodError)
				return {
					error: error.issues
						.map(
							(issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
						)
						.join("; "),
				};
			if (
				error instanceof PlanConflictError ||
				error instanceof AuthoringInputError ||
				// Recorded at the read boundary; the architect hears the true cause.
				error instanceof ReadProjectionError ||
				error instanceof SourceMaterialError ||
				error instanceof ChangeSetStagingRejectedError
			)
				return { error: error.message };
			throw error;
		};
		const peerReview = async (
			requestId: string,
			app: boolean,
			focus?: string,
		) => {
			const active = await activePlanReview(authority);
			if (
				app &&
				!active &&
				(!runtime.appId || (await runtime.hasUnsavedWork()))
			)
				throw new PlanConflictError(
					"Save the app changes before asking for an app review.",
				);
			const current = await runtime.snapshot(true);
			const review = await beginPlanReview(authority, requestId, {
				sourceDigest: source.digest,
				appSeq: app ? current.canonicalSeq : null,
				focus,
			});
			if (review.complete)
				return {
					revision: review.review.completed_revision,
					plan: review.plan.markdown,
					review: review.review.summary,
				};
			await emitState(
				app && current.canonicalSeq !== null
					? {
							kind: "reviewing-app",
							reviewId: review.reviewId,
							appSeq: current.canonicalSeq,
						}
					: { kind: "reviewing-plan", reviewId: review.reviewId },
			);
			const system = buildArchitectPeerPrompt();
			const peer = await runArchitectLoop({
				...commonLoop("peer"),
				spec: await spec("peer", review.reviewId, system),
				system,
				turnId: review.reviewId,
				additions: [
					...sourceMessages,
					{
						key: `review-context:${review.reviewId}`,
						message: {
							role: "user",
							content: JSON.stringify({
								reviewId: review.reviewId,
								planRevision: review.plan.revision,
								appRevision: current.canonicalSeq,
								sourceDigest: source.digest,
								plan: review.plan.markdown,
								app: await runtime.overview(true),
								focus: review.review.focus,
							}),
						},
					},
				],
				tools: () =>
					architectToolDefinitions({
						role: "peer",
						building: false,
						hasApp: runtime.appId !== null,
					}),
				dispatch: async (call) => {
					await runtime.authorize();
					let output: unknown;
					try {
						if (["readPlan", "writePlan", "editPlan"].includes(call.toolName))
							output = await planTool(call, {
								editor: "peer",
								reviewId: review.reviewId,
							});
						else if (call.toolName === "readSource")
							output = readSource(source, call.input);
						else if (call.toolName === "getApp")
							output = await runtime.overview(true);
						else output = await runtime.shared(call, "peer");
					} catch (error) {
						output = recoverableToolError(error);
					}
					return { kind: "result", output };
				},
				onFinish: async () => ({ kind: "complete" }),
			});
			const plan = await finishPlanReview(authority, review.reviewId, {
				contextId: peer.contextId,
				summary: peer.text,
			});
			await emitPlan();
			await emitState(
				runtime.building
					? { kind: "building", appId: runtime.appId }
					: { kind: "planning", sourceDigest: source.digest },
			);
			return {
				revision: plan.revision,
				plan: plan.markdown,
				review: peer.text,
			};
		};
		// An interrupted peer still owns the plan. Resume that conversation
		// before the lead tries to reopen its private workspace.
		const activeReview = await activePlanReview(authority);
		if (activeReview)
			await peerReview(activeReview.request_id, activeReview.app_seq !== null);
		const dispatch = async (call: ArchitectToolCall) => {
			await runtime.authorize();
			if (call.toolName === "askQuestions") return question(call);
			args.writer.write({
				type: "tool-input-available",
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				input: call.input,
			});
			let output: unknown;
			try {
				if (["readPlan", "writePlan", "editPlan"].includes(call.toolName))
					output = await planTool(call, { editor: "architect" });
				else if (call.toolName === "readSource")
					output = readSource(source, call.input);
				else if (call.toolName === "getApp") output = await runtime.overview();
				else if (
					call.toolName === "reviewPlan" ||
					call.toolName === "reviewApp"
				)
					output = await peerReview(
						call.toolCallId,
						call.toolName === "reviewApp",
						reviewInputSchema.parse(call.input).focus,
					);
				else if (call.toolName === "startBuilding") {
					const plan = await readAppPlan(authority);
					const review =
						plan?.reviewedRevision === null || !plan
							? await peerReview(`${call.toolCallId}:plan`, false)
							: undefined;
					await runtime.ensureWorkspace();
					await emitState({ kind: "building", appId: runtime.appId });
					output = { building: true, ...(review && { ...review }) };
				} else if (call.toolName === "translateLanguage") {
					const { language } = translateLanguageInputSchema.parse(call.input);
					output = await runtime.write(call, (ctx) =>
						translateLanguage(
							ctx,
							{
								language: language.language,
								...(language.script != null && { script: language.script }),
								...(language.region != null && { region: language.region }),
							},
							{
								...commonLoop("translator"),
								designSessionId: args.designSessionId,
								authority: {
									actorUserId: args.actorUserId,
									runId: args.runId,
									holderNonce: args.holderNonce,
									expectedProjectId: args.projectId,
								},
							},
						),
					);
				} else if (call.toolName === "saveWork") {
					output = await runtime.saveWork(call.toolCallId);
					await emitState({ kind: "building", appId: runtime.appId });
				} else output = await runtime.shared(call, "architect");
			} catch (error) {
				output = recoverableToolError(error);
			}
			args.writer.write({
				type: "tool-output-available",
				toolCallId: call.toolCallId,
				output,
			});
			return { kind: "result" as const, output };
		};
		if (
			!head ||
			head.state.kind === "failed" ||
			head.state.kind === "awaiting-input"
		)
			await emitState(
				runtime.building
					? { kind: "building", appId: runtime.appId }
					: { kind: "planning", sourceDigest: source.digest },
			);
		const system = buildArchitectPrompt();
		const result = await runArchitectLoop({
			...commonLoop("architect"),
			spec: await spec("architect", MODEL_CONTEXT_VERSION, system),
			system,
			turnId,
			additions: sourceMessages,
			currentState: async () => {
				const plan = await readAppPlan(authority);
				return {
					role: "user",
					content: JSON.stringify({
						appSaved: runtime.appId !== null,
						...(plan && {
							plan: plan.markdown,
							planRevision: plan.revision,
							reviewedRevision: plan.reviewedRevision,
						}),
						...(runtime.building && { workspace: await runtime.overview() }),
					}),
				};
			},
			tools: () =>
				architectToolDefinitions({
					role: "architect",
					building: runtime.building,
					hasApp: runtime.appId !== null,
				}),
			dispatch,
			onFinish: async (_text, conversation) => {
				const deliverReview = async (app: boolean) => {
					const snapshot = await runtime.snapshot(true);
					let review = await latestPlanReview(
						authority,
						source.digest,
						app ? snapshot.canonicalSeq : null,
					);
					if (!review) {
						await peerReview(
							`${app ? "app" : "planning"}-finish:${turnId}:${snapshot.canonicalSeq ?? 0}`,
							app,
						);
						review = await latestPlanReview(
							authority,
							source.digest,
							app ? snapshot.canonicalSeq : null,
						);
					}
					if (!review)
						throw new Error("The completed peer review is unavailable.");
					const key = `peer-feedback:${review.id}`;
					// A tool result or this durable message is the acknowledgment.
					// No extra model-authored disposition or receipt is needed.
					if (
						conversation.hasMessage(key) ||
						conversation.hasMessage(`tool:${review.request_id}`) ||
						(review.request_id.endsWith(":plan") &&
							conversation.hasMessage(`tool:${review.request_id.slice(0, -5)}`))
					)
						return null;
					return {
						kind: "continue" as const,
						key,
						message: JSON.stringify({
							plan: (await readAppPlan(authority))?.markdown,
							review: review.summary,
						}),
					};
				};
				if (!runtime.building) {
					const plan = await readAppPlan(authority);
					if (plan) {
						const feedback = await deliverReview(false);
						if (feedback) return feedback;
					}
					return { kind: "awaiting-input" };
				}
				if (await runtime.hasUnsavedWork())
					return {
						kind: "continue",
						message:
							"There are unsaved app changes. Save a complete workflow or resolve the reported issues before finishing.",
					};
				if (!runtime.appId)
					return {
						kind: "continue",
						message: "The app has no saved workflow yet.",
					};
				const feedback = await deliverReview(true);
				if (feedback) return feedback;
				await runtime.discardEmptyWorkspace();
				return { kind: "complete" };
			},
		});
		if (result.kind === "awaiting-input") {
			emitText(`${result.contextId}:final:${turnId}`, result.text);
			await emitState({ kind: "awaiting-input" });
			const pause = runtime.appId
				? await setAwaitingInput(
						runtime.appId,
						args.runId,
						args.holderNonce,
						"build",
						true,
						args.actorUserId,
						args.projectId,
					)
				: await setDesignSessionAwaitingInput(
						args.designSessionId,
						args.runId,
						args.holderNonce,
						true,
						args.actorUserId,
						args.projectId,
					);
			return { kind: "awaiting-input", pauseOwned: pause === "owned" };
		}
		if (!runtime.appId)
			throw new Error("A completed build must have a saved app.");
		const finalApp = await loadApp(runtime.appId);
		if (!finalApp) throw new Error("The saved app is unavailable.");
		const finalized = await args.finalizeCompletion({
			appId: runtime.appId,
			expectedSeq: finalApp.mutation_seq,
			expectedHead: head,
		});
		args.writer.write({
			type: "data-authoring-progress",
			data: {
				sessionId: args.designSessionId,
				revision: finalized.head.revision,
				stage: "ready",
			},
			transient: true,
		});
		emitText(`${result.contextId}:final:${turnId}`, result.text);
		return {
			kind: "completed",
			appId: runtime.appId,
			finalSeq: finalApp.mutation_seq,
			finalBlueprint: finalized.blueprint,
		};
	} catch (error) {
		const classified = classifyError(error);
		const session = await loadDesignSession(args.designSessionId);
		if (session?.app_id) runtime.appId = session.app_id;
		try {
			await emitState({
				kind: "failed",
				failureId: randomUUID(),
				recoverable: classified.recoverable,
				errorType: classified.type,
			});
		} catch (stateError) {
			log.warn("authoring_failure_record_unavailable", {
				runId: args.runId,
				errorType: stateError instanceof Error ? stateError.name : "unknown",
			});
		}
		throw error;
	} finally {
		clearInterval(heartbeatTimer);
		await heartbeatTask;
		args.writer.write({ type: "finish" });
	}
}
