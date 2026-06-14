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
	useEditMode,
	usePreviewing,
	useSetActiveFieldId,
	useSetPreviewing,
	useSetSidebarOpen,
	useSidebarState,
} from "../hooks";
import { BuilderSessionProvider } from "../provider";

/** Wrapper that provides the BuilderSessionProvider context. */
function wrapper({ children }: { children: ReactNode }) {
	return <BuilderSessionProvider>{children}</BuilderSessionProvider>;
}

describe("session hooks", () => {
	it("usePreviewing reads initial not-previewing state", () => {
		const { result } = renderHook(() => usePreviewing(), { wrapper });
		expect(result.current).toBe(false);
	});

	it("useSetPreviewing toggles preview with stash/restore", () => {
		const { result } = renderHook(
			() => ({
				previewing: usePreviewing(),
				setPreviewing: useSetPreviewing(),
				chatSidebar: useSidebarState("chat"),
			}),
			{ wrapper },
		);

		/* Enter preview — sidebars stashed and closed. */
		act(() => result.current.setPreviewing(true));
		expect(result.current.previewing).toBe(true);
		expect(result.current.chatSidebar.open).toBe(false);
		expect(result.current.chatSidebar.stashed).toBe(true);

		/* Leave preview — sidebars restored. */
		act(() => result.current.setPreviewing(false));
		expect(result.current.previewing).toBe(false);
		expect(result.current.chatSidebar.open).toBe(true);
		expect(result.current.chatSidebar.stashed).toBeUndefined();
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

	it("useEditMode derives preview from previewing, edit otherwise", () => {
		const { result } = renderHook(
			() => ({
				editMode: useEditMode(),
				setPreviewing: useSetPreviewing(),
			}),
			{ wrapper },
		);

		expect(result.current.editMode).toBe("edit");
		act(() => result.current.setPreviewing(true));
		expect(result.current.editMode).toBe("preview");
		act(() => result.current.setPreviewing(false));
		expect(result.current.editMode).toBe("edit");
	});
});
