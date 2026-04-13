// @vitest-environment happy-dom

/**
 * Positive-path coverage for `useDeleteSelectedQuestion`.
 *
 * The hook:
 *   1. Resolves the selected uuid from `useLocation()`.
 *   2. Computes the neighbor via `flattenQuestionRefs` on the assembled
 *      form (skipping hidden/conditional questions).
 *   3. Dispatches `removeQuestion` through the doc store.
 *   4. Replaces the URL's `sel=` with the neighbor uuid (or clears it).
 *
 * Regression coverage
 * -------------------
 * One of these tests locks in the Phase 2 Fix #2 guard: when the
 * selected uuid isn't found in `refs` (hidden question, stale uuid),
 * `idx < 0`, and `refs[idx + 1]` would silently promote `refs[0]`
 * — jumping selection to the top of the form. The guard drops
 * selection entirely instead.
 */

import { act, renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";

const routerReplace = vi.fn();
const mockParams = { current: new URLSearchParams() };
const pathname = "/build/test-app";

vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		useSearchParams: () => new ReadonlyURLSearchParams(mockParams.current),
		useRouter: () => ({
			push: vi.fn(),
			replace: routerReplace,
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
		usePathname: () => pathname,
	};
});

/* `useSelect` calls `useConsultEditGuard()` from EditGuardContext, so we
 * stub that to always allow selection. The useBuilder mock is only needed
 * for `useBuilderStore` (reads activeFieldId). */
vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => () => true,
}));

vi.mock("@/hooks/useBuilder", () => ({
	useBuilderStore: <T,>(
		selector: (s: { activeFieldId: string | undefined }) => T,
	) => selector({ activeFieldId: undefined }),
}));

import { useDeleteSelectedQuestion } from "@/lib/routing/builderActions";

/*
 * Three top-level questions so we can test middle-neighbor, last-neighbor,
 * and only-question deletion. A fourth "hidden" question (with a bogus
 * `relevant` that `flattenQuestionRefs` would skip) covers the guard.
 */
const BP = {
	app_name: "T",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			name: "M",
			case_type: undefined,
			forms: [
				{
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

/*
 * Tests set this from the freshly loaded store — uuids for the form
 * and module are deterministic only across a single `makeStore()` call.
 */
function setFormUrl(
	store: ReturnType<typeof makeStore>,
	selectedUuid?: string,
) {
	const state = store.getState();
	const moduleUuid = state.moduleOrder[0];
	const formUuid = state.formOrder[moduleUuid][0];
	const qs = `s=f&m=${moduleUuid}&f=${formUuid}${
		selectedUuid ? `&sel=${selectedUuid}` : ""
	}`;
	mockParams.current = new URLSearchParams(qs);
	return { moduleUuid, formUuid };
}

describe("useDeleteSelectedQuestion", () => {
	beforeEach(() => {
		routerReplace.mockReset();
		mockParams.current = new URLSearchParams();
	});

	it("no-ops when not on a form location", () => {
		const store = makeStore();
		mockParams.current = new URLSearchParams("s=m&m=whatever");

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		// Nothing removed, no URL change.
		expect(Object.keys(store.getState().questions).length).toBe(3);
		expect(routerReplace).not.toHaveBeenCalled();
	});

	it("no-ops when no question is selected", () => {
		const store = makeStore();
		setFormUrl(store); // form URL with no sel=

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(Object.keys(store.getState().questions).length).toBe(3);
		expect(routerReplace).not.toHaveBeenCalled();
	});

	it("deleting a middle question selects the next sibling", () => {
		const store = makeStore();
		const { moduleUuid, formUuid } = setFormUrl(store, Q_B);

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		// `b` removed from the doc, `c` should be the neighbor.
		expect(store.getState().questions[asUuid(Q_B)]).toBeUndefined();
		expect(routerReplace).toHaveBeenCalledWith(
			`${pathname}?s=f&m=${moduleUuid}&f=${formUuid}&sel=${Q_C}`,
			{ scroll: false },
		);
	});

	it("deleting the last question selects the previous sibling", () => {
		const store = makeStore();
		const { moduleUuid, formUuid } = setFormUrl(store, Q_C);

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(store.getState().questions[asUuid(Q_C)]).toBeUndefined();
		expect(routerReplace).toHaveBeenCalledWith(
			`${pathname}?s=f&m=${moduleUuid}&f=${formUuid}&sel=${Q_B}`,
			{ scroll: false },
		);
	});

	it("deleting the only remaining question clears the selection", () => {
		const store = makeStore();
		// Manually remove `b` and `c` first so only `a` is left.
		store.getState().apply({ kind: "removeQuestion", uuid: asUuid(Q_B) });
		store.getState().apply({ kind: "removeQuestion", uuid: asUuid(Q_C) });

		const { moduleUuid, formUuid } = setFormUrl(store, Q_A);
		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		expect(store.getState().questions[asUuid(Q_A)]).toBeUndefined();
		// URL should have no `sel=` → the entire replace URL is just the
		// form screen with no selection.
		expect(routerReplace).toHaveBeenCalledWith(
			`${pathname}?s=f&m=${moduleUuid}&f=${formUuid}`,
			{ scroll: false },
		);
	});

	it("drops selection when selected uuid is stale / not in refs (regression for idx<0 guard)", () => {
		/* Simulates the selected uuid being absent from `flattenQuestionRefs`
		 * output — in real life this happens for hidden-by-relevance
		 * questions or races with LocationRecoveryEffect. `findIndex`
		 * returns -1; without the guard, `refs[-1 + 1]` would resolve to
		 * refs[0] and promote the top of the form to selection. The fix
		 * drops selection instead. */
		const store = makeStore();
		const { moduleUuid, formUuid } = setFormUrl(
			store,
			"bogus-not-in-form-uuid",
		);

		const { result } = renderHook(() => useDeleteSelectedQuestion(), {
			wrapper: wrap(store),
		});
		act(() => result.current());

		// The store receives a removeQuestion for the bogus uuid — the
		// reducer no-ops on unknown uuids — so existing questions remain.
		expect(Object.keys(store.getState().questions).length).toBe(3);
		// The select() call fires with `undefined`, producing a URL WITHOUT sel=.
		expect(routerReplace).toHaveBeenCalledWith(
			`${pathname}?s=f&m=${moduleUuid}&f=${formUuid}`,
			{ scroll: false },
		);
		// Critically: the URL must NOT contain `sel=${Q_A}` (top-of-form).
		expect(routerReplace).not.toHaveBeenCalledWith(
			`${pathname}?s=f&m=${moduleUuid}&f=${formUuid}&sel=${Q_A}`,
			{ scroll: false },
		);
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
