/** Real Responses decoding, durable context, attempt budget, private tools and
 * genesis publication. Only the remote model's output is controlled. These
 * journeys stop at slice materialization; they do not claim plan conformance. */
import type { ServerResponse } from "node:http";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import {
	emptyGenesisBase,
	loadCanonicalBlueprintAtSequence,
} from "@/lib/agent/change-set/baseLoader";
import { materializeAppFromGenesis } from "@/lib/agent/change-set/materializeGenesis";
import {
	beginGenesisChangeSet,
	loadChangeSet,
	loadChangeSetSteps,
} from "@/lib/agent/change-set/store";
import { ChangeSetMutationWorkspace } from "@/lib/agent/change-set/workspace";
import {
	fixtureValue,
	makeWorkflowChainContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { persistAcceptedDesignFixture } from "@/lib/agent/design/__tests__/persistedFixtures";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
import { proseText } from "@/lib/domain";
import { MODEL_CONTEXT_VERSION, MODEL_ROLES } from "@/lib/models";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	budgetForSlice,
	remainingWallClockMs,
	type SliceExecutionBudget,
} from "../budgets";
import { briefDigest, deriveSliceExecutionBrief } from "../executionBrief";
import {
	buildExecutorTools,
	type ExecutorConversationContext,
	type ExecutorStepFn,
	productionExecutorStep,
	runSliceExecutor,
} from "../executorLoop";
import { EXECUTOR_PROMPT_VERSION } from "../executorPrompt";
import {
	appendDesignModelContext,
	completeDesignModelStep,
	openDesignModelContext,
	recordDesignModelStepEvent,
} from "../modelContextStore";
import {
	beginOrRecoverSliceAttempt,
	beginSliceAttemptOutcomeCollection,
	claimSliceAttemptBudget,
	finishSliceAttemptOutcomeCollection,
	recordSliceAttemptDiagnostic,
} from "../sliceAttempts";

const h = setupAppStateTestDb("executor_native_", {
	authSchema: "migrated",
	poolMax: 3,
});
const ACTOR = "executor-actor";
const PROJECT = "executor-project";
const RUN = "executor-run";
type Call = { id: string; name: string; input: unknown };

function respondWithCalls(response: ServerResponse, calls: readonly Call[]) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const event = (value: unknown) =>
		response.write(`data: ${JSON.stringify(value)}\n\n`);
	event({
		type: "response.created",
		response: {
			id: "resp_executor",
			created_at: 1,
			model: MODEL_ROLES.buildExecutor.modelId,
		},
	});
	for (const [index, call] of calls.entries()) {
		const input = JSON.stringify(call.input);
		const item = {
			type: "function_call",
			id: `fc_${call.id}`,
			call_id: call.id,
			name: call.name,
			arguments: input,
			status: "completed",
		};
		event({
			type: "response.output_item.added",
			output_index: index,
			item: { ...item, arguments: "" },
		});
		for (const delta of [input.slice(0, 5), input.slice(5)])
			event({
				type: "response.function_call_arguments.delta",
				item_id: item.id,
				output_index: index,
				delta,
			});
		event({ type: "response.output_item.done", output_index: index, item });
	}
	event({
		type: "response.completed",
		response: {
			incomplete_details: null,
			usage: { input_tokens: 11, output_tokens: 7 },
		},
	});
	response.end();
}

async function fixture() {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const claim = await createAndClaimDesignSessionRun({
		actorUserId: ACTOR,
		projectId: PROJECT,
		runId: RUN,
		cost: 1,
	});
	const authority = {
		actorUserId: ACTOR,
		runId: RUN,
		holderNonce: claim.holderNonce,
		expectedProjectId: PROJECT,
	};
	const contract = makeWorkflowChainContract(1);
	fixtureValue(
		fixtureValue(contract.records[0], "record").properties[0],
		"property",
	).name = "Case name";
	const artifacts = await persistAcceptedDesignFixture({
		designSessionId: claim.designSessionId,
		authority,
		contract: appDesignContractSchema.parse(contract),
	});
	const plan = artifacts.plan.envelope.payload;
	const brief = deriveSliceExecutionBrief({
		contract: artifacts.accepted.envelope.payload,
		revision: {
			id: artifacts.accepted.id,
			digest: artifacts.accepted.artifactDigest,
		},
		plan,
		sliceId: fixtureValue(plan.slices[0], "slice").id,
		planDigest: artifacts.plan.artifactDigest,
	});
	const attemptArgs = {
		...authority,
		designSessionId: claim.designSessionId,
		designRevisionId: artifacts.accepted.id,
		designRevisionDigest: artifacts.accepted.artifactDigest,
		buildPlanId: artifacts.plan.id,
		buildPlanDigest: artifacts.plan.artifactDigest,
		sliceId: brief.slice.id,
		baseTarget: {
			kind: "empty-genesis" as const,
			proposedAppId: claim.proposedAppId,
			digest: emptyGenesisBase(claim.proposedAppId).digest,
		},
		executorModel: MODEL_ROLES.buildExecutor.modelId,
		promptVersion: EXECUTOR_PROMPT_VERSION,
		briefDigest: briefDigest(brief),
	};
	const { attempt } = await beginOrRecoverSliceAttempt(attemptArgs);
	const changeSet = await beginGenesisChangeSet({
		proposedAppId: claim.proposedAppId,
		projectId: PROJECT,
		baseSnapshotDigest: attemptArgs.baseTarget.digest,
		lineage: {
			designSessionId: claim.designSessionId,
			designRevisionId: artifacts.accepted.id,
			designRevisionDigest: artifacts.accepted.artifactDigest,
			buildPlanId: artifacts.plan.id,
			buildPlanDigest: artifacts.plan.artifactDigest,
			sliceId: brief.slice.id,
			attemptId: attempt.id,
		},
		ownerUserId: ACTOR,
		ownerRunId: RUN,
		attemptAuthority: authority,
	});
	const contextSpec = {
		designSessionId: claim.designSessionId,
		kind: "executor" as const,
		modelId: MODEL_ROLES.buildExecutor.modelId,
		promptVersion: EXECUTOR_PROMPT_VERSION,
		toolsetDigest: canonicalJsonDigest(buildExecutorTools()),
		contextVersion: MODEL_CONTEXT_VERSION,
		semanticScopeKey: attempt.id,
		authority,
	};
	async function openContext(): Promise<ExecutorConversationContext> {
		const persisted = await openDesignModelContext(contextSpec);
		const base = {
			designSessionId: claim.designSessionId,
			contextId: persisted.id,
			authority,
		};
		return {
			contextId: persisted.id,
			messages: [...persisted.messages],
			items: persisted.items.map((item) => ({ ...item })),
			appendKeys: new Set(persisted.appendKeys),
			completedStepKeys: new Set(persisted.completedStepKeys),
			async append(appendKey, messages) {
				await appendDesignModelContext({ ...base, appendKey, messages });
			},
			async recordStep(stepKey, event) {
				await recordDesignModelStepEvent({ ...base, stepKey, event });
			},
			async completeStep(completion) {
				await completeDesignModelStep({ ...base, ...completion });
			},
		};
	}
	const host = {
		actorUserId: ACTOR,
		runId: RUN,
		chatRunHolder: {
			mode: "build" as const,
			runId: RUN,
			nonce: claim.holderNonce,
			source: "chat" as const,
		},
		async conversionImpact() {
			throw new Error("Registration fixture cannot require conversion impact");
		},
	};
	const reopenWorkspace = () =>
		ChangeSetMutationWorkspace.open(host, changeSet.id);
	const realization = fixtureValue(
		brief.moduleRealizations[0],
		"module realization",
	);
	const caseType = fixtureValue(
		realization.hostRecord?.blueprintCaseType,
		"case type",
	);
	const calls = {
		schema: {
			id: "schema",
			name: "generateSchema",
			input: {
				caseTypes: [
					{
						name: caseType,
						properties: [
							{
								name: "case_name",
								label: proseText("Name"),
								data_type: "text",
							},
						],
					},
				],
			},
		},
		module: {
			id: "module",
			name: "createModule",
			input: {
				moduleUuid: { handle: realization.blueprintModuleHandle },
				name: "Workflow 1",
				case_type: caseType,
				forms: [
					{
						formUuid: { handle: "@registration" },
						name: "Workflow 1",
						type: "registration",
						fields: [
							{
								fieldUuid: { handle: "@value" },
								id: "workflow_1_value",
								kind: "text",
								label: proseText("Workflow 1 value"),
								caseWrite: { caseType, property: "case_name" },
							},
						],
					},
				],
				case_list_columns: [
					{
						columnUuid: { handle: "@name_column" },
						kind: "plain",
						field: "case_name",
						header: "Name",
					},
				],
			},
		},
		finish: { id: "finish", name: "finishWorkflow", input: {} },
		suffix: {
			id: "suffix",
			name: "updateApp",
			input: { name: "Unapproved suffix" },
		},
	} satisfies Record<string, Call>;
	async function run(
		step: ExecutorStepFn,
		options: {
			context?: ExecutorConversationContext;
			budget?: Partial<SliceExecutionBudget>;
		} = {},
	) {
		const recovered = await beginOrRecoverSliceAttempt(attemptArgs);
		const workspace = await reopenWorkspace();
		const budget = { ...budgetForSlice(brief.slice), ...options.budget };
		const attemptAuthority = {
			...authority,
			designSessionId: claim.designSessionId,
			attemptId: attempt.id,
		};
		await beginSliceAttemptOutcomeCollection(attemptAuthority);
		let persistenceFailed = false;
		try {
			return await runSliceExecutor({
				brief,
				workspace,
				step,
				budget,
				signal: new AbortController().signal,
				context: options.context ?? (await openContext()),
				contextScopeKey: attempt.id,
				budgetLedger: {
					spent: recovered.attempt.budgetSpent,
					deadlineAt:
						Date.now() +
						remainingWallClockMs(
							budget,
							recovered.attempt.wallClockMsUsed,
							recovered.attempt.budgetSpent.blockerReports,
						),
					claim: (counter, limit, claimKey) =>
						claimSliceAttemptBudget({
							...attemptAuthority,
							counter,
							limit,
							claimKey,
						}),
				},
				async commit(signal, deadlineAt) {
					if (signal.aborted) throw signal.reason;
					const fresh = fixtureValue(
						await loadChangeSet(changeSet.id),
						"change set",
					);
					const result = await materializeAppFromGenesis({
						...authority,
						changeSetId: changeSet.id,
						expectedRevision: fresh.revision,
						deadlineAt,
					});
					return result.kind === "materialized"
						? { kind: "committed", receipt: result.receipt }
						: result;
				},
				async onToolOutcome(event) {
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
							persistenceFailed = true;
							throw error;
						}
					}
				},
			});
		} finally {
			if (!persistenceFailed)
				await finishSliceAttemptOutcomeCollection(attemptAuthority);
		}
	}
	return {
		...claim,
		attempt,
		changeSet,
		contextSpec,
		caseType,
		calls,
		run,
		openContext,
		reopenWorkspace,
	};
}

function results(messages: readonly ModelMessage[]) {
	return messages.flatMap((message) =>
		message.role === "tool"
			? message.content.filter((part) => part.type === "tool-result")
			: [],
	);
}

describe("persisted executor Responses journeys", () => {
	it("stages and materializes one response in order and skips calls after finish", async () => {
		const f = await fixture();
		let requests = 0;
		const context = await f.openContext();
		const append = fixtureValue(context.append, "durable append");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		context.append = async (key, messages) => {
			await append(key, messages);
			if (results(messages).some((part) => part.toolCallId === "schema")) {
				entered.resolve();
				await release.promise;
			}
		};
		const outcome = await withResponsesPeer(
			(_request, response) => {
				requests += 1;
				respondWithCalls(response, [
					f.calls.schema,
					f.calls.module,
					f.calls.finish,
					f.calls.suffix,
				]);
			},
			async (provider) => {
				const running = f.run(
					productionExecutorStep(provider(MODEL_ROLES.buildExecutor.modelId)),
					{ context },
				);
				try {
					await Promise.race([
						entered.promise,
						running.then(() => {
							throw new Error(
								"Executor ended before the durable schema result",
							);
						}),
					]);
					const stored = await openDesignModelContext(f.contextSpec);
					expect(stored.completedStepKeys.size).toBe(1);
					expect(
						results(stored.messages).map((part) => part.toolCallId),
					).toEqual(["schema"]);
					const reopened = await f.reopenWorkspace();
					expect(reopened.currentSnapshot().revision).toBe(1);
					expect(reopened.currentSnapshot().doc.caseTypes).toMatchObject([
						{ name: f.caseType, properties: [{ name: "case_name" }] },
					]);
					expect(reopened.currentSnapshot().doc.moduleOrder).toEqual([]);
					expect(
						await h
							.db()
							.selectFrom("apps")
							.select("id")
							.where("id", "=", f.proposedAppId)
							.execute(),
					).toEqual([]);
				} finally {
					release.resolve();
					await running;
				}
				return await running;
			},
		);
		expect(outcome).toMatchObject({ kind: "committed" });
		expect(requests).toBe(1);
		const steps = await loadChangeSetSteps(f.changeSet.id);
		expect(steps.map((step) => step.toolName)).toEqual([
			"generateSchema",
			"createModule",
		]);
		const canonical = await loadCanonicalBlueprintAtSequence(h.db(), {
			appId: f.proposedAppId,
			seq: 1,
			expectedDigest: null,
		});
		expect(canonical.doc.moduleOrder).toHaveLength(1);
		expect(Object.values(canonical.doc.forms)).toMatchObject([
			{ name: "Workflow 1", type: "registration" },
		]);
		const stored = await openDesignModelContext(f.contextSpec);
		expect(results(stored.messages).map((part) => part.toolCallId)).toEqual([
			"schema",
			"module",
			"finish",
			"suffix",
		]);
		expect(results(stored.messages).at(-1)?.output).toMatchObject({
			type: "json",
			value: { code: "DEPENDENT_CALL_SKIPPED" },
		});
	});

	it("reopens the stored response after result acknowledgement loss without replaying the paid model step or mutation", async () => {
		const f = await fixture();
		const context = await f.openContext();
		const append = fixtureValue(context.append, "durable append");
		const lost = new Error(
			"Tool result was persisted but its acknowledgement was lost",
		);
		context.append = async (key, messages) => {
			await append(key, messages);
			if (results(messages).some((part) => part.toolCallId === "schema"))
				throw lost;
		};
		let requests = 0;
		await withResponsesPeer(
			(_request, response) => {
				requests += 1;
				respondWithCalls(response, [
					f.calls.schema,
					f.calls.module,
					f.calls.finish,
				]);
			},
			async (provider) => {
				const step = productionExecutorStep(
					provider(MODEL_ROLES.buildExecutor.modelId),
				);
				await expect(f.run(step, { context })).rejects.toBe(lost);
				const before = await loadChangeSetSteps(f.changeSet.id);
				expect(before.map((step) => step.toolName)).toEqual(["generateSchema"]);
				const replacement = await f.openContext();
				expect(replacement.contextId).toBe(context.contextId);
				expect(
					results(replacement.messages).map((part) => part.toolCallId),
				).toEqual(["schema"]);
				await expect(
					f.run(step, { context: replacement }),
				).resolves.toMatchObject({ kind: "committed" });
				expect((await loadChangeSetSteps(f.changeSet.id))[0]).toEqual(
					before[0],
				);
			},
		);
		expect(requests).toBe(1);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select([
					"model_steps_used",
					"mutation_calls_used",
					"commit_attempts_used",
				])
				.where("id", "=", f.attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			model_steps_used: 1,
			mutation_calls_used: 2,
			commit_attempts_used: 1,
		});
		expect(
			(await loadChangeSetSteps(f.changeSet.id)).map((step) => step.toolName),
		).toEqual(["generateSchema", "createModule"]);
	});

	it("returns canonical wire rejection to the next model call and skips the dependent suffix before a real correction", async () => {
		const f = await fixture();
		const invalid: Call = {
			...f.calls.module,
			id: "invalid",
			input: {
				...f.calls.module.input,
				forms: [
					{
						...f.calls.module.input.forms[0],
						fields: [
							{
								fieldUuid: { handle: "@value" },
								id: "workflow_1_value",
								kind: "text",
							},
						],
					},
				],
			},
		};
		const requests: unknown[] = [];
		const outcome = await withResponsesPeer(
			(request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					requests.push(JSON.parse(body));
					if (requests.length === 1)
						respondWithCalls(response, [
							f.calls.schema,
							invalid,
							f.calls.suffix,
						]);
					else if (requests.length === 2)
						respondWithCalls(response, [f.calls.module, f.calls.finish]);
					else respondWithObject(response, "Unexpected extra request");
				});
			},
			(provider) =>
				f.run(
					productionExecutorStep(provider(MODEL_ROLES.buildExecutor.modelId)),
				),
		);
		expect(outcome).toMatchObject({ kind: "committed" });
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({
			input: expect.arrayContaining([
				expect.objectContaining({
					type: "function_call_output",
					call_id: "invalid",
					output: expect.stringContaining("TOOL_INPUT_INVALID"),
				}),
			]),
		});
		const stored = await openDesignModelContext(f.contextSpec);
		expect(
			results(stored.messages).find((part) => part.toolCallId === "invalid")
				?.output,
		).toMatchObject({ type: "json", value: { code: "TOOL_INPUT_INVALID" } });
		expect(
			results(stored.messages).find((part) => part.toolCallId === "suffix")
				?.output,
		).toMatchObject({
			type: "json",
			value: { code: "DEPENDENT_CALL_SKIPPED" },
		});
		expect(
			(await loadChangeSetSteps(f.changeSet.id)).map((step) => step.toolName),
		).toEqual(["generateSchema", "createModule"]);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select([
					"wire_invalid_count",
					"private_mutation_rejected_count",
					"validator_repair_count",
				])
				.where("id", "=", f.attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			wire_invalid_count: 1,
			private_mutation_rejected_count: 0,
			validator_repair_count: 0,
		});
	});

	it("exhausts the durable mutation budget before a second mutation and leaves no canonical app", async () => {
		const f = await fixture();
		const outcome = await withResponsesPeer(
			(_request, response) =>
				respondWithCalls(response, [
					f.calls.schema,
					f.calls.module,
					f.calls.finish,
				]),
			(provider) =>
				f.run(
					productionExecutorStep(provider(MODEL_ROLES.buildExecutor.modelId)),
					{ budget: { maxMutationCalls: 1 } },
				),
		);
		expect(outcome).toMatchObject({
			kind: "budget-exhausted",
			axis: "mutation-calls",
			spent: { modelSteps: 1, mutationCalls: 1, commitAttempts: 0 },
		});
		expect(
			(await loadChangeSetSteps(f.changeSet.id)).map((step) => step.toolName),
		).toEqual(["generateSchema"]);
		expect(
			await h
				.db()
				.selectFrom("apps")
				.select("id")
				.where("id", "=", f.proposedAppId)
				.execute(),
		).toEqual([]);
		const stored = await openDesignModelContext(f.contextSpec);
		expect(results(stored.messages).map((part) => part.toolCallId)).toEqual([
			"schema",
			"module",
			"finish",
		]);
		expect(results(stored.messages).at(-1)?.output).toMatchObject({
			type: "json",
			value: { code: "DEPENDENT_CALL_SKIPPED" },
		});
	});

	it("keeps a valid private candidate unpublished until an invented input requirement is corrected", async () => {
		const f = await fixture();
		const form = fixtureValue(
			f.calls.module.input.forms[0],
			"registration form",
		);
		const requiredModule: Call = {
			...f.calls.module,
			input: {
				...f.calls.module.input,
				forms: [
					{
						...form,
						fields: form.fields.map((field) => ({
							...field,
							required: xp("true()"),
						})),
					},
				],
			},
		};
		const repair: Call = {
			id: "repair",
			name: "editField",
			input: {
				moduleUuid: f.calls.module.input.moduleUuid,
				formUuid: { handle: "@registration" },
				fieldUuid: { handle: "@value" },
				updates: { kind: "text", required: null },
			},
		};
		const context = await f.openContext();
		const append = fixtureValue(context.append, "durable append");
		let sawRefusal = false;
		context.append = async (key, messages) => {
			await append(key, messages);
			if (
				results(messages).some((part) => part.toolCallId === "refused_finish")
			) {
				sawRefusal = true;
				expect(
					await h
						.db()
						.selectFrom("apps")
						.select("id")
						.where("id", "=", f.proposedAppId)
						.execute(),
				).toEqual([]);
				const workspace = await f.reopenWorkspace();
				expect((await workspace.inspect()).canCommit).toBe(true);
				expect(results(messages)[0]?.output).toMatchObject({
					type: "json",
					value: {
						status: "needs-correction",
						diagnostics: {
							canCommit: false,
							findings: [
								expect.objectContaining({
									code: "ACCEPTED_INPUT_REQUIREMENT_MISMATCH",
								}),
							],
						},
					},
				});
			}
		};
		let requests = 0;
		const outcome = await withResponsesPeer(
			(_request, response) => {
				requests += 1;
				if (requests === 1)
					respondWithCalls(response, [
						f.calls.schema,
						requiredModule,
						{ ...f.calls.finish, id: "refused_finish" },
						f.calls.suffix,
					]);
				else if (requests === 2)
					respondWithCalls(response, [repair, f.calls.finish]);
				else respondWithObject(response, "Unexpected extra request");
			},
			(provider) =>
				f.run(
					productionExecutorStep(provider(MODEL_ROLES.buildExecutor.modelId)),
					{ context },
				),
		);
		expect(outcome).toMatchObject({ kind: "committed" });
		expect(sawRefusal).toBe(true);
		expect(requests).toBe(2);
		const canonical = await loadCanonicalBlueprintAtSequence(h.db(), {
			appId: f.proposedAppId,
			seq: 1,
			expectedDigest: null,
		});
		expect(Object.values(canonical.doc.fields)).toHaveLength(1);
		expect(Object.values(canonical.doc.fields)[0]).not.toHaveProperty(
			"required",
		);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select(["validator_repair_count", "commit_attempts_used"])
				.where("id", "=", f.attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ validator_repair_count: 1, commit_attempts_used: 1 });
	});

	it("ends repeated canonical input rejection without spending an architect blocker", async () => {
		const f = await fixture();
		let requests = 0;
		const outcome = await withResponsesPeer(
			(_request, response) => {
				requests += 1;
				respondWithCalls(response, [
					{
						id: `invalid_${requests}`,
						name: "generateSchema",
						input: { caseTypes: "invalid" },
					},
				]);
			},
			(provider) =>
				f.run(
					productionExecutorStep(provider(MODEL_ROLES.buildExecutor.modelId)),
				),
		);
		expect(outcome).toMatchObject({
			kind: "protocol-failure",
			code: "repeated-rejected-call",
		});
		expect(requests).toBe(3);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select([
					"wire_invalid_count",
					"blocker_reports_used",
					"model_steps_used",
				])
				.where("id", "=", f.attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			wire_invalid_count: 3,
			blocker_reports_used: 0,
			model_steps_used: 3,
		});
		expect(await loadChangeSetSteps(f.changeSet.id)).toEqual([]);
	});

	it("refuses prose-only completion after three actual Responses steps", async () => {
		const f = await fixture();
		let requests = 0;
		const outcome = await withResponsesPeer(
			(_request, response) => {
				requests += 1;
				respondWithObject(response, "The workflow is complete.");
			},
			(provider) =>
				f.run(
					productionExecutorStep(provider(MODEL_ROLES.buildExecutor.modelId)),
				),
		);
		expect(outcome).toMatchObject({
			kind: "protocol-failure",
			code: "no-tool-call",
		});
		expect(requests).toBe(3);
		expect(
			await h
				.db()
				.selectFrom("apps")
				.select("id")
				.where("id", "=", f.proposedAppId)
				.execute(),
		).toEqual([]);
		expect(
			(await openDesignModelContext(f.contextSpec)).completedStepKeys.size,
		).toBe(3);
	});
});
