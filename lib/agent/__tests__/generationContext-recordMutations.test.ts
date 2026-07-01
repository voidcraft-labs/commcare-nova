// lib/agent/__tests__/generationContext-recordMutations.test.ts
//
// Unit tests for the doc-mutating write surface on `GenerationContext` —
// `recordMutations`, `recordMutationStages`, and their private commit
// helper `commitBatch` — plus the unchanged `emitConversation`, `emit`,
// `emitError`, and `handleAgentStep` methods.
//
// The chat SA now commits AWAITED-INLINE through the unified guarded
// writer (`commitGuardedBatch`). The ordering flipped from the old
// fire-and-forget `emitMutations`: the `data-mutations` SSE frame is
// emitted AFTER the commit resolves and carries the committed `seq` +
// `batchId`; a `BlueprintCommitRejectedError` from the commit emits
// NOTHING. Both record methods return `{ events, committedDoc }` — the
// writer's hydrated `nextDoc` — and the SA continues against it.

import type { LanguageModelUsage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifiedError } from "@/lib/agent/errorClassifier";
import { commitGuardedBatch } from "@/lib/db/apps";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "@/lib/db/commitGuard";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import { log } from "@/lib/logger";
import type { GenerationContext } from "../generationContext";
import { makeMinimalDoc, makeTestContext } from "./fixtures";

/* Both record methods await `commitGuardedBatch` (kind:'chat'). Mock the
 * unified writer at module scope so no Firestore transaction is touched;
 * each test tweaks the resolved `{ seq, basisToken, committedDoc, deduped }`
 * via `mockResolvedValueOnce` / `mockRejectedValueOnce`. */
vi.mock("@/lib/db/apps", () => ({
	commitGuardedBatch: vi.fn(),
}));

/* Mock the logger so `emitError`'s server-side cause-logging is silent in
 * test output and assertable. */
vi.mock("@/lib/logger", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), critical: vi.fn() },
}));

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

/** Build a distinct committed doc the writer "returns" so tests can assert
 *  the SA adopts the writer's hydrated `nextDoc`, not its own candidate. */
function committedDocFor(appName: string) {
	return { ...makeMinimalDoc(), appName };
}

describe("GenerationContext.recordMutations", () => {
	let ctx: GenerationContext;
	let writer: ReturnType<typeof makeTestContext>["writer"];
	let logWriter: ReturnType<typeof makeTestContext>["logWriter"];

	const DOC = makeMinimalDoc();

	beforeEach(() => {
		vi.mocked(commitGuardedBatch).mockReset();
		// Default: the writer commits at seq 1 and returns a distinct hydrated
		// doc so tests can distinguish "adopted committedDoc" from "kept DOC".
		vi.mocked(commitGuardedBatch).mockResolvedValue({
			seq: 1,
			basisToken: "token-1",
			committedDoc: committedDocFor("committed"),
			deduped: false,
		});
		const handles = makeTestContext();
		ctx = handles.ctx;
		writer = handles.writer;
		logWriter = handles.logWriter;
	});

	it("commits through the unified guarded writer with kind:'chat', the run's id, and the actor", async () => {
		await ctx.recordMutations([TEXT_FIELD_MUTATION], DOC);
		expect(vi.mocked(commitGuardedBatch)).toHaveBeenCalledTimes(1);
		const args = vi.mocked(commitGuardedBatch).mock.calls[0]?.[0];
		expect(args).toMatchObject({
			appId: "test-app",
			runId: "run-1",
			actorUserId: "user-1",
			kind: "chat",
			mutations: [TEXT_FIELD_MUTATION],
		});
		// A fresh uuid batchId per commit.
		expect(args?.batchId).toEqual(expect.any(String));
	});

	it("emits data-mutations AFTER the commit, carrying raw mutations + envelopes + seq + batchId", async () => {
		await ctx.recordMutations([TEXT_FIELD_MUTATION], DOC);
		const call = writer.write.mock.calls[0]?.[0] as {
			type: string;
			data: {
				mutations: Mutation[];
				events: Array<Record<string, unknown>>;
				seq: number;
				batchId: string;
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
		// The committed seq + the same batchId handed to the writer ride the frame
		// so the reconciler can dedup its own echoes + advance its cursor.
		expect(call.data.seq).toBe(1);
		const commitBatchId =
			vi.mocked(commitGuardedBatch).mock.calls[0]?.[0]?.batchId;
		expect(call.data.batchId).toBe(commitBatchId);
	});

	it("emits the data-mutations frame ONLY after the commit resolves (never before)", async () => {
		let resolveCommit: (v: {
			seq: number;
			basisToken: string;
			committedDoc: ReturnType<typeof committedDocFor>;
			deduped: boolean;
		}) => void = () => {};
		vi.mocked(commitGuardedBatch).mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolveCommit = r;
				}),
		);

		const pending = ctx.recordMutations([TEXT_FIELD_MUTATION], DOC);
		// The commit is in flight — nothing is on the wire yet.
		await Promise.resolve();
		expect(writer.write).not.toHaveBeenCalled();
		expect(logWriter.logEvent).not.toHaveBeenCalled();

		resolveCommit({
			seq: 3,
			basisToken: "t",
			committedDoc: committedDocFor("late"),
			deduped: false,
		});
		await pending;
		// Only now does the frame + log fan-out fire.
		expect(writer.write).toHaveBeenCalledTimes(1);
		expect(logWriter.logEvent).toHaveBeenCalledTimes(1);
	});

	it("carries the optional stage tag on the SSE payload AND on every envelope", async () => {
		await ctx.recordMutations([TEXT_FIELD_MUTATION], DOC, "form:0-0");
		const call = writer.write.mock.calls[0]?.[0] as {
			data: {
				mutations: Mutation[];
				events: Array<{ stage?: string }>;
				stage?: string;
			};
		};
		expect(call.data.stage).toBe("form:0-0");
		expect(call.data.events).toHaveLength(1);
		expect(call.data.events[0]?.stage).toBe("form:0-0");
	});

	it("omits the stage key entirely from SSE when no stage is provided", async () => {
		await ctx.recordMutations([TEXT_FIELD_MUTATION], DOC);
		const call = writer.write.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect("stage" in call.data).toBe(false);
	});

	it("writes one MutationEvent per mutation to the log with the supplied stage", async () => {
		await ctx.recordMutations(
			[TEXT_FIELD_MUTATION, SECOND_MUTATION],
			DOC,
			"form:0-0",
		);
		expect(logWriter.logEvent).toHaveBeenCalledTimes(2);
		expect(logWriter.logEvent).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				kind: "mutation",
				runId: "run-1",
				stage: "form:0-0",
				mutation: TEXT_FIELD_MUTATION,
			}),
		);
		expect(logWriter.logEvent).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				kind: "mutation",
				runId: "run-1",
				stage: "form:0-0",
				mutation: SECOND_MUTATION,
			}),
		);
	});

	it("assigns monotonically increasing seq to each emitted mutation event", async () => {
		await ctx.recordMutations(
			[TEXT_FIELD_MUTATION, SECOND_MUTATION],
			DOC,
			"form:0-0",
		);
		const first = logWriter.logEvent.mock.calls[0]?.[0] as { seq: number };
		const second = logWriter.logEvent.mock.calls[1]?.[0] as { seq: number };
		expect(second.seq).toBeGreaterThan(first.seq);
	});

	it("returns { events, committedDoc } — the writer's hydrated nextDoc, not the passed doc", async () => {
		const committed = committedDocFor("merged-peer-edit");
		vi.mocked(commitGuardedBatch).mockResolvedValueOnce({
			seq: 5,
			basisToken: "t",
			committedDoc: committed,
			deduped: false,
		});
		const { events, committedDoc } = await ctx.recordMutations(
			[TEXT_FIELD_MUTATION],
			DOC,
			"form:0-0",
		);
		expect(events).toHaveLength(1);
		// The SA adopts the writer's committed doc (a concurrent peer edit merged
		// in), NOT the local candidate it passed in.
		expect(committedDoc).toBe(committed);
		expect(committedDoc).not.toBe(DOC);
	});

	it("no-ops on empty batches — no commit, no SSE write, no log event; returns the passed doc", async () => {
		const result = await ctx.recordMutations([], DOC, "form:0-0");
		expect(result.events).toEqual([]);
		expect(result.committedDoc).toBe(DOC);
		expect(vi.mocked(commitGuardedBatch)).not.toHaveBeenCalled();
		expect(writer.write).not.toHaveBeenCalled();
		expect(logWriter.logEvent).not.toHaveBeenCalled();
	});

	it("emits NOTHING and propagates when the guarded commit rejects (BlueprintCommitRejectedError)", async () => {
		vi.mocked(commitGuardedBatch).mockRejectedValueOnce(
			new BlueprintCommitRejectedError("removed by someone else"),
		);
		await expect(
			ctx.recordMutations([TEXT_FIELD_MUTATION], DOC),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		// The client never sees a batch the doc didn't absorb, and no log entry
		// records a batch that never committed.
		expect(writer.write).not.toHaveBeenCalled();
		expect(logWriter.logEvent).not.toHaveBeenCalled();
		// A retryable conflict is NOT a reauth loss — the finalize flag stays clear
		// so the run can complete after the SA reloads and retries.
		expect(ctx.reauthError()).toBeUndefined();
	});

	it("stashes the CommitReauthError on the context (for finalize) AND re-throws it", async () => {
		// The actor lost edit access mid-run. The tool + SA still see the throw and
		// stop, but the route can't key run failure on the (non-fatal) tool chunk —
		// it reads `reauthError()` after the drain to `failRun` instead of falsely
		// completing. So the context must record it before propagating.
		const reauth = new CommitReauthError("no longer a member");
		vi.mocked(commitGuardedBatch).mockRejectedValueOnce(reauth);

		expect(ctx.reauthError()).toBeUndefined();
		await expect(ctx.recordMutations([TEXT_FIELD_MUTATION], DOC)).rejects.toBe(
			reauth,
		);
		expect(ctx.reauthError()).toBe(reauth);
		// Nothing committed → nothing emitted.
		expect(writer.write).not.toHaveBeenCalled();
		expect(logWriter.logEvent).not.toHaveBeenCalled();
	});

	it("forwards mediaExpectations into the guarded commit for the in-txn re-check", async () => {
		const mediaExpectations = [
			{ assetId: "asset-1", kind: "image", slot: "label media" },
		] as const;
		await ctx.recordMutations(
			[TEXT_FIELD_MUTATION],
			DOC,
			undefined,
			mediaExpectations,
		);
		const args = vi.mocked(commitGuardedBatch).mock.calls[0]?.[0];
		expect(args?.mediaExpectations).toEqual(mediaExpectations);
	});

	it("omits mediaExpectations from the commit args when the batch attaches no media", async () => {
		await ctx.recordMutations([TEXT_FIELD_MUTATION], DOC);
		const args = vi.mocked(commitGuardedBatch).mock.calls[0]?.[0];
		expect(args && "mediaExpectations" in args).toBe(false);
	});

	it("latestPersistedDoc + latestCommittedSeq reflect the committed batch (absent before any)", async () => {
		expect(ctx.latestPersistedDoc()).toBeUndefined();
		expect(ctx.latestCommittedSeq()).toBeUndefined();

		const committed = committedDocFor("committed-latest");
		vi.mocked(commitGuardedBatch).mockResolvedValueOnce({
			seq: 9,
			basisToken: "t",
			committedDoc: committed,
			deduped: false,
		});
		await ctx.recordMutations([TEXT_FIELD_MUTATION], DOC);
		expect(ctx.latestPersistedDoc()).toBe(committed);
		expect(ctx.latestCommittedSeq()).toBe(9);
	});
});

describe("GenerationContext.recordMutationStages", () => {
	let ctx: GenerationContext;
	let writer: ReturnType<typeof makeTestContext>["writer"];
	let logWriter: ReturnType<typeof makeTestContext>["logWriter"];

	beforeEach(() => {
		vi.mocked(commitGuardedBatch).mockReset();
		vi.mocked(commitGuardedBatch).mockResolvedValue({
			seq: 1,
			basisToken: "token-1",
			committedDoc: committedDocFor("committed"),
			deduped: false,
		});
		const handles = makeTestContext();
		ctx = handles.ctx;
		writer = handles.writer;
		logWriter = handles.logWriter;
	});

	it("commits the whole sequence as ONE batch (one batchId, one seq) preserving editField atomicity", async () => {
		const midDoc = { ...makeMinimalDoc(), appName: "renamed" };
		const finalDoc = { ...makeMinimalDoc(), appName: "patched" };
		const committed = committedDocFor("committed-final");
		vi.mocked(commitGuardedBatch).mockResolvedValueOnce({
			seq: 4,
			basisToken: "t",
			committedDoc: committed,
			deduped: false,
		});

		const { events, committedDoc } = await ctx.recordMutationStages([
			{ mutations: [TEXT_FIELD_MUTATION], doc: midDoc, stage: "rename:0-0" },
			{ mutations: [SECOND_MUTATION], doc: finalDoc, stage: "edit:0-0" },
		]);

		// Exactly ONE commit over the concatenated batch.
		expect(vi.mocked(commitGuardedBatch)).toHaveBeenCalledTimes(1);
		const args = vi.mocked(commitGuardedBatch).mock.calls[0]?.[0];
		expect(args?.mutations).toEqual([TEXT_FIELD_MUTATION, SECOND_MUTATION]);
		expect(args?.kind).toBe("chat");

		// ONE data-mutations frame carrying the whole batch + the single seq +
		// the single batchId.
		expect(writer.write).toHaveBeenCalledTimes(1);
		const frame = writer.write.mock.calls[0]?.[0] as {
			data: { mutations: Mutation[]; seq: number; batchId: string };
		};
		expect(frame.data.mutations).toEqual([
			TEXT_FIELD_MUTATION,
			SECOND_MUTATION,
		]);
		expect(frame.data.seq).toBe(4);
		expect(frame.data.batchId).toBe(args?.batchId);

		// Per-stage envelopes keep their own tags, in order, with distinct seqs.
		expect(events.map((e) => e.stage)).toEqual(["rename:0-0", "edit:0-0"]);
		expect(events.map((e) => e.seq)).toEqual([0, 1]);
		// The SA continues against the writer's committed doc.
		expect(committedDoc).toBe(committed);
	});

	it("no-ops when every stage is empty — the last stage's doc is the current state", async () => {
		const lastDoc = { ...makeMinimalDoc(), appName: "unchanged" };
		const { events, committedDoc } = await ctx.recordMutationStages([
			{ mutations: [], doc: makeMinimalDoc(), stage: "a" },
			{ mutations: [], doc: lastDoc, stage: "b" },
		]);
		expect(events).toEqual([]);
		expect(committedDoc).toBe(lastDoc);
		expect(vi.mocked(commitGuardedBatch)).not.toHaveBeenCalled();
		expect(writer.write).not.toHaveBeenCalled();
		expect(logWriter.logEvent).not.toHaveBeenCalled();
	});

	it("emits nothing when the single staged commit rejects", async () => {
		vi.mocked(commitGuardedBatch).mockRejectedValueOnce(
			new BlueprintCommitRejectedError("rejected"),
		);
		await expect(
			ctx.recordMutationStages([
				{
					mutations: [TEXT_FIELD_MUTATION],
					doc: makeMinimalDoc(),
					stage: "rename:0-0",
				},
			]),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(writer.write).not.toHaveBeenCalled();
		expect(logWriter.logEvent).not.toHaveBeenCalled();
	});
});

describe("GenerationContext.emitConversation", () => {
	it("writes a ConversationEvent to the log AND emits data-conversation-event on SSE", () => {
		const { ctx, writer, logWriter } = makeTestContext();
		ctx.emitConversation({ type: "assistant-text", text: "hi" });

		expect(logWriter.logEvent).toHaveBeenCalledTimes(1);
		const logCall = logWriter.logEvent.mock.calls[0]?.[0];
		expect(logCall).toEqual(
			expect.objectContaining({
				kind: "conversation",
				runId: "run-1",
				payload: { type: "assistant-text", text: "hi" },
			}),
		);

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
		expect(writer.write).toHaveBeenCalledTimes(1);
		const writerCall = writer.write.mock.calls[0]?.[0] as { type: string };
		expect(writerCall.type).toBe("data-conversation-event");
	});

	it("logs an internal error's raw cause server-side so it isn't swallowed", () => {
		vi.mocked(log.error).mockClear();
		const { ctx } = makeTestContext();
		ctx.emitError(
			{
				type: "internal",
				message: "Something went wrong during generation.",
				recoverable: false,
				raw: "Cloud SQL case store is missing required environment variables: NOVA_DB_NAME",
			},
			"route:finalize",
		);
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("internal error"),
			undefined,
			expect.objectContaining({
				raw: expect.stringContaining("missing required environment variables"),
				context: "route:finalize",
			}),
		);
	});

	it("logs known external errors at warn, not error", () => {
		vi.mocked(log.warn).mockClear();
		vi.mocked(log.error).mockClear();
		const { ctx } = makeTestContext();
		ctx.emitError(
			{
				type: "api_rate_limit",
				message: "Nova is rate limited right now.",
				recoverable: false,
				raw: "429 Too Many Requests",
			},
			"route:stream",
		);
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("api_rate_limit"),
			expect.objectContaining({ raw: "429 Too Many Requests" }),
		);
		expect(log.error).not.toHaveBeenCalled();
	});
});

describe("GenerationContext.handleAgentStep", () => {
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

	it("flags pausedOnInput when a step emits an askQuestions tool-call", () => {
		const { ctx } = makeTestContext();
		expect(ctx.pausedOnInput()).toBe(false);

		ctx.handleAgentStep(
			{
				usage: MINIMAL_USAGE,
				toolCalls: [{ toolCallId: "q-1", toolName: "askQuestions", input: {} }],
			},
			"Solutions Architect",
		);

		expect(ctx.pausedOnInput()).toBe(true);
	});

	it("does NOT flag pausedOnInput for an ordinary mutation tool-call", () => {
		const { ctx } = makeTestContext();
		ctx.handleAgentStep(
			{
				usage: MINIMAL_USAGE,
				toolCalls: [{ toolCallId: "tc-1", toolName: "addFields", input: {} }],
			},
			"Solutions Architect",
		);
		expect(ctx.pausedOnInput()).toBe(false);
	});

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

	it("logs a failed tool call's error as a paired tool-result", () => {
		const { ctx, logWriter } = makeTestContext();

		ctx.handleAgentStep(
			{
				usage: MINIMAL_USAGE,
				toolCalls: [
					{ toolCallId: "tc-1", toolName: "addFields", input: { fields: [] } },
				],
				toolResults: [],
				toolErrors: [
					{
						toolCallId: "tc-1",
						error: new Error("Invalid input: missing required field"),
					},
				],
			},
			"Solutions Architect",
		);

		expect(logWriter.logEvent).toHaveBeenCalledTimes(2);
		const payloads = logWriter.logEvent.mock.calls.map(
			(c) => (c[0] as { payload: unknown }).payload,
		);
		expect(payloads).toEqual([
			{
				type: "tool-call",
				toolCallId: "tc-1",
				toolName: "addFields",
				input: { fields: [] },
			},
			{
				type: "tool-result",
				toolCallId: "tc-1",
				toolName: "addFields",
				output: { error: "Invalid input: missing required field" },
			},
		]);
	});

	it("prefers a real tool-result over a tool-error for the same call", () => {
		const { ctx, logWriter } = makeTestContext();

		ctx.handleAgentStep(
			{
				usage: MINIMAL_USAGE,
				toolCalls: [{ toolCallId: "tc-1", toolName: "addFields", input: {} }],
				toolResults: [{ toolCallId: "tc-1", output: { success: true } }],
				toolErrors: [{ toolCallId: "tc-1", error: "ignored" }],
			},
			"Solutions Architect",
		);

		const resultPayload = logWriter.logEvent.mock.calls
			.map(
				(c) =>
					(c[0] as { payload: { type: string; output?: unknown } }).payload,
			)
			.find((p) => p.type === "tool-result");
		expect(resultPayload?.output).toEqual({ success: true });
	});
});
