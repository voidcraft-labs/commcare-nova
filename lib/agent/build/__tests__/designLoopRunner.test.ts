import type { ModelMessage, UIMessage } from "ai";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	contractSubmissionPulsePhase,
	designLoopStopMessage,
	designModelContextTrailsSuccessfulWait,
	designModelStepKey,
	designTerminalOmissionCanCorrect,
	designTerminalOmissionCorrectionPrefix,
	designToolPulsePhase,
	designTurnProvenanceId,
	designWaitForInputCanPause,
	projectAnsweredDesignContinuation,
	projectMissingDesignUserContinuations,
} from "@/lib/agent/build/designLoopRunner";
import {
	designPhaseTerminalSucceeded,
	designStepBudgetReached,
} from "@/lib/agent/design/loop/designAgent";
import type { DesignGateState } from "@/lib/agent/design/loop/gates";

describe("contractSubmissionPulsePhase", () => {
	it("distinguishes a first design from an immutable replacement revision", () => {
		expect(contractSubmissionPulsePhase(false)).toBe("design");
		expect(contractSubmissionPulsePhase(true)).toBe("revise");
	});

	it("keeps schema-repair internals out of the user-facing stop message", () => {
		const message = designLoopStopMessage({ head: null } as DesignGateState);
		expect(message).toContain("unfinished design workspace");
		expect(message).not.toMatch(/schema|submission|diagnostic|tool/i);
		expect(message).not.toContain("reviewed design is saved");
	});
});

describe("designToolPulsePhase", () => {
	it("switches to review as soon as requestReview starts", () => {
		expect(designToolPulsePhase("requestReview", "revise")).toBe("review");
	});

	it("keeps the current phase for semantic design updates", () => {
		expect(designToolPulsePhase("updateWorkflows", "revise")).toBe("revise");
	});
});

describe("design POST step budget", () => {
	it("counts completed steps from prior transient stream attempts", () => {
		expect(designStepBudgetReached(62, 1)).toBe(false);
		expect(designStepBudgetReached(63, 1)).toBe(true);
		expect(designStepBudgetReached(64, 1)).toBe(true);
	});

	it("reserves exactly one model step for a terminal correction", () => {
		expect(designStepBudgetReached(64, 0, 0, 1)).toBe(false);
		expect(designStepBudgetReached(64, 1, 0, 1)).toBe(true);
	});

	it("gives a replacement provider attempt a distinct durable step identity", () => {
		const shared = {
			stepNumber: 1,
			requestDigest: "a".repeat(64),
		};
		expect(designModelStepKey({ attemptId: "attempt-1", ...shared })).not.toBe(
			designModelStepKey({ attemptId: "attempt-2", ...shared }),
		);
	});

	it("ends a phase only after the finalizer succeeds", () => {
		const call = { toolCallId: "finish-1", toolName: "finishDesign" };
		expect(
			designPhaseTerminalSucceeded(
				[
					{
						toolCalls: [call],
						toolResults: [
							{ toolCallId: call.toolCallId, output: { error: "Fix this." } },
						],
					},
				],
				"finishDesign",
			),
		).toBe(false);
		expect(
			designPhaseTerminalSucceeded(
				[
					{
						toolCalls: [call],
						toolResults: [
							{ toolCallId: call.toolCallId, output: { ok: true } },
						],
					},
				],
				"finishDesign",
			),
		).toBe(true);
	});

	it("treats a completed waitForInput call as an explicit terminal", () => {
		const call = { toolCallId: "wait-1", toolName: "waitForInput" };
		expect(
			designPhaseTerminalSucceeded(
				[
					{
						toolCalls: [call],
						toolResults: [
							{
								toolCallId: call.toolCallId,
								output: { ok: true, awaitingInput: true },
							},
						],
					},
				],
				"waitForInput",
			),
		).toBe(true);
	});
});

describe("design terminal omission correction", () => {
	it("allows exactly one durable correction per logical input turn", () => {
		const target = {
			turnProvenanceId: "user-turn-1",
		};
		const prefix = designTerminalOmissionCorrectionPrefix(target);
		expect(designTerminalOmissionCanCorrect(new Set(), target)).toBe(true);
		expect(
			designTerminalOmissionCanCorrect(new Set([`${prefix}7`]), target),
		).toBe(false);
		expect(
			designTerminalOmissionCanCorrect(new Set([`${prefix}7`]), {
				...target,
				turnProvenanceId: "user-turn-2",
			}),
		).toBe(true);
	});

	it("keeps the correction identity when a dead response is regenerated", () => {
		const messages = [
			{ id: "user-turn-1", role: "user", parts: [] },
		] as UIMessage[];
		expect(designTurnProvenanceId(messages, "response-1")).toBe(
			designTurnProvenanceId(messages, "response-2"),
		);
	});

	it("distinguishes consecutive answered-question turns in one assistant message", () => {
		const firstRound = [
			{
				id: "assistant-1",
				role: "assistant",
				parts: [
					{
						type: "tool-askQuestions",
						toolCallId: "question-1",
						state: "output-available",
						input: { questions: [] },
						output: { "0": "First answer" },
					},
				],
			},
		] as UIMessage[];
		const secondRound = structuredClone(firstRound);
		secondRound[0]?.parts.push({
			type: "tool-askQuestions",
			toolCallId: "question-2",
			state: "output-available",
			input: { questions: [] },
			output: { "0": "Second answer" },
		} as never);

		expect(designTurnProvenanceId(firstRound, "response-1")).not.toBe(
			designTurnProvenanceId(secondRound, "response-1"),
		);
		expect(designTurnProvenanceId(secondRound, "response-1")).toBe(
			designTurnProvenanceId(secondRound, "response-2"),
		);
	});
});

describe("design wait terminal", () => {
	it("cannot bypass a server-required question batch", () => {
		expect(designWaitForInputCanPause(0)).toBe(true);
		expect(designWaitForInputCanPause(1)).toBe(false);
	});

	it("recovers only a successful wait from the latest durable provider step", () => {
		const waitStep = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "wait-1",
						toolName: "waitForInput",
						input: { reason: "more-requirements-coming" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "wait-1",
						toolName: "waitForInput",
						output: {
							type: "json",
							value: { ok: true, awaitingInput: true },
						},
					},
				],
			},
		] as ModelMessage[];

		expect(designModelContextTrailsSuccessfulWait(waitStep)).toBe(true);
		expect(
			designModelContextTrailsSuccessfulWait([
				...waitStep,
				{ role: "user", content: [{ type: "text", text: "Continue now." }] },
			]),
		).toBe(false);
		expect(
			designModelContextTrailsSuccessfulWait([
				...waitStep,
				{ role: "assistant", content: [{ type: "text", text: "Later step" }] },
			]),
		).toBe(false);
	});
});

describe("answered design continuation", () => {
	const toolCallId = "question-1";
	const tools = {
		askQuestions: tool({
			inputSchema: z.object({ questions: z.array(z.unknown()) }),
		}),
	};
	const answered = [
		{
			id: "assistant-1",
			role: "assistant",
			parts: [
				{ type: "step-start" },
				{
					type: "tool-askQuestions",
					toolCallId,
					state: "output-available",
					input: { questions: [{ question: "Which values?", options: [] }] },
					output: { "0": "Alpha and beta" },
				},
			],
		},
	] as UIMessage[];
	const call: ModelMessage = {
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId,
				toolName: "askQuestions",
				input: { questions: [{ question: "Which values?", options: [] }] },
			},
		],
	};

	it("appends only the missing tool result when the original call is durable", async () => {
		const continuation = await projectAnsweredDesignContinuation({
			uiMessages: answered,
			modelContext: [call],
			tools,
		});
		expect(continuation).toHaveLength(1);
		expect(continuation[0]).toMatchObject({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId,
					toolName: "askQuestions",
					output: { type: "json", value: { "0": "Alpha and beta" } },
				},
			],
		});
	});

	it("restores both sides after a crash and deduplicates a completed round", async () => {
		const restored = await projectAnsweredDesignContinuation({
			uiMessages: answered,
			modelContext: [],
			tools,
		});
		expect(restored.map((message) => message.role)).toEqual([
			"assistant",
			"tool",
		]);
		expect(
			await projectAnsweredDesignContinuation({
				uiMessages: answered,
				modelContext: restored,
				tools,
			}),
		).toEqual([]);
	});

	it("finds a missing answered result before a later user recovery turn", async () => {
		const continuation = await projectAnsweredDesignContinuation({
			uiMessages: [
				...answered,
				{
					id: "user-after-crash",
					role: "user",
					parts: [{ type: "text", text: "Please continue." }],
				},
			],
			modelContext: [call],
			tools,
		});
		expect(continuation).toMatchObject([
			{
				role: "tool",
				content: [{ type: "tool-result", toolCallId }],
			},
		]);
	});

	it("closes an orphaned durable question call before provider redrive", async () => {
		const continuation = await projectAnsweredDesignContinuation({
			uiMessages: [],
			modelContext: [call],
			tools,
		});
		expect(continuation).toMatchObject([
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId,
						toolName: "askQuestions",
						output: {
							type: "json",
							value: { error: expect.stringContaining("interrupted") },
						},
					},
				],
			},
		]);
	});
});

describe("ordinary design continuation", () => {
	const tools = {
		ask: tool({ inputSchema: z.object({ value: z.string() }) }),
	};

	it("appends every missing user turn under its stable message id", async () => {
		const messages = [
			{ id: "user-1", role: "user", parts: [{ type: "text", text: "First" }] },
			{
				id: "assistant-1",
				role: "assistant",
				parts: [{ type: "text", text: "Response" }],
			},
			{ id: "user-2", role: "user", parts: [{ type: "text", text: "Next" }] },
		] as UIMessage[];

		await expect(
			projectMissingDesignUserContinuations({
				uiMessages: messages,
				appendKeys: new Set(),
				tools,
			}),
		).resolves.toEqual([
			{
				appendKey: "ui-turn:user-1",
				messages: [
					{ role: "user", content: [{ type: "text", text: "First" }] },
				],
			},
			{
				appendKey: "ui-turn:user-2",
				messages: [{ role: "user", content: [{ type: "text", text: "Next" }] }],
			},
		]);
	});

	it("honors an atomic seed cursor and individually persisted later turns", async () => {
		await expect(
			projectMissingDesignUserContinuations({
				uiMessages: [
					{
						id: "user-1",
						role: "user",
						parts: [{ type: "text", text: "One" }],
					},
					{
						id: "assistant-2",
						role: "assistant",
						parts: [{ type: "text", text: "Waiting" }],
					},
					{
						id: "user-3",
						role: "user",
						parts: [{ type: "text", text: "Three" }],
					},
					{
						id: "user-4",
						role: "user",
						parts: [{ type: "text", text: "Four" }],
					},
				] as UIMessage[],
				appendKeys: new Set(["seed-through:assistant-2", "ui-turn:user-3"]),
				tools,
			}),
		).resolves.toEqual([
			{
				appendKey: "ui-turn:user-4",
				messages: [{ role: "user", content: [{ type: "text", text: "Four" }] }],
			},
		]);
	});
});
