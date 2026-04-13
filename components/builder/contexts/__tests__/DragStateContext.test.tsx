// @vitest-environment happy-dom

import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	DragStateProvider,
	useIsDragActive,
	useSetDragActive,
} from "@/components/builder/contexts/DragStateContext";

const wrapper = ({ children }: { children: ReactNode }) => (
	<DragStateProvider>{children}</DragStateProvider>
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
		const setActive = vi.fn();

		/** Probe component that renders the drag-active state as text. */
		function ControlledProbe() {
			return <>{useIsDragActive() ? "active" : "inactive"}</>;
		}

		const { container, rerender } = render(
			<DragStateProvider isActive={true} setActive={setActive}>
				<ControlledProbe />
			</DragStateProvider>,
		);
		expect(container.textContent).toBe("active");

		rerender(
			<DragStateProvider isActive={false} setActive={setActive}>
				<ControlledProbe />
			</DragStateProvider>,
		);
		expect(container.textContent).toBe("inactive");
	});
});
