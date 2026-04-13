// @vitest-environment happy-dom

/**
 * BuilderSession hooks — smoke-level tests verifying the named domain hooks
 * correctly read and write session state through the provider.
 *
 * Uses @testing-library/react's `renderHook` with a `BuilderSessionProvider`
 * wrapper so the hooks have access to the context-scoped Zustand store.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
	useActiveFieldId,
	useCursorMode,
	useEditMode,
	useSetActiveFieldId,
	useSetCursorMode,
	useSetSidebarOpen,
	useSidebarState,
	useSwitchCursorMode,
} from "../hooks";
import { BuilderSessionProvider } from "../provider";

/** Wrapper that provides the BuilderSessionProvider context. */
function wrapper({ children }: { children: ReactNode }) {
	return <BuilderSessionProvider>{children}</BuilderSessionProvider>;
}

describe("session hooks", () => {
	it("useCursorMode reads initial edit mode", () => {
		const { result } = renderHook(() => useCursorMode(), { wrapper });
		expect(result.current).toBe("edit");
	});

	it("useSwitchCursorMode toggles mode with stash/restore", () => {
		const { result } = renderHook(
			() => ({
				mode: useCursorMode(),
				switchMode: useSwitchCursorMode(),
				chatSidebar: useSidebarState("chat"),
			}),
			{ wrapper },
		);

		/* Enter pointer mode — sidebars stashed and closed. */
		act(() => result.current.switchMode("pointer"));
		expect(result.current.mode).toBe("pointer");
		expect(result.current.chatSidebar.open).toBe(false);
		expect(result.current.chatSidebar.stashed).toBe(true);

		/* Return to edit — sidebars restored. */
		act(() => result.current.switchMode("edit"));
		expect(result.current.mode).toBe("edit");
		expect(result.current.chatSidebar.open).toBe(true);
		expect(result.current.chatSidebar.stashed).toBeUndefined();
	});

	it("useSetCursorMode sets mode without sidebar effects", () => {
		const { result } = renderHook(
			() => ({
				mode: useCursorMode(),
				setMode: useSetCursorMode(),
				chatSidebar: useSidebarState("chat"),
			}),
			{ wrapper },
		);

		act(() => result.current.setMode("pointer"));
		expect(result.current.mode).toBe("pointer");
		/* Sidebars unchanged — no stash behavior. */
		expect(result.current.chatSidebar.open).toBe(true);
	});

	it("useActiveFieldId + useSetActiveFieldId read/write correctly", () => {
		const { result } = renderHook(
			() => ({
				fieldId: useActiveFieldId(),
				setFieldId: useSetActiveFieldId(),
			}),
			{ wrapper },
		);

		expect(result.current.fieldId).toBeUndefined();
		act(() => result.current.setFieldId("label"));
		expect(result.current.fieldId).toBe("label");
		act(() => result.current.setFieldId(undefined));
		expect(result.current.fieldId).toBeUndefined();
	});

	it("useSidebarState + useSetSidebarOpen read/write one sidebar", () => {
		const { result } = renderHook(
			() => ({
				chat: useSidebarState("chat"),
				structure: useSidebarState("structure"),
				setSidebar: useSetSidebarOpen(),
			}),
			{ wrapper },
		);

		act(() => result.current.setSidebar("chat", false));
		expect(result.current.chat.open).toBe(false);
		/* Structure unchanged. */
		expect(result.current.structure.open).toBe(true);
	});

	it("useEditMode derives test from pointer, edit from edit", () => {
		const { result } = renderHook(
			() => ({
				editMode: useEditMode(),
				switchMode: useSwitchCursorMode(),
			}),
			{ wrapper },
		);

		expect(result.current.editMode).toBe("edit");
		act(() => result.current.switchMode("pointer"));
		expect(result.current.editMode).toBe("test");
		act(() => result.current.switchMode("edit"));
		expect(result.current.editMode).toBe("edit");
	});
});
