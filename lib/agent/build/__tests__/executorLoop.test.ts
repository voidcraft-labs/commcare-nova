/**
 * The native slice executor protocol, fully offline.
 *
 * A scripted model supplies ordinary Nova calls. The fake workspace proves
 * call ordering, durable response/result boundaries, recovery, and the
 * server-owned finalizer without reproducing any tool implementation.
 */

import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { buildDoc, xp } from "@/lib/__tests__/docHelpers";
import type { ChangeSetDiagnostics } from "@/lib/agent/change-set/diagnostics";
import {
	ChangeSetScopeLostError,
	ChangeSetStagingRejectedError,
} from "@/lib/agent/change-set/errors";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import {
	fixtureValue,
	ids,
	makeBuildPlan,
	makeContract,
	makeNestedMenuContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import type { WorkspaceSnapshot } from "@/lib/agent/workspace/types";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/domain";
import { acceptedInputRequirementIssues } from "../acceptedInputParity";
import { budgetForSlice, type SliceExecutionBudget } from "../budgets";
import {
	deriveSliceExecutionBrief,
	type SliceExecutionBrief,
} from "../executionBrief";
import {
	compositionAdmissionIssue,
	type ExecutorConversationContext,
	type ExecutorStepFn,
	type ExecutorToolOutcomeEvent,
	type ExecutorWorkspace,
	recoverCommittedExecutorToolResult,
	runSliceExecutor,
	type SliceCommitResult,
} from "../executorLoop";

function brief(): SliceExecutionBrief {
	const plan = makeBuildPlan();
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: fixtureValue(plan.slices[0], "first slice").id,
	});
}

function diagnostics(
	overrides: Partial<ChangeSetDiagnostics> = {},
): ChangeSetDiagnostics {
	return {
		snapshotRevision: 1,
		candidateDigest: "d".repeat(64),
		allFindings: [],
		finalizationFindings: [],
		introducedSincePreviousStep: [],
		resolvedSincePreviousStep: [],
		readSetStatus: [],
		canCommit: true,
		...overrides,
	};
}

const BLOCKING_DIAGNOSTICS = diagnostics({
	canCommit: false,
	allFindings: [
		{
			code: "MISSING_CASE_LIST_COLUMNS",
			message: "This case module has no visible Results fields.",
			location: { kind: "app" },
			details: {},
		},
	] as unknown as ChangeSetDiagnostics["allFindings"],
});

interface DispatchCall {
	readonly toolName: string;
	readonly requestId: string;
	readonly input: unknown;
}

interface FakeWorkspace extends ExecutorWorkspace {
	readonly dispatched: DispatchCall[];
	readonly dispatchOrder: string[];
	inspectCalls: number;
}

function acceptedWorkspaceFixture(): {
	readonly doc: BlueprintDoc;
	readonly handles: ReturnType<
		ExecutorWorkspace["currentExecutionCheckpoint"]
	>["handles"];
} {
	const sliceBrief = brief();
	const realization = fixtureValue(
		sliceBrief.moduleRealizations[0],
		"accepted module realization",
	);
	const composition = fixtureValue(
		sliceBrief.moduleCompositions.find(
			(entry) => entry.id === realization.compositionId,
		),
		"accepted module composition",
	);
	const caseType = realization.hostRecord?.blueprintCaseType;
	const doc = buildDoc({
		appName: sliceBrief.charter.appName,
		...(caseType === undefined
			? {}
			: { caseTypes: [{ name: caseType, properties: [] }] }),
		modules: [
			{
				name: composition.name,
				...(caseType === undefined ? {} : { caseType }),
				caseListOnly: true,
				forms: [],
			},
		],
	});
	const moduleUuid = fixtureValue(doc.moduleOrder[0], "accepted module");
	return {
		doc,
		handles: [
			{
				handle: realization.blueprintModuleHandle,
				uuid: moduleUuid,
				entityKind: "module",
			},
		],
	};
}

function fakeWorkspace(options?: {
	readonly doc?: BlueprintDoc;
	readonly inspect?: () => Promise<ChangeSetDiagnostics>;
	readonly stage?: (args: DispatchCall) => Promise<unknown>;
	readonly beforeDispatch?: (args: DispatchCall) => void;
}): FakeWorkspace {
	const dispatched: DispatchCall[] = [];
	const dispatchOrder: string[] = [];
	let revision = 0;
	const accepted =
		options?.doc === undefined ? acceptedWorkspaceFixture() : null;
	const doc =
		options?.doc ?? fixtureValue(accepted?.doc, "accepted workspace document");
	const workspace: FakeWorkspace = {
		dispatched,
		dispatchOrder,
		inspectCalls: 0,
		currentSnapshot(): WorkspaceSnapshot {
			return {
				doc,
				revision,
				canonicalSeq: null,
				projectId: "project-1",
			};
		},
		currentExecutionCheckpoint() {
			return { handles: accepted?.handles ?? [] };
		},
		async stageDispatch(args) {
			const call = {
				toolName: args.toolName,
				requestId: args.requestId,
				input: args.input,
			};
			options?.beforeDispatch?.(call);
			dispatched.push(call);
			dispatchOrder.push(`tool:${args.requestId}`);
			const custom = await options?.stage?.(call);
			if (custom !== undefined) return custom as never;
			const entry = CHANGE_SET_TOOL_REGISTRY.get(args.toolName);
			if (entry?.policy.effect === "mutate-blueprint") {
				revision += 1;
				return {
					replayed: false,
					result: {
						kind: "mutate",
						mutations: [],
						result: { message: `Applied ${args.toolName}.` },
					},
				} as never;
			}
			return {
				replayed: false,
				result: { kind: "read", data: { found: args.toolName } },
			} as never;
		},
		async inspect() {
			workspace.inspectCalls += 1;
			dispatchOrder.push("inspect");
			return (
				options?.inspect?.() ?? diagnostics({ snapshotRevision: revision })
			);
		},
	};
	return workspace;
}

interface ScriptedResponse {
	readonly calls?: readonly {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly input?: unknown;
	}[];
	readonly text?: string;
	readonly reasoningText?: string;
}

function assistantMessage(
	calls: NonNullable<ScriptedResponse["calls"]>,
	text = "",
): ModelMessage {
	return {
		role: "assistant",
		content: [
			...(text === "" ? [] : [{ type: "text" as const, text }]),
			...calls.map((call) => ({
				type: "tool-call" as const,
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				input: call.input ?? {},
			})),
		],
	};
}

function scriptedStep(script: readonly ScriptedResponse[]) {
	let index = 0;
	const seen: Array<{
		readonly messages: ModelMessage[];
		readonly toolNames: readonly string[] | undefined;
		readonly mounted: readonly string[];
	}> = [];
	const step: ExecutorStepFn = async ({ messages, tools, allowedTools }) => {
		const response = script[Math.min(index, script.length - 1)] ?? {};
		index += 1;
		const calls = response.calls ?? [];
		seen.push({
			messages: [...messages],
			toolNames: allowedTools,
			mounted: Object.keys(tools),
		});
		return {
			toolCalls: calls.map((call) => ({
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				input: call.input ?? {},
			})),
			text: response.text ?? "",
			...(response.reasoningText !== undefined && {
				reasoningText: response.reasoningText,
			}),
			usage: undefined,
			responseMessages: [assistantMessage(calls, response.text)],
		};
	};
	return { step, seen };
}

function receipt(): CommittedSliceReceipt {
	const slice = brief().slice;
	return {
		id: "receipt-1",
		changeSetId: "change-set-1",
		appId: "app-executor-test",
		seq: 1,
		batchId: "batch-1",
		committedSnapshotDigest: "c".repeat(64),
		mutationCount: 1,
		committedAt: new Date(0),
		designSessionId: "session-1",
		designRevisionId: ids.revisionId,
		designRevisionDigest: "b".repeat(64),
		buildPlanId: brief().buildPlanId,
		buildPlanDigest: brief().buildPlanDigest,
		sliceId: slice.id,
		attemptId: "attempt-1",
	};
}

function budget(overrides: Partial<SliceExecutionBudget> = {}) {
	return { ...budgetForSlice(brief().slice), ...overrides };
}

function toolResultValues(messages: readonly ModelMessage[]) {
	return messages.flatMap((message) =>
		message.role !== "tool"
			? []
			: message.content.flatMap((part) =>
					part.type === "tool-result" && part.output.type === "json"
						? [
								{
									toolCallId: part.toolCallId,
									toolName: part.toolName,
									value: part.output.value,
								},
							]
						: [],
				),
	);
}

function toolResultMessage(
	toolCallId: string,
	toolName: string,
	value: unknown,
): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				output: { type: "json", value: value as never },
			},
		],
	};
}

function run(args: {
	readonly workspace: ExecutorWorkspace;
	readonly step: ExecutorStepFn;
	readonly context?: ExecutorConversationContext;
	readonly contextScopeKey?: string;
	readonly commit?: () => Promise<SliceCommitResult>;
	readonly resolveBlocker?: Parameters<
		typeof runSliceExecutor
	>[0]["resolveBlocker"];
	readonly onToolOutcome?: (
		event: ExecutorToolOutcomeEvent,
	) => void | Promise<void>;
	readonly budget?: SliceExecutionBudget;
}) {
	return runSliceExecutor({
		workspace: args.workspace,
		brief: brief(),
		budget: args.budget ?? budget(),
		step: args.step,
		...(args.context !== undefined && { context: args.context }),
		...(args.contextScopeKey !== undefined && {
			contextScopeKey: args.contextScopeKey,
		}),
		commit:
			args.commit ??
			(async () => ({ kind: "committed", receipt: receipt() }) as const),
		...(args.resolveBlocker !== undefined && {
			resolveBlocker: args.resolveBlocker,
		}),
		...(args.onToolOutcome !== undefined && {
			onToolOutcome: args.onToolOutcome,
		}),
		signal: new AbortController().signal,
	});
}

describe("native executor surface", () => {
	it("mounts the stable full grammar while passing a slice-specific allowed set", async () => {
		const scripted = scriptedStep([
			{ calls: [{ toolCallId: "finish", toolName: "finishWorkflow" }] },
		]);
		await run({ workspace: fakeWorkspace(), step: scripted.step });
		const request = fixtureValue(scripted.seen[0], "model request");
		expect(request.mounted).toEqual(
			expect.arrayContaining([
				"searchBlueprint",
				"createModule",
				"finishWorkflow",
				"reportExecutionBlocker",
			]),
		);
		expect(request.mounted).not.toEqual(
			expect.arrayContaining(["readBatch", "stageBatch", "stageModule"]),
		);
		expect(request.toolNames).toEqual([
			...brief().toolProfile.readTools,
			...brief().toolProfile.mutationTools,
			"finishWorkflow",
			"reportExecutionBlocker",
		]);
	});

	it("persists one response, then runs native calls serially and finalizes", async () => {
		const order: string[] = [];
		const context: ExecutorConversationContext = {
			messages: [],
			async append(key) {
				order.push(`persist:${key}`);
			},
		};
		const workspace = fakeWorkspace({
			beforeDispatch: (call) => {
				expect(
					context.messages.some(
						(message) =>
							message.role === "assistant" &&
							JSON.stringify(message).includes(call.requestId),
					),
				).toBe(true);
				order.push(`dispatch:${call.requestId}`);
			},
		});
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "rename",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
					{
						toolCallId: "read",
						toolName: "searchBlueprint",
						input: { query: "module" },
					},
					{ toolCallId: "finish", toolName: "finishWorkflow" },
				],
			},
		]);
		const outcomes: ExecutorToolOutcomeEvent[] = [];
		const result = await run({
			workspace,
			step: scripted.step,
			context,
			onToolOutcome: (event) => {
				outcomes.push(event);
			},
			commit: async () => {
				order.push("commit");
				return { kind: "committed", receipt: receipt() };
			},
		});
		expect(result.kind).toBe("committed");
		expect(workspace.dispatched.map((call) => call.requestId)).toEqual([
			"rename",
			"read",
		]);
		expect(
			order.findIndex((entry) => entry.includes(":response")),
		).toBeLessThan(order.indexOf("dispatch:rename"));
		expect(order.indexOf("dispatch:rename")).toBeLessThan(
			order.indexOf("dispatch:read"),
		);
		expect(order.indexOf("dispatch:read")).toBeLessThan(
			order.indexOf("commit"),
		);
		expect(outcomes.map(({ outcome, code }) => [outcome, code])).toEqual([
			["accepted", "PRIVATE_MUTATION_APPLIED"],
			["accepted", "READ_COMPLETED"],
			["committed", "WORKFLOW_COMMITTED"],
		]);
		expect(
			toolResultValues(context.messages).map((item) => item.toolCallId),
		).toEqual(["rename", "read", "finish"]);
	});

	it("retains an accepted prefix and skips the dependent suffix after failure", async () => {
		const workspace = fakeWorkspace({
			stage: async (call) => {
				if (call.requestId !== "bad") return undefined;
				return {
					replayed: false,
					receipt: { error: { code: "TARGET_INVALID" } },
					result: {
						kind: "mutate",
						mutations: [],
						result: { error: "The target does not exist." },
					},
				};
			},
		});
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "good",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
					{
						toolCallId: "bad",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
					{
						toolCallId: "dependent",
						toolName: "searchBlueprint",
						input: { query: "module" },
					},
				],
			},
			{ calls: [{ toolCallId: "finish", toolName: "finishWorkflow" }] },
		]);
		const context: ExecutorConversationContext = { messages: [] };
		const outcomes: ExecutorToolOutcomeEvent[] = [];
		const result = await run({
			workspace,
			step: scripted.step,
			context,
			onToolOutcome: (event) => {
				outcomes.push(event);
			},
		});
		expect(result.kind).toBe("committed");
		expect(workspace.dispatched.map((call) => call.requestId)).toEqual([
			"good",
			"bad",
		]);
		expect(outcomes.map(({ outcome, code }) => [outcome, code])).toContainEqual(
			["skipped", "DEPENDENT_CALL_SKIPPED"],
		);
		expect(
			toolResultValues(context.messages).find(
				(item) => item.toolCallId === "dependent",
			)?.value,
		).toMatchObject({ status: "skipped", code: "DEPENDENT_CALL_SKIPPED" });
	});

	it("awaits each durable result before dispatching the next call", async () => {
		const persisted: string[] = [];
		let firstResultPersisted = false;
		const context: ExecutorConversationContext = {
			messages: [],
			async append(key) {
				persisted.push(key);
				if (key.endsWith(":tool:first")) firstResultPersisted = true;
			},
		};
		const workspace = fakeWorkspace({
			beforeDispatch: (call) => {
				if (call.requestId === "second")
					expect(firstResultPersisted).toBe(true);
			},
		});
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "first",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
					{
						toolCallId: "second",
						toolName: "searchBlueprint",
						input: { query: "form" },
					},
					{ toolCallId: "finish", toolName: "finishWorkflow" },
				],
			},
		]);
		await run({ workspace, step: scripted.step, context });
		expect(persisted.some((key) => key.endsWith(":tool:first"))).toBe(true);
		expect(persisted.some((key) => key.endsWith(":tool:second"))).toBe(true);
	});
});

describe("native response recovery", () => {
	function recoveringContext(
		firstResult: unknown,
	): ExecutorConversationContext {
		const response = assistantMessage([
			{
				toolCallId: "first",
				toolName: "updateApp",
				input: { name: brief().charter.appName },
			},
			{
				toolCallId: "second",
				toolName: "searchBlueprint",
				input: { query: "form" },
			},
		]);
		const result = toolResultMessage("first", "updateApp", firstResult);
		return {
			messages: [response, result],
			items: [{ appendKey: "step:attempt-1:1:response", message: response }],
			appendKeys: new Set([
				"step:attempt-1:1:response",
				"step:attempt-1:1:tool:first",
			]),
		};
	}

	it("dispatches only the unanswered suffix after process replacement", async () => {
		const workspace = fakeWorkspace();
		const scripted = scriptedStep([
			{ calls: [{ toolCallId: "finish", toolName: "finishWorkflow" }] },
		]);
		const result = await run({
			workspace,
			step: scripted.step,
			context: recoveringContext({ message: "Applied updateApp." }),
			contextScopeKey: "attempt-1",
		});
		expect(result.kind).toBe("committed");
		expect(workspace.dispatched.map((call) => call.requestId)).toEqual([
			"second",
		]);
		expect(scripted.seen).toHaveLength(1);
	});

	it("skips an unanswered suffix when the durable prefix already failed", async () => {
		const workspace = fakeWorkspace();
		const context = recoveringContext({
			status: "failed",
			code: "TARGET_INVALID",
			error: "The target does not exist.",
		});
		const scripted = scriptedStep([
			{ calls: [{ toolCallId: "finish", toolName: "finishWorkflow" }] },
		]);
		const outcomes: ExecutorToolOutcomeEvent[] = [];
		const result = await run({
			workspace,
			step: scripted.step,
			context,
			contextScopeKey: "attempt-1",
			onToolOutcome: (event) => {
				outcomes.push(event);
			},
		});
		expect(result.kind).toBe("committed");
		expect(workspace.dispatched).toEqual([]);
		expect(outcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolName: "searchBlueprint",
					outcome: "skipped",
					code: "DEPENDENT_CALL_SKIPPED",
				}),
			]),
		);
	});

	it("reconstructs a lost finalizer result only for a pending finishWorkflow", () => {
		const response = assistantMessage([
			{ toolCallId: "finish", toolName: "finishWorkflow" },
		]);
		const context: ExecutorConversationContext = {
			messages: [response],
			items: [{ appendKey: "step:attempt-1:1:response", message: response }],
		};
		const recovered = recoverCommittedExecutorToolResult({
			context,
			attemptId: "attempt-1",
			receipt: receipt(),
		});
		expect(recovered?.appendKey).toBe("step:attempt-1:1:tool:finish");
		expect(
			toolResultValues(recovered ? [recovered.message] : [])[0]?.value,
		).toMatchObject({
			status: "committed",
			code: "WORKFLOW_COMMITTED",
		});
	});
});

describe("failure and finalization policy", () => {
	it("does not call the architect for a pure tool-input failure", async () => {
		const resolveBlocker = vi.fn();
		const workspace = fakeWorkspace({
			stage: async () => {
				throw new ChangeSetStagingRejectedError(
					"TOOL_INPUT_INVALID",
					"The input is malformed.",
				);
			},
		});
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "invalid",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
				],
			},
			{ calls: [{ toolCallId: "finish", toolName: "finishWorkflow" }] },
		]);
		const result = await run({
			workspace,
			step: scripted.step,
			resolveBlocker,
		});
		expect(result.kind).toBe("committed");
		expect(resolveBlocker).not.toHaveBeenCalled();
	});

	it("asks the architect only after the same substantive composition failure repeats", async () => {
		const resolveBlocker = vi.fn(async () => ({
			kind: "continue" as const,
			guidance: "Use the accepted module composition.",
		}));
		const wrongModule = {
			moduleUuid: { handle: "@wrong" },
			name: "Invented module",
			case_type: null,
			forms: [],
		};
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "wrong-1",
						toolName: "createModule",
						input: wrongModule,
					},
				],
			},
			{
				calls: [
					{
						toolCallId: "wrong-2",
						toolName: "createModule",
						input: wrongModule,
					},
				],
			},
			{ calls: [{ toolCallId: "finish", toolName: "finishWorkflow" }] },
		]);
		const outcomes: ExecutorToolOutcomeEvent[] = [];
		const result = await run({
			workspace: fakeWorkspace(),
			step: scripted.step,
			resolveBlocker,
			onToolOutcome: (event) => {
				outcomes.push(event);
			},
		});
		expect(result.kind).toBe("committed");
		expect(resolveBlocker).toHaveBeenCalledTimes(1);
		expect(
			outcomes.filter((event) => event.code === "COMPOSITION_HOST_FORBIDDEN"),
		).toHaveLength(2);
	});

	it("corrects the second identical deterministic rejection and stops the third locally", async () => {
		const resolveBlocker = vi.fn();
		const workspace = fakeWorkspace({
			stage: async () => ({
				replayed: false,
				receipt: { error: { code: "TARGET_ALREADY_ABSENT" } },
				result: {
					kind: "mutate",
					mutations: [],
					result: {
						error:
							"The requested state is already absent; this call has no edit.",
					},
				},
			}),
		});
		const repeatedCall = { name: brief().charter.appName };
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "no-op-1",
						toolName: "updateApp",
						input: repeatedCall,
					},
				],
			},
			{
				calls: [
					{
						toolCallId: "no-op-2",
						toolName: "updateApp",
						input: repeatedCall,
					},
				],
			},
			{
				calls: [
					{
						toolCallId: "no-op-3",
						toolName: "updateApp",
						input: repeatedCall,
					},
				],
			},
		]);
		const context: ExecutorConversationContext = { messages: [] };

		const result = await run({
			workspace,
			step: scripted.step,
			context,
			resolveBlocker,
		});

		expect(result).toMatchObject({
			kind: "protocol-failure",
			code: "repeated-rejected-call",
		});
		expect(workspace.dispatched).toHaveLength(3);
		expect(resolveBlocker).not.toHaveBeenCalled();
		expect(
			toolResultValues(context.messages).find(
				(item) => item.toolCallId === "no-op-2",
			)?.value,
		).toMatchObject({
			repeatedFailure: {
				occurrence: 2,
				recoveryGuidance: expect.stringContaining("Do not retry it unchanged"),
			},
		});
		expect(
			toolResultValues(context.messages).find(
				(item) => item.toolCallId === "no-op-3",
			)?.value,
		).toMatchObject({ repeatedFailure: { occurrence: 3 } });
	});

	it("does not collapse changed rejected inputs into one no-progress sequence", async () => {
		const workspace = fakeWorkspace({
			stage: async () => ({
				replayed: false,
				receipt: { error: { code: "TARGET_INVALID" } },
				result: {
					kind: "mutate",
					mutations: [],
					result: { error: "The requested target is invalid." },
				},
			}),
		});
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "bad-1",
						toolName: "updateApp",
						input: { name: "One" },
					},
				],
			},
			{
				calls: [
					{
						toolCallId: "bad-2",
						toolName: "updateApp",
						input: { name: "Two" },
					},
				],
			},
			{
				calls: [
					{
						toolCallId: "bad-3",
						toolName: "updateApp",
						input: { name: "Three" },
					},
				],
			},
			{ calls: [{ toolCallId: "finish", toolName: "finishWorkflow" }] },
		]);

		await expect(
			run({ workspace, step: scripted.step }),
		).resolves.toMatchObject({
			kind: "committed",
		});
	});

	it("does not recover a rejection sequence that a later accepted call reset", async () => {
		const input = { name: brief().charter.appName };
		const priorFailure = toolResultMessage("old-failure", "updateApp", {
			status: "failed",
			code: "TARGET_INVALID",
			error: "The requested target is invalid.",
			repeatedFailure: {
				fingerprint: "old-fingerprint",
				occurrence: 2,
				recoveryGuidance: "Do not retry it unchanged.",
			},
		});
		const priorSuccess = toolResultMessage("old-success", "searchBlueprint", {
			kind: "read",
			data: { found: true },
		});
		const context: ExecutorConversationContext = {
			messages: [priorFailure, priorSuccess],
		};
		const workspace = fakeWorkspace({
			stage: async () => ({
				replayed: false,
				receipt: { error: { code: "TARGET_INVALID" } },
				result: {
					kind: "mutate",
					mutations: [],
					result: { error: "The requested target is invalid." },
				},
			}),
		});
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "new-failure",
						toolName: "updateApp",
						input,
					},
				],
			},
			{ calls: [{ toolCallId: "finish", toolName: "finishWorkflow" }] },
		]);

		await expect(
			run({ workspace, step: scripted.step, context }),
		).resolves.toMatchObject({ kind: "committed" });
		expect(
			toolResultValues(context.messages).find(
				(item) => item.toolCallId === "new-failure",
			)?.value,
		).toMatchObject({ repeatedFailure: { occurrence: 1 } });
	});

	it("returns validator corrections and commits only after a later clean finish", async () => {
		let inspection = 0;
		const workspace = fakeWorkspace({
			inspect: async () => {
				inspection += 1;
				return inspection === 1 ? BLOCKING_DIAGNOSTICS : diagnostics();
			},
		});
		const scripted = scriptedStep([
			{ calls: [{ toolCallId: "finish-1", toolName: "finishWorkflow" }] },
			{
				calls: [
					{
						toolCallId: "repair",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
				],
			},
			{ calls: [{ toolCallId: "finish-2", toolName: "finishWorkflow" }] },
		]);
		const commit = vi.fn(async () => ({
			kind: "committed" as const,
			receipt: receipt(),
		}));
		const context: ExecutorConversationContext = { messages: [] };
		const result = await run({
			workspace,
			step: scripted.step,
			commit,
			context,
		});
		expect(result.kind).toBe("committed");
		expect(commit).toHaveBeenCalledTimes(1);
		expect(
			toolResultValues(context.messages).find(
				(item) => item.toolCallId === "finish-1",
			)?.value,
		).toMatchObject({
			status: "needs-correction",
			code: "WORKFLOW_NEEDS_CORRECTION",
		});
		const correctionResult = JSON.stringify(
			toolResultValues(context.messages).find(
				(item) => item.toolCallId === "finish-1",
			)?.value,
		);
		expect(correctionResult).toContain("addCaseListColumns");
		expect(correctionResult).toContain('\\"field\\":\\"case_name\\"');
		expect(correctionResult).toContain("never addFields");
	});

	it("reports a lost workspace as a terminal protocol fact", async () => {
		const workspace = fakeWorkspace({
			stage: async () => {
				throw new ChangeSetScopeLostError("The private workspace was closed.");
			},
		});
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "lost",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
				],
			},
		]);
		await expect(
			run({ workspace, step: scripted.step }),
		).resolves.toMatchObject({
			kind: "protocol-failure",
			code: "CHANGE_SET_SCOPE_LOST",
		});
	});

	it("preserves the accepted mutation prefix when the native-call budget ends", async () => {
		const workspace = fakeWorkspace();
		const scripted = scriptedStep([
			{
				calls: [
					{
						toolCallId: "first",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
					{
						toolCallId: "second",
						toolName: "updateApp",
						input: { name: brief().charter.appName },
					},
				],
			},
		]);
		const result = await run({
			workspace,
			step: scripted.step,
			budget: budget({ maxMutationCalls: 1 }),
		});
		expect(result).toMatchObject({
			kind: "budget-exhausted",
			axis: "mutation-calls",
			spent: { mutationCalls: 1, commitAttempts: 0, blockerReports: 0 },
		});
		expect(workspace.dispatched.map((call) => call.requestId)).toEqual([
			"first",
		]);
	});

	it("stops after three prose-only responses", async () => {
		const scripted = scriptedStep([
			{ text: "thinking" },
			{ text: "still thinking" },
			{ text: "more thinking" },
		]);
		await expect(
			run({ workspace: fakeWorkspace(), step: scripted.step }),
		).resolves.toMatchObject({
			kind: "protocol-failure",
			code: "no-tool-call",
		});
	});
});

describe("accepted input requirement parity", () => {
	function visitBrief(requiredWhen?: string): SliceExecutionBrief {
		const base = makeContract();
		const contract = appDesignContractSchema.parse({
			...base,
			workflows: base.workflows.map((workflow) =>
				workflow.id !== ids.taskVisit
					? workflow
					: {
							...workflow,
							inputs: workflow.inputs.map((input) =>
								input.handle !== "visit_summary" || requiredWhen === undefined
									? input
									: { ...input, requiredWhen },
							),
						},
			),
		});
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"visit workflow slice",
		);
		return deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		});
	}

	function visitDoc(required: boolean): BlueprintDoc {
		return buildDoc({
			appName: "Patient tracker",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patient care",
					caseType: "patient",
					forms: [
						{
							name: "Record visit",
							type: "followup",
							fields: [
								{
									kind: "group",
									id: "visit_notes",
									children: [
										{
											kind: "text",
											id: "visit_summary",
											...(required && { required: xp("true()") }),
										},
									],
								},
							],
						},
					],
				},
			],
		});
	}

	function visitHandles(doc: BlueprintDoc, sliceBrief: SliceExecutionBrief) {
		const moduleUuid = fixtureValue(doc.moduleOrder[0], "visit module");
		const realization = fixtureValue(
			sliceBrief.moduleRealizations[0],
			"visit module realization",
		);
		return [
			{
				handle: realization.blueprintModuleHandle,
				uuid: moduleUuid,
				entityKind: "module",
			},
		];
	}

	it("rejects record-level requiredness that leaked onto an optional workflow input", () => {
		const doc = visitDoc(true);
		const sliceBrief = visitBrief();
		const issues = acceptedInputRequirementIssues(
			doc,
			sliceBrief,
			visitHandles(doc, sliceBrief),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			code: "ACCEPTED_INPUT_REQUIREMENT_MISMATCH",
			details: {
				inputHandle: "visit_summary",
				blueprintFieldId: "visit_summary",
				acceptedRequiredWhen: null,
				realizedRequired: true,
			},
		});
	});

	it("requires the realized field to carry an accepted input requirement", () => {
		const missingDoc = visitDoc(false);
		const requiredBrief = visitBrief("Always during a visit");
		const issues = acceptedInputRequirementIssues(
			missingDoc,
			requiredBrief,
			visitHandles(missingDoc, requiredBrief),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.details).toMatchObject({
			acceptedRequiredWhen: "Always during a visit",
			realizedRequired: false,
		});
		const realizedDoc = visitDoc(true);
		expect(
			acceptedInputRequirementIssues(
				realizedDoc,
				requiredBrief,
				visitHandles(realizedDoc, requiredBrief),
			),
		).toEqual([]);
	});
});

describe("accepted composition admission", () => {
	it("allows a child viewer to bootstrap top-level until its parent exists", () => {
		const contract = makeNestedMenuContract();
		const childComposition = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"child slice",
		);
		const sliceBrief = deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		});
		const childRealization = fixtureValue(
			sliceBrief.moduleRealizations.find(
				(realization) => realization.compositionId === ids.moduleVisits,
			),
			"child realization",
		);
		const workspace = fakeWorkspace({
			doc: emptyBlueprintDoc("app-executor-test"),
		});

		expect(
			compositionAdmissionIssue(
				"createModule",
				{
					moduleUuid: { handle: childRealization.blueprintModuleHandle },
					name: childComposition.name,
					case_type: childRealization.hostRecord?.blueprintCaseType,
					forms: [],
				},
				sliceBrief,
				workspace,
			),
		).toBeNull();
	});

	it("uses the compiler-owned handle to distinguish equal module semantics", () => {
		const contract = makeNestedMenuContract();
		const parentComposition = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.modulePatients,
			),
			"parent module composition",
		);
		const childComposition = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		childComposition.name = parentComposition.name;
		childComposition.parentModuleCompositionId = undefined;
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"second root slice",
		);
		const sliceBrief = deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		});
		const parentRealization = fixtureValue(
			sliceBrief.moduleRealizations.find(
				(realization) => realization.compositionId === ids.modulePatients,
			),
			"parent realization",
		);
		const childRealization = fixtureValue(
			sliceBrief.moduleRealizations.find(
				(realization) => realization.compositionId === ids.moduleVisits,
			),
			"child realization",
		);
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: parentComposition.name,
					caseType: "patient",
					caseListOnly: true,
					forms: [],
				},
			],
		});
		const parentUuid = fixtureValue(doc.moduleOrder[0], "parent module");
		const workspace = fakeWorkspace({ doc });
		workspace.currentExecutionCheckpoint = () => ({
			handles: [
				{
					handle: parentRealization.blueprintModuleHandle,
					uuid: parentUuid,
					entityKind: "module",
				},
			],
		});
		const input = {
			name: childComposition.name,
			case_type: "patient",
			forms: [],
		};
		expect(
			compositionAdmissionIssue(
				"createModule",
				{
					...input,
					moduleUuid: { handle: childRealization.blueprintModuleHandle },
				},
				sliceBrief,
				workspace,
			),
		).toBeNull();
		expect(
			compositionAdmissionIssue(
				"createModule",
				{
					...input,
					moduleUuid: { handle: parentRealization.blueprintModuleHandle },
				},
				sliceBrief,
				workspace,
			),
		).toContain("blueprintModuleHandle");
	});

	it("keeps a selected-record form on the accepted host module", () => {
		const base = makeContract();
		const contract = appDesignContractSchema.parse({
			...base,
			records: base.records.map((record) => ({
				...record,
				name:
					record.id === ids.recPatient
						? "Beneficiary"
						: record.id === ids.recVisit
							? "Referral"
							: record.name,
			})),
		});
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"referral workflow slice",
		);
		const visitBrief = deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		});
		const doc = buildDoc({
			appName: "Referral tracker",
			caseTypes: [
				{ name: "beneficiary", properties: [] },
				{ name: "referral", properties: [] },
			],
			modules: [
				{ name: "Beneficiaries", caseType: "beneficiary", forms: [] },
				{ name: "Referrals", caseType: "referral", forms: [] },
			],
		});
		const beneficiaryModuleUuid = fixtureValue(
			doc.moduleOrder[0],
			"beneficiary module",
		);
		const referralModuleUuid = fixtureValue(
			doc.moduleOrder[1],
			"referral module",
		);
		const acceptedModuleHandle = fixtureValue(
			visitBrief.moduleRealizations.find(
				(realization) => realization.compositionId === ids.modulePatients,
			),
			"accepted beneficiary module realization",
		).blueprintModuleHandle;
		const workspace = fakeWorkspace({ doc });
		workspace.currentExecutionCheckpoint = () => ({
			handles: [
				{
					handle: acceptedModuleHandle,
					uuid: beneficiaryModuleUuid,
					entityKind: "module",
				},
				{
					handle: "@referrals",
					uuid: referralModuleUuid,
					entityKind: "module",
				},
			],
		});
		expect(
			compositionAdmissionIssue(
				"createForm",
				{
					moduleUuid: { handle: "@referrals" },
					name: "Record visit",
					type: "followup",
				},
				visitBrief,
				workspace,
			),
		).toContain("child/outcome record");
		expect(
			compositionAdmissionIssue(
				"createForm",
				{
					moduleUuid: { handle: acceptedModuleHandle },
					name: "Record visit",
					type: "followup",
				},
				visitBrief,
				workspace,
			),
		).toBeNull();
	});
});
