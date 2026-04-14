// @vitest-environment happy-dom

/**
 * Positive-path coverage for `useUndoRedo` — verifies the hook actually
 * invokes the doc store's temporal undo/redo and that the scroll/flash
 * affordance is triggered or skipped based on the current location and
 * DOM state.
 *
 * Provider strategy
 * -----------------
 * We stub `@/hooks/useBuilder` entirely. `useUndoRedo` only calls two
 * things on the builder side: `useBuilderEngine()` (for DOM side-effect
 * helpers) and `useBuilderStore((s) => s.activeFieldId)`. Neither has
 * React-state semantics that we need here — the interesting behavior
 * lives in the doc store's temporal middleware and in the scroll/flash
 * branching logic, which we exercise directly.
 *
 * The real doc store is constructed once per test via
 * `createBlueprintDocStore()` and wrapped in a `BlueprintDocContext.Provider`.
 * This matches the shared-store pattern already used in
 * `hooks-useBreadcrumbs.test.tsx`: one store instance visible both to
 * the test setup (which dispatches mutations and inspects temporal
 * state) and to the hook under test.
 */

import { act, renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ScrollRegistryProvider,
	useRegisterScrollCallback,
} from "@/components/builder/contexts/ScrollRegistryContext";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";

const routerReplace = vi.fn();
const mockParams = { current: new URLSearchParams() };

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
		usePathname: () => "/build/a",
	};
});

/*
 * Shared spies on every engine method `useUndoRedo` may call. They're
 * module-scoped so individual tests can reset and assert on them.
 */
const findFieldElement = vi.fn<
	(uuid: string, fieldId?: string) => HTMLElement | null
>(() => null);
const scrollToQuestion = vi.fn();
const flashUndoHighlight = vi.fn();
const setFocusHint = vi.fn();
/*
 * `activeFieldId` is exposed via `useBuilderStore((s) => s.activeFieldId)`.
 * A module-scoped ref lets individual tests flip the value without
 * rebuilding the mock.
 */
const activeFieldIdRef = { current: undefined as string | undefined };

/* `useSelect` calls `useConsultEditGuard()` from EditGuardContext. Stub
 * it to always allow selection so undo/redo tests focus on their own logic. */
vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => () => true,
}));

/*
 * Full stub of `@/hooks/useBuilder`. Every consumer goes through this
 * module, so mocking it here avoids dragging in the whole
 * BuilderEngine / BuilderStore stack just to get engine imperative
 * methods and `activeFieldId` answers.
 */
vi.mock("@/hooks/useBuilder", () => ({
	useBuilderEngine: () => ({
		findFieldElement,
		scrollToQuestion,
		flashUndoHighlight,
		setFocusHint,
	}),
	useBuilderStore: <T,>(
		selector: (s: { activeFieldId: string | undefined }) => T,
	) => selector({ activeFieldId: activeFieldIdRef.current }),
}));

import { useUndoRedo } from "@/lib/routing/builderActions";

/*
 * Tiny fixture: one module, one form, two top-level questions. Enough
 * to verify "mutation → undo reverses it → redo reapplies it" without
 * pulling in a full blueprint.
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
					],
				},
			],
		},
	],
};

function makeStore() {
	const store = createBlueprintDocStore();
	store.getState().load(BP, "test-app");
	// Temporal is paused after `load()` — resume so mutations issued by
	// the test are tracked. Matches real-app wiring in
	// `BlueprintDocProvider` (`startTracking=true` default).
	store.temporal.getState().resume();
	return store;
}

/** Registers the `scrollToQuestion` spy as the scroll registry callback
 *  so `useUndoRedo`'s `scrollTo(...)` dispatches through the spy. */
function ScrollCallbackInstaller({ children }: { children: ReactNode }) {
	useRegisterScrollCallback(scrollToQuestion);
	return <>{children}</>;
}

function wrap(store: ReturnType<typeof makeStore>) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<ScrollRegistryProvider>
				<ScrollCallbackInstaller>
					<BlueprintDocContext.Provider value={store}>
						{children}
					</BlueprintDocContext.Provider>
				</ScrollCallbackInstaller>
			</ScrollRegistryProvider>
		);
	};
}

describe("useUndoRedo", () => {
	beforeEach(() => {
		findFieldElement.mockReset();
		findFieldElement.mockImplementation(() => null);
		scrollToQuestion.mockReset();
		flashUndoHighlight.mockReset();
		setFocusHint.mockReset();
		activeFieldIdRef.current = undefined;
		mockParams.current = new URLSearchParams();
		routerReplace.mockReset();
	});

	it("undo no-ops when pastStates is empty (fresh load)", () => {
		const store = makeStore();
		/* Clear history so the only state is the post-load snapshot. The
		 * store's `load()` already pauses+clears, but temporal is resumed
		 * in `makeStore()`; clear() leaves the resumed state untouched. */
		store.temporal.getState().clear();

		const countBefore = Object.keys(store.getState().questions).length;
		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});

		act(() => result.current.undo());

		expect(Object.keys(store.getState().questions).length).toBe(countBefore);
	});

	it("redo no-ops when futureStates is empty", () => {
		const store = makeStore();
		store.temporal.getState().clear();

		const countBefore = Object.keys(store.getState().questions).length;
		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});

		act(() => result.current.redo());

		expect(Object.keys(store.getState().questions).length).toBe(countBefore);
	});

	it("undo reverses the last mutation; redo reapplies it", () => {
		const store = makeStore();

		// Dispatch a remove. Temporal should capture the pre-remove state.
		const qaUuid = asUuid("q-a-0000-0000-0000-000000000000");
		act(() => {
			store.getState().apply({ kind: "removeQuestion", uuid: qaUuid });
		});
		expect(store.getState().questions[qaUuid]).toBeUndefined();
		expect(store.temporal.getState().pastStates.length).toBeGreaterThan(0);

		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});

		act(() => result.current.undo());
		// Question restored.
		expect(store.getState().questions[qaUuid]).toBeDefined();

		act(() => result.current.redo());
		// Question removed again.
		expect(store.getState().questions[qaUuid]).toBeUndefined();
	});

	it("skips scroll/flash when not on a form location", () => {
		/* URL is empty → `loc.kind === "home"` → hook reads no selectedUuid.
		 * Even with undo work to do, no engine DOM calls should fire. */
		const store = makeStore();
		act(() => {
			store.getState().apply({
				kind: "removeQuestion",
				uuid: asUuid("q-a-0000-0000-0000-000000000000"),
			});
		});

		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});
		act(() => result.current.undo());

		expect(scrollToQuestion).not.toHaveBeenCalled();
		expect(flashUndoHighlight).not.toHaveBeenCalled();
		expect(setFocusHint).not.toHaveBeenCalled();
	});

	it("skips scroll/flash gracefully when the DOM has no matching element", () => {
		/* Simulates the documented cross-form undo limitation: the URL's
		 * `sel=` points at a question that exists in the doc but not in
		 * the current viewport (different form). `findFieldElement` and
		 * `document.querySelector` both return null → the hook should
		 * bail without throwing. */
		const store = makeStore();
		act(() => {
			store.getState().apply({
				kind: "updateQuestion",
				uuid: asUuid("q-a-0000-0000-0000-000000000000"),
				patch: { label: "Renamed" },
			});
		});

		/* Point the URL at the form + selection for `q-a`. */
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		mockParams.current = new URLSearchParams(
			`s=f&m=${moduleUuid}&f=${formUuid}&sel=q-a-0000-0000-0000-000000000000`,
		);

		const qsSpy = vi.spyOn(document, "querySelector").mockReturnValue(null);
		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});

		expect(() => {
			act(() => result.current.undo());
		}).not.toThrow();

		// No DOM-side effects should have fired — no element to target.
		expect(scrollToQuestion).not.toHaveBeenCalled();
		expect(flashUndoHighlight).not.toHaveBeenCalled();

		qsSpy.mockRestore();
	});

	it("scrolls and flashes when the selection has a live DOM target", () => {
		/* Happy path — the URL selects a question, `findFieldElement`
		 * returns a fake element, and the hook should call both
		 * scroll + flash + (since no activeFieldId) skip setFocusHint. */
		const store = makeStore();
		act(() => {
			store.getState().apply({
				kind: "updateQuestion",
				uuid: asUuid("q-a-0000-0000-0000-000000000000"),
				patch: { label: "Renamed" },
			});
		});

		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		mockParams.current = new URLSearchParams(
			`s=f&m=${moduleUuid}&f=${formUuid}&sel=q-a-0000-0000-0000-000000000000`,
		);

		const fakeEl = document.createElement("div") as HTMLElement;
		findFieldElement.mockReturnValue(fakeEl);

		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});
		act(() => result.current.undo());

		expect(findFieldElement).toHaveBeenCalledWith(
			"q-a-0000-0000-0000-000000000000",
			undefined,
		);
		expect(scrollToQuestion).toHaveBeenCalledWith(
			"q-a-0000-0000-0000-000000000000",
			fakeEl,
			"instant",
			undefined,
		);
		expect(flashUndoHighlight).toHaveBeenCalledWith(fakeEl);
		expect(setFocusHint).not.toHaveBeenCalled();
	});

	it("sets focus hint when activeFieldId is present", () => {
		const store = makeStore();
		act(() => {
			store.getState().apply({
				kind: "updateQuestion",
				uuid: asUuid("q-a-0000-0000-0000-000000000000"),
				patch: { label: "Renamed" },
			});
		});

		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		mockParams.current = new URLSearchParams(
			`s=f&m=${moduleUuid}&f=${formUuid}&sel=q-a-0000-0000-0000-000000000000`,
		);

		activeFieldIdRef.current = "label";
		const fakeEl = document.createElement("div") as HTMLElement;
		findFieldElement.mockReturnValue(fakeEl);

		const { result } = renderHook(() => useUndoRedo(), {
			wrapper: wrap(store),
		});
		act(() => result.current.undo());

		expect(setFocusHint).toHaveBeenCalledWith("label");
	});
});
