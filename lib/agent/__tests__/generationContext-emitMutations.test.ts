// lib/agent/__tests__/generationContext-emitMutations.test.ts
//
// Unit tests for the `emitMutations`, `emitConversation`, `emit`,
// `emitError`, and `handleAgentStep` methods on `GenerationContext`.
// These are the single sanctioned write surface for server-side emission
// — if their shape changes, every SA tool handler changes with it.
//
// Phase 4: the context fans out to TWO surfaces — the `UIMessageStreamWriter`
// (live SSE, unchanged wire format) and the `LogWriter` (Firestore event
// log, one doc per event). `emit()` is a pure SSE pass-through;
// `emitMutations` writes SSE + triggers the intermediate blueprint save +
// one `MutationEvent` per mutation to the log; `emitConversation` writes
// log only; `emitError` writes both; `handleAgentStep` is the shared fan-in
// for every `ToolLoopAgent`'s `onStepFinish`.

import type { LanguageModelUsage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClassifiedError } from "@/lib/agent/errorClassifier";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import type { GenerationContext } from "../generationContext";
import { makeTestContext } from "./fixtures";

// Representative text-field add mutation. The specific mutation shape is
// unimportant to the helper — these tests only assert that the batch
// round-trips verbatim through `writer.write` and serialises correctly
// into MutationEvents on the log writer.
const TEXT_FIELD_MUTATION: Mutation = {
	kind: "addField",
	parentUuid: asUuid("form-uuid"),
	field: {
		kind: "text",
		uuid: asUuid("field-uuid"),
		id: "patient_name",
		label: "Patient name",
	},
};

const SECOND_MUTATION: Mutation = {
	kind: "addField",
	parentUuid: asUuid("form-uuid"),
	field: {
		kind: "text",
		uuid: asUuid("field-uuid-2"),
		id: "patient_age",
		label: "Patient age",
	},
};

describe("GenerationContext.emitMutations", () => {
	let ctx: GenerationContext;
	let writer: ReturnType<typeof makeTestContext>["writer"];
	let logWriter: ReturnType<typeof makeTestContext>["logWriter"];

	beforeEach(() => {
		const handles = makeTestContext();
		ctx = handles.ctx;
		writer = handles.writer;
		logWriter = handles.logWriter;
	});

	it("writes a data-mutations event to the SSE stream with the supplied mutations", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION]);
		expect(writer.write).toHaveBeenCalledWith({
			type: "data-mutations",
			data: { mutations: [TEXT_FIELD_MUTATION] },
			transient: true,
		});
	});

	it("includes the optional stage tag on the SSE payload when provided", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION], "form:0-0");
		expect(writer.write).toHaveBeenCalledWith({
			type: "data-mutations",
			data: { mutations: [TEXT_FIELD_MUTATION], stage: "form:0-0" },
			transient: true,
		});
	});

	it("omits the stage key entirely from SSE when no stage is provided (not 'stage: undefined')", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION]);
		const call = writer.write.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect("stage" in call.data).toBe(false);
	});

	it("writes exactly one MutationEvent to the log for a single-mutation batch (default case)", () => {
		// Catches the regression where emitMutations writes SSE but
		// silently skips the log fan-out on the default (stage-less) path.
		ctx.emitMutations([TEXT_FIELD_MUTATION]);
		expect(logWriter.logEvent).toHaveBeenCalledTimes(1);
		expect(logWriter.logEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "mutation",
				runId: "run-1",
				actor: "agent",
				mutation: TEXT_FIELD_MUTATION,
			}),
		);
	});

	it("writes one MutationEvent per mutation to the log writer with the supplied stage", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION, SECOND_MUTATION], "form:0-0");
		expect(logWriter.logEvent).toHaveBeenCalledTimes(2);
		expect(logWriter.logEvent).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				kind: "mutation",
				runId: "run-1",
				stage: "form:0-0",
				actor: "agent",
				mutation: TEXT_FIELD_MUTATION,
			}),
		);
		expect(logWriter.logEvent).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				kind: "mutation",
				runId: "run-1",
				stage: "form:0-0",
				actor: "agent",
				mutation: SECOND_MUTATION,
			}),
		);
	});

	it("assigns monotonically increasing seq to each emitted mutation event", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION, SECOND_MUTATION], "form:0-0");
		const first = logWriter.logEvent.mock.calls[0]?.[0] as { seq: number };
		const second = logWriter.logEvent.mock.calls[1]?.[0] as { seq: number };
		expect(second.seq).toBeGreaterThan(first.seq);
	});

	it("writes a mutation event WITHOUT a stage field when no stage is provided", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION]);
		const event = logWriter.logEvent.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect("stage" in event).toBe(false);
	});

	it("no-ops on empty mutation arrays — no SSE write, no log event", () => {
		ctx.emitMutations([], "form:0-0");
		expect(writer.write).not.toHaveBeenCalled();
		expect(logWriter.logEvent).not.toHaveBeenCalled();
	});
});

describe("GenerationContext.emitConversation", () => {
	it("writes a ConversationEvent to the log writer", () => {
		const { ctx, writer, logWriter } = makeTestContext();
		ctx.emitConversation({ type: "assistant-text", text: "hi" });
		expect(logWriter.logEvent).toHaveBeenCalledTimes(1);
		expect(logWriter.logEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "conversation",
				runId: "run-1",
				payload: { type: "assistant-text", text: "hi" },
			}),
		);
		expect(writer.write).not.toHaveBeenCalled();
	});

	it("carries the constructor-seeded runId on every event", () => {
		const { ctx, logWriter } = makeTestContext();
		ctx.emitConversation({ type: "assistant-text", text: "a" });
		ctx.emitConversation({ type: "assistant-reasoning", text: "b" });
		const calls = logWriter.logEvent.mock.calls.map(
			(c) => (c[0] as { runId: string }).runId,
		);
		expect(calls).toEqual(["run-1", "run-1"]);
	});
});

describe("GenerationContext.emit", () => {
	it("writes SSE only — no log write — for non-mutation events", () => {
		const { ctx, writer, logWriter } = makeTestContext();
		ctx.emit("data-phase", { phase: "schema" });
		expect(writer.write).toHaveBeenCalledWith({
			type: "data-phase",
			data: { phase: "schema" },
			transient: true,
		});
		expect(logWriter.logEvent).not.toHaveBeenCalled();
	});
});

describe("GenerationContext.emitError", () => {
	it("writes a conversation error event AND emits data-error on SSE", () => {
		const { ctx, writer, logWriter } = makeTestContext();
		const classified: ClassifiedError = {
			type: "internal",
			message: "boom",
			recoverable: false,
		};
		ctx.emitError(classified, "test:context");
		// Log side: single conversation error event.
		expect(logWriter.logEvent).toHaveBeenCalledTimes(1);
		expect(logWriter.logEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "conversation",
				runId: "run-1",
				payload: {
					type: "error",
					error: { type: "internal", message: "boom", fatal: true },
				},
			}),
		);
		// SSE side: data-error payload for the live client.
		expect(writer.write).toHaveBeenCalledWith({
			type: "data-error",
			data: { message: "boom", type: "internal", fatal: true },
			transient: true,
		});
	});
});

describe("GenerationContext.handleAgentStep", () => {
	/* A complete usage record with the cache-aware detail shape the
	 * AI SDK emits; the helper only reads a handful of fields, so this
	 * is the minimum needed to exercise the `usage.track` + step-count
	 * path. */
	const MINIMAL_USAGE: LanguageModelUsage = {
		inputTokens: 100,
		outputTokens: 50,
		totalTokens: 150,
		reasoningTokens: undefined,
		cachedInputTokens: undefined,
		inputTokenDetails: {
			noCacheTokens: 100,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	} as unknown as LanguageModelUsage;

	it("emits reasoning + text + tool-call + tool-result events in order for a full step", () => {
		const { ctx, logWriter, usage } = makeTestContext();

		ctx.handleAgentStep(
			{
				usage: MINIMAL_USAGE,
				text: "the visible answer",
				reasoningText: "thinking about the answer",
				toolCalls: [
					{
						toolCallId: "tc-1",
						toolName: "addQuestions",
						input: { moduleIndex: 0 },
					},
				],
				toolResults: [{ toolCallId: "tc-1", output: { success: true } }],
			},
			"Solutions Architect",
		);

		// Four conversation events, in canonical order:
		// reasoning → text → tool-call → tool-result.
		expect(logWriter.logEvent).toHaveBeenCalledTimes(4);
		const payloads = logWriter.logEvent.mock.calls.map((c) => {
			const ev = c[0] as { payload: unknown };
			return ev.payload;
		});
		expect(payloads).toEqual([
			{ type: "assistant-reasoning", text: "thinking about the answer" },
			{ type: "assistant-text", text: "the visible answer" },
			{
				type: "tool-call",
				toolCallId: "tc-1",
				toolName: "addQuestions",
				input: { moduleIndex: 0 },
			},
			{
				type: "tool-result",
				toolCallId: "tc-1",
				toolName: "addQuestions",
				output: { success: true },
			},
		]);

		// Usage: one step recorded, one tool call counted, token totals
		// flowed through. `usage.snapshot()` is the public read path for
		// assertion here — the private counters aren't exposed otherwise.
		const snap = usage.snapshot();
		expect(snap.stepCount).toBe(1);
		expect(snap.toolCallCount).toBe(1);
		expect(snap.inputTokens).toBe(100);
		expect(snap.outputTokens).toBe(50);
	});

	it("no-ops when usage is undefined — no track, no events", () => {
		const { ctx, logWriter, usage } = makeTestContext();

		ctx.handleAgentStep(
			{
				usage: undefined,
				text: "ignored without usage",
				toolCalls: [{ toolCallId: "tc-x", toolName: "foo", input: {} }],
			},
			"Solutions Architect",
		);

		expect(logWriter.logEvent).not.toHaveBeenCalled();
		const snap = usage.snapshot();
		expect(snap.stepCount).toBe(0);
		expect(snap.toolCallCount).toBe(0);
	});

	it("emits a tool-call without a paired result when no matching toolResult arrives", () => {
		const { ctx, logWriter, usage } = makeTestContext();

		ctx.handleAgentStep(
			{
				usage: MINIMAL_USAGE,
				toolCalls: [
					{ toolCallId: "tc-1", toolName: "askQuestions", input: {} },
				],
				toolResults: [],
			},
			"Solutions Architect",
		);

		// Exactly one event: the tool-call. Result side is empty, so no
		// tool-result event should fire.
		expect(logWriter.logEvent).toHaveBeenCalledTimes(1);
		const payload = (
			logWriter.logEvent.mock.calls[0]?.[0] as {
				payload: unknown;
			}
		).payload;
		expect(payload).toEqual({
			type: "tool-call",
			toolCallId: "tc-1",
			toolName: "askQuestions",
			input: {},
		});

		const snap = usage.snapshot();
		expect(snap.stepCount).toBe(1);
		expect(snap.toolCallCount).toBe(1);
	});
});
