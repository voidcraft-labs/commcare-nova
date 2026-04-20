// @vitest-environment happy-dom

/**
 * `useExternalNavigate` — verifies the sanctioned wrapper over Next.js's
 * `useRouter` delegates `push`/`replace`/`refresh` to the router with
 * the expected arguments.
 *
 * `next/navigation`'s `useRouter` is mocked to return a stub with spy
 * functions so we can assert the delegation shape without mounting an
 * App Router tree.
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Stable router stub — retained across renders so the spies survive the
 * hook invocation and we can assert call arguments after the fact. */
const routerStub = {
	push: vi.fn(),
	replace: vi.fn(),
	back: vi.fn(),
	forward: vi.fn(),
	refresh: vi.fn(),
	prefetch: vi.fn(),
};

vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		useRouter: () => routerStub,
	};
});

import { useExternalNavigate } from "@/lib/routing/hooks";

describe("useExternalNavigate", () => {
	beforeEach(() => {
		routerStub.push.mockClear();
		routerStub.replace.mockClear();
		routerStub.refresh.mockClear();
	});

	it("push delegates to router.push with the given path", () => {
		const { result } = renderHook(() => useExternalNavigate());
		result.current.push("/dashboard");
		expect(routerStub.push).toHaveBeenCalledTimes(1);
		expect(routerStub.push).toHaveBeenCalledWith("/dashboard");
	});

	it("replace delegates to router.replace with the given path", () => {
		const { result } = renderHook(() => useExternalNavigate());
		result.current.replace("/login");
		expect(routerStub.replace).toHaveBeenCalledTimes(1);
		expect(routerStub.replace).toHaveBeenCalledWith("/login");
	});

	it("refresh delegates to router.refresh with no arguments", () => {
		const { result } = renderHook(() => useExternalNavigate());
		result.current.refresh();
		expect(routerStub.refresh).toHaveBeenCalledTimes(1);
		expect(routerStub.refresh).toHaveBeenCalledWith();
	});
});
