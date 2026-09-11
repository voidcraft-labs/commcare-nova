import type { ModelMessage, UIMessage } from "ai";
import { validateUIMessages } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	designModelStepKey,
	designResponseAppendKey,
	designTerminalOmissionCanCorrect,
	designTerminalOmissionCorrectionPrefix,
	designToolPulsePhase,
	designTurnProvenanceId,
	designWaitForInputCanPause,
	designWaitResponseAppendKey,
	pendingDesignTerminalCorrectionStepAllowance,
	projectAnsweredDesignContinuation,
	projectMissingDesignUserContinuations,
	recoverableDesignTerminalOmissionForTurn,
	recoverableDesignWaitForTurn,
	recoveredDesignWaitChunks,
	trailingSuccessfulDesignWait,
	trailingSuccessfulDesignWaitForTurn,
} from "@/lib/agent/build/designLoopRunner";
import {
	designPhaseTerminalSucceeded,
	designStepBudgetReached,
} from "@/lib/agent/design/loop/designAgent";
import { askQuestionsTool } from "@/lib/agent/tools/askQuestions";

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
	it.each([64, 65])(
		"does not recover a rejected finalizer at step %s as an omission",
		(modelStepsSpent) => {
			const turnProvenanceId = "turn-finalize";
			const appendKey = `design-response:${turnProvenanceId}:revision:response`;
			expect(
				recoverableDesignTerminalOmissionForTurn({
					currentItems: [
						{
							appendKey,
							message: {
								role: "assistant",
								content: [
									{
										type: "tool-call",
										toolName: "finishDesign",
										toolCallId: "finish",
										input: {},
									},
								],
							},
						},
						{
							appendKey,
							message: {
								role: "tool",
								content: [
									{
										type: "tool-result",
										toolName: "finishDesign",
										toolCallId: "finish",
										output: {
											type: "json",
											value: { error: "Module placement needs correction." },
										},
									},
								],
							},
						},
					],
					predecessorItems: [],
					currentGenerationHasCompletedStep: true,
					appendKeys: new Set([
						`design-terminal-omission:${turnProvenanceId}:64`,
					]),
					turnProvenanceId,
					phase: "revision",
					modelStepsSpent,
				}),
			).toBeNull();
		},
	);

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
		] satisfies UIMessage[];
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
		] satisfies UIMessage[];
		const secondRound: UIMessage[] = structuredClone(firstRound);
		secondRound[0]?.parts.push({
			type: "tool-askQuestions",
			toolCallId: "question-2",
			state: "output-available",
			input: { questions: [] },
			output: { "0": "Second answer" },
		});

		expect(designTurnProvenanceId(firstRound, "response-1")).not.toBe(
			designTurnProvenanceId(secondRound, "response-1"),
		);
		expect(designTurnProvenanceId(secondRound, "response-1")).toBe(
			designTurnProvenanceId(secondRound, "response-2"),
		);
	});

	it("restores an unused correction allowance after process replacement", () => {
		const turnProvenanceId = "user-turn-1";
		const prefix = designTerminalOmissionCorrectionPrefix({ turnProvenanceId });
		expect(
			pendingDesignTerminalCorrectionStepAllowance({
				appendKeys: new Set([`${prefix}64`]),
				turnProvenanceId,
				modelStepsSpent: 64,
				ordinaryStepBudget: 64,
			}),
		).toBe(1);
		expect(
			pendingDesignTerminalCorrectionStepAllowance({
				appendKeys: new Set([`${prefix}64`]),
				turnProvenanceId,
				modelStepsSpent: 65,
				ordinaryStepBudget: 64,
			}),
		).toBe(0);
	});

	it("recovers a committed clean omission before the ordinary step ceiling", () => {
		const turnProvenanceId = "user-turn-1";
		const appendKey = designResponseAppendKey({
			turnProvenanceId,
			phase: "author",
			stepKey: "design:attempt:64:digest",
			responseDigest: "a".repeat(64),
		});
		const response = [
			{
				appendKey,
				message: { role: "assistant", content: "I am still thinking." },
			},
		] as const;
		expect(
			recoverableDesignTerminalOmissionForTurn({
				currentItems: response,
				predecessorItems: [],
				currentGenerationHasCompletedStep: true,
				appendKeys: new Set([appendKey]),
				turnProvenanceId,
				phase: "author",
				modelStepsSpent: 64,
			}),
		).toBe("needs-correction");

		const correctionKey = `${designTerminalOmissionCorrectionPrefix({
			turnProvenanceId,
		})}64`;
		expect(
			recoverableDesignTerminalOmissionForTurn({
				currentItems: response,
				predecessorItems: [],
				currentGenerationHasCompletedStep: true,
				appendKeys: new Set([appendKey, correctionKey]),
				turnProvenanceId,
				phase: "author",
				modelStepsSpent: 64,
			}),
		).toBe("correction-pending");
		expect(
			recoverableDesignTerminalOmissionForTurn({
				currentItems: response,
				predecessorItems: [],
				currentGenerationHasCompletedStep: true,
				appendKeys: new Set([appendKey, correctionKey]),
				turnProvenanceId,
				phase: "author",
				modelStepsSpent: 65,
			}),
		).toBe("correction-exhausted");
	});

	it("does not recover another turn or a response whose durable phase advanced", () => {
		const appendKey = designResponseAppendKey({
			turnProvenanceId: "user-turn-1",
			phase: "author",
			stepKey: "design:attempt:1:digest",
			responseDigest: "b".repeat(64),
		});
		const base = {
			currentItems: [
				{
					appendKey,
					message: { role: "assistant", content: "Draft finished." },
				},
			] as const,
			predecessorItems: [],
			currentGenerationHasCompletedStep: true,
			appendKeys: new Set([appendKey]),
			modelStepsSpent: 1,
		};
		expect(
			recoverableDesignTerminalOmissionForTurn({
				...base,
				turnProvenanceId: "user-turn-2",
				phase: "author",
			}),
		).toBeNull();
		expect(
			recoverableDesignTerminalOmissionForTurn({
				...base,
				turnProvenanceId: "user-turn-1",
				phase: "review",
			}),
		).toBeNull();
	});

	it("reconciles a committed question before exhausting its correction", () => {
		const turnProvenanceId = "user-turn-1";
		const appendKey = designResponseAppendKey({
			turnProvenanceId,
			phase: "author",
			stepKey: "design:attempt:65:digest",
			responseDigest: "c".repeat(64),
		});
		const correctionKey = `${designTerminalOmissionCorrectionPrefix({
			turnProvenanceId,
		})}64`;

		expect(
			recoverableDesignTerminalOmissionForTurn({
				currentItems: [
					{
						appendKey,
						message: {
							role: "assistant",
							content: [
								{
									type: "tool-call",
									toolCallId: "question-1",
									toolName: "askQuestions",
									input: { questions: [] },
								},
							],
						} satisfies ModelMessage,
					},
				],
				predecessorItems: [],
				currentGenerationHasCompletedStep: true,
				appendKeys: new Set([appendKey, correctionKey]),
				turnProvenanceId,
				phase: "author",
				modelStepsSpent: 65,
			}),
		).toBeNull();
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
						type: "text",
						text: "I have that. Send the rest when you're ready.",
					},
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
		] satisfies ModelMessage[];

		expect(trailingSuccessfulDesignWait(waitStep) !== null).toBe(true);
		expect(trailingSuccessfulDesignWait(waitStep)).toMatchObject({
			acknowledgement: "I have that. Send the rest when you're ready.",
		});
		expect(
			trailingSuccessfulDesignWait([
				...waitStep,
				{ role: "user", content: [{ type: "text", text: "Continue now." }] },
			]),
		).toBeNull();
		expect(
			trailingSuccessfulDesignWait([
				...waitStep,
				{ role: "assistant", content: [{ type: "text", text: "Later step" }] },
			]),
		).toBeNull();
	});

	it("honors the first provider-ordered input terminal", () => {
		const waitResult = {
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
		} satisfies ModelMessage;
		const question = {
			type: "tool-call",
			toolCallId: "question-1",
			toolName: "askQuestions",
			input: { questions: [] },
		} as const;
		const wait = {
			type: "tool-call",
			toolCallId: "wait-1",
			toolName: "waitForInput",
			input: { reason: "more-requirements-coming" },
		} as const;

		expect(
			trailingSuccessfulDesignWait([
				{ role: "assistant", content: [question, wait] } satisfies ModelMessage,
				waitResult,
			]),
		).toBeNull();
		expect(
			trailingSuccessfulDesignWait([
				{ role: "assistant", content: [wait, question] } satisfies ModelMessage,
				waitResult,
			]),
		).toMatchObject({ toolCallId: "wait-1" });
		expect(
			trailingSuccessfulDesignWait([
				{ role: "assistant", content: [question, wait] } satisfies ModelMessage,
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "question-1",
							toolName: "askQuestions",
							output: {
								type: "error-json",
								value: { error: "The question input was invalid." },
							},
						},
						...(waitResult.role === "tool" ? waitResult.content : []),
					],
				} satisfies ModelMessage,
			]),
		).toMatchObject({ toolCallId: "wait-1" });
	});

	it("recreates the complete visible wait tool part", () => {
		expect(
			recoveredDesignWaitChunks({
				toolCallId: "wait-1",
				input: { reason: "more-requirements-coming" },
				output: { ok: true, awaitingInput: true },
				acknowledgement: "I have that. Send the rest when you're ready.",
			}),
		).toEqual([
			{
				type: "text-start",
				id: "recovered-design-wait:wait-1",
			},
			{
				type: "text-delta",
				id: "recovered-design-wait:wait-1",
				delta: "I have that. Send the rest when you're ready.",
			},
			{
				type: "text-end",
				id: "recovered-design-wait:wait-1",
			},
			{
				type: "tool-input-start",
				toolCallId: "wait-1",
				toolName: "waitForInput",
			},
			{
				type: "tool-input-available",
				toolCallId: "wait-1",
				toolName: "waitForInput",
				input: { reason: "more-requirements-coming" },
			},
			{
				type: "tool-output-available",
				toolCallId: "wait-1",
				output: { ok: true, awaitingInput: true },
			},
		]);
	});

	it("recovers a predecessor wait only for the logical turn that produced it", () => {
		const turnProvenanceId = "user-turn-1";
		const appendKey = designWaitResponseAppendKey({
			turnProvenanceId,
			stepKey: "step-1",
			responseDigest: "a".repeat(64),
		});
		const waitAssistant = {
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "wait-1",
					toolName: "waitForInput",
					input: { reason: "more-requirements-coming" },
				},
				{
					type: "tool-call",
					toolCallId: "question-after-wait",
					toolName: "askQuestions",
					input: { questions: [] },
				},
			],
		} satisfies ModelMessage;
		const items = [
			{
				appendKey,
				message: waitAssistant,
			},
			{
				appendKey,
				message: {
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
				} satisfies ModelMessage,
			},
			{
				appendKey: "input-terminal-rejection:question-after-wait:digest",
				message: {
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "question-after-wait",
							toolName: "askQuestions",
							output: {
								type: "json",
								value: { error: "An earlier input terminal won." },
							},
						},
					],
				} satisfies ModelMessage,
			},
		];

		expect(
			trailingSuccessfulDesignWaitForTurn(items, { turnProvenanceId }),
		).toMatchObject({ toolCallId: "wait-1" });
		expect(
			trailingSuccessfulDesignWaitForTurn(items, {
				turnProvenanceId: "user-turn-2",
			}),
		).toBeNull();
		expect(
			recoverableDesignWaitForTurn({
				currentItems: [
					{
						appendKey: designResponseAppendKey({
							turnProvenanceId,
							phase: "author",
							stepKey: "design:new-step:digest",
							responseDigest: "c".repeat(64),
						}),
						message: { role: "assistant", content: "New response." },
					},
				],
				predecessorItems: items,
				currentGenerationHasCompletedStep: true,
				turnProvenanceId,
			}),
		).toBeNull();
		expect(
			recoverableDesignWaitForTurn({
				currentItems: items,
				predecessorItems: [],
				currentGenerationHasCompletedStep: true,
				turnProvenanceId: "user-turn-2",
			}),
		).toBeNull();
		expect(
			trailingSuccessfulDesignWaitForTurn(
				[
					...items,
					{
						appendKey: designResponseAppendKey({
							turnProvenanceId: "user-turn-2",
							phase: "author",
							stepKey: "design:later-step:digest",
							responseDigest: "b".repeat(64),
						}),
						message: {
							role: "assistant",
							content: "A later provider response superseded the wait.",
						} satisfies ModelMessage,
					},
				],
				{ turnProvenanceId },
			),
		).toBeNull();
	});
});

describe("answered design continuation", () => {
	const toolCallId = "question-1";
	const tools = {
		askQuestions: {
			...askQuestionsTool,
			outputSchema: z.record(z.string(), z.string()),
		},
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
					input: {
						header: "Values",
						questions: [{ question: "Which values?", options: [] }],
					},
					output: { "0": "Alpha and beta" },
				},
			],
		},
	] satisfies UIMessage[];
	const call: ModelMessage = {
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId,
				toolName: "askQuestions",
				input: {
					header: "Values",
					questions: [{ question: "Which values?", options: [] }],
				},
			},
		],
	};

	it("appends only the missing tool result when the original call is durable", async () => {
		const continuation = await projectAnsweredDesignContinuation({
			uiMessages: await validateUIMessages({ messages: answered, tools }),
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
			uiMessages: await validateUIMessages({ messages: answered, tools }),
			modelContext: [],
			tools,
		});
		expect(restored.map((message) => message.role)).toEqual([
			"assistant",
			"tool",
		]);
		expect(
			await projectAnsweredDesignContinuation({
				uiMessages: await validateUIMessages({ messages: answered, tools }),
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
		ask: { inputSchema: z.object({ value: z.string() }) },
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
		] satisfies UIMessage[];

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
				] satisfies UIMessage[],
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

it("does not treat saved assistant output on a reconnect as a fresh user allowance", () => {
	const user = {
		id: "original-input",
		role: "user",
		parts: [{ type: "text", text: "Build the app" }],
	} as const;
	const transcript: UIMessage[] = [
		{ ...user, parts: [...user.parts] },
		{
			id: "partial-output",
			role: "assistant",
			parts: [{ type: "text", text: "Working on the design" }],
		},
	];
	expect(designTurnProvenanceId(transcript, "replacement-output")).toBe(
		user.id,
	);
});
