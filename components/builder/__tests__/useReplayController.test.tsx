// @vitest-environment happy-dom

/**
 * useReplayController — behavioural tests for the replay transport bar.
 *
 * The hook owns three coupled responsibilities the tests below exercise
 * directly via `renderHook`:
 *   1. Deriving the current chapter index from the session cursor.
 *   2. Dispatching `goToChapter(N)` as a cumulative replay — reset the
 *      doc, apply `events[0..chapters[N].endIndex]` via `applyMany`,
 *      then commit the new cursor so `useReplayMessages` re-derives
 *      the chat.
 *   3. Composing `handleExit` — `resetBuilder + sessionStore.reset() +
 *      router.push` in that order, so the next route's mount doesn't
 *      observe stale session state.
 *
 * The view component (`ReplayController.tsx`) is a presentational
 * shell whose chrome lives in visual QA / Playwright.
 *
 * `resetBuilder` is mocked so the doc-store `load()` + signal-grid
 * side effects stay out of the assertion surface — only the
 * composition shape matters here. Router + engine controller stubs
 * round out the mock surface.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import { createWiredStores } from "@/lib/generation/__tests__/testHelpers";
import type { Event } from "@/lib/log/types";
import {
	BuilderSessionContext,
	type BuilderSessionStoreApi,
} from "@/lib/session/provider";
import type { ReplayChapter } from "@/lib/session/types";
import { useReplayController } from "../useReplayController";

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

/* `resetBuilder` covers the doc + engine + signal-grid surfaces only —
 * session state is composed separately. Mocking it lets us verify call
 * shape + ordering independently from the doc-store `load()` + signal-
 * grid side effects, which aren't relevant to the controller contract. */
const resetBuilderMock = vi.fn();
vi.mock("@/lib/doc/resetBuilder", () => ({
	resetBuilder: (...args: unknown[]) => resetBuilderMock(...args),
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
		source: "chat",
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
		source: "chat",
		payload: { type: "user-message", text },
	};
}

/**
 * Build a 4-event / 3-chapter fixture: one Conversation chapter, two
 * Scaffold/Module chapters. Wide enough to exercise forward + back
 * navigation bounds and cumulative `goToChapter` replays without being
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

/** Mount the `useReplayController` hook against fresh doc + session
 *  stores with the canonical 3-chapter fixture loaded and cursor at
 *  `initialCursor`. Returns the hook result + both stores so tests can
 *  call `goToChapter`, observe state, and spy on store methods. */
function mountController(opts: { events: Event[]; initialCursor: number }): {
	result: { current: ReturnType<typeof useReplayController> };
	docStore: BlueprintDocStoreApi;
	sessionStore: BuilderSessionStoreApi;
	applyManySpy: ReturnType<typeof vi.spyOn>;
} {
	const { docStore, sessionStore } = createWiredStores();
	const { chapters } = buildFixture();

	sessionStore.getState().loadReplay({
		events: opts.events,
		chapters,
		initialCursor: opts.initialCursor,
		exitPath: "/admin/logs",
	});

	const applyManySpy = vi.spyOn(docStore.getState(), "applyMany");

	function wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocContext value={docStore}>
				<BuilderSessionContext value={sessionStore}>
					{children}
				</BuilderSessionContext>
			</BlueprintDocContext>
		);
	}

	const { result } = renderHook(() => useReplayController(), { wrapper });
	return { result, docStore, sessionStore, applyManySpy };
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
	routerPush.mockReset();
	resetBuilderMock.mockReset();
	engineControllerStub.deactivate.mockReset();
	engineControllerStub.activate.mockReset();
});

describe("useReplayController — cursor derivation", () => {
	/* Cursor=1 lands inside chapter 1 (Scaffold, [1, 1]). The hook
	 * must report `currentChapterIndex === 1` and surface the chapter
	 * record in `currentChapter`. */
	it("derives currentChapterIndex from the session cursor", () => {
		const { events } = buildFixture();
		const { result } = mountController({ events, initialCursor: 1 });
		expect(result.current.currentChapterIndex).toBe(1);
		expect(result.current.currentChapter?.header).toBe("Scaffold");
		expect(result.current.totalChapters).toBe(3);
	});
});

describe("useReplayController — goToChapter", () => {
	/* Start at chapter 2 (cursor=3), go back to chapter 1 (Scaffold,
	 * endIndex=1). Expect:
	 *   - resetBuilder called once before applyMany (doc + engine +
	 *     signal grid only; session.reset is NOT called on scrub so
	 *     replay.* survives)
	 *   - applyMany called for every mutation in events[0..1]
	 *     (event[0] is conversation and contributes nothing)
	 *   - session cursor advanced to 1 */
	it("resets, replays events up to chapter.endIndex, and advances the cursor", () => {
		const { events } = buildFixture();
		const { result, sessionStore, applyManySpy } = mountController({
			events,
			initialCursor: 3,
		});
		const sessionResetSpy = vi.spyOn(sessionStore.getState(), "reset");

		act(() => result.current.goToChapter(1));

		/* resetBuilder runs first so the doc is empty before the replay
		 * slice lands. Session reset must NOT fire on scrub — that would
		 * clear `replay.*`. */
		expect(resetBuilderMock).toHaveBeenCalledTimes(1);
		expect(resetBuilderMock).toHaveBeenCalledWith(
			expect.objectContaining({
				docStore: expect.anything(),
				engineController: expect.anything(),
			}),
		);
		/* Explicit negative assertion: `sessionStore` is intentionally
		 * absent from `resetBuilder`'s input shape. A regression that
		 * silently re-added it would be caught by TS, but pinning it at
		 * runtime documents the contract. */
		const resetArgs = resetBuilderMock.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(resetArgs).not.toHaveProperty("sessionStore");
		expect(sessionResetSpy).not.toHaveBeenCalled();

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

	/* `goToChapter` must not wipe session state. `resetBuilder` is scoped
	 * to doc + engine + signal grid; the scrub path never calls
	 * `sessionStore.reset()`. This test pins that contract by snapshotting
	 * `session.replay` before and after a scrub and asserting only the
	 * cursor moved. */
	it("preserves session.replay across a scrub call", () => {
		const { events } = buildFixture();
		const { result, sessionStore } = mountController({
			events,
			initialCursor: 3,
		});

		const replayBefore = sessionStore.getState().replay;
		expect(replayBefore).toBeDefined();
		expect(replayBefore?.events).toHaveLength(4);
		expect(replayBefore?.chapters).toHaveLength(3);

		act(() => result.current.goToChapter(1));

		/* Post-scrub: replay still defined, chapters + events unchanged,
		 * only the cursor has moved. This is the whole point of keeping
		 * session reset out of the scrub path. */
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
		const { result, applyManySpy } = mountController({
			events,
			initialCursor: 1,
		});

		act(() => result.current.goToChapter(2));

		/* events[0..3] contains three mutations (seq 1, 2, 3). The
		 * conversation event at seq 0 is skipped by the dispatcher, so
		 * applyMany fires three times — in order. */
		expect(applyManySpy).toHaveBeenCalledTimes(3);
		expect(applyManySpy.mock.calls.map((c: unknown[]) => c[0])).toEqual([
			[{ kind: "setAppName", name: "v1" }],
			[{ kind: "setAppName", name: "v2" }],
			[{ kind: "setAppName", name: "v3" }],
		]);
	});

	/* Regression pin: scrubbing to the final chapter clears the session
	 * events buffer so `derivePhase` returns Ready, matching live's
	 * post-endRun state. Without this, the final frame of a completed
	 * build would render as Generating (buffer has schema/scaffold +
	 * later stage tags → bufferHasBuildFoundation=true → Generating).
	 * Non-terminal scrubs populate the buffer normally. */
	it("terminal scrub clears the session events buffer; non-terminal populates it", () => {
		const { events } = buildFixture();
		const { result, sessionStore } = mountController({
			events,
			initialCursor: 1,
		});

		act(() => result.current.goToChapter(2));

		/* Terminal scrub → buffer empty. Cursor committed at endIndex=3. */
		expect(sessionStore.getState().events).toEqual([]);
		expect(sessionStore.getState().replay?.cursor).toBe(3);

		act(() => result.current.goToChapter(1));

		/* Non-terminal scrub → buffer populated with slice. Events[0..1]
		 * is one conversation + one scaffold mutation. */
		expect(sessionStore.getState().events).toHaveLength(2);
		expect(sessionStore.getState().replay?.cursor).toBe(1);
	});
});

describe("useReplayController — arrow gating", () => {
	/* At chapter 0, back is disabled. Calling goToChapter(-1) is a
	 * no-op — resetBuilder must not fire. */
	it("canGoBack is false at chapter 0; calling goToChapter on the disabled side is a no-op", () => {
		const { events } = buildFixture();
		const { result } = mountController({ events, initialCursor: 0 });
		expect(result.current.canGoBack).toBe(false);
		act(() => result.current.goToChapter(-1));
		expect(resetBuilderMock).not.toHaveBeenCalled();
	});

	/* At the final chapter, forward is disabled. Same no-op assertion. */
	it("canGoForward is false at the last chapter", () => {
		const { events } = buildFixture();
		const { result } = mountController({ events, initialCursor: 3 });
		expect(result.current.canGoForward).toBe(false);
		act(() => result.current.goToChapter(3));
		expect(resetBuilderMock).not.toHaveBeenCalled();
	});
});

describe("useReplayController — error path", () => {
	/* If the reset throws, the hook should surface the error in its
	 * `error` field and NOT advance the cursor. The `try/catch` around
	 * the whole `goToChapter` body is the whole reason this behaviour
	 * is worth pinning. */
	it("surfaces an error when goToChapter throws during reset", () => {
		resetBuilderMock.mockImplementationOnce(() => {
			throw new Error("reset explosion");
		});
		const { events } = buildFixture();
		const { result, sessionStore } = mountController({
			events,
			initialCursor: 3,
		});

		act(() => result.current.goToChapter(1));

		/* Cursor stays at 3 — failed scrubs must not leave the UI
		 * pointing at a frame the doc doesn't reflect. */
		expect(sessionStore.getState().replay?.cursor).toBe(3);
		/* Error string surfaces the underlying message. */
		expect(result.current.error).toContain("reset explosion");
	});
});

describe("useReplayController — exit", () => {
	/* Calling handleExit composes the full exit: `resetBuilder` wipes
	 * doc + engine + signal grid, then `sessionStore.reset()` clears
	 * session state (including `replay.*`), then `router.push`
	 * navigates. Order matters — session must reset before the new
	 * route mounts so its initial render doesn't observe stale state. */
	it("composes resetBuilder + session.reset + push in order, using exitPath", () => {
		const { events } = buildFixture();
		const { result, sessionStore } = mountController({
			events,
			initialCursor: 3,
		});
		const sessionResetSpy = vi.spyOn(sessionStore.getState(), "reset");

		act(() => result.current.handleExit());

		/* All three sides of the composition fire exactly once. */
		expect(resetBuilderMock).toHaveBeenCalledTimes(1);
		expect(sessionResetSpy).toHaveBeenCalledTimes(1);
		expect(routerPush).toHaveBeenCalledTimes(1);
		expect(routerPush).toHaveBeenCalledWith("/admin/logs");

		/* `resetBuilder` still takes only doc + engine — adding session
		 * back into its inputs would be a silent regression. */
		const resetArgs = resetBuilderMock.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(resetArgs).not.toHaveProperty("sessionStore");

		/* Strict ordering: resetBuilder → session.reset → router.push.
		 * Vitest spies share a monotonic invocation order via
		 * `mock.invocationCallOrder`, so comparing first-call indices
		 * pins the sequence without timing heuristics. */
		const resetOrder = resetBuilderMock.mock.invocationCallOrder[0];
		const sessionOrder = sessionResetSpy.mock.invocationCallOrder[0];
		const pushOrder = routerPush.mock.invocationCallOrder[0];
		expect(resetOrder).toBeLessThan(sessionOrder);
		expect(sessionOrder).toBeLessThan(pushOrder);
	});
});
