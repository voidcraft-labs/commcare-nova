// @vitest-environment happy-dom

/**
 * Tests for the `useNavigate` and `useSelect` navigation hooks.
 *
 * Verifies that navigation actions dispatch the correct `router.push`
 * or `router.replace` calls with the expected URL and `{ scroll: false }`.
 *
 * `useConsultEditGuard` is mocked because these tests focus on router-level
 * behavior — the edit-guard integration in `useSelect` has its own
 * dedicated coverage in `EditGuardContext.test.tsx`; here we just need
 * the consult function to return `true` so the gate lets the selection through.
 */
import { renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerBack = vi.fn();
const mockParams = { current: new URLSearchParams() };
const consultGuard = vi.fn(() => true);

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

/* Stub EditGuardContext — `useSelect` calls `useConsultEditGuard()` at
 * hook-body top level and uses the returned function inside the select
 * callback. Mocking returns our controllable `consultGuard` function
 * so tests can simulate both "allow" and "block" scenarios. */
vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => consultGuard,
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
		consultGuard.mockReturnValue(true);
		const { result } = renderHook(() => useSelect());
		act(() => result.current(asUuid("q-99")));
		expect(routerReplace).not.toHaveBeenCalled();
	});

	it("useSelect respects the edit guard — returning false blocks the URL change", () => {
		/* Simulates an inline editor (e.g. XPathField) with unsaved invalid
		 * content: its first guard invocation returns false. The selection
		 * must not reach the router — otherwise the user silently loses the
		 * edit. The two-strike "warn then allow" UX lives inside the guard
		 * predicate itself; `useSelect` just trusts the boolean.
		 *
		 * This is the regression test for the Phase 2 retrospective: the
		 * edit guard integration was silently dropped when useSelect moved
		 * from engine.checkEditGuard() to EditGuardContext. Phase 3 must
		 * have a test that catches any future reversion. */
		mockParams.current = new URLSearchParams("s=f&m=m-1&f=f-1");
		routerReplace.mockClear();
		consultGuard.mockClear();
		consultGuard.mockReturnValue(false);
		const { result } = renderHook(() => useSelect());
		act(() => result.current(asUuid("q-42")));
		expect(consultGuard).toHaveBeenCalled();
		expect(routerReplace).not.toHaveBeenCalled();
		/* Reset for any later tests in this file. */
		consultGuard.mockReturnValue(true);
	});
});
