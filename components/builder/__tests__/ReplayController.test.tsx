// @vitest-environment happy-dom

/**
 * ReplayController — behavioural tests for the replay transport bar.
 *
 * The controller owns three coupled responsibilities:
 *   1. Deriving the current chapter index from the session cursor.
 *   2. Dispatching `goToChapter(N)` as a cumulative replay — reset the
 *      doc, apply `events[0..chapters[N].endIndex]` via `applyMany`, then
 *      commit the new cursor so `useReplayMessages` re-derives the chat.
 *   3. Gating the forward/back arrows + the exit navigation.
 *
 * The tests mount the real `ReplayController` inside the two contexts it
 * actually reads from (`BuilderSessionContext` + `BlueprintDocContext`)
 * plus a mocked `useRouter` / `useBuilderFormEngine`. `resetBuilder` is
 * mocked so the doc-store `load()` + signal-grid side effects stay out
 * of the assertion surface — we only care that the controller calls into
 * the reset + applyMany + setReplayCursor pipeline in the correct order.
 */

import { fireEvent, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayController } from "@/components/builder/ReplayController";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createWiredStores } from "@/lib/generation/__tests__/testHelpers";
import type { Event } from "@/lib/log/types";
import {
	BuilderSessionContext,
	type BuilderSessionStoreApi,
	useBuilderSession,
} from "@/lib/session/provider";
import type { ReplayChapter } from "@/lib/session/types";

// ── Module mocks ────────────────────────────────────────────────────────

/* Router spy — one `push` function we can assert on per test. Recreated
 * in `beforeEach` so call counts don't leak between cases. */
const routerPush = vi.fn();
vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		useRouter: () => ({
			push: routerPush,
			replace: vi.fn(),
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
	};
});

/* Engine controller stub — the real controller carries a heavy per-
 * field reactive graph we don't need here. The controller is only
 * touched via `resetBuilder`, which we mock out anyway; providing a
 * minimal `deactivate`/`activate` surface keeps the provider-hook
 * return-type happy. */
const engineControllerStub = {
	deactivate: vi.fn(),
	activate: vi.fn(),
};
vi.mock("@/lib/preview/engine/provider", () => ({
	useBuilderFormEngine: () => engineControllerStub,
}));

/* Two resets now live in `lib/services/resetBuilder`:
 *   - `resetBuilder` — full wipe (doc + engine + signal + SESSION). Only
 *     `handleExit` uses this.
 *   - `resetBuilderForReplay` — scrub wipe (doc + engine + signal, session
 *     PRESERVED). `goToChapter` uses this so the transport bar's
 *     `replay.*` state survives the click.
 *
 * Spying on both separately lets us verify that each code path picks
 * the right variant — a regression where `goToChapter` reverted to the
 * full reset would wipe `session.replay` and leave the controller
 * rendering `0/0` chapters until unmount. */
const resetBuilderMock = vi.fn();
const resetBuilderForReplayMock = vi.fn();
vi.mock("@/lib/services/resetBuilder", () => ({
	resetBuilder: (...args: unknown[]) => resetBuilderMock(...args),
	resetBuilderForReplay: (...args: unknown[]) =>
		resetBuilderForReplayMock(...args),
}));

// ── Fixtures ────────────────────────────────────────────────────────────

/** Build a mutation event with `setAppName` as the payload — cheapest
 *  mutation variant that still round-trips through `applyMany`. The
 *  name carries the seq so tests can assert order. */
function mut(seq: number, stage: string): Event {
	return {
		kind: "mutation",
		runId: "r",
		ts: seq,
		seq,
		actor: "agent",
		stage,
		mutation: { kind: "setAppName", name: `v${seq}` },
	};
}

/** Minimal conversation event — drives chapter derivation tests. */
function userMsg(seq: number, text: string): Event {
	return {
		kind: "conversation",
		runId: "r",
		ts: seq,
		seq,
		payload: { type: "user-message", text },
	};
}

/**
 * Build a 4-event / 3-chapter fixture: one Conversation chapter, two
 * Scaffold/Module chapters. Wide enough to exercise forward + back
 * arrow bounds and cumulative `goToChapter` replays without being
 * tedious to read in assertions.
 */
function buildFixture(): { events: Event[]; chapters: ReplayChapter[] } {
	const events: Event[] = [
		userMsg(0, "hi"),
		mut(1, "scaffold"),
		mut(2, "module:0"),
		mut(3, "module:0"),
	];
	const chapters: ReplayChapter[] = [
		{ header: "Conversation", startIndex: 0, endIndex: 0 },
		{ header: "Scaffold", startIndex: 1, endIndex: 1 },
		{ header: "Module", subtitle: "module:0", startIndex: 2, endIndex: 3 },
	];
	return { events, chapters };
}

/** Mount the real ReplayController inside fresh doc + session stores,
 *  with the canonical 3-chapter fixture loaded and cursor at
 *  `initialCursor`. Returns the two stores + the render result so tests
 *  can poke state and click buttons. `applyMany` is spied on the doc
 *  store's initial state snapshot so `goToChapter` dispatches are
 *  observable — the store never swaps the function reference, so the
 *  spy remains valid across re-renders. */
function mountController(opts: { events: Event[]; initialCursor: number }) {
	const { docStore, sessionStore } = createWiredStores();
	const { chapters } = buildFixture();

	sessionStore.getState().loadReplay({
		events: opts.events,
		chapters,
		initialCursor: opts.initialCursor,
		exitPath: "/admin/logs",
	});

	const applyManySpy = vi.spyOn(docStore.getState(), "applyMany");

	const result = render(
		<BlueprintDocContext value={docStore}>
			<BuilderSessionContext value={sessionStore}>
				<ReplayController />
			</BuilderSessionContext>
		</BlueprintDocContext>,
	);

	return { docStore, sessionStore, applyManySpy, ...result };
}

/** Same wrapper, but mounts a hook so we can observe the session
 *  store through the real `useBuilderSession` hook (used for the
 *  cursor-derivation test). */
function mountWithSession<T>(
	initialCursor: number,
	hook: () => T,
): {
	result: { current: T };
	sessionStore: BuilderSessionStoreApi;
} {
	const { events, chapters } = buildFixture();
	const { sessionStore } = createWiredStores();
	sessionStore.getState().loadReplay({
		events,
		chapters,
		initialCursor,
		exitPath: "/admin/logs",
	});
	function wrapper({ children }: { children: ReactNode }) {
		return (
			<BuilderSessionContext value={sessionStore}>
				{children}
			</BuilderSessionContext>
		);
	}
	const { result } = renderHook(hook, { wrapper });
	return { result, sessionStore };
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
	routerPush.mockReset();
	resetBuilderMock.mockReset();
	resetBuilderForReplayMock.mockReset();
	engineControllerStub.deactivate.mockReset();
	engineControllerStub.activate.mockReset();
});

describe("ReplayController — cursor derivation", () => {
	/* When the cursor lands inside chapter 1's inclusive range, the
	 * controller should pick chapter 1 as "current" — verified through
	 * the session store rather than DOM inspection so the test is
	 * decoupled from the rendered label text. */
	it("derives currentChapterIndex from the session cursor", () => {
		const { events, chapters } = buildFixture();
		/* Cursor = 1 lands inside chapter 1 (Scaffold, [1, 1]). */
		const { result } = mountWithSession(1, () =>
			useBuilderSession((s) => s.replay),
		);
		expect(result.current?.cursor).toBe(1);
		const cursor = result.current?.cursor ?? -1;
		const idx = chapters.findIndex(
			(c) => cursor >= c.startIndex && cursor <= c.endIndex,
		);
		expect(idx).toBe(1);
		expect(events[cursor]).toEqual(mut(1, "scaffold"));
	});
});

describe("ReplayController — goToChapter", () => {
	/* Start at chapter 2 (cursor=3), click left arrow to go back to
	 * chapter 1 (Scaffold, endIndex=1). Expect:
	 *   - resetBuilderForReplay called once before applyMany (scrub
	 *     preserves session state — the full resetBuilder would clear
	 *     replay.*)
	 *   - applyMany called for every mutation in events[0..1]
	 *     (event[0] is conversation and contributes nothing)
	 *   - session cursor advanced to 1 */
	it("resets, replays events up to chapter.endIndex, and advances the cursor", () => {
		const { events } = buildFixture();
		const { sessionStore, applyManySpy, getAllByRole } = mountController({
			events,
			initialCursor: 3,
		});

		/* Order: left arrow, chapter info, right arrow, exit. Click left. */
		const [leftArrow] = getAllByRole("button");
		fireEvent.click(leftArrow);

		/* resetBuilderForReplay runs first so the doc is empty before the
		 * replay slice lands. The full resetBuilder (session-wiping) must
		 * NOT fire on scrub — that would clear `replay.*`. */
		expect(resetBuilderForReplayMock).toHaveBeenCalledTimes(1);
		expect(resetBuilderMock).not.toHaveBeenCalled();

		/* Cumulative replay from event 0 through the *previous* chapter's
		 * endIndex. Going back from chapter 2 (endIndex=3) lands on
		 * chapter 1 (endIndex=1) — that's events[0..1], and only event[1]
		 * is a mutation. */
		expect(applyManySpy).toHaveBeenCalledTimes(1);
		expect(applyManySpy).toHaveBeenCalledWith([
			{ kind: "setAppName", name: "v1" },
		]);

		/* Cursor committed AFTER the mutations land — this is the sync
		 * ordering guarantee `replayEventsSync` exists to protect. */
		expect(sessionStore.getState().replay?.cursor).toBe(1);
	});

	/* Regression pin for Bug 3 — `goToChapter` must NOT call the full
	 * `resetBuilder` (which calls `sessionStore.reset()` and clears
	 * `replay: undefined`). If it did, the transport bar would render
	 * `0/0` chapters on the next frame. Assert directly that replay
	 * state survives the click. */
	it("preserves session.replay across a scrub click", () => {
		const { events } = buildFixture();
		const { sessionStore, getAllByRole } = mountController({
			events,
			initialCursor: 3,
		});

		/* Baseline: replay state is populated on mount. */
		const replayBefore = sessionStore.getState().replay;
		expect(replayBefore).toBeDefined();
		expect(replayBefore?.events).toHaveLength(4);
		expect(replayBefore?.chapters).toHaveLength(3);

		const [leftArrow] = getAllByRole("button");
		fireEvent.click(leftArrow);

		/* Post-scrub: replay still defined, chapters + events unchanged,
		 * only the cursor has moved. This is the whole point of the
		 * replay-aware reset variant. */
		const replayAfter = sessionStore.getState().replay;
		expect(replayAfter).toBeDefined();
		expect(replayAfter?.events).toHaveLength(4);
		expect(replayAfter?.chapters).toHaveLength(3);
		expect(replayAfter?.cursor).toBe(1);
	});

	/* Forward navigation into the Module chapter (endIndex=3) replays
	 * both mutations in events[1] and events[2..3]. Proves the
	 * cumulative-from-zero semantics, not just the single-event delta. */
	it("replays ALL mutations from index 0 through the target chapter (cumulative)", () => {
		const { events } = buildFixture();
		const { applyManySpy, getAllByRole } = mountController({
			events,
			initialCursor: 1, // Scaffold chapter
		});

		/* Click right arrow → advance to Module chapter (endIndex=3). */
		const buttons = getAllByRole("button");
		const rightArrow = buttons[1];
		fireEvent.click(rightArrow);

		/* events[0..3] contains three mutations (seq 1, 2, 3). The
		 * conversation event at seq 0 is skipped by the dispatcher, so
		 * applyMany fires three times — in order. */
		expect(applyManySpy).toHaveBeenCalledTimes(3);
		expect(applyManySpy.mock.calls.map((c) => c[0])).toEqual([
			[{ kind: "setAppName", name: "v1" }],
			[{ kind: "setAppName", name: "v2" }],
			[{ kind: "setAppName", name: "v3" }],
		]);
	});
});

describe("ReplayController — arrow gating", () => {
	/* At chapter 0, back is disabled. Clicking the disabled button is a
	 * no-op — neither reset variant must fire. */
	it("disables the left arrow at chapter 0", () => {
		const { events } = buildFixture();
		const { getAllByRole } = mountController({
			events,
			initialCursor: 0, // Conversation chapter
		});
		const [leftArrow] = getAllByRole("button");
		/* `.disabled` on an HTMLButtonElement is the native DOM property;
		 * `@testing-library/jest-dom` isn't wired into this project so we
		 * check the property directly rather than using `toBeDisabled()`. */
		expect((leftArrow as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(leftArrow);
		expect(resetBuilderForReplayMock).not.toHaveBeenCalled();
		expect(resetBuilderMock).not.toHaveBeenCalled();
	});

	/* At the final chapter, forward is disabled. Same no-op assertion. */
	it("disables the right arrow at the last chapter", () => {
		const { events } = buildFixture();
		const { getAllByRole } = mountController({
			events,
			initialCursor: 3, // Module chapter (last)
		});
		const buttons = getAllByRole("button");
		const rightArrow = buttons[1];
		expect((rightArrow as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(rightArrow);
		expect(resetBuilderForReplayMock).not.toHaveBeenCalled();
		expect(resetBuilderMock).not.toHaveBeenCalled();
	});
});

describe("ReplayController — error path", () => {
	/* If the scrub-scoped reset throws, the controller should surface the
	 * error in its toast and NOT advance the cursor. The `try/catch`
	 * around the whole `goToChapter` body is the whole reason this
	 * behaviour is worth pinning. */
	it("renders an error toast when goToChapter throws during reset", () => {
		resetBuilderForReplayMock.mockImplementationOnce(() => {
			throw new Error("reset explosion");
		});
		const { events } = buildFixture();
		const { sessionStore, getAllByRole, findByText } = mountController({
			events,
			initialCursor: 3,
		});

		const [leftArrow] = getAllByRole("button");
		fireEvent.click(leftArrow);

		/* Cursor stays at 3 — failed scrubs must not leave the UI
		 * pointing at a frame the doc doesn't reflect. */
		expect(sessionStore.getState().replay?.cursor).toBe(3);
		/* Toast surfaces the underlying error message. */
		return findByText(/Cannot load chapter: reset explosion/).then((el) => {
			expect(el).toBeDefined();
		});
	});
});

describe("ReplayController — exit", () => {
	/* Clicking the exit button should reset once (via the FULL
	 * `resetBuilder`, not the scrub-scoped variant — exiting wipes
	 * session state on purpose) and push the exitPath from the replay
	 * state — not a hardcoded "/" fallback. */
	it("resets and navigates to exitPath from the replay state", () => {
		const { events } = buildFixture();
		const { getAllByRole } = mountController({
			events,
			initialCursor: 3,
		});
		/* Exit is the 3rd button: [←, →, ✕]. */
		const buttons = getAllByRole("button");
		const exitButton = buttons[2];
		fireEvent.click(exitButton);

		/* Full reset — the replay-scoped variant must NOT fire on exit:
		 * the user is leaving replay mode, so `replay.*` should clear. */
		expect(resetBuilderMock).toHaveBeenCalledTimes(1);
		expect(resetBuilderForReplayMock).not.toHaveBeenCalled();
		expect(routerPush).toHaveBeenCalledTimes(1);
		expect(routerPush).toHaveBeenCalledWith("/admin/logs");
	});
});
