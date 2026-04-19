import { describe, expect, it, vi } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain/uuid";
import {
	deriveReplayChapters,
	replayEvents,
	replayEventsSync,
} from "../replay";
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

/**
 * Mutation-event variant with a caller-supplied Mutation payload, for the
 * name-resolution test below. The default `mut()` above hard-codes
 * `setAppName` because it's the cheapest variant that round-trips through
 * `applyMany`; the resolution test needs to construct an actual module +
 * form in the running doc, so it emits the real `addModule` / `addForm`
 * mutations here instead.
 */
function mutWith(
	seq: number,
	stage: string,
	mutation: Mutation,
): MutationEvent {
	return {
		kind: "mutation",
		runId: "r",
		ts: seq,
		seq,
		actor: "agent",
		stage,
		mutation,
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

describe("replayEventsSync", () => {
	/* Mirror of the async happy-path test — the sync helper is the
	 * load-bearing contract for ReplayController + ReplayHydrator, so
	 * the in-order, synchronous dispatch guarantee needs an explicit
	 * test so a future refactor can't silently break it. */
	it("dispatches mutation + conversation events in order synchronously", () => {
		const calls: Array<["mut" | "conv", number]> = [];
		const events: Event[] = [
			conv(0, { type: "user-message", text: "hi" }),
			mut(1, "scaffold"),
			conv(2, { type: "assistant-text", text: "done" }),
			mut(3, "module:0"),
		];
		replayEventsSync(
			events,
			(m) => {
				/* Use the mutation's embedded `name` to prove order — `seq`
				 * isn't visible on the Mutation payload. `v{seq}` was set
				 * by the `mut()` factory above. */
				const name = "name" in m ? m.name : "";
				calls.push(["mut", Number(name.replace("v", ""))]);
			},
			(p) => {
				/* Conversation payloads don't carry `seq` either, so key
				 * off the text body the factory set (`hi` → 0, `done` → 2). */
				if (p.type === "user-message") calls.push(["conv", 0]);
				if (p.type === "assistant-text") calls.push(["conv", 2]);
			},
		);
		expect(calls).toEqual([
			["conv", 0],
			["mut", 1],
			["conv", 2],
			["mut", 3],
		]);
	});

	/* The sync helper is an empty no-op on an empty log — exercised by
	 * hydration of replays whose cursor lands before the first event. */
	it("no-ops on empty events array", () => {
		const onMutation = vi.fn();
		const onConversation = vi.fn();
		replayEventsSync([], onMutation, onConversation);
		expect(onMutation).not.toHaveBeenCalled();
		expect(onConversation).not.toHaveBeenCalled();
	});
});

describe("deriveReplayChapters", () => {
	/* No synthetic "Done" chapter trails the real ones — a prior version
	 * of this helper appended one and it overlapped the last real chapter
	 * at `events.length - 1`, causing `findIndex` in the ReplayController
	 * to return the PREVIOUS chapter at the done cursor (`N-1/N`). The
	 * final real chapter is the terminal scrub target. */
	it("groups mutation events by stage tag (no trailing Done)", () => {
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
		]);
		expect(chapters.map((c) => [c.startIndex, c.endIndex])).toEqual([
			[0, 1],
			[2, 2],
			[3, 4],
			[5, 5],
		]);
	});

	it("creates a leading Conversation chapter for pre-mutation chat", () => {
		const events: Event[] = [
			conv(0, { type: "user-message", text: "hi" }),
			conv(1, { type: "assistant-text", text: "sure" }),
			mut(2, "scaffold"),
		];
		const chapters = deriveReplayChapters(events);
		expect(chapters.map((c) => c.header)).toEqual(["Conversation", "Scaffold"]);
		expect(chapters[0]).toMatchObject({ startIndex: 0, endIndex: 1 });
		expect(chapters[1]).toMatchObject({ startIndex: 2, endIndex: 2 });
	});

	/* Regression pin — the synthetic Done chapter must NOT be appended.
	 * Keeping an explicit negative test here (rather than deleting the
	 * original Done test outright) flags any accidental re-introduction
	 * as a loud failure instead of a silent behavioural change. */
	it("does not append a synthetic Done chapter", () => {
		const events: Event[] = [mut(0, "scaffold")];
		const chapters = deriveReplayChapters(events);
		expect(chapters).toHaveLength(1);
		expect(chapters[0].header).toBe("Scaffold");
	});

	it("absorbs conversation events into the current mutation chapter", () => {
		const events: Event[] = [
			mut(0, "scaffold"),
			conv(1, { type: "assistant-text", text: "done scaffolding" }),
			mut(2, "scaffold"),
			mut(3, "module:0"),
		];
		const chapters = deriveReplayChapters(events);
		/* Scaffold chapter spans index 0..2 (absorbing the intervening conv
		 * event); module:0 chapter is index 3..3. */
		expect(chapters.map((c) => c.header)).toEqual(["Scaffold", "Module"]);
		expect(chapters[0].endIndex).toBe(2);
	});

	it("handles events with no mutations — leading conversation only", () => {
		const events: Event[] = [
			conv(0, { type: "user-message", text: "hi" }),
			conv(1, { type: "assistant-text", text: "hello" }),
		];
		const chapters = deriveReplayChapters(events);
		/* One Conversation chapter covering [0, 1]. */
		expect(chapters.map((c) => c.header)).toEqual(["Conversation"]);
		expect(chapters[0]).toMatchObject({ startIndex: 0, endIndex: 1 });
	});

	it("returns an empty chapter list for empty input", () => {
		expect(deriveReplayChapters([])).toEqual([]);
	});

	/* When no scaffold mutation precedes an indexed stage tag, the running
	 * doc has no module/form to resolve against. The subtitle falls back
	 * to a human-readable placeholder (`Module N` / `Form M-F`) rather
	 * than the raw SA-facing index tag — a user scrubbing a truncated /
	 * partial log should never see `module:0` bleed through to the UI. */
	it("falls back to `Module N` / `Form M-F` when the doc can't resolve the index", () => {
		const events: Event[] = [mut(0, "module:2"), mut(1, "form:1-3")];
		const chapters = deriveReplayChapters(events);
		expect(chapters[0].subtitle).toBe("Module 2");
		expect(chapters[1].subtitle).toBe("Form 1-3");
	});

	/* Name-resolution happy path — a log that actually mints a module
	 * and form before the `module:0` / `form:0-0` stage tags hit should
	 * surface the entities' display names in the subtitle. Uses real
	 * `addModule` + `addForm` mutations so the running doc accumulates the
	 * same way it does in production. */
	it("resolves module:N and form:M-F subtitles to display names from the running doc", () => {
		const moduleUuid = asUuid(crypto.randomUUID());
		const formUuid = asUuid(crypto.randomUUID());
		const events: Event[] = [
			/* Scaffold chapter lays down the entities. The `scaffold` tag
			 * groups these three mutations into one chapter, after which
			 * the running doc has { appName, modules[moduleUuid],
			 * forms[formUuid] }. */
			mutWith(0, "scaffold", {
				kind: "setAppName",
				name: "Outreach",
			}),
			mutWith(1, "scaffold", {
				kind: "addModule",
				module: {
					uuid: moduleUuid,
					id: "visits",
					name: "Patient Visits",
				},
			}),
			mutWith(2, "scaffold", {
				kind: "addForm",
				moduleUuid,
				form: {
					uuid: formUuid,
					id: "intake",
					name: "Initial Intake",
					type: "registration",
				},
			}),
			/* Followup chapters reference the entities by index — these
			 * are what the live SA emits as it starts writing into each
			 * module/form. The subtitle must resolve to the scaffold's
			 * `name` field, not the raw tag. */
			mutWith(3, "module:0", {
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseType: "patient" },
			}),
			mutWith(4, "form:0-0", {
				kind: "updateForm",
				uuid: formUuid,
				patch: { type: "followup" },
			}),
		];
		const chapters = deriveReplayChapters(events);
		expect(chapters.map((c) => c.header)).toEqual([
			"Scaffold",
			"Module",
			"Form",
		]);
		/* Scaffold has no indexed stage → no subtitle. */
		expect(chapters[0].subtitle).toBeUndefined();
		/* module:0 → running doc has one module, so subtitle is its name. */
		expect(chapters[1].subtitle).toBe("Patient Visits");
		/* form:0-0 → running doc has one form under the first module, so
		 * subtitle is the form's name. */
		expect(chapters[2].subtitle).toBe("Initial Intake");
	});
});
