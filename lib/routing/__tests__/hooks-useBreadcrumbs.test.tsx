// @vitest-environment happy-dom

/**
 * Tests for the `useBreadcrumbs` hook.
 *
 * Verifies breadcrumb derivation from the current URL location and the
 * doc store. The doc is populated via a `BlueprintDocProvider` wrapper
 * with a minimal fixture blueprint.
 */
import { renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";

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
		usePathname: () => "/build/a",
	};
});

import { useBreadcrumbs } from "@/lib/routing/hooks";

describe("useBreadcrumbs", () => {
	const blueprint = {
		app_name: "My App",
		connect_type: undefined,
		case_types: null,
		modules: [
			{
				name: "Patients",
				case_type: "patient",
				forms: [
					{ name: "Register", type: "registration" as const, questions: [] },
				],
			},
		],
	};

	function wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocProvider appId="a" initialBlueprint={blueprint}>
				{children}
			</BlueprintDocProvider>
		);
	}

	it("at home, only the app name is shown", () => {
		mockParams.current = new URLSearchParams();
		const { result } = renderHook(() => useBreadcrumbs(), { wrapper });
		expect(result.current).toEqual([
			{ key: "home", label: "My App", location: { kind: "home" } },
		]);
	});

	// Further cases (module/form) omitted here — Task 1 step is about
	// establishing the hook shape. Full coverage added in Task 11 review.
});
