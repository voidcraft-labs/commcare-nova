// @vitest-environment happy-dom

/**
 * Tests for the `useBreadcrumbs` hook.
 *
 * Verifies breadcrumb derivation from the current URL location and the
 * doc store. The doc is populated via a shared store instance constructed
 * from a fixture blueprint. A direct `BlueprintDocContext.Provider` wrapper
 * (rather than `BlueprintDocProvider`) ensures the store and the test share
 * the same UUIDs — `toDoc` generates random UUIDs, so passing the same
 * blueprint to both would yield different identities.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";

/* Mock the client path hook — segments control the current location. */
const mockSegments = { current: [] as string[] };
vi.mock("@/lib/routing/useClientPath", () => ({
	useBuilderPathSegments: () => mockSegments.current,
	notifyPathChange: vi.fn(),
}));

vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		usePathname: () => "/build/a",
		useRouter: () => ({
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
	};
});

/* Stub EditGuardContext — needed by useSelect in the same module. */
vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => () => true,
}));

import { useBreadcrumbs } from "@/lib/routing/hooks";

describe("useBreadcrumbs", () => {
	const blueprint = {
		app_name: "My App",
		connect_type: undefined,
		case_types: null,
		modules: [
			{
				uuid: "module-1-uuid",
				name: "Patients",
				case_type: "patient",
				forms: [
					{
						uuid: "form-1-uuid",
						name: "Register",
						type: "registration" as const,
						questions: [],
					},
				],
			},
		],
	};

	// Build the store once so all tests share the same UUID assignments.
	const store = createBlueprintDocStore();
	store.getState().load(blueprint, "a");
	const state = store.getState();
	const moduleUuid = state.moduleOrder[0];
	const formUuid = state.formOrder[moduleUuid][0];

	function wrapperFn({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocContext.Provider value={store}>
				{children}
			</BlueprintDocContext.Provider>
		);
	}

	it("at home, only the app name is shown", () => {
		mockSegments.current = [];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current).toEqual([
			{ key: "home", label: "My App", location: { kind: "home" } },
		]);
	});

	it("at a module, shows [Home, Module]", () => {
		mockSegments.current = [moduleUuid];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current).toEqual([
			{ key: "home", label: "My App", location: { kind: "home" } },
			{
				key: `m:${moduleUuid}`,
				label: "Patients",
				location: { kind: "module", moduleUuid },
			},
		]);
	});

	it("at a form, shows [Home, Module, Form]", () => {
		mockSegments.current = [formUuid];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current).toEqual([
			{ key: "home", label: "My App", location: { kind: "home" } },
			{
				key: `m:${moduleUuid}`,
				label: "Patients",
				location: { kind: "module", moduleUuid },
			},
			{
				key: `f:${formUuid}`,
				label: "Register",
				location: { kind: "form", moduleUuid, formUuid },
			},
		]);
	});
});
