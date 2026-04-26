// lib/agent/__tests__/generationContext-emitMutations.test.ts
//
// Unit tests for the `emitMutations`, `emitConversation`, `emit`,
// `emitError`, and `handleAgentStep` methods on `GenerationContext`.
// These are the single sanctioned write surface for server-side emission
// — if their shape changes, every SA tool handler changes with it.
//
// The context fans out to TWO surfaces — the `UIMessageStreamWriter`
// (live SSE wire format) and the `LogWriter` (Firestore event log, one
// doc per event). `emit()` is a pure SSE pass-through; `emitMutations`
// writes SSE + triggers the intermediate blueprint save + one
// `MutationEvent` per mutation to the log; `emitConversation` writes log
// only; `emitError` writes both; `handleAgentStep` is the shared fan-in
// for every `ToolLoopAgent`'s `onStepFinish`.

import type { LanguageModelUsage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifiedError } from "@/lib/agent/errorClassifier";
import { updateAppForRun } from "@/lib/db/apps";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import type { GenerationContext } from "../generationContext";
import { makeMinimalDoc, makeTestContext } from "./fixtures";

/* `emitMutations` fires a fire-and-forget `updateAppForRun` on every
 * call (the doc argument is the persistence target; the run id keeps
 * `app.run_id` in sync with the current chat run so MCP's sliding-
 * window derivation doesn't re-attach to a closed run). Stub it out at
 * the module level so the no-op save doesn't reach Firestore. */
vi.mock("@/lib/db/apps", () => ({
	updateAppForRun: vi.fn(() => Promise.resolve()),
}));

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

	/* A minimal doc reused across these tests. The content doesn't matter —
	 * the tests assert on writer + logWriter side effects, not on what got
	 * written to Firestore (that's mocked out). But the arg must type-check
	 * against `BlueprintDoc`, so we hand a valid shape. */
	const DOC = makeMinimalDoc();

	beforeEach(() => {
		/* Reset the shared module-level `updateAppForRun` mock so one test's save
		 * calls don't bleed into the next one's `toHaveBeenCalledWith`
		 * assertions. The `vi.mock(...)` factory ran once at module load;
		 * only the call log needs resetting. */
		vi.mocked(updateAppForRun).mockClear();
		const handles = makeTestContext();
		ctx = handles.ctx;
		writer = handles.writer;
		logWriter = handles.logWriter;
	});

	it("writes a data-mutations event to the SSE stream carrying raw mutations + MutationEvent envelopes", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION], DOC);
		const call = writer.write.mock.calls[0]?.[0] as {
			type: string;
			data: {
				mutations: Mutation[];
				events: Array<Record<string, unknown>>;
			};
			transient: boolean;
		};
		expect(call.type).toBe("data-mutations");
		expect(call.transient).toBe(true);
		expect(call.data.mutations).toEqual([TEXT_FIELD_MUTATION]);
		expect(call.data.events).toHaveLength(1);
		expect(call.data.events[0]).toEqual(
			expect.objectContaining({
				kind: "mutation",
				runId: "run-1",
				actor: "agent",
				mutation: TEXT_FIELD_MUTATION,
			}),
		);
	});

	it("includes the optional stage tag on the SSE payload AND on every envelope", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION], DOC, "form:0-0");
		const call = writer.write.mock.calls[0]?.[0] as {
			data: {
				mutations: Mutation[];
				events: Array<{ stage?: string }>;
				stage?: string;
			};
		};
		expect(call.data.mutations).toEqual([TEXT_FIELD_MUTATION]);
		expect(call.data.stage).toBe("form:0-0");
		expect(call.data.events).toHaveLength(1);
		expect(call.data.events[0]?.stage).toBe("form:0-0");
	});

	it("omits the stage key entirely from SSE when no stage is provided (not 'stage: undefined')", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION], DOC);
		const call = writer.write.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect("stage" in call.data).toBe(false);
	});

	it("writes exactly one MutationEvent to the log for a single-mutation batch (default case)", () => {
		// Catches the regression where emitMutations writes SSE but
		// silently skips the log fan-out on the default (stage-less) path.
		ctx.emitMutations([TEXT_FIELD_MUTATION], DOC);
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
		ctx.emitMutations([TEXT_FIELD_MUTATION, SECOND_MUTATION], DOC, "form:0-0");
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
		ctx.emitMutations([TEXT_FIELD_MUTATION, SECOND_MUTATION], DOC, "form:0-0");
		const first = logWriter.logEvent.mock.calls[0]?.[0] as { seq: number };
		const second = logWriter.logEvent.mock.calls[1]?.[0] as { seq: number };
		expect(second.seq).toBeGreaterThan(first.seq);
	});

	it("writes a mutation event WITHOUT a stage field when no stage is provided", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION], DOC);
		const event = logWriter.logEvent.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect("stage" in event).toBe(false);
	});

	it("no-ops on empty mutation arrays — no SSE write, no log event, no Firestore save", () => {
		const result = ctx.emitMutations([], DOC, "form:0-0");
		expect(result).toEqual([]);
		expect(writer.write).not.toHaveBeenCalled();
		expect(logWriter.logEvent).not.toHaveBeenCalled();
	});

	it("returns the built MutationEvent array so callers can forward metadata without rebuilding", () => {
		const events = ctx.emitMutations([TEXT_FIELD_MUTATION], DOC, "form:0-0");
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(
			expect.objectContaining({
				kind: "mutation",
				runId: "run-1",
				actor: "agent",
				stage: "form:0-0",
				mutation: TEXT_FIELD_MUTATION,
			}),
		);
	});

	it("dispatches a fire-and-forget Firestore save carrying the passed-in doc under the expected appId", () => {
		/* `emitMutations` persists the `doc` argument — every caller threads
		 * a post-mutation snapshot through. A caller that forgets to advance
		 * the doc would show up here as either the wrong appId or a body
		 * shape that doesn't match what was handed in. */
		ctx.emitMutations([TEXT_FIELD_MUTATION], DOC);
		expect(vi.mocked(updateAppForRun)).toHaveBeenCalledTimes(1);
		const [savedAppId, savedDoc] =
			vi.mocked(updateAppForRun).mock.calls[0] ?? [];
		expect(savedAppId).toBe("test-app");
		// The rest of the doc flows through verbatim.
		expect(savedDoc).toMatchObject({
			appId: "test-app",
			appName: "",
			moduleOrder: [],
		});
	});

	it("strips fieldParent from the persisted payload even when populated", () => {
		/* `fieldParent` is a derived reverse-index the client rebuilds from
		 * `fieldOrder` in `docStore.load()`; it must never reach Firestore,
		 * otherwise the persisted shape grows a second source of truth that
		 * can drift from `fieldOrder`. The base `makeMinimalDoc()` has an
		 * empty `fieldParent`, which would make `not.toHaveProperty` pass
		 * vacuously — this test hands in a populated map so the strip is
		 * exercised on real data. */
		const docWithParent = {
			...makeMinimalDoc(),
			fieldParent: {
				[asUuid("f1")]: asUuid("form-uuid"),
				[asUuid("f2")]: asUuid("form-uuid"),
			},
		};
		ctx.emitMutations([TEXT_FIELD_MUTATION], docWithParent);
		expect(vi.mocked(updateAppForRun)).toHaveBeenCalledTimes(1);
		const savedDoc = vi.mocked(updateAppForRun).mock.calls[0]?.[1];
		expect(savedDoc).not.toHaveProperty("fieldParent");
	});

	it("skips the Firestore save on empty batches (no-op path)", () => {
		ctx.emitMutations([], DOC, "form:0-0");
		expect(vi.mocked(updateAppForRun)).not.toHaveBeenCalled();
	});
});

describe("GenerationContext.emitConversation", () => {
	it("writes a ConversationEvent to the log AND emits data-conversation-event on SSE", () => {
		const { ctx, writer, logWriter } = makeTestContext();
		ctx.emitConversation({ type: "assistant-text", text: "hi" });

		/* Log side — durable debug artifact. */
		expect(logWriter.logEvent).toHaveBeenCalledTimes(1);
		const logCall = logWriter.logEvent.mock.calls[0]?.[0];
		expect(logCall).toEqual(
			expect.objectContaining({
				kind: "conversation",
				runId: "run-1",
				payload: { type: "assistant-text", text: "hi" },
			}),
		);

		/* SSE side — same envelope, so the client's session events buffer
		 * mirrors the log. */
		expect(writer.write).toHaveBeenCalledTimes(1);
		const writerCall = writer.write.mock.calls[0]?.[0] as {
			type: string;
			data: unknown;
			transient: boolean;
		};
		expect(writerCall.type).toBe("data-conversation-event");
		expect(writerCall.transient).toBe(true);
		expect(writerCall.data).toBe(logCall);
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
		ctx.emit("data-done", { doc: {} });
		expect(writer.write).toHaveBeenCalledWith({
			type: "data-done",
			data: { doc: {} },
			transient: true,
		});
		expect(logWriter.logEvent).not.toHaveBeenCalled();
	});
});

describe("GenerationContext.emitError", () => {
	it("writes a conversation error event that flows to both log and SSE", () => {
		const { ctx, writer, logWriter } = makeTestContext();
		const classified: ClassifiedError = {
			type: "internal",
			message: "boom",
			recoverable: false,
		};
		ctx.emitError(classified, "test:context");

		/* Single conversation error event — visible in both surfaces. */
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
		/* SSE emission is the same envelope via `data-conversation-event`
		 * — no separate `data-error` side channel. */
		expect(writer.write).toHaveBeenCalledTimes(1);
		const writerCall = writer.write.mock.calls[0]?.[0] as {
			type: string;
		};
		expect(writerCall.type).toBe("data-conversation-event");
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
						toolName: "addFields",
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
				toolName: "addFields",
				input: { moduleIndex: 0 },
			},
			{
				type: "tool-result",
				toolCallId: "tc-1",
				toolName: "addFields",
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
