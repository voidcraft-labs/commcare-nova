// @vitest-environment happy-dom

/**
 * Tests for URL-driven location hooks.
 *
 * We mock `useBuilderPathSegments` to simulate different URL paths,
 * and provide a doc store with known entities for UUID disambiguation.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { toDoc } from "@/lib/doc/converter";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";

/* Mock the client path hook to return controlled segments. */
const mockSegments = { current: [] as string[] };
vi.mock("@/lib/routing/useClientPath", () => ({
	useBuilderPathSegments: () => mockSegments.current,
	notifyPathChange: vi.fn(),
}));

/* Mock next/navigation — only usePathname is needed by useLocation's
 * downstream dependencies (useNavigate/useSelect). useLocation itself
 * doesn't use it, but the module imports next/navigation. */
vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		usePathname: () => "/build/app-1",
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

/* Stub EditGuardContext — needed by useSelect which shares the module. */
vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => () => true,
}));

import { useLocation } from "@/lib/routing/hooks";

/**
 * Build a doc store with a known module, form, and question so the
 * path parser can disambiguate UUIDs.
 */
const BP = {
	app_name: "T",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			uuid: "mod-uuid",
			name: "M",
			case_type: undefined,
			forms: [
				{
					uuid: "form-uuid",
					name: "F",
					type: "survey" as const,
					questions: [
						{
							uuid: "q-uuid",
							id: "q",
							type: "text" as const,
							label: "Q",
						},
					],
				},
			],
		},
	],
};

function makeStore() {
	const store = createBlueprintDocStore();
	store.getState().load(toDoc(BP, "app-1"));
	return store;
}

function wrapper(store: ReturnType<typeof makeStore>) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocContext.Provider value={store}>
				{children}
			</BlueprintDocContext.Provider>
		);
	};
}

describe("useLocation", () => {
	it("returns home when path segments are empty", () => {
		const store = makeStore();
		mockSegments.current = [];
		const { result } = renderHook(() => useLocation(), {
			wrapper: wrapper(store),
		});
		expect(result.current).toEqual({ kind: "home" });
	});

	it("returns module location for a module UUID segment", () => {
		const store = makeStore();
		const moduleUuid = store.getState().moduleOrder[0];
		mockSegments.current = [moduleUuid];
		const { result } = renderHook(() => useLocation(), {
			wrapper: wrapper(store),
		});
		expect(result.current).toEqual({ kind: "module", moduleUuid });
	});

	it("returns form+selected location for [formUuid, questionUuid]", () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		const questionUuid = state.fieldOrder[formUuid][0];
		mockSegments.current = [formUuid, questionUuid];
		const { result } = renderHook(() => useLocation(), {
			wrapper: wrapper(store),
		});
		expect(result.current).toEqual({
			kind: "form",
			moduleUuid,
			formUuid,
			selectedUuid: questionUuid,
		});
	});

	it("degrades to home on unrecognized segment", () => {
		const store = makeStore();
		mockSegments.current = ["bogus-uuid"];
		const { result } = renderHook(() => useLocation(), {
			wrapper: wrapper(store),
		});
		expect(result.current).toEqual({ kind: "home" });
	});
});
