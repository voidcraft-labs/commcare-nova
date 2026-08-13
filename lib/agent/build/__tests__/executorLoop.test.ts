/**
 * The slice executor loop — the one-call law, staged dispatch, the
 * server-owned commit precondition, escalation, terminal protocol errors, and
 * every budget axis.
 *
 * Fully offline: a scripted `ExecutorStepFn` stands in for the model, and a
 * fake workspace implements exactly the three operations the loop uses.
 */

import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	BLOCKER_RESOLUTION_ALLOWANCE,
	budgetForSlice,
} from "@/lib/agent/build/budgets";
import {
	deriveSliceExecutionBrief,
	type SliceExecutionBrief,
} from "@/lib/agent/build/executionBrief";
import {
	buildExecutorTools,
	type ExecutorConversationContext,
	type ExecutorStepFn,
	type ExecutorToolOutcomeEvent,
	type ExecutorWorkspace,
	recoverCommittedExecutorToolResult,
	renderExecutorWorkspaceSummary,
	runSliceExecutor,
	type SliceCommitResult,
} from "@/lib/agent/build/executorLoop";
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
} from "@/lib/agent/design/__tests__/fixtures";
import type { WorkspaceSnapshot } from "@/lib/agent/workspace/types";
import type { BlueprintDoc } from "@/lib/domain";
import { conversationPayloadSchema } from "@/lib/log/types";

// ── Fixtures ─────────────────────────────────────────────────────────

function brief(): SliceExecutionBrief {
	const plan = makeBuildPlan();
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: fixtureValue(plan.slices[0], "first slice").id,
	});
}

const TEST_CONSTRUCTION_GROUP_ID = fixtureValue(
	brief().constructionGroupIds[0],
	"first construction group",
);

const EMPTY_DOC = {
	modules: {},
	moduleOrder: [],
	forms: {},
	fields: {},
} as unknown as BlueprintDoc;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: ((value: T) => void) | undefined;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return {
		promise,
		resolve: (value) => {
			if (resolve === undefined) throw new Error("deferred promise not ready");
			resolve(value);
		},
	};
}

function diagnostics(
	overrides: Partial<ChangeSetDiagnostics> = {},
): ChangeSetDiagnostics {
	return {
		snapshotRevision: 1,
		candidateDigest: "d".repeat(64),
		allFindings: [],
		introducedSincePreviousStep: [],
		resolvedSincePreviousStep: [],
		readSetStatus: [],
		sliceIntentCoverage: brief().constructionGroupIds.map((intentId) => ({
			intentId,
			stepCount: 1,
		})),
		canCommit: true,
		...overrides,
	};
}

const BLOCKING_DIAGNOSTICS = diagnostics({
	canCommit: false,
	allFindings: [
		{ code: "EMPTY_FORM", message: "This form has no questions." },
	] as unknown as ChangeSetDiagnostics["allFindings"],
});

interface FakeWorkspace extends ExecutorWorkspace {
	readonly staged: { toolName: string; requestId: string; input: unknown }[];
	inspectCalls: number;
}

function fakeWorkspace(options?: {
	inspect?: () => Promise<ChangeSetDiagnostics>;
	executionCheckpoint?: ReturnType<
		ExecutorWorkspace["currentExecutionCheckpoint"]
	>;
	stage?: (args: {
		toolName: string;
		requestId: string;
		input: unknown;
		deadlineAt?: number;
	}) => Promise<unknown>;
}): FakeWorkspace {
	const staged: FakeWorkspace["staged"] = [];
	const workspace: FakeWorkspace = {
		staged,
		inspectCalls: 0,
		currentSnapshot(): WorkspaceSnapshot {
			return {
				doc: EMPTY_DOC,
				revision: 1,
				canonicalSeq: null,
				projectId: "project-1",
			};
		},
		currentExecutionCheckpoint() {
			return (
				options?.executionCheckpoint ?? {
					intentCoverage: [],
					handles: [],
				}
			);
		},
		async stageDispatch(args) {
			staged.push({
				toolName: args.toolName,
				requestId: args.requestId,
				input: args.input,
			});
			const result = options?.stage
				? await options.stage(args)
				: {
						kind: "mutate",
						mutations: [],
						result: {
							message: `Staged ${args.toolName}.`,
							summary: { action: "internal" },
						},
					};
			return { replayed: false, result };
		},
		async inspect() {
			workspace.inspectCalls += 1;
			return options?.inspect
				? await options.inspect()
				: diagnostics({ canCommit: false });
		},
	};
	return workspace;
}

it("checkpoints the identities needed to continue after compaction", () => {
	const doc = buildDoc({
		appName: "Referral tracker",
		caseTypes: [
			{
				name: "referral",
				properties: [{ name: "status", label: "Status", data_type: "text" }],
			},
		],
		modules: [
			{
				name: "Referrals",
				caseType: "referral",
				forms: [
					{
						name: "Follow up",
						type: "followup",
						fields: [f({ kind: "text", id: "notes", label: "Notes" })],
					},
				],
			},
		],
	});
	const userPropertyUuid = testUuid("11111111-1111-4111-8111-111111111111");
	doc.userProperties = {
		[userPropertyUuid]: {
			uuid: userPropertyUuid,
			slug: "staff_role",
			label: "Staff role",
			required: false,
			choices: ["intake", "coordinator"],
		},
	};
	doc.userPropertyOrder = [userPropertyUuid];
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const fieldUuid = doc.fieldOrder[formUuid][0];
	const workspace = fakeWorkspace({
		executionCheckpoint: {
			intentCoverage: [{ intentId: TEST_CONSTRUCTION_GROUP_ID, stepCount: 2 }],
			handles: [
				{
					handle: "@staff_role",
					uuid: userPropertyUuid,
					entityKind: "worker_property",
				},
				{
					handle: "@referrals",
					uuid: moduleUuid,
					entityKind: "module",
				},
				{
					handle: "@follow_up",
					uuid: formUuid,
					entityKind: "form",
				},
				{
					handle: "@notes",
					uuid: fieldUuid,
					entityKind: "field",
				},
			],
		},
	});
	workspace.currentSnapshot = () => ({
		doc,
		revision: 7,
		canonicalSeq: 1,
		projectId: "project-1",
	});

	const summary = renderExecutorWorkspaceSummary(workspace);
	expect(summary).toContain("Revision 7");
	expect(summary).toContain("staff_role (@staff_role)");
	expect(summary).toContain("Case type referral: status");
	expect(summary).toContain("Module @referrals");
	expect(summary).toContain("Form @follow_up");
	expect(summary).toContain("notes:text (@notes)");
	expect(summary).toContain(brief().constructionGroupIds[0]);
	expect(summary).toContain("@staff_role:worker_property");
	expect(summary).not.toContain(userPropertyUuid);
});

type ScriptedStep =
	| { text: string }
	| { calls: { toolCallId: string; toolName: string; input?: unknown }[] };

const VALID_BLOCKER = {
	schemaVersion: 1 as const,
	affectedConstructionGroupIds: [brief().constructionGroupIds[0]],
	observations: ["The current operation cannot satisfy the accepted slice."],
	requestedDecision: "Clarify the safe construction that preserves the design.",
};

function batchInput(toolName: string, input: unknown = {}) {
	const creationIdentity =
		toolName === "stageModule"
			? { moduleUuid: { handle: "@staged_module" } }
			: toolName === "stageForm"
				? {
						formUuid: { handle: "@staged_form" },
						moduleUuid: { handle: "@staged_module" },
					}
				: {};
	return {
		operations: [
			{
				toolName,
				input: {
					...creationIdentity,
					...(input as Record<string, unknown>),
					constructionGroupIds: [brief().constructionGroupIds[0]],
				},
			},
		],
	};
}

function scriptedInput(call: { toolName: string; input?: unknown }): unknown {
	if (call.toolName === "reportExecutionBlocker") {
		return call.input ?? VALID_BLOCKER;
	}
	const input = call.input ?? {};
	const entry = CHANGE_SET_TOOL_REGISTRY.get(call.toolName);
	if (entry?.policy.effect !== "mutate-blueprint") return input;
	return {
		...(input as Record<string, unknown>),
		constructionGroupIds: [brief().constructionGroupIds[0]],
	};
}

/** A scripted model: one entry per step, then it keeps repeating the last. */
function scriptedStep(script: ScriptedStep[]): {
	step: ExecutorStepFn;
	seen: ModelMessage[][];
} {
	const seen: ModelMessage[][] = [];
	let index = 0;
	const step: ExecutorStepFn = async ({ messages }) => {
		seen.push(messages);
		const entry = script[Math.min(index, script.length - 1)];
		index += 1;
		if (entry === undefined || "text" in entry) {
			const text = entry?.text ?? "";
			return {
				toolCalls: [],
				text,
				usage: undefined,
				responseMessages: [{ role: "assistant", content: text }],
			};
		}
		return {
			toolCalls: entry.calls.map((call) => ({
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				input: scriptedInput(call),
			})),
			text: "",
			usage: undefined,
			responseMessages: [
				{
					role: "assistant",
					content: entry.calls.map((call) => ({
						type: "tool-call" as const,
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						input: scriptedInput(call),
					})),
				},
			],
		};
	};
	return { step, seen };
}

function run(args: {
	workspace: ExecutorWorkspace;
	step: ExecutorStepFn;
	commit?: () => Promise<SliceCommitResult>;
	onProgress?: (note: string) => void;
	onUsage?: Parameters<typeof runSliceExecutor>[0]["onUsage"];
	resolveBlocker?: Parameters<typeof runSliceExecutor>[0]["resolveBlocker"];
	onToolOutcome?: Parameters<typeof runSliceExecutor>[0]["onToolOutcome"];
	context?: ExecutorConversationContext;
}) {
	const plan = makeBuildPlan();
	const slice = plan.slices[0];
	if (slice === undefined) throw new Error("fixture slice missing");
	return runSliceExecutor({
		workspace: args.workspace,
		brief: brief(),
		budget: budgetForSlice(slice),
		step: args.step,
		commit:
			args.commit ??
			(async () => {
				throw new Error("commit must not be called");
			}),
		signal: new AbortController().signal,
		resolveBlocker:
			args.resolveBlocker ??
			(async () => ({
				kind: "unsupported" as const,
				reason: "The scripted test ended execution.",
			})),
		...(args.onProgress !== undefined && { onProgress: args.onProgress }),
		...(args.onUsage !== undefined && { onUsage: args.onUsage }),
		...(args.onToolOutcome !== undefined && {
			onToolOutcome: args.onToolOutcome,
		}),
		...(args.context !== undefined && { context: args.context }),
	});
}

/** Every tool result the loop appended, flattened. */
function toolResults(
	messages: ModelMessage[],
): { toolCallId: string; value: unknown }[] {
	const results: { toolCallId: string; value: unknown }[] = [];
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (part.type !== "tool-result") continue;
			results.push({
				toolCallId: part.toolCallId,
				value: part.output.type === "json" ? part.output.value : part.output,
			});
		}
	}
	return results;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runSliceExecutor — the one-call law", () => {
	it("carries one exact append-only context across workflow slices", async () => {
		const plan = makeBuildPlan();
		const firstSlice = fixtureValue(plan.slices[0], "first slice");
		const secondSlice = fixtureValue(plan.slices[1], "second slice");
		const firstBrief = deriveSliceExecutionBrief({
			contract: makeContract(),
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: firstSlice.id,
		});
		const secondBrief = deriveSliceExecutionBrief({
			contract: makeContract(),
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: secondSlice.id,
		});
		const context: ExecutorConversationContext = { messages: [] };
		const first = scriptedStep([{ text: "" }]);
		await runSliceExecutor({
			workspace: fakeWorkspace(),
			brief: firstBrief,
			budget: budgetForSlice(firstSlice),
			step: first.step,
			context,
			contextScopeKey: "attempt-1",
			commit: async () => {
				throw new Error("empty protocol must not commit");
			},
			signal: new AbortController().signal,
		});
		const exactFirstTranscript = structuredClone(context.messages);
		const second = scriptedStep([{ text: "" }]);
		await runSliceExecutor({
			workspace: fakeWorkspace(),
			brief: secondBrief,
			budget: budgetForSlice(secondSlice),
			step: second.step,
			context,
			contextScopeKey: "attempt-2",
			commit: async () => {
				throw new Error("empty protocol must not commit");
			},
			signal: new AbortController().signal,
		});
		const secondOpening = fixtureValue(second.seen[0], "second slice opening");
		expect(secondOpening.slice(0, exactFirstTranscript.length)).toEqual(
			exactFirstTranscript,
		);
		expect(JSON.stringify(secondOpening)).toContain(secondBrief.workflow.name);
		expect(JSON.stringify(secondOpening)).toContain(firstBrief.workflow.name);
	});

	it("keeps the exact prior turn as the next request prefix", async () => {
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "stage",
						toolName: "stageBatch",
						input: batchInput("stageModule"),
					},
				],
			},
			{ calls: [{ toolCallId: "stop", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace: fakeWorkspace(), step });

		const first = seen[0] ?? [];
		const second = seen[1] ?? [];
		expect(JSON.stringify(first)).not.toContain("promptCacheBreakpoint");
		expect(second.slice(0, first.length)).toEqual(first);
		expect(toolResults(second).map((result) => result.toolCallId)).toEqual([
			"stage",
		]);
	});

	it("keeps every read and mutation result in the append-only transcript", async () => {
		const workspace = fakeWorkspace({
			stage: async ({ toolName }) =>
				toolName === "getModule" || toolName === "getForm"
					? { kind: "read", data: { marker: toolName } }
					: {
							kind: "mutate",
							mutations: [],
							result: { message: `Staged ${toolName}.` },
						},
		});
		const read = (toolName: "getModule" | "getForm") => ({
			operations: [{ toolName, input: {} }],
		});
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "module",
						toolName: "readBatch",
						input: read("getModule"),
					},
				],
			},
			{
				calls: [
					{ toolCallId: "form", toolName: "readBatch", input: read("getForm") },
				],
			},
			{
				calls: [
					{
						toolCallId: "stage",
						toolName: "stageBatch",
						input: batchInput("stageModule"),
					},
				],
			},
			{ calls: [{ toolCallId: "stop", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step });

		expect(
			toolResults(seen[2] ?? []).map((result) => result.toolCallId),
		).toEqual(["module", "form"]);
		expect(
			toolResults(seen[3] ?? []).map((result) => result.toolCallId),
		).toEqual(["module", "form", "stage"]);
	});

	it("reads several related structures in one model step", async () => {
		const workspace = fakeWorkspace({
			stage: async ({ toolName }) => ({
				kind: "read",
				data: { marker: toolName },
			}),
		});
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "read",
						toolName: "readBatch",
						input: {
							operations: [
								{
									toolName: "getModule",
									input: {
										moduleUuid: testUuid(
											"11111111-1111-4111-8111-111111111111",
										),
									},
								},
								{
									toolName: "getForm",
									input: {
										formUuid: testUuid("22222222-2222-4222-8222-222222222222"),
									},
								},
							],
						},
					},
				],
			},
			{ calls: [{ toolCallId: "stop", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step });

		expect(workspace.staged.map((entry) => entry.toolName)).toEqual([
			"getModule",
			"getForm",
		]);
		expect(toolResults(seen[1] ?? [])[0]?.value).toMatchObject({
			status: "completed",
			completed: [
				{ index: 0, toolName: "getModule", result: { marker: "getModule" } },
				{ index: 1, toolName: "getForm", result: { marker: "getForm" } },
			],
		});
	});

	it("executes none of a multi-call step and answers both calls", async () => {
		const workspace = fakeWorkspace();
		const { step, seen } = scriptedStep([
			{
				calls: [
					{ toolCallId: "a", toolName: "stageModule", input: { name: "One" } },
					{ toolCallId: "b", toolName: "stageForm", input: { name: "Two" } },
				],
			},
			{ calls: [{ toolCallId: "c", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step });

		expect(workspace.staged).toEqual([]);
		const answered = toolResults(seen[1] ?? []);
		expect(answered).toHaveLength(2);
		for (const result of answered) {
			expect(result.value).toEqual({
				error:
					"One executable call per step; nothing was executed. Re-send exactly one call.",
			});
		}
		expect(answered.map((r) => r.toolCallId)).toEqual(["a", "b"]);
	});

	it("nudges an empty step twice, then fails the protocol", async () => {
		const { step, seen } = scriptedStep([{ text: "Thinking about it." }]);
		const outcome = await run({ workspace: fakeWorkspace(), step });

		expect(outcome).toEqual({
			kind: "protocol-failure",
			code: "no-tool-call",
			message: expect.stringContaining("three consecutive steps"),
		});
		/* Both nudges remain part of the ordinary growing transcript. */
		const nudges = (seen[2] ?? []).filter(
			(message) =>
				message.role === "user" &&
				JSON.stringify(message.content).includes("exactly one tool call"),
		);
		expect(nudges).toHaveLength(2);
	});
});

describe("runSliceExecutor — staged dispatch", () => {
	it("requires durable handles in the canonical creation identity slots", () => {
		const base = brief();
		const definitions = buildExecutorTools({
			...base,
			toolProfile: {
				...base.toolProfile,
				mutationTools: [
					"addUserProperties",
					"addUserTypes",
					"addPersonas",
					"addLocationProperties",
				],
			},
		});

		const batch = definitions?.stageBatch?.inputSchema as {
			properties?: {
				operations?: { items?: { oneOf?: unknown[] } };
			};
		};
		const arms = (batch.properties?.operations?.items?.oneOf ?? []) as Array<{
			properties?: Record<string, unknown>;
		}>;
		const arm = (name: string) =>
			arms.find(
				(candidate) =>
					(candidate.properties?.toolName as { const?: string } | undefined)
						?.const === name,
			);
		const itemSchema = (name: string, collection: string) => {
			const input = arm(name)?.properties?.input as
				| { properties?: Record<string, unknown> }
				| undefined;
			const array = input?.properties?.[collection] as
				| { items?: unknown }
				| undefined;
			return array?.items as
				| { properties?: Record<string, unknown>; required?: string[] }
				| undefined;
		};
		for (const [name, collection, identity] of [
			["addUserProperties", "properties", "userPropertyUuid"],
			["addUserTypes", "userTypes", "userTypeUuid"],
			["addPersonas", "personas", "personaUuid"],
			["addLocationProperties", "properties", "locationPropertyUuid"],
		] as const) {
			const item = itemSchema(name, collection);
			const slot = item?.properties?.[identity] as
				| { properties?: Record<string, unknown> }
				| undefined;
			expect(slot?.properties?.handle).toBeDefined();
			expect(item?.required).toContain(identity);
			expect(item?.properties).not.toHaveProperty("handle");
		}
		expect(
			arms.every(
				(candidate) => !("outputHandles" in (candidate.properties ?? {})),
			),
		).toBe(true);
		expect(itemSchema("stageModule", "modules")).toBeUndefined();
	});

	it("passes the absolute slice deadline into the staging write", async () => {
		const stage = vi.fn(async (_args: { deadlineAt?: number }) => ({
			kind: "mutate",
			mutations: [],
		}));
		const { step } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "stageBatch",
						input: batchInput("stageModule"),
					},
				],
			},
			{ calls: [{ toolCallId: "b", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace: fakeWorkspace({ stage }), step });

		expect(stage).toHaveBeenCalledOnce();
		expect(stage.mock.calls[0]?.[0].deadlineAt).toEqual(expect.any(Number));
	});

	it("dispatches with the tool call id as the staging request id", async () => {
		const workspace = fakeWorkspace();
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "call-42",
						toolName: "stageBatch",
						input: batchInput("stageModule", { name: "Patients" }),
					},
				],
			},
			{ calls: [{ toolCallId: "c", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step });

		expect(workspace.staged).toEqual([
			{
				toolName: "stageModule",
				requestId: "call-42:0",
				input: {
					moduleUuid: { handle: "@staged_module" },
					name: "Patients",
				},
			},
		]);
		/* The envelope is unwrapped and the UI-only summary is stripped. */
		expect(toolResults(seen[1] ?? [])[0]?.value).toMatchObject({
			status: "completed",
			completed: [
				{
					index: 0,
					toolName: "stageModule",
					result: { message: "Staged stageModule." },
				},
			],
		});
	});

	it("refuses an unbound creation identity before shared-tool dispatch", async () => {
		const workspace = fakeWorkspace();
		const outcomes: Array<Record<string, unknown>> = [];
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "raw-creation",
						toolName: "stageBatch",
						input: batchInput("stageModule", {
							moduleUuid: testUuid("raw-created-module"),
							name: "Patients",
						}),
					},
				],
			},
			{ calls: [{ toolCallId: "stop", toolName: "reportExecutionBlocker" }] },
		]);

		await run({
			workspace,
			step,
			onToolOutcome: (event) => {
				outcomes.push({ ...event });
			},
		});

		expect(workspace.staged).toHaveLength(0);
		expect(toolResults(seen[1] ?? [])[0]?.value).toMatchObject({
			status: "stopped",
			failed: {
				index: 0,
				toolName: "stageModule",
				error: "input.moduleUuid must declare a durable handle.",
			},
		});
		expect(outcomes[0]).toEqual({
			modelStep: 1,
			toolName: "stageModule",
			workspaceRevision: 1,
			outcome: "wire-invalid",
			code: "CREATION_HANDLE_REQUIRED",
			operationIndex: 0,
		});
	});

	it("returns a staging rejection as a self-correctable error", async () => {
		const workspace = fakeWorkspace({
			stage: async () => {
				throw new ChangeSetStagingRejectedError(
					"TARGET_INVALID",
					"No module with that identity exists in this change set.",
				);
			},
		});
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "stageBatch",
						input: batchInput("stageForm"),
					},
				],
			},
			{ calls: [{ toolCallId: "b", toolName: "reportExecutionBlocker" }] },
		]);

		const outcome = await run({ workspace, step });

		expect(toolResults(seen[1] ?? [])[0]?.value).toMatchObject({
			status: "stopped",
			failed: {
				index: 0,
				toolName: "stageForm",
				error: "No module with that identity exists in this change set.",
			},
		});
		/* The loop kept going — a rejection is not terminal. */
		expect(outcome.kind).not.toBe("protocol-failure");
	});

	it("stops a batch at the first rejection and preserves its admitted prefix", async () => {
		const workspace = fakeWorkspace({
			stage: async ({ toolName }) => {
				if (toolName === "stageForm") {
					throw new ChangeSetStagingRejectedError(
						"TARGET_INVALID",
						"The form needs a module that exists in the candidate.",
					);
				}
				return {
					kind: "mutate",
					result: { message: `Staged ${toolName}.` },
				};
			},
		});
		const inputFor = (toolName: string) => batchInput(toolName).operations[0];
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "batch",
						toolName: "stageBatch",
						input: {
							operations: [
								inputFor("stageModule"),
								inputFor("stageForm"),
								inputFor("addFields"),
							],
						},
					},
				],
			},
			{ calls: [{ toolCallId: "stop", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step });

		expect(workspace.staged.map((entry) => entry.requestId)).toEqual([
			"batch:0",
			"batch:1",
		]);
		expect(toolResults(seen[1] ?? [])[0]?.value).toMatchObject({
			completed: [{ index: 0, toolName: "stageModule" }],
			failed: { index: 1, toolName: "stageForm" },
			unattemptedCount: 1,
		});
	});

	it("delegates canonical declarations and nested handle references to the durable workspace", async () => {
		const workspace = fakeWorkspace({
			stage: async ({ toolName }) => ({
				kind: "mutate",
				result: { message: `Staged ${toolName}.` },
			}),
		});
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "users",
						toolName: "stageBatch",
						input: {
							operations: [
								{
									toolName: "addUserProperties",
									input: {
										properties: [
											{
												userPropertyUuid: { handle: "@role_property" },
												slug: "role",
												label: "Role",
											},
										],
										constructionGroupIds: [TEST_CONSTRUCTION_GROUP_ID],
									},
								},
								{
									toolName: "addUserTypes",
									input: {
										userTypes: [
											{
												userTypeUuid: { handle: "@supervisor_role" },
												name: "Supervisor",
												values: [
													{
														userPropertyUuid: {
															handle: "@role_property",
														},
														value: "supervisor",
													},
												],
											},
										],
										constructionGroupIds: [TEST_CONSTRUCTION_GROUP_ID],
									},
								},
							],
						},
					},
				],
			},
			{ calls: [{ toolCallId: "stop", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step });

		expect(workspace.staged).toHaveLength(2);
		expect(workspace.staged[0]?.input).toMatchObject({
			properties: [{ userPropertyUuid: { handle: "@role_property" } }],
		});
		expect(workspace.staged[1]?.input).toMatchObject({
			userTypes: [
				{
					userTypeUuid: { handle: "@supervisor_role" },
					values: [{ userPropertyUuid: { handle: "@role_property" } }],
				},
			],
		});
		const result = toolResults(seen[1] ?? [])[0]?.value;
		expect(result).toMatchObject({ status: "completed" });
		expect(result).not.toHaveProperty("bindings");
	});

	it("projects bound result values and object keys back through symbols", async () => {
		const moduleUuid = testUuid("projected-module-result");
		const workspace = fakeWorkspace({
			executionCheckpoint: {
				intentCoverage: [],
				handles: [
					{
						handle: "@patients",
						uuid: moduleUuid,
						entityKind: "module",
					},
				],
			},
			stage: async () => ({
				kind: "mutate",
				result: {
					uuids: [moduleUuid],
					byUuid: { [moduleUuid]: { uuid: moduleUuid } },
				},
			}),
		});
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "module",
						toolName: "stageBatch",
						input: batchInput("stageModule"),
					},
				],
			},
			{ calls: [{ toolCallId: "stop", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step });

		const projected = JSON.stringify(toolResults(seen[1] ?? [])[0]?.value);
		expect(projected).toContain("@patients");
		expect(projected).not.toContain(moduleUuid);
	});

	it("rejects the legacy operation-level outputHandles shape before staging", async () => {
		const workspace = fakeWorkspace();
		const outcomes: Array<Record<string, unknown>> = [];
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "legacy",
						toolName: "stageBatch",
						input: {
							operations: [
								{
									toolName: "addUserProperties",
									input: {
										properties: [{ slug: "role", label: "Role" }],
										constructionGroupIds: [TEST_CONSTRUCTION_GROUP_ID],
									},
									outputHandles: ["@role_property"],
								},
							],
						},
					},
				],
			},
			{ calls: [{ toolCallId: "stop", toolName: "reportExecutionBlocker" }] },
		]);

		await run({
			workspace,
			step,
			onToolOutcome: (event) => {
				outcomes.push({ ...event });
			},
		});

		expect(workspace.staged).toHaveLength(0);
		expect(toolResults(seen[1] ?? [])[0]?.value).toMatchObject({
			error: expect.stringContaining("batch shape is invalid"),
		});
		expect(outcomes[0]).toEqual({
			modelStep: 1,
			toolName: "stageBatch",
			workspaceRevision: 1,
			outcome: "wire-invalid",
			code: "STAGE_BATCH_ENVELOPE_INVALID",
		});
		expect(
			conversationPayloadSchema.safeParse({
				type: "executor-tool-outcome",
				...outcomes[0],
			}).success,
		).toBe(true);
	});

	it("ends the attempt on lost scope", async () => {
		const workspace = fakeWorkspace({
			stage: async () => {
				throw new ChangeSetScopeLostError(
					"This change set is no longer yours.",
				);
			},
		});
		const { step } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "stageBatch",
						input: batchInput("stageModule"),
					},
				],
			},
		]);

		expect(await run({ workspace, step })).toEqual({
			kind: "protocol-failure",
			code: "CHANGE_SET_SCOPE_LOST",
			message: "This change set is no longer yours.",
		});
	});

	it("names the mounted tools when the model invents one", async () => {
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "publishApp" }] },
			{ calls: [{ toolCallId: "b", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace: fakeWorkspace(), step });

		const value = toolResults(seen[1] ?? [])[0]?.value as { error: string };
		expect(value.error).toContain("There is no tool named publishApp");
		expect(value.error).toContain("stageBatch");
		expect(value.error).toContain("commitChangeSet");
	});
});

describe("runSliceExecutor — commit is a request", () => {
	it("refuses to commit while diagnostics block it", async () => {
		const workspace = fakeWorkspace({
			inspect: async () => BLOCKING_DIAGNOSTICS,
		});
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({
				kind: "committed",
				receipt: {} as never,
			}),
		);
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "commitChangeSet" }] },
			{ calls: [{ toolCallId: "b", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step, commit });

		expect(commit).not.toHaveBeenCalled();
		const value = toolResults(seen[1] ?? [])[0]?.value as { error: string };
		expect(value.error).toContain("cannot commit yet");
		expect(value.error).toContain("EMPTY_FORM");
	});

	it("commits once the server's own inspect says it can", async () => {
		const receipt = { id: "receipt-1" } as never;
		const workspace = fakeWorkspace({ inspect: async () => diagnostics() });
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({ kind: "committed", receipt }),
		);
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "commitChangeSet" }] },
		]);

		expect(await run({ workspace, step, commit })).toEqual({
			kind: "committed",
			receipt,
		});
		expect(commit).toHaveBeenCalledTimes(1);
		expect(workspace.inspectCalls).toBe(1);
	});

	it("returns a rebase conflict so the orchestrator can restart from a fresh base", async () => {
		const context: ExecutorConversationContext = { messages: [] };
		const workspace = fakeWorkspace({ inspect: async () => diagnostics() });
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({
				kind: "rebase-conflict",
				report: { steps: ["s1"] },
			}),
		);
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "commitChangeSet" }] },
		]);

		expect(await run({ workspace, step, commit, context })).toEqual({
			kind: "rebase-conflict",
			report: { steps: ["s1"] },
		});
		expect(commit).toHaveBeenCalledTimes(1);
		expect(toolResults(context.messages).at(-1)?.value).toMatchObject({
			report: { steps: ["s1"] },
		});
	});

	it("ends an append-only attempt when inspection finds a stale external read", async () => {
		const context: ExecutorConversationContext = { messages: [] };
		const stale = [
			{
				dependency: {
					kind: "lookup-definition" as const,
					projectId: "project-1",
					tableId: testUuid("stale-table") as never,
					definitionRevision: "1",
				},
				state: "stale" as const,
			},
		];
		const workspace = fakeWorkspace({
			inspect: async () =>
				diagnostics({ canCommit: false, readSetStatus: stale }),
		});
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "inspectChangeSet" }] },
		]);

		expect(await run({ workspace, step, context })).toEqual({
			kind: "read-set-stale",
			stale,
		});
		expect(toolResults(context.messages).at(-1)?.value).toMatchObject({
			stale,
		});
	});

	it("returns a commit-time stale read so the orchestrator can restart", async () => {
		const context: ExecutorConversationContext = { messages: [] };
		const stale = [{ kind: "lookup-definition", state: "stale" }];
		const workspace = fakeWorkspace({ inspect: async () => diagnostics() });
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({
				kind: "read-set-stale",
				stale,
			}),
		);
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "commitChangeSet" }] },
		]);

		expect(await run({ workspace, step, commit, context })).toEqual({
			kind: "read-set-stale",
			stale,
		});
		expect(commit).toHaveBeenCalledTimes(1);
		expect(toolResults(context.messages).at(-1)?.value).toMatchObject({
			stale,
		});
	});

	it("projects bounded diagnostics for inspectChangeSet", async () => {
		const uncovered = brief().constructionGroupIds[0];
		const workspace = fakeWorkspace({
			inspect: async () =>
				diagnostics({
					canCommit: false,
					sliceIntentCoverage: brief()
						.constructionGroupIds.slice(1)
						.map((intentId) => ({
							intentId,
							stepCount: 1,
						})),
					introducedSincePreviousStep: ["aaaa"],
					allFindings: Array.from({ length: 25 }, (_, index) => ({
						code: `CODE_${index}`,
						message: `Finding ${index}`,
						...(index === 0 && {
							location: {
								formUuid: "11111111-1111-4111-8111-111111111111",
								field: "22222222-2222-4222-8222-222222222222",
							},
							details: {
								operationUuid: "22222222-2222-4222-8222-222222222222",
								operationId: "finalize",
							},
						}),
					})) as unknown as ChangeSetDiagnostics["allFindings"],
				}),
		});
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "inspectChangeSet" }] },
			{ calls: [{ toolCallId: "b", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step });

		const value = toolResults(seen[1] ?? [])[0]?.value as {
			findingCount: number;
			findings: unknown[];
			truncated: { shown: number; total: number };
			canCommit: boolean;
			introducedSincePreviousStep: string[];
			remainingConstructionGroupIds: string[];
		};
		expect(value.findingCount).toBe(25);
		expect(value.findings).toHaveLength(20);
		expect(value.findings[0]).toMatchObject({
			location: {
				formUuid: "11111111-1111-4111-8111-111111111111",
				field: "22222222-2222-4222-8222-222222222222",
			},
			details: {
				operationUuid: "22222222-2222-4222-8222-222222222222",
				operationId: "finalize",
			},
		});
		expect(value.truncated).toEqual({ shown: 20, total: 25 });
		expect(value.canCommit).toBe(false);
		expect(value.introducedSincePreviousStep).toEqual(["aaaa"]);
		expect(value.remainingConstructionGroupIds).toEqual([uncovered]);
	});

	it("refuses a commit request until durable steps cover every construction group", async () => {
		const uncovered = brief().constructionGroupIds[0];
		const workspace = fakeWorkspace({
			inspect: async () =>
				diagnostics({
					canCommit: true,
					sliceIntentCoverage: brief()
						.constructionGroupIds.slice(1)
						.map((intentId) => ({
							intentId,
							stepCount: 1,
						})),
				}),
		});
		const commit = vi.fn();
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "commitChangeSet" }] },
			{ calls: [{ toolCallId: "b", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace, step, commit });

		expect(commit).not.toHaveBeenCalled();
		expect(toolResults(seen[1] ?? [])[0]?.value).toMatchObject({
			remainingConstructionGroupIds: [uncovered],
		});
	});
});

describe("runSliceExecutor — architect blocker resolution", () => {
	it("lets the server-owned architect classify a valid compiler report", async () => {
		const persisted: string[] = [];
		const context: ExecutorConversationContext = {
			messages: [],
			append: async (appendKey) => {
				persisted.push(appendKey);
			},
		};
		const { step } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "reportExecutionBlocker",
						input: VALID_BLOCKER,
					},
				],
			},
		]);

		const outcome = await run({
			workspace: fakeWorkspace(),
			step,
			context,
			resolveBlocker: async () => ({
				kind: "ask-user",
				question: "Which workflow should be available first?",
				options: [],
			}),
		});

		expect(outcome).toEqual({
			kind: "architect-decision",
			decision: {
				kind: "ask-user",
				question: "Which workflow should be available first?",
				options: [],
			},
		});
		expect(persisted.at(-1)).toMatch(/:tool:a$/);
		expect(toolResults(context.messages)).toEqual([
			expect.objectContaining({ toolCallId: "a" }),
		]);
	});

	it("returns an error and keeps going on an invalid blocker report", async () => {
		const workspace = fakeWorkspace();
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "reportExecutionBlocker",
						input: { ...VALID_BLOCKER, affectedConstructionGroupIds: [] },
					},
				],
			},
			{
				calls: [
					{
						toolCallId: "b",
						toolName: "reportExecutionBlocker",
						input: VALID_BLOCKER,
					},
				],
			},
		]);

		const outcome = await run({ workspace, step });

		const value = toolResults(seen[1] ?? [])[0]?.value as { error: string };
		expect(value.error).toContain("blocker report is invalid");
		expect(value.error).toContain("affectedConstructionGroupIds");
		expect(outcome.kind).toBe("architect-decision");
	});
});

describe("runSliceExecutor — budgets", () => {
	it("grants the priced allowance for an answered architect blocker", async () => {
		/* Session five's slice three died at its base cap after two honest
		 * blockers whose architect guidance directed a rehosting the plan
		 * never priced. Each paid `continue` decision now grows the limits. */
		const workspace = fakeWorkspace({
			inspect: async () => BLOCKING_DIAGNOSTICS,
		});
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "b", toolName: "reportExecutionBlocker" }] },
			{ calls: [{ toolCallId: "read", toolName: "inspectChangeSet" }] },
		]);
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const outcome = await runSliceExecutor({
			workspace,
			brief: brief(),
			budget: { ...budgetForSlice(slice), maxModelSteps: 2 },
			step,
			commit: async () => {
				throw new Error("commit must not be called");
			},
			signal: new AbortController().signal,
			resolveBlocker: async () => ({
				kind: "continue" as const,
				guidance: "Lower the reserved property and continue.",
			}),
		});
		expect(outcome).toEqual({
			kind: "budget-exhausted",
			spent: {
				modelSteps: 2 + BLOCKER_RESOLUTION_ALLOWANCE.modelSteps,
				stagedRequests: 0,
			},
		});
	});

	it("commits a clean fully accepted repair at the model-step boundary", async () => {
		const workspace = fakeWorkspace({
			inspect: vi
				.fn<() => Promise<ChangeSetDiagnostics>>()
				.mockResolvedValueOnce(BLOCKING_DIAGNOSTICS)
				.mockResolvedValueOnce(diagnostics()),
		});
		const receipt = { id: "boundary-receipt" } as never;
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({ kind: "committed", receipt }),
		);
		const outcomes: ExecutorToolOutcomeEvent[] = [];
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "inspect", toolName: "inspectChangeSet" }] },
			{
				calls: [
					{
						toolCallId: "repair",
						toolName: "stageBatch",
						input: batchInput("stageModule"),
					},
				],
			},
		]);
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");

		const outcome = await runSliceExecutor({
			workspace,
			brief: brief(),
			budget: { ...budgetForSlice(slice), maxModelSteps: 2 },
			step,
			commit,
			signal: new AbortController().signal,
			onToolOutcome: (event) => {
				outcomes.push(event);
			},
		});

		expect(outcome).toEqual({ kind: "committed", receipt });
		expect(commit).toHaveBeenCalledTimes(1);
		expect(workspace.inspectCalls).toBe(2);
		expect(outcomes.at(-1)).toMatchObject({
			modelStep: 2,
			toolName: "commitChangeSet",
			outcome: "committed",
			code: "CHANGE_SET_COMMITTED_AT_STEP_BOUNDARY",
		});
	});

	it("does not finalize a clean prefix from a stopped repair batch", async () => {
		let staged = 0;
		const workspace = fakeWorkspace({
			inspect: async () => diagnostics(),
			stage: async () => {
				staged += 1;
				return staged === 1
					? {
							kind: "mutate",
							mutations: [],
							result: { message: "Staged the prefix." },
						}
					: {
							kind: "mutate",
							mutations: [],
							result: { error: "The dependent repair did not stage." },
						};
			},
		});
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({
				kind: "committed",
				receipt: {} as never,
			}),
		);
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "inspect", toolName: "inspectChangeSet" }] },
			{
				calls: [
					{
						toolCallId: "repair",
						toolName: "stageBatch",
						input: {
							operations: [
								batchInput("stageModule").operations[0],
								batchInput("stageForm").operations[0],
							],
						},
					},
				],
			},
		]);
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");

		expect(
			await runSliceExecutor({
				workspace,
				brief: brief(),
				budget: { ...budgetForSlice(slice), maxModelSteps: 2 },
				step,
				commit,
				signal: new AbortController().signal,
			}),
		).toEqual({
			kind: "budget-exhausted",
			spent: { modelSteps: 2, stagedRequests: 2 },
		});
		expect(commit).not.toHaveBeenCalled();
	});

	it("does not carry boundary-finalization eligibility across a step that executes nothing", async () => {
		const finalSteps = [
			{ text: "The work is done." },
			{
				calls: [
					{ toolCallId: "first", toolName: "inspectChangeSet" },
					{ toolCallId: "second", toolName: "commitChangeSet" },
				],
			},
		] satisfies ScriptedStep[];

		for (const finalStep of finalSteps) {
			const workspace = fakeWorkspace({ inspect: async () => diagnostics() });
			const commit = vi.fn(
				async (): Promise<SliceCommitResult> => ({
					kind: "committed",
					receipt: {} as never,
				}),
			);
			const { step } = scriptedStep([
				{
					calls: [{ toolCallId: "inspect", toolName: "inspectChangeSet" }],
				},
				finalStep,
			]);
			const plan = makeBuildPlan();
			const slice = fixtureValue(plan.slices[0], "first slice");

			expect(
				await runSliceExecutor({
					workspace,
					brief: brief(),
					budget: { ...budgetForSlice(slice), maxModelSteps: 2 },
					step,
					commit,
					signal: new AbortController().signal,
				}),
			).toEqual({
				kind: "budget-exhausted",
				spent: { modelSteps: 2, stagedRequests: 0 },
			});
			expect(commit).not.toHaveBeenCalled();
		}
	});

	it("bounds a provider step even when the provider ignores abort", async () => {
		const plan = makeBuildPlan();
		const slice = plan.slices[0];
		if (slice === undefined) throw new Error("fixture slice missing");
		const pendingStep = deferred<Awaited<ReturnType<ExecutorStepFn>>>();
		const step: ExecutorStepFn = () => pendingStep.promise;
		const outcome = await runSliceExecutor({
			workspace: fakeWorkspace(),
			brief: brief(),
			budget: { ...budgetForSlice(slice), maxWallClockMs: 10 },
			step,
			commit: async () => {
				throw new Error("commit must not be called");
			},
			signal: new AbortController().signal,
		});
		expect(outcome).toEqual({
			kind: "budget-exhausted",
			spent: { modelSteps: 1, stagedRequests: 0 },
		});
		pendingStep.resolve({
			toolCalls: [],
			text: "",
			usage: undefined,
			responseMessages: [],
		});
		await pendingStep.promise;
	});

	it("bounds an awaited commit even when the callback ignores abort", async () => {
		const plan = makeBuildPlan();
		const slice = plan.slices[0];
		if (slice === undefined) throw new Error("fixture slice missing");
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "commit", toolName: "commitChangeSet" }] },
		]);
		const pendingCommit = deferred<SliceCommitResult>();
		const outcome = await runSliceExecutor({
			workspace: fakeWorkspace({ inspect: async () => diagnostics() }),
			brief: brief(),
			budget: { ...budgetForSlice(slice), maxWallClockMs: 10 },
			step,
			commit: async () => pendingCommit.promise,
			signal: new AbortController().signal,
		});
		expect(outcome).toEqual({
			kind: "budget-exhausted",
			spent: { modelSteps: 1, stagedRequests: 0 },
		});
		pendingCommit.resolve({
			kind: "gate-rejected",
			message: "settled after deadline",
		});
		await pendingCommit.promise;
		await Promise.resolve();
	});

	it("reconciles a durable commit whose response loses the deadline race", async () => {
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "commit", toolName: "commitChangeSet" }] },
		]);
		const pendingCommit = deferred<SliceCommitResult>();
		const receipt = {} as never;
		const reconcileCommit = vi.fn(
			async (): Promise<SliceCommitResult> => ({
				kind: "committed",
				receipt,
			}),
		);
		const outcome = await runSliceExecutor({
			workspace: fakeWorkspace({ inspect: async () => diagnostics() }),
			brief: brief(),
			budget: { ...budgetForSlice(slice), maxWallClockMs: 10 },
			step,
			commit: async () => pendingCommit.promise,
			reconcileCommit,
			signal: new AbortController().signal,
		});
		expect(outcome).toEqual({ kind: "committed", receipt });
		expect(reconcileCommit).toHaveBeenCalledOnce();
		pendingCommit.resolve({
			kind: "gate-rejected",
			message: "the response settled after reconciliation",
		});
		await pendingCommit.promise;
	});

	it("continues from durable attempt counters instead of resetting them", async () => {
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const step = vi.fn<ExecutorStepFn>();
		const claim = vi.fn(async () => "claimed" as const);
		const budget = { ...budgetForSlice(slice), maxModelSteps: 3 };
		const outcome = await runSliceExecutor({
			workspace: fakeWorkspace(),
			brief: brief(),
			budget,
			budgetLedger: {
				deadlineAt: Date.now() + budget.maxWallClockMs,
				/* The restored blocker raises the step limit by one allowance,
				 * so the restored step count sits exactly at that raised limit
				 * and the recovered attempt is exhausted without a fresh call. */
				spent: {
					modelSteps: 3 + BLOCKER_RESOLUTION_ALLOWANCE.modelSteps,
					stagedRequests: 2,
					commitAttempts: 1,
					blockerReports: 1,
				},
				finalizationCheckpoint: {
					validationRequested: false,
					eligible: false,
				},
				claim,
				checkpointFinalization: vi.fn(async () => undefined),
			},
			step,
			commit: async () => {
				throw new Error("commit must not be called");
			},
			signal: new AbortController().signal,
		});
		expect(outcome).toEqual({
			kind: "budget-exhausted",
			spent: {
				modelSteps: 3 + BLOCKER_RESOLUTION_ALLOWANCE.modelSteps,
				stagedRequests: 2,
			},
		});
		expect(step).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});

	it("recovers a persisted finalization checkpoint at the model-step limit", async () => {
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const budget = { ...budgetForSlice(slice), maxModelSteps: 3 };
		const receipt = { id: "recovered-boundary-receipt" } as never;
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({ kind: "committed", receipt }),
		);
		const claim = vi.fn(async () => "claimed" as const);
		const step = vi.fn<ExecutorStepFn>();

		await expect(
			runSliceExecutor({
				workspace: fakeWorkspace({ inspect: async () => diagnostics() }),
				brief: brief(),
				budget,
				budgetLedger: {
					deadlineAt: Date.now() + budget.maxWallClockMs,
					spent: {
						modelSteps: 3,
						stagedRequests: 1,
						commitAttempts: 0,
						blockerReports: 0,
					},
					finalizationCheckpoint: {
						validationRequested: true,
						eligible: true,
					},
					claim,
					checkpointFinalization: vi.fn(async () => undefined),
				},
				step,
				commit,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ kind: "committed", receipt });
		expect(step).not.toHaveBeenCalled();
		expect(claim).toHaveBeenCalledWith(
			"commitAttempts",
			budget.maxCommitAttempts,
			expect.stringMatching(/^commit-boundary:/),
		);
		expect(commit).toHaveBeenCalledOnce();
	});

	it("clears finalization eligibility when the final model step's commit is rejected", async () => {
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const budget = { ...budgetForSlice(slice), maxModelSteps: 1 };
		const checkpointFinalization = vi.fn(
			async (_checkpoint: {
				validationRequested: boolean;
				eligible: boolean;
			}) => undefined,
		);
		const commit = vi
			.fn<() => Promise<SliceCommitResult>>()
			.mockResolvedValueOnce({
				kind: "gate-rejected",
				message: "repair needed",
			})
			.mockResolvedValueOnce({ kind: "committed", receipt: {} as never });
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "commit", toolName: "commitChangeSet" }] },
		]);

		await expect(
			runSliceExecutor({
				workspace: fakeWorkspace({ inspect: async () => diagnostics() }),
				brief: brief(),
				budget,
				budgetLedger: {
					deadlineAt: Date.now() + budget.maxWallClockMs,
					spent: {
						modelSteps: 0,
						stagedRequests: 0,
						commitAttempts: 0,
						blockerReports: 0,
					},
					finalizationCheckpoint: {
						validationRequested: false,
						eligible: false,
					},
					claim: vi.fn(async () => "claimed" as const),
					checkpointFinalization,
				},
				step,
				commit,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({
			kind: "budget-exhausted",
			spent: { modelSteps: 1, stagedRequests: 0 },
		});
		expect(commit).toHaveBeenCalledOnce();
		expect(checkpointFinalization.mock.calls.at(-1)?.[0]).toEqual({
			validationRequested: true,
			eligible: false,
		});
	});

	it("clears a recovered finalization checkpoint after the canonical gate rejects", async () => {
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const budget = { ...budgetForSlice(slice), maxModelSteps: 1 };
		const checkpointFinalization = vi.fn(
			async (_checkpoint: {
				validationRequested: boolean;
				eligible: boolean;
			}) => undefined,
		);
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({
				kind: "gate-rejected",
				message: "repair needed",
			}),
		);

		await expect(
			runSliceExecutor({
				workspace: fakeWorkspace({ inspect: async () => diagnostics() }),
				brief: brief(),
				budget,
				budgetLedger: {
					deadlineAt: Date.now() + budget.maxWallClockMs,
					spent: {
						modelSteps: 1,
						stagedRequests: 0,
						commitAttempts: 0,
						blockerReports: 0,
					},
					finalizationCheckpoint: {
						validationRequested: true,
						eligible: true,
					},
					claim: vi.fn(async () => "claimed" as const),
					checkpointFinalization,
				},
				step: vi.fn<ExecutorStepFn>(),
				commit,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({
			kind: "budget-exhausted",
			spent: { modelSteps: 1, stagedRequests: 0 },
		});
		expect(commit).toHaveBeenCalledOnce();
		expect(checkpointFinalization).toHaveBeenCalledWith({
			validationRequested: true,
			eligible: false,
		});
	});

	it("recovers when the final repair stage committed before its attempt checkpoint", async () => {
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const budget = { ...budgetForSlice(slice), maxModelSteps: 3 };
		const receipt = { id: "atomic-stage-boundary-receipt" } as never;
		const commit = vi.fn(
			async (): Promise<SliceCommitResult> => ({ kind: "committed", receipt }),
		);
		const claim = vi.fn(async () => "claimed" as const);

		await expect(
			runSliceExecutor({
				workspace: fakeWorkspace({
					inspect: async () => diagnostics(),
					executionCheckpoint: {
						intentCoverage: [],
						handles: [],
						finalizationModelStep: 3,
					},
				}),
				brief: brief(),
				budget,
				budgetLedger: {
					deadlineAt: Date.now() + budget.maxWallClockMs,
					spent: {
						modelSteps: 3,
						stagedRequests: 1,
						commitAttempts: 0,
						blockerReports: 0,
					},
					finalizationCheckpoint: {
						validationRequested: true,
						eligible: false,
					},
					claim,
					checkpointFinalization: vi.fn(async () => undefined),
				},
				step: vi.fn<ExecutorStepFn>(),
				commit,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ kind: "committed", receipt });
		expect(claim).toHaveBeenCalledWith(
			"commitAttempts",
			budget.maxCommitAttempts,
			expect.stringMatching(/^commit-boundary:/),
		);
		expect(commit).toHaveBeenCalledOnce();
	});

	it("exhausts on model steps without claiming completion", async () => {
		const workspace = fakeWorkspace();
		const { step } = scriptedStep([
			{
				calls: [
					{ toolCallId: "a", toolName: "stageModule" },
					{ toolCallId: "b", toolName: "stageForm" },
				],
			},
		]);
		const plan = makeBuildPlan();
		const slice = plan.slices[0];
		if (slice === undefined) throw new Error("fixture slice missing");
		const budget = { ...budgetForSlice(slice), maxModelSteps: 3 };

		const outcome = await runSliceExecutor({
			workspace,
			brief: brief(),
			budget,
			step,
			commit: async () => {
				throw new Error("commit must not be called");
			},
			signal: new AbortController().signal,
		});

		expect(outcome).toEqual({
			kind: "budget-exhausted",
			spent: { modelSteps: 3, stagedRequests: 0 },
		});
	});

	it("exhausts on staged requests", async () => {
		const workspace = fakeWorkspace();
		const { step } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "stageBatch",
						input: batchInput("stageModule"),
					},
				],
			},
		]);
		const plan = makeBuildPlan();
		const slice = plan.slices[0];
		if (slice === undefined) throw new Error("fixture slice missing");
		const budget = {
			...budgetForSlice(slice),
			maxModelSteps: 50,
			maxStagedRequests: 2,
		};

		const outcome = await runSliceExecutor({
			workspace,
			brief: brief(),
			budget,
			step,
			commit: async () => {
				throw new Error("commit must not be called");
			},
			signal: new AbortController().signal,
		});

		expect(outcome.kind).toBe("budget-exhausted");
		expect(workspace.staged).toHaveLength(2);
	});
});

describe("runSliceExecutor — plumbing", () => {
	it("replays a durable unanswered tool call without another provider request", async () => {
		const scopeKey = "attempt-recovery";
		const input = batchInput("stageModule");
		const response: ModelMessage = {
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "durable-stage-call",
					toolName: "stageBatch",
					input,
				},
			],
		};
		const responseKey = `step:${scopeKey}:1:response`;
		const context: ExecutorConversationContext = {
			messages: [response],
			items: [{ appendKey: responseKey, message: response }],
			appendKeys: new Set([responseKey]),
			completedStepKeys: new Set([`${scopeKey}:1`]),
		};
		const workspace = fakeWorkspace();
		const providerStep = vi.fn<ExecutorStepFn>(() => {
			throw new Error("recovery must not call the provider");
		});
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const budget = {
			...budgetForSlice(slice),
			maxModelSteps: 1,
			maxStagedRequests: 1,
		};
		const claim = vi.fn(async () => "replayed" as const);

		const outcome = await runSliceExecutor({
			workspace,
			brief: brief(),
			budget,
			budgetLedger: {
				deadlineAt: Date.now() + budget.maxWallClockMs,
				spent: {
					modelSteps: 1,
					stagedRequests: 1,
					commitAttempts: 0,
					blockerReports: 0,
				},
				finalizationCheckpoint: {
					validationRequested: false,
					eligible: false,
				},
				claim,
				checkpointFinalization: vi.fn(async () => undefined),
			},
			context,
			contextScopeKey: scopeKey,
			step: providerStep,
			commit: async () => {
				throw new Error("recovered stage call must not commit");
			},
			signal: new AbortController().signal,
		});

		expect(outcome.kind).toBe("budget-exhausted");
		expect(providerStep).not.toHaveBeenCalled();
		expect(claim).toHaveBeenCalledWith(
			"stagedRequests",
			1,
			`stage:${scopeKey}:1:durable-stage-call:0`,
		);
		expect(workspace.staged).toEqual([
			expect.objectContaining({
				requestId: "durable-stage-call:0",
				toolName: "stageModule",
			}),
		]);
		expect(toolResults(context.messages)).toEqual([
			expect.objectContaining({ toolCallId: "durable-stage-call" }),
		]);
	});

	it("does not purchase a second architect decision for a claimed unanswered blocker", async () => {
		const scopeKey = "attempt-blocker-recovery";
		const response: ModelMessage = {
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "durable-blocker-call",
					toolName: "reportExecutionBlocker",
					input: VALID_BLOCKER,
				},
			],
		};
		const responseKey = `step:${scopeKey}:1:response`;
		const context: ExecutorConversationContext = {
			messages: [response],
			items: [{ appendKey: responseKey, message: response }],
			appendKeys: new Set([responseKey]),
			completedStepKeys: new Set([`${scopeKey}:1`]),
		};
		const resolver = vi.fn(async () => ({
			kind: "continue" as const,
			guidance: "Do not call this resolver again.",
		}));
		const plan = makeBuildPlan();
		const slice = fixtureValue(plan.slices[0], "first slice");
		const budget = { ...budgetForSlice(slice), maxModelSteps: 1 };

		await expect(
			runSliceExecutor({
				workspace: fakeWorkspace(),
				brief: brief(),
				budget,
				budgetLedger: {
					deadlineAt: Date.now() + budget.maxWallClockMs,
					spent: {
						modelSteps: 1,
						stagedRequests: 0,
						commitAttempts: 0,
						blockerReports: 1,
					},
					finalizationCheckpoint: {
						validationRequested: false,
						eligible: false,
					},
					claim: vi.fn(async () => "replayed" as const),
					checkpointFinalization: vi.fn(async () => undefined),
				},
				context,
				contextScopeKey: scopeKey,
				step: vi.fn<ExecutorStepFn>(),
				resolveBlocker: resolver,
				commit: async () => {
					throw new Error("recovered blocker must not commit");
				},
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({
			kind: "protocol-failure",
			code: "architect-decision-response-lost",
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it("pairs a durable commit receipt with its unanswered original call", () => {
		const attemptId = "attempt-committed";
		const response: ModelMessage = {
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "durable-commit-call",
					toolName: "commitChangeSet",
					input: {},
				},
			],
		};
		const context: ExecutorConversationContext = {
			messages: [response],
			items: [{ appendKey: `step:${attemptId}:4:response`, message: response }],
		};
		const receipt = {
			id: "receipt-1",
			designSessionId: "design-session-1",
			designRevisionId: ids.revisionId,
			designRevisionDigest: "a".repeat(64),
			buildPlanId: ids.planId,
			buildPlanDigest: "b".repeat(64),
			sliceId: fixtureValue(makeBuildPlan().slices[0], "first slice").id,
			attemptId,
			changeSetId: "change-set-1",
			appId: "app-1",
			seq: 2,
			batchId: "batch-1",
			committedSnapshotDigest: "c".repeat(64),
			owningIntentIds: [TEST_CONSTRUCTION_GROUP_ID],
			mutationCount: 1,
			committedAt: new Date("2026-08-12T00:00:00.000Z"),
		} satisfies CommittedSliceReceipt;

		const recovered = recoverCommittedExecutorToolResult({
			context,
			attemptId,
			receipt,
		});

		expect(recovered?.appendKey).toBe(
			`step:${attemptId}:4:tool:durable-commit-call`,
		);
		expect(toolResults(recovered === null ? [] : [recovered.message])).toEqual([
			{
				toolCallId: "durable-commit-call",
				value: expect.objectContaining({ committed: true }),
			},
		]);
	});

	it("meters every returned provider step", async () => {
		const usage = {
			inputTokens: 11,
			outputTokens: 7,
			totalTokens: 18,
		} as never;
		const seen: unknown[] = [];
		const step: ExecutorStepFn = async () => ({
			toolCalls: [
				{
					toolCallId: "issue",
					toolName: "reportExecutionBlocker",
					input: VALID_BLOCKER,
				},
			],
			text: "",
			usage,
			responseMessages: [],
		});

		await run({
			workspace: fakeWorkspace(),
			step,
			onUsage: (reported) => seen.push(reported),
		});

		expect(seen).toEqual([usage]);
	});

	it("does not meter a response whose completion evidence failed to persist", async () => {
		const usage = {
			inputTokens: 13,
			outputTokens: 5,
			totalTokens: 18,
		} as never;
		const seen: unknown[] = [];
		const durabilityOrder: string[] = [];
		const step: ExecutorStepFn = async () => ({
			toolCalls: [],
			text: "Observed response",
			usage,
			responseMessages: [{ role: "assistant", content: "Observed response" }],
		});

		await expect(
			run({
				workspace: fakeWorkspace(),
				step,
				onUsage: (reported) => seen.push(reported),
				context: {
					messages: [],
					append: async (appendKey) => {
						durabilityOrder.push(appendKey);
					},
					recordStep: async (_stepKey, event) => {
						if (event.eventKind === "completed") {
							durabilityOrder.push("completed");
							throw new Error("completed ledger unavailable");
						}
					},
				},
			}),
		).rejects.toThrow("completed ledger unavailable");
		expect(seen).toEqual([]);
		expect(durabilityOrder.slice(-2)).toEqual([
			`step:ephemeral:${brief().slice.id}:1:response`,
			"completed",
		]);
	});

	it("refreshes the candidate after every distinct compaction boundary", async () => {
		const context: ExecutorConversationContext = { messages: [] };
		let modelStep = 0;
		const step: ExecutorStepFn = async () => {
			modelStep += 1;
			return {
				toolCalls: [],
				text: "",
				usage: undefined,
				responseMessages: [
					{
						role: "assistant",
						content: [
							{
								type: "custom",
								kind: "openai.compaction",
								value: `checkpoint-${modelStep}`,
							},
						],
					},
				],
			};
		};

		const outcome = await run({ workspace: fakeWorkspace(), step, context });

		expect(outcome.kind).toBe("protocol-failure");
		const refreshKeys = [...(context.appendKeys ?? [])].filter((key) =>
			key.startsWith("compaction-candidate:"),
		);
		expect(refreshKeys).toHaveLength(2);
		expect(refreshKeys[0]).toContain(":1:");
		expect(refreshKeys[1]).toContain(":2:");
	});

	it("opens with a stable brief followed by the current workspace state", async () => {
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace: fakeWorkspace(), step });

		const opening = seen[0];
		expect(opening).toHaveLength(2);
		expect(JSON.stringify(opening?.[0])).toContain("Register patient");
		const checkpoint = JSON.stringify(opening?.[1]);
		expect(checkpoint).toContain("Current change set");
		expect(checkpoint).toContain("Nothing has been staged yet");
	});

	it("emits only coarse, user-safe progress notes", async () => {
		const notes: string[] = [];
		const workspace = fakeWorkspace({ inspect: async () => diagnostics() });
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "inspectChangeSet" }] },
			{ calls: [{ toolCallId: "b", toolName: "commitChangeSet" }] },
		]);

		await run({
			workspace,
			step,
			commit: async () => ({
				kind: "committed",
				receipt: {} as never,
			}),
			onProgress: (note) => notes.push(note),
		});

		expect(notes).toEqual(["building", "validating", "committing"]);
		for (const note of notes) {
			expect(note).not.toMatch(/changeSet|stageModule|uuid/i);
		}
	});
});
