// @vitest-environment happy-dom

/**
 * Tests for the `useBreadcrumbs` hook.
 *
 * Verifies breadcrumb derivation from the current URL location and the
 * doc store. The doc is populated via a shared store instance constructed
 * from a domain fixture. A direct `BlueprintDocContext.Provider` wrapper
 * (rather than `BlueprintDocProvider`) ensures the store and the test
 * share the same UUIDs.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
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
	// Build the store once so all tests share the same UUID assignments.
	const store = createBlueprintDocStore();
	store.getState().load(
		buildDoc({
			appId: "a",
			appName: "My App",
			modules: [
				{
					uuid: "module-1-uuid",
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "form-1-uuid",
							name: "Register",
							type: "registration",
						},
					],
				},
				{
					/* A bare case list — caseType, no forms, caseListOnly. The
					 *  module IS its case list, so its breadcrumb collapses. */
					uuid: "module-2-uuid",
					name: "Villages",
					caseType: "village",
					caseListOnly: true,
				},
			],
		}),
	);
	const state = store.getState();
	const moduleUuid = state.moduleOrder[0];
	const formUuid = state.formOrder[moduleUuid][0];
	const bareCaseListUuid = state.moduleOrder[1];

	function wrapperFn({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocContext.Provider value={store}>
				{children}
			</BlueprintDocContext.Provider>
		);
	}

	it("at home, only the Home crumb is shown", () => {
		mockSegments.current = [];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current).toEqual([
			{ key: "home", label: "Home", location: { kind: "home" } },
		]);
	});

	it("at a module, shows [Home, Module]", () => {
		mockSegments.current = [moduleUuid];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current).toEqual([
			{ key: "home", label: "Home", location: { kind: "home" } },
			{
				key: `m:${moduleUuid}`,
				label: "Patients",
				location: { kind: "module", moduleUuid },
			},
		]);
	});

	it("at a form-bearing module's Results screen, shows [Home, Module, Results]", () => {
		mockSegments.current = [moduleUuid, "results"];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current).toEqual([
			{ key: "home", label: "Home", location: { kind: "home" } },
			{
				key: `m:${moduleUuid}`,
				label: "Patients",
				location: { kind: "module", moduleUuid },
			},
			{
				key: `cases:${moduleUuid}`,
				label: "Results",
				location: { kind: "cases", moduleUuid },
			},
		]);
	});

	it("at a bare case list, collapses to [Home, Module→Results] with no Results crumb", () => {
		mockSegments.current = [bareCaseListUuid, "results"];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current).toEqual([
			{ key: "home", label: "Home", location: { kind: "home" } },
			{
				key: `m:${bareCaseListUuid}`,
				label: "Villages",
				/* The module crumb IS the case list — no redundant trailing crumb. */
				location: { kind: "cases", moduleUuid: bareCaseListUuid },
			},
		]);
	});

	it.each([
		["search", "Search", "search-config"],
		["details", "Details", "detail-config"],
	] as const)("at the %s workspace path, names the %s tab in the breadcrumb", (pathSegment, label, kind) => {
		mockSegments.current = [moduleUuid, pathSegment];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current.at(-1)).toEqual({
			key: `${kind}:${moduleUuid}`,
			label,
			location: { kind, moduleUuid },
		});
	});

	it("at a form, shows [Home, Module, Form]", () => {
		mockSegments.current = [formUuid];
		const { result } = renderHook(() => useBreadcrumbs(), {
			wrapper: wrapperFn,
		});
		expect(result.current).toEqual([
			{ key: "home", label: "Home", location: { kind: "home" } },
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
