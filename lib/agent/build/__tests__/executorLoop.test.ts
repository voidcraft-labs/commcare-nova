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
import { budgetForSlice } from "@/lib/agent/build/budgets";
import {
	deriveSliceExecutionBrief,
	type SliceExecutionBrief,
} from "@/lib/agent/build/executionBrief";
import {
	type ExecutorStepFn,
	type ExecutorWorkspace,
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
		sliceIntentCoverage: [],
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

type ScriptedStep =
	| { text: string }
	| { calls: { toolCallId: string; toolName: string; input?: unknown }[] };

function scriptedInput(call: { toolName: string; input?: unknown }): unknown {
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
	it("executes none of a multi-call step and answers both calls", async () => {
		const workspace = fakeWorkspace();
		const { step, seen } = scriptedStep([
			{
				calls: [
					{ toolCallId: "a", toolName: "stageModule", input: { name: "One" } },
					{ toolCallId: "b", toolName: "stageForm", input: { name: "Two" } },
				],
			},
			{ calls: [{ toolCallId: "c", toolName: "raiseDesignExecutionIssue" }] },
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
		/* Two nudges landed before the third empty step ended it. */
		const nudges = (seen[2] ?? []).filter(
			(message) =>
				message.role === "user" &&
				JSON.stringify(message.content).includes("exactly one tool call"),
		);
		expect(nudges).toHaveLength(2);
	});
});

describe("runSliceExecutor — staged dispatch", () => {
	it("passes the absolute slice deadline into the staging write", async () => {
		const stage = vi.fn(async (_args: { deadlineAt?: number }) => ({
			kind: "mutate",
			mutations: [],
		}));
		const { step } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "stageModule" }] },
			{ calls: [{ toolCallId: "b", toolName: "raiseDesignExecutionIssue" }] },
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
						toolName: "stageModule",
						input: { name: "Patients" },
					},
				],
			},
			{ calls: [{ toolCallId: "c", toolName: "raiseDesignExecutionIssue" }] },
		]);

		await run({ workspace, step });

		expect(workspace.staged).toEqual([
			{
				toolName: "stageModule",
				requestId: "call-42",
				input: { name: "Patients" },
			},
		]);
		/* The envelope is unwrapped and the UI-only summary is stripped. */
		expect(toolResults(seen[1] ?? [])[0]?.value).toEqual({
			message: "Staged stageModule.",
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
			{ calls: [{ toolCallId: "a", toolName: "stageForm" }] },
			{ calls: [{ toolCallId: "b", toolName: "raiseDesignExecutionIssue" }] },
		]);

		const outcome = await run({ workspace, step });

		expect(toolResults(seen[1] ?? [])[0]?.value).toEqual({
			error: "No module with that identity exists in this change set.",
		});
		/* The loop kept going — a rejection is not terminal. */
		expect(outcome.kind).not.toBe("protocol-failure");
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
			{ calls: [{ toolCallId: "a", toolName: "stageModule" }] },
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
			{ calls: [{ toolCallId: "b", toolName: "raiseDesignExecutionIssue" }] },
		]);

		await run({ workspace: fakeWorkspace(), step });

		const value = toolResults(seen[1] ?? [])[0]?.value as { error: string };
		expect(value.error).toContain("There is no tool named publishApp");
		expect(value.error).toContain("stageModule");
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
			{ calls: [{ toolCallId: "b", toolName: "raiseDesignExecutionIssue" }] },
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
		const workspace = fakeWorkspace({
			inspect: async () =>
				diagnostics({
					canCommit: false,
					introducedSincePreviousStep: ["aaaa"],
					allFindings: Array.from({ length: 25 }, (_, index) => ({
						code: `CODE_${index}`,
						message: `Finding ${index}`,
					})) as unknown as ChangeSetDiagnostics["allFindings"],
				}),
		});
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "inspectChangeSet" }] },
			{ calls: [{ toolCallId: "b", toolName: "raiseDesignExecutionIssue" }] },
		]);

		await run({ workspace, step });

		const value = toolResults(seen[1] ?? [])[0]?.value as {
			findingCount: number;
			findings: unknown[];
			truncated: { shown: number; total: number };
			canCommit: boolean;
			introducedSincePreviousStep: string[];
		};
		expect(value.findingCount).toBe(25);
		expect(value.findings).toHaveLength(20);
		expect(value.truncated).toEqual({ shown: 20, total: 25 });
		expect(value.canCommit).toBe(false);
		expect(value.introducedSincePreviousStep).toEqual(["aaaa"]);
	});
});

describe("runSliceExecutor — design issue escalation", () => {
	const validIssue = {
		schemaVersion: 1 as const,
		id: "00000000-0000-4000-8000-0000000000ff",
		category: "platform-gap" as const,
		affectedIntentIds: [ids.taskRegister],
		explanation: "The design needs case attachments, which Nova cannot emit.",
		evidenceRefs: [],
		implementationCoordinates: [],
		structuralImpact: "architecture" as const,
		proposedOptions: ["Capture the photo without saving it to the case."],
	};

	it("ends the loop on a valid escalation", async () => {
		const { step } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "raiseDesignExecutionIssue",
						input: validIssue,
					},
				],
			},
		]);

		const outcome = await run({ workspace: fakeWorkspace(), step });

		expect(outcome.kind).toBe("design-issue");
		if (outcome.kind !== "design-issue") throw new Error("unreachable");
		expect(outcome.issue.category).toBe("platform-gap");
		expect(outcome.issue.affectedIntentIds).toEqual([ids.taskRegister]);
	});

	it("returns an error and keeps going on an invalid escalation", async () => {
		const workspace = fakeWorkspace();
		const { step, seen } = scriptedStep([
			{
				calls: [
					{
						toolCallId: "a",
						toolName: "raiseDesignExecutionIssue",
						input: { ...validIssue, affectedIntentIds: [] },
					},
				],
			},
			{
				calls: [
					{
						toolCallId: "b",
						toolName: "raiseDesignExecutionIssue",
						input: validIssue,
					},
				],
			},
		]);

		const outcome = await run({ workspace, step });

		const value = toolResults(seen[1] ?? [])[0]?.value as { error: string };
		expect(value.error).toContain("could not be recorded");
		expect(value.error).toContain("affectedIntentIds");
		expect(outcome.kind).toBe("design-issue");
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
			{ calls: [{ toolCallId: "a", toolName: "stageModule" }] },
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
					toolName: "raiseDesignExecutionIssue",
					input: {
						schemaVersion: 1,
						id: "00000000-0000-4000-8000-0000000000fe",
						category: "platform-gap",
						explanation: "The platform cannot represent this intent.",
						affectedIntentIds: [ids.taskRegister],
						evidenceRefs: [],
						implementationCoordinates: [],
						structuralImpact: "architecture",
						proposedOptions: ["Revise the design"],
					},
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

	it("opens with one message carrying the brief and the workspace state", async () => {
		const { step, seen } = scriptedStep([
			{ calls: [{ toolCallId: "a", toolName: "raiseDesignExecutionIssue" }] },
		]);

		await run({ workspace: fakeWorkspace(), step });

		const opening = seen[0];
		expect(opening).toHaveLength(1);
		const text = JSON.stringify(opening?.[0]);
		expect(text).toContain("Patient registration and queue");
		expect(text).toContain("Current change set");
		expect(text).toContain("Nothing has been staged yet");
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
