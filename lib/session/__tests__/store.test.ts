/**
 * BuilderSession store — reducer-shaped action invariant tests.
 *
 * These tests exercise the store directly (no React, no provider) to verify
 * the atomic `switchCursorMode` action preserves sidebar stash/restore
 * semantics. The double-entry guard (test 5) is the critical invariant —
 * without it, entering pointer mode twice overwrites the stash with the
 * already-closed sidebar values.
 */

import { describe, expect, it } from "vitest";
import { createBuilderSessionStore } from "../store";

describe("BuilderSession store", () => {
	it("1. initial state: edit mode, both sidebars open, no stash", () => {
		const store = createBuilderSessionStore();
		const s = store.getState();
		expect(s.cursorMode).toBe("edit");
		expect(s.activeFieldId).toBeUndefined();
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("2. switchCursorMode('pointer') from edit: stashes open values, closes both", () => {
		const store = createBuilderSessionStore();
		store.getState().switchCursorMode("pointer");
		const s = store.getState();
		expect(s.cursorMode).toBe("pointer");
		expect(s.sidebars.chat).toEqual({ open: false, stashed: true });
		expect(s.sidebars.structure).toEqual({ open: false, stashed: true });
	});

	it("3. switchCursorMode('edit') after pointer: restores stashed values, clears stash", () => {
		const store = createBuilderSessionStore();
		store.getState().switchCursorMode("pointer");
		store.getState().switchCursorMode("edit");
		const s = store.getState();
		expect(s.cursorMode).toBe("edit");
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("4. switchCursorMode('pointer') with chat already closed: restores chat-closed state exactly", () => {
		const store = createBuilderSessionStore();

		/* Close chat before entering pointer mode. */
		store.getState().setSidebarOpen("chat", false);
		expect(store.getState().sidebars.chat.open).toBe(false);

		/* Enter pointer mode — stashes the current state (chat closed). */
		store.getState().switchCursorMode("pointer");
		const pointerState = store.getState();
		expect(pointerState.sidebars.chat).toEqual({
			open: false,
			stashed: false,
		});
		expect(pointerState.sidebars.structure).toEqual({
			open: false,
			stashed: true,
		});

		/* Return to edit — restores the stashed values exactly: chat stays
		 * closed (was closed before pointer), structure reopens. */
		store.getState().switchCursorMode("edit");
		const editState = store.getState();
		expect(editState.sidebars.chat).toEqual({
			open: false,
			stashed: undefined,
		});
		expect(editState.sidebars.structure).toEqual({
			open: true,
			stashed: undefined,
		});
	});

	it("5. switchCursorMode('pointer') twice is a no-op on the second call", () => {
		const store = createBuilderSessionStore();

		/* First switch: stashes both open values. */
		store.getState().switchCursorMode("pointer");
		const afterFirst = store.getState();

		/* Second switch: same mode → no-op. The stash must NOT be
		 * overwritten with { stashed: false } (the currently-closed values). */
		store.getState().switchCursorMode("pointer");
		const afterSecond = store.getState();

		/* State must be identical (same object reference from Zustand). */
		expect(afterSecond.cursorMode).toBe("pointer");
		expect(afterSecond.sidebars).toEqual(afterFirst.sidebars);

		/* Verify the stash still holds the original pre-pointer values, not
		 * the post-close false values. */
		expect(afterSecond.sidebars.chat.stashed).toBe(true);
		expect(afterSecond.sidebars.structure.stashed).toBe(true);
	});

	it("6. setSidebarOpen changes only the targeted sidebar, stash untouched", () => {
		const store = createBuilderSessionStore();

		store.getState().setSidebarOpen("chat", false);
		const s = store.getState();
		expect(s.sidebars.chat.open).toBe(false);
		expect(s.sidebars.chat.stashed).toBeUndefined();
		/* Structure sidebar unchanged. */
		expect(s.sidebars.structure.open).toBe(true);
		expect(s.sidebars.structure.stashed).toBeUndefined();
	});

	it("setCursorMode does not stash/restore sidebars", () => {
		const store = createBuilderSessionStore();

		/* Non-atomic setter: just sets the mode, no sidebar side-effects. */
		store.getState().setCursorMode("pointer");
		const s = store.getState();
		expect(s.cursorMode).toBe("pointer");
		/* Sidebars remain as initial state — no stash, still open. */
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("setActiveFieldId updates and no-ops on same value", () => {
		const store = createBuilderSessionStore();

		store.getState().setActiveFieldId("label");
		expect(store.getState().activeFieldId).toBe("label");

		/* Same value — should not trigger a new state object. */
		const prev = store.getState();
		store.getState().setActiveFieldId("label");
		expect(store.getState()).toBe(prev);

		store.getState().setActiveFieldId(undefined);
		expect(store.getState().activeFieldId).toBeUndefined();
	});

	it("setSidebarOpen no-ops on same value", () => {
		const store = createBuilderSessionStore();
		const prev = store.getState();

		/* Chat is already open — setting to true is a no-op. */
		store.getState().setSidebarOpen("chat", true);
		expect(store.getState()).toBe(prev);
	});
});
