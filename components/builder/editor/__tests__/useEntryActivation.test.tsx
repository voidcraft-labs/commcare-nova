// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEntryActivation } from "../useEntryActivation";

describe("useEntryActivation", () => {
	it("starts with no pending key", () => {
		const { result } = renderHook(() => useEntryActivation("u1", "logic"));
		expect(result.current.pending("validate")).toBe(false);
	});

	it("activate marks the key as pending", () => {
		const { result } = renderHook(() => useEntryActivation("u1", "logic"));
		act(() => result.current.activate("validate"));
		expect(result.current.pending("validate")).toBe(true);
		expect(result.current.pending("hint")).toBe(false);
	});

	it("clear resets pending", () => {
		const { result } = renderHook(() => useEntryActivation("u1", "logic"));
		act(() => result.current.activate("validate"));
		act(() => result.current.clear());
		expect(result.current.pending("validate")).toBe(false);
	});

	it("scope changes invalidate pending state", () => {
		const { result, rerender } = renderHook(
			({ uuid }) => useEntryActivation(uuid, "logic"),
			{ initialProps: { uuid: "u1" } },
		);
		act(() => result.current.activate("validate"));
		rerender({ uuid: "u2" });
		expect(result.current.pending("validate")).toBe(false);
	});
});
