// @vitest-environment happy-dom

/**
 * Tests for URL-driven location hooks.
 *
 * We simulate Next.js's App Router context using a test wrapper that
 * provides a mock `useSearchParams` result. Full router dispatch is
 * covered in `hooks-useNavigate.test.tsx`.
 */
import { renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

// Mock next/navigation BEFORE importing the hook under test.
const mockParams = { current: new URLSearchParams() };
vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		useSearchParams: () => new ReadonlyURLSearchParams(mockParams.current),
		useRouter: () => ({
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
		usePathname: () => "/build/app-1",
	};
});

import { useLocation } from "@/lib/routing/hooks";

describe("useLocation", () => {
	it("returns home when no screen param is present", () => {
		mockParams.current = new URLSearchParams();
		const { result } = renderHook(() => useLocation());
		expect(result.current).toEqual({ kind: "home" });
	});

	it("returns module location for ?s=m&m=<uuid>", () => {
		mockParams.current = new URLSearchParams("s=m&m=mod-uuid");
		const { result } = renderHook(() => useLocation());
		expect(result.current).toEqual({ kind: "module", moduleUuid: "mod-uuid" });
	});

	it("returns form+selected location for ?s=f&m=&f=&sel=", () => {
		mockParams.current = new URLSearchParams(
			"s=f&m=mod-uuid&f=form-uuid&sel=q-uuid",
		);
		const { result } = renderHook(() => useLocation());
		expect(result.current).toEqual({
			kind: "form",
			moduleUuid: "mod-uuid",
			formUuid: "form-uuid",
			selectedUuid: "q-uuid",
		});
	});

	it("degrades to home on malformed (missing required) params", () => {
		mockParams.current = new URLSearchParams("s=f&m=mod-uuid"); // missing f
		const { result } = renderHook(() => useLocation());
		expect(result.current).toEqual({ kind: "home" });
	});
});
