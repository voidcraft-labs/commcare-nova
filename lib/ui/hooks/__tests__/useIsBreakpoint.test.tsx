// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsBreakpoint } from "../useIsBreakpoint";

const listeners = new Set<() => void>();
let matches = false;

function installMatchMedia(initial: boolean) {
	matches = initial;
	vi.stubGlobal(
		"matchMedia",
		vi.fn((media: string) => ({
			media,
			get matches() {
				return matches;
			},
			onchange: null,
			addEventListener: (_type: string, listener: () => void) =>
				listeners.add(listener),
			removeEventListener: (_type: string, listener: () => void) =>
				listeners.delete(listener),
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => true,
		})),
	);
}

afterEach(() => {
	listeners.clear();
	vi.unstubAllGlobals();
});

describe("useIsBreakpoint", () => {
	it("reads the first browser snapshot synchronously and follows changes", () => {
		installMatchMedia(true);
		const { result } = renderHook(() => useIsBreakpoint("max", 1200));

		expect(result.current).toBe(true);
		expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 1199px)");

		act(() => {
			matches = false;
			for (const listener of listeners) listener();
		});
		expect(result.current).toBe(false);
	});

	it("builds height queries for short-window layouts", () => {
		installMatchMedia(false);
		renderHook(() => useIsBreakpoint("max", 700, "height"));

		expect(window.matchMedia).toHaveBeenCalledWith("(max-height: 699px)");
	});
});
