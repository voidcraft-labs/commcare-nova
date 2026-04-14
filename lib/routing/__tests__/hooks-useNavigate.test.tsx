// @vitest-environment happy-dom

/**
 * Tests for the `useNavigate` and `useSelect` navigation hooks.
 *
 * Verifies that navigation actions dispatch the correct `pushState`
 * or `replaceState` calls with the expected URL.
 *
 * `useConsultEditGuard` is mocked because these tests focus on
 * History API behavior — the edit-guard integration in `useSelect`
 * has its own dedicated coverage; here we just need the consult
 * function to return `true` so the gate lets the selection through.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";

const consultGuard = vi.fn(() => true);

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

vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => consultGuard,
}));

import { asUuid } from "@/lib/doc/types";
import { useNavigate, useSelect } from "@/lib/routing/hooks";

const pushStateSpy = vi.spyOn(window.history, "pushState");
const replaceStateSpy = vi.spyOn(window.history, "replaceState");

/**
 * Fixture: one module, one form, one question. Known UUIDs for
 * assertion matching.
 */
const BP = {
	app_name: "T",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			uuid: "mod-1",
			name: "M",
			case_type: undefined,
			forms: [
				{
					uuid: "f-1",
					name: "F",
					type: "survey" as const,
					questions: [
						{ uuid: "q-1", id: "q", type: "text" as const, label: "Q" },
					],
				},
			],
		},
	],
};

function makeStore() {
	const store = createBlueprintDocStore();
	store.getState().load(BP, "app-1");
	return store;
}

function wrap(store: ReturnType<typeof makeStore>) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocContext.Provider value={store}>
				{children}
			</BlueprintDocContext.Provider>
		);
	};
}

describe("useNavigate", () => {
	beforeEach(() => {
		mockSegments.current = [];
		/* Set window.location so useNavigate/useSelect basePathRef reads
		 * /build/app-1. Must happen BEFORE clearing spies so the setup
		 * call isn't counted. */
		window.history.replaceState(null, "", "/build/app-1");
		pushStateSpy.mockClear();
		replaceStateSpy.mockClear();
	});

	it("openForm issues pushState with the form UUID path", () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];

		const { result } = renderHook(() => useNavigate(), {
			wrapper: wrap(store),
		});
		act(() => result.current.openForm(asUuid(moduleUuid), asUuid(formUuid)));
		expect(pushStateSpy).toHaveBeenCalledWith(
			null,
			"",
			`/build/app-1/${formUuid}`,
		);
	});

	it("up on form-with-selection clears only the selection", () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		const questionUuid = state.questionOrder[formUuid][0];

		/* Set segments to simulate being on form+selection. */
		mockSegments.current = [formUuid, questionUuid];

		const { result } = renderHook(() => useNavigate(), {
			wrapper: wrap(store),
		});
		act(() => result.current.up());
		expect(pushStateSpy).toHaveBeenCalledWith(
			null,
			"",
			`/build/app-1/${formUuid}`,
		);
	});

	it("useSelect uses replaceState, not pushState", () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];

		/* Simulate being on a form screen. */
		mockSegments.current = [formUuid];

		const { result } = renderHook(() => useSelect(), {
			wrapper: wrap(store),
		});
		act(() => result.current(asUuid("q-42")));
		expect(replaceStateSpy).toHaveBeenCalledWith(
			null,
			"",
			`/build/app-1/${formUuid}/q-42`,
		);
		expect(pushStateSpy).not.toHaveBeenCalled();
	});

	it("useSelect is a no-op when not on a form location", () => {
		const store = makeStore();
		const moduleUuid = store.getState().moduleOrder[0];

		/* Simulate being on a module screen. */
		mockSegments.current = [moduleUuid];

		replaceStateSpy.mockClear();
		consultGuard.mockReturnValue(true);
		const { result } = renderHook(() => useSelect(), {
			wrapper: wrap(store),
		});
		act(() => result.current(asUuid("q-99")));
		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it("useSelect respects the edit guard — returning false blocks the URL change", () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];

		mockSegments.current = [formUuid];
		replaceStateSpy.mockClear();
		consultGuard.mockClear();
		consultGuard.mockReturnValue(false);

		const { result } = renderHook(() => useSelect(), {
			wrapper: wrap(store),
		});
		act(() => result.current(asUuid("q-42")));
		expect(consultGuard).toHaveBeenCalled();
		expect(replaceStateSpy).not.toHaveBeenCalled();

		/* Reset for later tests. */
		consultGuard.mockReturnValue(true);
	});
});
