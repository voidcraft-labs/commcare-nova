// @vitest-environment happy-dom
//
// Tests for `useAppStructure` — the shallow-stable paired selector that
// returns the module + form order arrays together (used by tree
// renderers, keyboard navigation, and blueprint sanity checks that need
// both sequences).

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useAppStructure } from "@/lib/doc/hooks/useAppStructure";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

const MOD_UUID = asUuid("module-1-uuid");
const FORM_UUID = asUuid("form-1-uuid");

function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "App Structure Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD_UUID]: { uuid: MOD_UUID, id: "reg", name: "Registration" },
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "form_a",
				name: "Form A",
				type: "registration",
			},
		},
		fields: {},
		moduleOrder: [MOD_UUID],
		formOrder: { [MOD_UUID]: [FORM_UUID] },
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

describe("useAppStructure", () => {
	it("returns moduleOrder and formOrder together", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useAppStructure(), { wrapper });
		expect(result.current.moduleOrder).toEqual([MOD_UUID]);
		expect(result.current.formOrder).toEqual({ [MOD_UUID]: [FORM_UUID] });
	});

	it("stays reference-stable when unrelated state changes", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useAppStructure(), { wrapper });
		const first = result.current;
		store.temporal.getState().resume();
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "Different" }]);
		});
		expect(result.current).toBe(first);
	});
});
