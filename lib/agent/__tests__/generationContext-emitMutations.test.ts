// lib/agent/__tests__/generationContext-emitMutations.test.ts
//
// Unit tests for the `emitMutations`, `emitConversation`, `emit`, and
// `emitError` helpers on `GenerationContext`. These are the single
// sanctioned write surface for server-side emission — if their shape
// changes, every SA tool handler changes with it.
//
// Phase 4: the context fans out to TWO surfaces — the `UIMessageStreamWriter`
// (live SSE, unchanged wire format) and the `LogWriter` (Firestore event log,
// one doc per event). `emit` remains SSE-only; `emitMutations` writes SSE +
// one `MutationEvent` per mutation to the log; `emitConversation` writes log
// only; `emitError` writes both.

import type { UIMessageStreamWriter } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifiedError } from "@/lib/agent/errorClassifier";
import type { Session } from "@/lib/auth";
import { UsageAccumulator } from "@/lib/db/usage";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import type { LogWriter } from "@/lib/log/writer";
import { GenerationContext } from "../generationContext";

// Minimal construction helper — the context needs a writer, a log writer,
// a usage accumulator, and a session. Every other collaborator is a bare
// stub; tests that exercise saveBlueprint install a docProvider explicitly.
function buildCtx() {
	const writer = {
		write: vi.fn(),
	} as unknown as UIMessageStreamWriter;
	const logEvent = vi.fn();
	const logWriter = {
		logEvent,
		flush: vi.fn(),
	} as unknown as LogWriter;
	const usage = new UsageAccumulator({
		appId: "a",
		userId: "u",
		runId: "r-1",
		model: "claude-opus-4-7",
		promptMode: "build",
		freshEdit: false,
		appReady: false,
		cacheExpired: false,
		moduleCount: 0,
	});
	const session = {
		user: { id: "user-1" },
	} as unknown as Session;
	return {
		ctx: new GenerationContext({
			apiKey: "sk-test",
			writer,
			logWriter,
			usage,
			session,
		}),
		writer: writer as unknown as { write: ReturnType<typeof vi.fn> },
		logWriter: logWriter as unknown as {
			logEvent: ReturnType<typeof vi.fn>;
			flush: ReturnType<typeof vi.fn>;
		},
	};
}

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
	let writer: { write: ReturnType<typeof vi.fn> };
	let logWriter: { logEvent: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		const built = buildCtx();
		ctx = built.ctx;
		writer = built.writer;
		logWriter = built.logWriter;
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

	it("writes one MutationEvent per mutation to the log writer", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION, SECOND_MUTATION], "form:0-0");
		expect(logWriter.logEvent).toHaveBeenCalledTimes(2);
		expect(logWriter.logEvent).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				kind: "mutation",
				runId: "r-1",
				stage: "form:0-0",
				actor: "agent",
				mutation: TEXT_FIELD_MUTATION,
			}),
		);
		expect(logWriter.logEvent).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				kind: "mutation",
				runId: "r-1",
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
		const { ctx, writer, logWriter } = buildCtx();
		ctx.emitConversation({ type: "assistant-text", text: "hi" });
		expect(logWriter.logEvent).toHaveBeenCalledTimes(1);
		expect(logWriter.logEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "conversation",
				runId: "r-1",
				payload: { type: "assistant-text", text: "hi" },
			}),
		);
		expect(writer.write).not.toHaveBeenCalled();
	});

	it("carries the constructor-seeded runId on every event", () => {
		const { ctx, logWriter } = buildCtx();
		ctx.emitConversation({ type: "assistant-text", text: "a" });
		ctx.emitConversation({ type: "assistant-reasoning", text: "b" });
		const calls = logWriter.logEvent.mock.calls.map(
			(c) => (c[0] as { runId: string }).runId,
		);
		expect(calls).toEqual(["r-1", "r-1"]);
	});
});

describe("GenerationContext.emit", () => {
	it("writes SSE only — no log write — for non-mutation events", () => {
		const { ctx, writer, logWriter } = buildCtx();
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
		const { ctx, writer, logWriter } = buildCtx();
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
				runId: "r-1",
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
