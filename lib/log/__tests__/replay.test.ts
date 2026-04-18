import { describe, expect, it, vi } from "vitest";
import { deriveReplayChapters, replayEvents } from "../replay";
import type { ConversationEvent, Event, MutationEvent } from "../types";

function mut(seq: number, stage?: string): MutationEvent {
	return {
		kind: "mutation",
		runId: "r",
		ts: seq,
		seq,
		actor: "agent",
		...(stage && { stage }),
		mutation: { kind: "setAppName", name: `v${seq}` },
	};
}

function conv(
	seq: number,
	payload: ConversationEvent["payload"],
): ConversationEvent {
	return { kind: "conversation", runId: "r", ts: seq, seq, payload };
}

describe("replayEvents", () => {
	it("dispatches mutation + conversation events in order", async () => {
		const onMutation = vi.fn();
		const onConversation = vi.fn();
		const events: Event[] = [
			conv(0, { type: "user-message", text: "hi" }),
			mut(1, "scaffold"),
			conv(2, { type: "assistant-text", text: "done" }),
		];
		await replayEvents(events, onMutation, onConversation, 0);
		expect(onMutation).toHaveBeenCalledTimes(1);
		expect(onConversation).toHaveBeenCalledTimes(2);
		expect(onMutation.mock.calls[0][0]).toEqual(
			(events[1] as MutationEvent).mutation,
		);
	});

	it("short-circuits when signal is aborted", async () => {
		const onMutation = vi.fn();
		const onConversation = vi.fn();
		const controller = new AbortController();
		controller.abort();
		await replayEvents(
			[mut(0)],
			onMutation,
			onConversation,
			0,
			controller.signal,
		);
		expect(onMutation).not.toHaveBeenCalled();
	});
});

describe("deriveReplayChapters", () => {
	it("groups mutation events by stage tag", () => {
		const events: Event[] = [
			mut(0, "schema"),
			mut(1, "schema"),
			mut(2, "scaffold"),
			mut(3, "module:0"),
			mut(4, "module:0"),
			mut(5, "form:0-0"),
		];
		const chapters = deriveReplayChapters(events);
		expect(chapters.map((c) => c.header)).toEqual([
			"Data Model",
			"Scaffold",
			"Module",
			"Form",
			"Done",
		]);
		expect(chapters.slice(0, 4).map((c) => [c.startIndex, c.endIndex])).toEqual(
			[
				[0, 1],
				[2, 2],
				[3, 4],
				[5, 5],
			],
		);
	});

	it("creates a leading Conversation chapter for pre-mutation chat", () => {
		const events: Event[] = [
			conv(0, { type: "user-message", text: "hi" }),
			conv(1, { type: "assistant-text", text: "sure" }),
			mut(2, "scaffold"),
		];
		const chapters = deriveReplayChapters(events);
		expect(chapters[0].header).toBe("Conversation");
		expect(chapters[0].endIndex).toBe(1);
		expect(chapters[1].header).toBe("Scaffold");
	});

	it("adds a synthetic Done chapter at the end", () => {
		const events: Event[] = [mut(0, "scaffold")];
		const chapters = deriveReplayChapters(events);
		expect(chapters[chapters.length - 1].header).toBe("Done");
	});

	it("absorbs conversation events into the current mutation chapter", () => {
		const events: Event[] = [
			mut(0, "scaffold"),
			conv(1, { type: "assistant-text", text: "done scaffolding" }),
			mut(2, "scaffold"),
			mut(3, "module:0"),
		];
		const chapters = deriveReplayChapters(events);
		/* Scaffold chapter spans index 0..2 (absorbing the intervening conv event);
		 * module:0 chapter is index 3..3. Plus the synthetic "Done". */
		expect(chapters.map((c) => c.header)).toEqual([
			"Scaffold",
			"Module",
			"Done",
		]);
		expect(chapters[0].endIndex).toBe(2);
	});

	it("handles events with no mutations — leading conversation only", () => {
		const events: Event[] = [
			conv(0, { type: "user-message", text: "hi" }),
			conv(1, { type: "assistant-text", text: "hello" }),
		];
		const chapters = deriveReplayChapters(events);
		/* One Conversation chapter covering [0, 1], then Done. */
		expect(chapters.map((c) => c.header)).toEqual(["Conversation", "Done"]);
		expect(chapters[0]).toMatchObject({ startIndex: 0, endIndex: 1 });
	});

	it("returns an empty chapter list for empty input", () => {
		expect(deriveReplayChapters([])).toEqual([]);
	});

	it("attaches module:N / form:M-N as the chapter subtitle", () => {
		const events: Event[] = [mut(0, "module:2"), mut(1, "form:1-3")];
		const chapters = deriveReplayChapters(events);
		expect(chapters[0].subtitle).toBe("module:2");
		expect(chapters[1].subtitle).toBe("form:1-3");
	});
});
