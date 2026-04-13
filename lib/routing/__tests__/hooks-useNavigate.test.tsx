// @vitest-environment happy-dom

/**
 * Tests for the `useNavigate` and `useSelect` navigation hooks.
 *
 * Verifies that navigation actions dispatch the correct `router.push`
 * or `router.replace` calls with the expected URL and `{ scroll: false }`.
 *
 * `useBuilderEngine` is mocked because these tests focus on router-level
 * behavior — the edit-guard integration in `useSelect` has its own
 * dedicated coverage; here we just need `checkEditGuard()` to return
 * `true` so the gate lets the selection through.
 */
import { renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerBack = vi.fn();
const mockParams = { current: new URLSearchParams() };
const checkEditGuard = vi.fn(() => true);

vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		useSearchParams: () => new ReadonlyURLSearchParams(mockParams.current),
		useRouter: () => ({
			push: routerPush,
			replace: routerReplace,
			back: routerBack,
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
		usePathname: () => "/build/app-1",
	};
});

/* Stub the entire builder context surface — `useSelect` only needs
 * `useBuilderEngine().checkEditGuard()` to answer `true`. Importing the
 * real `useBuilder` module would drag in the full engine/store stack
 * and require a live `BuilderProvider` wrapper around each test. */
vi.mock("@/hooks/useBuilder", () => ({
	useBuilderEngine: () => ({ checkEditGuard }),
}));

import { asUuid } from "@/lib/doc/types";
import { useNavigate, useSelect } from "@/lib/routing/hooks";

describe("useNavigate", () => {
	it("openForm issues router.push with scroll:false", () => {
		mockParams.current = new URLSearchParams();
		routerPush.mockClear();
		const { result } = renderHook(() => useNavigate());
		act(() => result.current.openForm(asUuid("m-1"), asUuid("f-1")));
		expect(routerPush).toHaveBeenCalledWith("/build/app-1?s=f&m=m-1&f=f-1", {
			scroll: false,
		});
	});

	it("up on form-with-selection clears only the selection", () => {
		mockParams.current = new URLSearchParams("s=f&m=m-1&f=f-1&sel=q-1");
		routerPush.mockClear();
		const { result } = renderHook(() => useNavigate());
		act(() => result.current.up());
		expect(routerPush).toHaveBeenCalledWith("/build/app-1?s=f&m=m-1&f=f-1", {
			scroll: false,
		});
	});

	it("useSelect uses router.replace, not push", () => {
		mockParams.current = new URLSearchParams("s=f&m=m-1&f=f-1");
		routerReplace.mockClear();
		const { result } = renderHook(() => useSelect());
		act(() => result.current(asUuid("q-42")));
		expect(routerReplace).toHaveBeenCalledWith(
			"/build/app-1?s=f&m=m-1&f=f-1&sel=q-42",
			{ scroll: false },
		);
	});

	it("useSelect is a no-op when not on a form location", () => {
		mockParams.current = new URLSearchParams("s=m&m=mod-1");
		routerReplace.mockClear();
		checkEditGuard.mockReturnValue(true);
		const { result } = renderHook(() => useSelect());
		act(() => result.current(asUuid("q-99")));
		expect(routerReplace).not.toHaveBeenCalled();
	});

	it("useSelect respects the edit guard — returning false blocks the URL change", () => {
		/* Simulates an inline editor (e.g. XPathField) with unsaved invalid
		 * content: its first guard invocation returns false. The selection
		 * must not reach the router — otherwise the user silently loses the
		 * edit. The two-strike "warn then allow" UX lives inside the guard
		 * predicate itself; `useSelect` just trusts the boolean. */
		mockParams.current = new URLSearchParams("s=f&m=m-1&f=f-1");
		routerReplace.mockClear();
		checkEditGuard.mockClear();
		checkEditGuard.mockReturnValue(false);
		const { result } = renderHook(() => useSelect());
		act(() => result.current(asUuid("q-42")));
		expect(checkEditGuard).toHaveBeenCalled();
		expect(routerReplace).not.toHaveBeenCalled();
		/* Reset for any later tests in this file. */
		checkEditGuard.mockReturnValue(true);
	});
});
