/**
 * Named domain hooks for the BuilderSession store.
 *
 * Components never call `useBuilderSession` with inline selectors — they
 * import a named hook from this file. This enforces a single subscription
 * API (no `select*` vs `derive*` split) and makes call sites greppable.
 *
 * All hooks are "use client" because they subscribe to React context.
 */
"use client";

import { useBuilderSession, useBuilderSessionShallow } from "./provider";
import type { SidebarKind } from "./store";
import type { CursorMode } from "./types";

// ── Cursor mode ───────────────────────────────────────────────────────────

/** Current cursor mode — "edit" or "pointer". */
export function useCursorMode(): CursorMode {
	return useBuilderSession((s) => s.cursorMode);
}

/** Atomic mode switch with sidebar stash/restore. Prefer over `useSetCursorMode`
 *  when the mode toggle should preserve sidebar layout state. */
export function useSwitchCursorMode(): (mode: CursorMode) => void {
	return useBuilderSession((s) => s.switchCursorMode);
}

/** Non-atomic cursor mode setter — for forced resets and initialization,
 *  not interactive mode toggles. Does not stash/restore sidebars. */
export function useSetCursorMode(): (mode: CursorMode) => void {
	return useBuilderSession((s) => s.setCursorMode);
}

// ── Active field ──────────────────────────────────────────────────────────

/** Which `[data-field-id]` element currently has focus. `undefined` when no
 *  field is focused. Transient UI hint for undo/redo scroll targeting. */
export function useActiveFieldId(): string | undefined {
	return useBuilderSession((s) => s.activeFieldId);
}

/** Setter for the active field ID. */
export function useSetActiveFieldId(): (fieldId: string | undefined) => void {
	return useBuilderSession((s) => s.setActiveFieldId);
}

// ── Sidebar state ─────────────────────────────────────────────────────────

/** Visibility + stash state for one sidebar. `open` is current visibility;
 *  `stashed` is the pre-pointer-mode value (or `undefined` if nothing stashed). */
export function useSidebarState(kind: SidebarKind): {
	open: boolean;
	stashed: boolean | undefined;
} {
	return useBuilderSessionShallow((s) => s.sidebars[kind]);
}

/** Set one sidebar's visibility. Preserves stash values and the other sidebar. */
export function useSetSidebarOpen(): (
	kind: SidebarKind,
	open: boolean,
) => void {
	return useBuilderSession((s) => s.setSidebarOpen);
}

// ── Derived ───────────────────────────────────────────────────────────────

/** Derive edit mode from cursor mode. "pointer" maps to "test" (live form
 *  preview); everything else maps to "edit" (design mode). Replaces the
 *  legacy `selectEditMode` selector. */
export function useEditMode(): "edit" | "test" {
	const mode = useCursorMode();
	return mode === "pointer" ? "test" : "edit";
}
