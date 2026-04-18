// @vitest-environment happy-dom

/**
 * `useReplayMessages` / `buildReplayMessages` — derivation tests.
 *
 * Two layers of tests:
 *   1. `buildReplayMessages` — pure-function unit tests covering every
 *      `ConversationPayload` variant, boundary cursors, and
 *      mutation-event skip semantics. No React, no provider.
 *   2. `useReplayMessages` — integration tests that mount the hook
 *      inside a `BuilderSessionProvider` seeded via `loadReplay` to
 *      verify the selector wires the builder into the store subscription
 *      and that `setReplayCursor` changes propagate into the returned
 *      `UIMessage[]`.
 *
 * Event construction: small helpers build `ConversationEvent` /
 * `MutationEvent` envelopes with sensible defaults. The tests pin
 * `runId`, `ts`, and `seq` so ordering semantics are deterministic even
 * when payloads match.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type {
	ConversationPayload,
	Event,
	MutationEvent,
} from "@/lib/log/types";
import { buildReplayMessages, useReplayMessages } from "../hooks";
import { BuilderSessionContext, useBuilderSessionApi } from "../provider";
import { createBuilderSessionStore } from "../store";

// ── Fixture builders ──────────────────────────────────────────────────────

/** Build a conversation event with monotonic `seq`/`ts` aligned to index.
 *  Keeping the two in sync matches the envelope invariant the reader
 *  enforces on read. */
function convEvent(seq: number, payload: ConversationPayload): Event {
	return {
		kind: "conversation",
		runId: "run-replay-test",
		ts: seq * 1000,
		seq,
		payload,
	};
}

/** Build a doc mutation event — used to verify the builder skips
 *  non-chat-visible events entirely without closing the assistant turn. */
function mutationEvent(seq: number): MutationEvent {
	return {
		kind: "mutation",
		runId: "run-replay-test",
		ts: seq * 1000,
		seq,
		actor: "agent",
		stage: "scaffold",
		mutation: { kind: "setAppName", name: `App ${seq}` },
	};
}

// ── Test wrapper factory ─────────────────────────────────────────────────

/** Creates a `BuilderSessionProvider`-equivalent wrapper with a preloaded
 *  replay. Returning the store lets tests call actions directly
 *  (`setReplayCursor`, etc.) without threading them through the hook. */
function renderUseReplayMessages(events: Event[], initialCursor: number) {
	const store = createBuilderSessionStore();
	store.getState().loadReplay({
		events,
		chapters: [],
		initialCursor,
		exitPath: "/exit",
	});
	function wrapper({ children }: { children: ReactNode }) {
		return (
			<BuilderSessionContext.Provider value={store}>
				{children}
			</BuilderSessionContext.Provider>
		);
	}
	return {
		...renderHook(
			() => ({
				messages: useReplayMessages(),
				api: useBuilderSessionApi(),
			}),
			{ wrapper },
		),
		store,
	};
}

// ── Pure builder ─────────────────────────────────────────────────────────

describe("buildReplayMessages", () => {
	it("returns [] when cursor is -1 (below any valid event index)", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "hi" }),
		];
		expect(buildReplayMessages(events, -1)).toEqual([]);
	});

	it("returns [] when events is empty regardless of cursor", () => {
		expect(buildReplayMessages([], 0)).toEqual([]);
		expect(buildReplayMessages([], 10)).toEqual([]);
	});

	it("projects a user-message → one user UIMessage with a text part", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "build me an app" }),
		];
		const msgs = buildReplayMessages(events, 0);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe("user");
		expect(msgs[0].parts).toEqual([{ type: "text", text: "build me an app" }]);
	});

	it("groups assistant-reasoning + assistant-text into a single assistant message", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "hi" }),
			convEvent(1, { type: "assistant-reasoning", text: "thinking…" }),
			convEvent(2, { type: "assistant-text", text: "ok" }),
		];
		const msgs = buildReplayMessages(events, 2);
		expect(msgs).toHaveLength(2);
		expect(msgs[0].role).toBe("user");
		expect(msgs[1].role).toBe("assistant");
		expect(msgs[1].parts).toHaveLength(2);
		expect(msgs[1].parts[0]).toMatchObject({
			type: "reasoning",
			text: "thinking…",
		});
		expect(msgs[1].parts[1]).toMatchObject({ type: "text", text: "ok" });
	});

	it("merges tool-result output into the matching tool-call by toolCallId", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "build" }),
			convEvent(1, {
				type: "tool-call",
				toolCallId: "t1",
				toolName: "addModule",
				input: { name: "Intake" },
			}),
			convEvent(2, {
				type: "tool-result",
				toolCallId: "t1",
				toolName: "addModule",
				output: "ok",
			}),
		];
		const msgs = buildReplayMessages(events, 2);
		expect(msgs).toHaveLength(2);
		const toolPart = msgs[1].parts[0] as {
			type: string;
			toolCallId: string;
			state: string;
			output: unknown;
			input: unknown;
		};
		expect(toolPart.type).toBe("tool-addModule");
		expect(toolPart.toolCallId).toBe("t1");
		expect(toolPart.state).toBe("output-available");
		expect(toolPart.input).toEqual({ name: "Intake" });
		expect(toolPart.output).toBe("ok");
	});

	it("tool-result with no matching call is a no-op (tolerates partial logs)", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "build" }),
			convEvent(1, {
				type: "tool-result",
				toolCallId: "orphan",
				toolName: "addModule",
				output: "ok",
			}),
		];
		const msgs = buildReplayMessages(events, 1);
		/* Orphan tool-result opens an empty assistant message but doesn't
		 * add a part — no call to merge into. */
		expect(msgs).toHaveLength(2);
		expect(msgs[1].role).toBe("assistant");
		expect(msgs[1].parts).toHaveLength(0);
	});

	it("appends an error part from an error event", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "go" }),
			convEvent(1, {
				type: "error",
				error: { type: "internal", message: "boom", fatal: true },
			}),
		];
		const msgs = buildReplayMessages(events, 1);
		expect(msgs).toHaveLength(2);
		expect(msgs[1].role).toBe("assistant");
		const errPart = msgs[1].parts[0] as { type: string; error: string };
		expect(errPart.type).toBe("error");
		expect(errPart.error).toBe("boom");
	});

	it("skips mutation events entirely without opening an assistant turn", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "build" }),
			mutationEvent(1),
			mutationEvent(2),
			convEvent(3, { type: "assistant-text", text: "done" }),
		];
		const msgs = buildReplayMessages(events, 3);
		/* Mutation events between user + assistant are invisible — the
		 * assistant turn opens when its first conversation event arrives. */
		expect(msgs).toHaveLength(2);
		expect(msgs[1].role).toBe("assistant");
		expect(msgs[1].parts).toEqual([{ type: "text", text: "done" }]);
	});

	it("a second user-message closes the prior assistant turn", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "first" }),
			convEvent(1, { type: "assistant-text", text: "reply 1" }),
			convEvent(2, { type: "user-message", text: "second" }),
			convEvent(3, { type: "assistant-text", text: "reply 2" }),
		];
		const msgs = buildReplayMessages(events, 3);
		expect(msgs).toHaveLength(4);
		expect(msgs.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(msgs[1].parts).toEqual([{ type: "text", text: "reply 1" }]);
		expect(msgs[3].parts).toEqual([{ type: "text", text: "reply 2" }]);
	});

	it("respects the cursor as an inclusive upper bound", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "first" }),
			convEvent(1, { type: "assistant-text", text: "streaming" }),
			convEvent(2, { type: "assistant-text", text: "more" }),
			convEvent(3, { type: "user-message", text: "second" }),
		];
		/* Cursor=1 → only first two events visible. The pending assistant
		 * message is flushed at the end of the walk. */
		const msgs = buildReplayMessages(events, 1);
		expect(msgs).toHaveLength(2);
		expect(msgs[1].parts).toEqual([{ type: "text", text: "streaming" }]);
	});

	it("clamps cursor > events.length - 1 to the full log", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "only" }),
			convEvent(1, { type: "assistant-text", text: "reply" }),
		];
		const all = buildReplayMessages(events, 999);
		const direct = buildReplayMessages(events, events.length - 1);
		expect(all).toEqual(direct);
	});
});

// ── Hook integration ─────────────────────────────────────────────────────

describe("useReplayMessages", () => {
	it("returns the reference-stable empty array when replay is not loaded", () => {
		const store = createBuilderSessionStore();
		function wrapper({ children }: { children: ReactNode }) {
			return (
				<BuilderSessionContext.Provider value={store}>
					{children}
				</BuilderSessionContext.Provider>
			);
		}
		const first = renderHook(() => useReplayMessages(), { wrapper });
		const second = renderHook(() => useReplayMessages(), { wrapper });
		expect(first.result.current).toHaveLength(0);
		/* Both calls should land on the same empty-array sentinel so
		 * shallow-equality consumers don't re-render. */
		expect(first.result.current).toBe(second.result.current);
	});

	it("builds progressive messages up to the seeded cursor", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "build me an app" }),
			convEvent(1, { type: "assistant-reasoning", text: "thinking…" }),
			convEvent(2, { type: "assistant-text", text: "ok" }),
			convEvent(3, {
				type: "tool-call",
				toolCallId: "t1",
				toolName: "addModule",
				input: {},
			}),
			convEvent(4, {
				type: "tool-result",
				toolCallId: "t1",
				toolName: "addModule",
				output: "ok",
			}),
		];
		const { result } = renderUseReplayMessages(events, 2);
		const msgs = result.current.messages;
		expect(msgs).toHaveLength(2);
		expect(msgs[0].role).toBe("user");
		expect(msgs[1].role).toBe("assistant");
		/* Assistant message has a text part from event 2 (plus reasoning
		 * from event 1). */
		expect(msgs[1].parts.some((p) => p.type === "text")).toBe(true);
	});

	it("re-derives when setReplayCursor advances the cursor", () => {
		const events: Event[] = [
			convEvent(0, { type: "user-message", text: "hi" }),
			convEvent(1, { type: "assistant-text", text: "one" }),
			convEvent(2, { type: "assistant-text", text: "two" }),
		];
		const { result } = renderUseReplayMessages(events, 1);
		/* Cursor=1: assistant has just "one". */
		expect(result.current.messages[1].parts).toEqual([
			{ type: "text", text: "one" },
		]);

		act(() => {
			result.current.api.getState().setReplayCursor(2);
		});

		/* Cursor=2: assistant now has "one" + "two". */
		expect(result.current.messages[1].parts).toEqual([
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		]);
	});
});
