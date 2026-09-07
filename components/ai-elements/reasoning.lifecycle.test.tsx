// @vitest-environment happy-dom

import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reasoning, useReasoning } from "./reasoning";

// Observe the committed context consumed by the production trigger. Native
// keyboard/disclosure behavior belongs to chat-controls-audit.spec.ts.
let committed: ReturnType<typeof useReasoning> | null = null;
function ContextObserver() {
	const value = useReasoning();
	useLayoutEffect(() => {
		committed = value;
		return () => {
			committed = null;
		};
	}, [value]);
	return null;
}
function tree(streaming: boolean) {
	return (
		<Reasoning isStreaming={streaming}>
			<ContextObserver />
		</Reasoning>
	);
}
beforeEach(() =>
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }),
);
afterEach(() => {
	try {
		cleanup();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
	}
});
describe("Reasoning committed stream lifecycle", () => {
	it("records elapsed stream time and commits the delayed close", async () => {
		const view = render(tree(true));
		expect(committed).toMatchObject({ isOpen: true, isStreaming: true });
		await act(() => vi.advanceTimersByTimeAsync(2400));
		view.rerender(tree(false));
		expect(committed).toMatchObject({
			duration: 3,
			isStreaming: false,
			isOpen: true,
		});
		await act(() => vi.advanceTimersByTimeAsync(999));
		expect(committed).toMatchObject({ isOpen: true });
		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(committed).toMatchObject({ isOpen: false });
	});
	it("cancels its scheduled close on unmount before that timer can run", () => {
		const view = render(tree(true));
		view.rerender(tree(false));
		expect(vi.getTimerCount()).toBe(1);
		view.unmount();
		expect(committed).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
});
