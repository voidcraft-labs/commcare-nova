// @vitest-environment happy-dom
/**
 * Tests for ScrollRegistryContext — verifies the scroll registry API:
 * callback registration/cleanup, pending scroll fulfillment, direct scroll,
 * and the provider guard on the internal useScrollRegistry hook.
 *
 * Tests that need multiple hooks sharing the same provider render them
 * in a single `renderHook` body. `useFulfillPendingScroll` is always
 * called (Rules of Hooks) with a sentinel uuid that switches to the
 * real target on rerender to trigger the effect.
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
			({ fulfillUuid }: { fulfillUuid: string }) => {
				useRegisterScrollCallback(cb);
				const scrollApi = useScrollIntoView();
				useFulfillPendingScroll(fulfillUuid);
				return scrollApi;
			},
			{ wrapper, initialProps: { fulfillUuid: SENTINEL } },
		);

		/* Set a pending scroll request. */
		act(() => {
			result.current.setPending("q-1", "smooth", false);
		});

		/* Trigger fulfillment by re-rendering with the matching uuid.
		 * The useFulfillPendingScroll effect fires because `uuid` changed. */
		rerender({ fulfillUuid: "q-1" });

		expect(cb).toHaveBeenCalledOnce();
		expect(cb).toHaveBeenCalledWith("q-1", undefined, "smooth", false);
	});

	it("fulfillPending with non-matching uuid does not fire; pending preserved", () => {
		const cb = vi.fn();

		const { result, rerender } = renderHook(
			({ fulfillUuid }: { fulfillUuid: string }) => {
				useRegisterScrollCallback(cb);
				const scrollApi = useScrollIntoView();
				useFulfillPendingScroll(fulfillUuid);
				return scrollApi;
			},
			{ wrapper, initialProps: { fulfillUuid: SENTINEL } },
		);

		/* Set pending for "q-1" but try to fulfill for "q-2". */
		act(() => {
			result.current.setPending("q-1", "instant", true);
		});

		rerender({ fulfillUuid: "q-2" });
		expect(cb).not.toHaveBeenCalled();

		/* Pending state should be preserved — fulfill with the correct uuid. */
		rerender({ fulfillUuid: "q-1" });
		expect(cb).toHaveBeenCalledOnce();
		expect(cb).toHaveBeenCalledWith("q-1", undefined, "instant", true);
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
			renderHook(() => useFulfillPendingScroll("q-1"));
		}).toThrow(
			"ScrollRegistry hooks must be used within ScrollRegistryProvider",
		);
	});
});
