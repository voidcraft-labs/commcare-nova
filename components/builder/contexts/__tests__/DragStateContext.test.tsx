// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
	DragStateProvider,
	useIsDragActive,
	useSetDragActive,
} from "@/components/builder/contexts/DragStateContext";

const wrapper = ({ children }: { children: ReactNode }) => (
	<DragStateProvider>{children}</DragStateProvider>
);

const controlledWrapper =
	(isActive: boolean, setActive: (next: boolean) => void) =>
	({ children }: { children: ReactNode }) => (
		<DragStateProvider isActive={isActive} setActive={setActive}>
			{children}
		</DragStateProvider>
	);

describe("DragStateContext", () => {
	it("returns false by default inside the provider", () => {
		const { result } = renderHook(() => useIsDragActive(), { wrapper });
		expect(result.current).toBe(false);
	});

	it("toggles active state via setActive", () => {
		const { result } = renderHook(
			() => ({ isActive: useIsDragActive(), setActive: useSetDragActive() }),
			{ wrapper },
		);

		act(() => result.current.setActive(true));
		expect(result.current.isActive).toBe(true);

		act(() => result.current.setActive(false));
		expect(result.current.isActive).toBe(false);
	});

	it("returns false when consumed outside the provider", () => {
		const { result } = renderHook(() => useIsDragActive());
		expect(result.current).toBe(false);
	});

	it("throws when useSetDragActive is called outside the provider", () => {
		expect(() => {
			renderHook(() => useSetDragActive());
		}).toThrow("useSetDragActive must be used within a DragStateProvider");
	});

	it("reflects controlled props when isActive and setActive are passed", () => {
		// Controlled-mode contract: when `isActive` and `setActive` are passed to
		// the provider, `useIsDragActive` reads from the prop (no internal state).
		// Hook-only assertion — no DOM rendering or text matching needed.
		const noop = (_: boolean) => undefined;
		const active = renderHook(() => useIsDragActive(), {
			wrapper: controlledWrapper(true, noop),
		});
		expect(active.result.current).toBe(true);

		const inactive = renderHook(() => useIsDragActive(), {
			wrapper: controlledWrapper(false, noop),
		});
		expect(inactive.result.current).toBe(false);
	});
});
