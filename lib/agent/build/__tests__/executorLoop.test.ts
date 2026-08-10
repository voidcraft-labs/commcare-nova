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
import { budgetForSlice } from "@/lib/agent/build/budgets";
import {
	deriveSliceExecutionBrief,
	type SliceExecutionBrief,
} from "@/lib/agent/build/executionBrief";
import {
	type ExecutorStepFn,
	type ExecutorWorkspace,
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
import {
	ids,
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import type { WorkspaceSnapshot } from "@/lib/agent/workspace/types";
import type { BlueprintDoc } from "@/lib/domain";

// ── Fixtures ─────────────────────────────────────────────────────────

function brief(): SliceExecutionBrief {
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan: makeBuildPlan(),
		sliceId: ids.sliceRegister,
	});
}

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
		sliceIntentCoverage: brief().owningIntentIds.map((intentId) => ({
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
	const workspace = fakeWorkspace({
		executionCheckpoint: {
			intentCoverage: [{ intentId: ids.taskRegister, stepCount: 2 }],
			handles: [
				{
					handle: "@registration",
					uuid: testUuid("22222222-2222-4222-8222-222222222222"),
					entityKind: "form",
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
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const fieldUuid = doc.fieldOrder[formUuid][0];
	expect(summary).toContain("Revision 7");
	expect(summary).toContain(`staff_role (${userPropertyUuid})`);
	expect(summary).toContain("Case type referral: status");
	expect(summary).toContain(`Module ${moduleUuid}`);
	expect(summary).toContain(`Form ${formUuid}`);
	expect(summary).toContain(`notes:text (${fieldUuid})`);
	expect(summary).toContain(ids.taskRegister);
	expect(summary).toContain("@registration=form:");
});

type ScriptedStep =
	| { text: string }
	| { calls: { toolCallId: string; toolName: string; input?: unknown }[] };

const VALID_BLOCKER = {
	schemaVersion: 1 as const,
	affectedIntentIds: [ids.taskRegister],
	observations: ["The current operation cannot satisfy the accepted slice."],
	requestedDecision: "Clarify the safe construction that preserves the design.",
};

function batchInput(toolName: string, input: unknown = {}) {
	return {
		operations: [
			{
				toolName,
				input: {
					...(input as Record<string, unknown>),
					implementedIntentIds: [brief().owningIntentIds[0]],
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
		implementedIntentIds: [brief().owningIntentIds[0]],
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
	it("pins the immutable brief as the cache prefix before the volatile checkpoint", async () => {
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
		expect(JSON.stringify(first[0])).toContain("promptCacheBreakpoint");
		expect(JSON.stringify(first[1])).not.toContain("promptCacheBreakpoint");
		expect(first[0]).toEqual(second[0]);
	});

	it("keeps consecutive read results together until a mutation refreshes the checkpoint", async () => {
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
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "module", toolName: "getModule" }] },
			{ calls: [{ toolCallId: "form", toolName: "getForm" }] },
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
		).toEqual(["stage"]);
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
		/* The checkpoint carries only the latest nudge, not a growing transcript. */
		const nudges = (seen[2] ?? []).filter(
			(message) =>
				message.role === "user" &&
				JSON.stringify(message.content).includes("exactly one tool call"),
		);
		expect(nudges).toHaveLength(1);
	});
});

describe("runSliceExecutor — staged dispatch", () => {
	it("offers output handles only on server-minted identity operations", async () => {
		let definitions: Parameters<ExecutorStepFn>[0]["tools"] | undefined;
		const step: ExecutorStepFn = async (args) => {
			definitions = args.tools;
			return {
				toolCalls: [
					{
						toolCallId: "stop",
						toolName: "reportExecutionBlocker",
						input: VALID_BLOCKER,
					},
				],
				text: "",
				usage: undefined,
				responseMessages: [],
			};
		};

		await run({ workspace: fakeWorkspace(), step });

		const batch = definitions?.stageBatch?.inputSchema as {
			properties?: {
				operations?: { items?: { oneOf?: unknown[] } };
			};
		};
		const arms = (batch.properties?.operations?.items?.oneOf ?? []) as Array<{
			properties?: Record<string, { const?: string }>;
		}>;
		const arm = (name: string) =>
			arms.find((candidate) => candidate.properties?.toolName?.const === name);
		expect(arm("addUserProperties")?.properties).toHaveProperty(
			"outputHandles",
		);
		expect(arm("stageModule")?.properties).not.toHaveProperty("outputHandles");
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
				input: { name: "Patients" },
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
		const inputFor = (toolName: string) => ({
			toolName,
			input: {
				implementedIntentIds: [brief().owningIntentIds[0]],
			},
		});
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

	it("resolves server-minted worker identities through batch-local handles", async () => {
		const propertyUuid = "11111111-1111-4111-8111-111111111111";
		const workspace = fakeWorkspace({
			stage: async ({ toolName }) => ({
				kind: "mutate",
				result:
					toolName === "addUserProperties"
						? { message: "Added property.", uuids: [propertyUuid] }
						: { message: "Added role.", uuids: [] },
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
										properties: [{ slug: "role", label: "Role" }],
										implementedIntentIds: [ids.accessSupervisor],
									},
									outputHandles: ["@role_property"],
								},
								{
									toolName: "addUserTypes",
									input: {
										userTypes: [
											{
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
										implementedIntentIds: [ids.accessSupervisor],
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

		expect(workspace.staged[1]?.input).toMatchObject({
			userTypes: [
				{
					values: [{ userPropertyUuid: propertyUuid }],
				},
			],
		});
		expect(toolResults(seen[1] ?? [])[0]?.value).toMatchObject({
			status: "completed",
			bindings: { "@role_property": propertyUuid },
		});
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

		expect(await run({ workspace, step, commit })).toEqual({
			kind: "rebase-conflict",
			report: { steps: ["s1"] },
		});
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it("projects bounded diagnostics for inspectChangeSet", async () => {
		const uncovered = brief().owningIntentIds[0];
		const workspace = fakeWorkspace({
			inspect: async () =>
				diagnostics({
					canCommit: false,
					sliceIntentCoverage: brief()
						.owningIntentIds.slice(1)
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
			remainingOwnedIntentIds: string[];
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
		expect(value.remainingOwnedIntentIds).toEqual([uncovered]);
	});

	it("refuses a commit request until durable steps cover every owned intent", async () => {
		const uncovered = brief().owningIntentIds[0];
		const workspace = fakeWorkspace({
			inspect: async () =>
				diagnostics({
					canCommit: true,
					sliceIntentCoverage: brief()
						.owningIntentIds.slice(1)
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
			remainingOwnedIntentIds: [uncovered],
		});
	});
});

describe("runSliceExecutor — architect blocker resolution", () => {
	it("lets the server-owned architect classify a valid compiler report", async () => {
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
	});

	it("returns an error and keeps going on an invalid blocker report", async () => {
		const workspace = fakeWorkspace();
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "reportExecutionBlocker",
						input: { ...VALID_BLOCKER, affectedIntentIds: [] },
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
		expect(value.error).toContain("affectedIntentIds");
		expect(outcome.kind).toBe("architect-decision");
	});
});

describe("runSliceExecutor — budgets", () => {
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
			spent: { modelSteps: 0, stagedRequests: 0 },
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

	it("opens with a stable brief followed by the current workspace state", async () => {
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "reportExecutionBlocker" }] },
		]);

		await run({ workspace: fakeWorkspace(), step });

		const opening = seen[0];
		expect(opening).toHaveLength(2);
		expect(JSON.stringify(opening?.[0])).toContain(
			"Patient registration and queue",
		);
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
