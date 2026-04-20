// @vitest-environment happy-dom
//
// Tests for `useAppName` — the named selector hook that replaces inline
// `useBlueprintDoc((s) => s.appName)` call sites.

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";

/**
 * Seed a minimal store with just the app name — no modules/forms/fields
 * are needed for this narrow selector hook.
 */
function setup(appName: string) {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName,
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

describe("useAppName", () => {
	it("returns the current app name from the doc", () => {
		const { wrapper } = setup("Immunization Tracker");
		const { result } = renderHook(() => useAppName(), { wrapper });
		expect(result.current).toBe("Immunization Tracker");
	});

	it("re-renders when the app name changes", () => {
		const { store, wrapper } = setup("Initial Name");
		const { result } = renderHook(() => useAppName(), { wrapper });
		expect(result.current).toBe("Initial Name");
		store.temporal.getState().resume();
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "Renamed" }]);
		});
		expect(result.current).toBe("Renamed");
	});
});
