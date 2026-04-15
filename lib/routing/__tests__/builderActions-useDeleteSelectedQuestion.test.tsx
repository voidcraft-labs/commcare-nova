// @vitest-environment happy-dom

/**
 * Positive-path coverage for `useDeleteSelectedQuestion`.
 *
 * The hook:
 *   1. Resolves the selected uuid from `useLocation()`.
 *   2. Computes the neighbor via `flattenQuestionRefs` on the assembled
 *      form (skipping hidden/conditional questions).
 *   3. Dispatches `removeQuestion` through the doc store.
 *   4. Replaces the URL selection segment with the neighbor uuid (or clears it).
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";

const replaceStateSpy = vi.spyOn(window.history, "replaceState");
const pathname = "/build/test-app";

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
		usePathname: () => pathname,
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
	useConsultEditGuard: () => () => true,
}));

vi.mock("@/lib/session/hooks", () => ({
	useActiveFieldId: () => undefined,
}));

import { useDeleteSelectedQuestion } from "@/lib/routing/builderActions";

const BP = {
	app_name: "T",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			uuid: "module-1-uuid",
			name: "M",
			case_type: undefined,
			forms: [
				{
					uuid: "form-1-uuid",
					name: "F",
					type: "survey" as const,
					questions: [
						{
							uuid: "q-a-0000-0000-0000-000000000000",
							id: "a",
							type: "text" as const,
							label: "A",
						},
						{
							uuid: "q-b-0000-0000-0000-000000000000",
							id: "b",
							type: "text" as const,
							label: "B",
						},
						{
							uuid: "q-c-0000-0000-0000-000000000000",
							id: "c",
							type: "text" as const,
							label: "C",
						},
					],
				},
			],
		},
	],
};

function makeStore() {
	const store = createBlueprintDocStore();
	store.getState().load(BP, "test-app");
	store.temporal.getState().resume();
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

const Q_A = "q-a-0000-0000-0000-000000000000";
const Q_B = "q-b-0000-0000-0000-000000000000";
const Q_C = "q-c-0000-0000-0000-000000000000";

/**
 * Set mockSegments to simulate being on a form screen, optionally with
 * a selected question.
 */
function setFormUrl(
	store: ReturnType<typeof makeStore>,
	selectedUuid?: string,
) {
	const state = store.getState();
	const moduleUuid = state.moduleOrder[0];
	const formUuid = state.formOrder[moduleUuid][0];
	mockSegments.current = selectedUuid ? [formUuid, selectedUuid] : [formUuid];
	return { moduleUuid, formUuid };
}

describe("useDeleteSelectedQuestion", () => {
	beforeEach(() => {
		mockSegments.current = [];
		/* Set window.location so useSelect's basePathRef reads the test app's
		 * path. Must happen BEFORE clearing the spy so the setup call isn't counted. */
		window.history.replaceState(null, "", pathname);
		replaceStateSpy.mockClear();
	});

	it("no-ops when not on a form location", () => {
		const store = makeStore();
		const moduleUuid = store.getState().moduleOrder[0];
		mockSegments.current = [moduleUuid]; // module screen

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(Object.keys(store.getState().questions).length).toBe(3);
		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it("no-ops when no question is selected", () => {
		const store = makeStore();
		setFormUrl(store); // form URL with no selection

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(Object.keys(store.getState().questions).length).toBe(3);
		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it("deleting a middle question selects the next sibling", () => {
		const store = makeStore();
		setFormUrl(store, Q_B);

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(store.getState().questions[asUuid(Q_B)]).toBeUndefined();
		/* Flat URL: selected question is a single segment (parser derives form). */
		expect(replaceStateSpy).toHaveBeenCalledWith(
			null,
			"",
			`${pathname}/${Q_C}`,
		);
	});

	it("deleting the last question selects the previous sibling", () => {
		const store = makeStore();
		setFormUrl(store, Q_C);

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(store.getState().questions[asUuid(Q_C)]).toBeUndefined();
		expect(replaceStateSpy).toHaveBeenCalledWith(
			null,
			"",
			`${pathname}/${Q_B}`,
		);
	});

	it("deleting the only remaining question clears the selection", () => {
		const store = makeStore();
		store.getState().apply({ kind: "removeQuestion", uuid: asUuid(Q_B) });
		store.getState().apply({ kind: "removeQuestion", uuid: asUuid(Q_C) });

		const { formUuid } = setFormUrl(store, Q_A);
		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(store.getState().questions[asUuid(Q_A)]).toBeUndefined();
		expect(replaceStateSpy).toHaveBeenCalledWith(
			null,
			"",
			`${pathname}/${formUuid}`,
		);
	});

	it("drops selection when selected uuid is stale / not in refs (regression for idx<0 guard)", () => {
		/* With path-based URLs, a stale question UUID in the selection segment
		 * is already degraded by the parser — `parsePathToLocation` returns
		 * a form location without `selectedUuid`. The delete hook sees no
		 * selection and no-ops entirely (no doc mutation, no URL change).
		 * The stale URL cleanup is handled by `LocationRecoveryEffect`. */
		const store = makeStore();
		setFormUrl(store, "bogus-not-in-form-uuid");

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		/* No questions removed — hook no-ops when selectedUuid is undefined. */
		expect(Object.keys(store.getState().questions).length).toBe(3);
		/* No URL change — the parser already degraded the stale UUID. */
		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it("doc question count drops by one after a successful delete", () => {
		const store = makeStore();
		setFormUrl(store, Q_A);

		const countBefore = Object.keys(store.getState().questions).length;
		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(Object.keys(store.getState().questions).length).toBe(
			countBefore - 1,
		);
	});
});
