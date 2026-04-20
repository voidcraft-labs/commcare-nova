// @vitest-environment happy-dom
//
// Tests for `useCanUndo` and `useCanRedo` — the two boolean availability
// hooks that drive the toolbar's undo/redo button disabled state.
//
// These hooks exist because BuilderSubheader was calling
// `useBlueprintDocTemporal` inline with a selector; that usage is now
// banned outside `lib/**` so consumers must route through a narrow named
// hook. The temporal store is paused by default (zundo loads are not
// captured) — tests must call `resume()` before mutating so pastStates
// actually accumulate.

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useCanRedo, useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";

/**
 * Build an empty-but-valid blueprint doc and mount a provider around it
 * so the temporal-subscription hooks have a store to bind to.
 */
function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "Undo/Redo Test",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
	store.getState().load(doc);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper };
}

describe("useCanUndo", () => {
	it("returns false when the temporal past stack is empty", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useCanUndo(), { wrapper });
		expect(result.current).toBe(false);
	});

	it("returns true after a tracked mutation lands on the past stack", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useCanUndo(), { wrapper });
		expect(result.current).toBe(false);
		// Temporal starts paused — resume before mutating so the mutation
		// actually captures a past state (matches the app's undo pause pattern).
		store.temporal.getState().resume();
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "After" }]);
		});
		expect(result.current).toBe(true);
	});
});

describe("useCanRedo", () => {
	it("returns false when no redo is available", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useCanRedo(), { wrapper });
		expect(result.current).toBe(false);
		// A fresh mutation pushes to pastStates but leaves futureStates empty,
		// so canRedo must still be false.
		store.temporal.getState().resume();
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "After" }]);
		});
		expect(result.current).toBe(false);
	});

	it("returns true after undoing a mutation (future stack populated)", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useCanRedo(), { wrapper });
		store.temporal.getState().resume();
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "After" }]);
		});
		expect(result.current).toBe(false);
		// Undoing moves the captured state from pastStates to futureStates —
		// canRedo should now flip to true.
		act(() => {
			store.temporal.getState().undo();
		});
		expect(result.current).toBe(true);
	});
});
