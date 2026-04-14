// @vitest-environment happy-dom
/**
 * Tests for ScrollRegistryContext — verifies the scroll registry API:
 * callback registration/cleanup, pending scroll fulfillment, direct scroll,
 * and the provider guard on the internal useScrollRegistry hook.
 *
 * Tests that need multiple hooks sharing the same provider render them
 * in a single `renderHook` body. `useFulfillPendingScroll` takes a
 * uuid and an isSelected flag — the effect only fires when isSelected
 * is true, and re-fires on false -> true transitions.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	ScrollRegistryProvider,
	useFulfillPendingScroll,
	useRegisterScrollCallback,
	useScrollIntoView,
} from "../ScrollRegistryContext";

/** Shared wrapper that provides ScrollRegistryProvider. */
function wrapper({ children }: { children: React.ReactNode }) {
	return <ScrollRegistryProvider>{children}</ScrollRegistryProvider>;
}

/** Sentinel uuid that will never match a real pending scroll request. */
const SENTINEL = "__noop__";

describe("ScrollRegistryContext", () => {
	it("registerCallback installs the callback; cleanup removes it", () => {
		const cb = vi.fn();

		const { result, unmount } = renderHook(
			() => {
				useRegisterScrollCallback(cb);
				return useScrollIntoView();
			},
			{ wrapper },
		);

		/* scrollTo should invoke the registered callback. */
		act(() => {
			result.current.scrollTo("q-1", undefined, "smooth", false);
		});
		expect(cb).toHaveBeenCalledOnce();

		/* Unmount cleans up the registered callback. */
		unmount();
		cb.mockClear();

		/* After unmount, a new hook in a fresh provider sees no callback. */
		const { result: fresh } = renderHook(() => useScrollIntoView(), {
			wrapper,
		});
		act(() => {
			fresh.current.scrollTo("q-orphan", undefined, "smooth", false);
		});
		expect(cb).not.toHaveBeenCalled();
	});

	it("setPending + fulfillPending with matching uuid fires callback once", () => {
		const cb = vi.fn();

		const { result, rerender } = renderHook(
			({
				fulfillUuid,
				isSelected,
			}: {
				fulfillUuid: string;
				isSelected: boolean;
			}) => {
				useRegisterScrollCallback(cb);
				const scrollApi = useScrollIntoView();
				useFulfillPendingScroll(fulfillUuid, isSelected);
				return scrollApi;
			},
			{
				wrapper,
				initialProps: { fulfillUuid: SENTINEL, isSelected: false },
			},
		);

		/* Set a pending scroll request. */
		act(() => {
			result.current.setPending("q-1", "smooth", false);
		});

		/* Trigger fulfillment by re-rendering with the matching uuid and
		 * isSelected=true. The effect fires because both deps changed. */
		rerender({ fulfillUuid: "q-1", isSelected: true });

		expect(cb).toHaveBeenCalledOnce();
		expect(cb).toHaveBeenCalledWith("q-1", undefined, "smooth", false);
	});

	it("fulfillPending with non-matching uuid does not fire; pending preserved", () => {
		const cb = vi.fn();

		const { result, rerender } = renderHook(
			({
				fulfillUuid,
				isSelected,
			}: {
				fulfillUuid: string;
				isSelected: boolean;
			}) => {
				useRegisterScrollCallback(cb);
				const scrollApi = useScrollIntoView();
				useFulfillPendingScroll(fulfillUuid, isSelected);
				return scrollApi;
			},
			{
				wrapper,
				initialProps: { fulfillUuid: SENTINEL, isSelected: true },
			},
		);

		/* Set pending for "q-1" but try to fulfill for "q-2". */
		act(() => {
			result.current.setPending("q-1", "instant", true);
		});

		rerender({ fulfillUuid: "q-2", isSelected: true });
		expect(cb).not.toHaveBeenCalled();

		/* Pending state should be preserved — fulfill with the correct uuid. */
		rerender({ fulfillUuid: "q-1", isSelected: true });
		expect(cb).toHaveBeenCalledOnce();
		expect(cb).toHaveBeenCalledWith("q-1", undefined, "instant", true);
	});

	it("fulfills pending when isSelected flips true after setPending", () => {
		const cb = vi.fn();

		const { result, rerender } = renderHook(
			({ isSelected }: { isSelected: boolean }) => {
				useRegisterScrollCallback(cb);
				const scrollApi = useScrollIntoView();
				useFulfillPendingScroll("q-target", isSelected);
				return scrollApi;
			},
			{ wrapper, initialProps: { isSelected: false } },
		);

		/* Set a pending scroll while the question is not selected. */
		act(() => {
			result.current.setPending("q-target", "smooth", false);
		});
		expect(cb).not.toHaveBeenCalled();

		/* Flip isSelected true — the effect re-fires and fulfills the
		 * pending request. This is the critical within-form navigation path
		 * where the target question is already mounted. */
		rerender({ isSelected: true });
		expect(cb).toHaveBeenCalledOnce();
		expect(cb).toHaveBeenCalledWith("q-target", undefined, "smooth", false);
	});

	it("scrollTo fires the callback immediately regardless of pending state", () => {
		const cb = vi.fn();

		const { result } = renderHook(
			() => {
				useRegisterScrollCallback(cb);
				return useScrollIntoView();
			},
			{ wrapper },
		);

		const target = document.createElement("div");

		act(() => {
			result.current.scrollTo("q-direct", target, "instant", true);
		});

		expect(cb).toHaveBeenCalledOnce();
		expect(cb).toHaveBeenCalledWith("q-direct", target, "instant", true);
	});

	it("hooks without provider throw", () => {
		/* Each hook internally calls useScrollRegistry which throws without a provider. */
		expect(() => {
			renderHook(() => useRegisterScrollCallback(vi.fn()));
		}).toThrow(
			"ScrollRegistry hooks must be used within ScrollRegistryProvider",
		);

		expect(() => {
			renderHook(() => useScrollIntoView());
		}).toThrow(
			"ScrollRegistry hooks must be used within ScrollRegistryProvider",
		);

		expect(() => {
			renderHook(() => useFulfillPendingScroll("q-1", true));
		}).toThrow(
			"ScrollRegistry hooks must be used within ScrollRegistryProvider",
		);
	});
});
