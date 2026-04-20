// @vitest-environment happy-dom
//
// Tests for `useDocEntityMaps` — the shallow-stable paired selector that
// returns all three entity maps. Consumers that need to walk entities
// (search filters, validators, compound selectors) subscribe once rather
// than three times with a shallow wrapper.

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useDocEntityMaps } from "@/lib/doc/hooks/useDocEntityMaps";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

const MOD_UUID = asUuid("module-1-uuid");
const FORM_UUID = asUuid("form-1-uuid");
const Q_UUID = asUuid("q-111-0000-0000-0000-000000000000");

function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "Entity Maps Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD_UUID]: { uuid: MOD_UUID, id: "registration", name: "Registration" },
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "reg_form",
				name: "Reg Form",
				type: "registration",
			},
		},
		fields: {
			[Q_UUID]: {
				uuid: Q_UUID,
				id: "name",
				kind: "text",
				label: "Name",
			} as BlueprintDoc["fields"][string],
		},
		moduleOrder: [MOD_UUID],
		formOrder: { [MOD_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [Q_UUID] },
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

describe("useDocEntityMaps", () => {
	it("returns the modules, forms, and fields maps", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useDocEntityMaps(), { wrapper });
		expect(Object.keys(result.current.modules)).toEqual([MOD_UUID]);
		expect(Object.keys(result.current.forms)).toEqual([FORM_UUID]);
		expect(Object.keys(result.current.fields)).toEqual([Q_UUID]);
	});

	it("returns the same object reference when no map changed (shallow stability)", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useDocEntityMaps(), { wrapper });
		const first = result.current;
		store.temporal.getState().resume();
		// `setAppName` doesn't touch any entity map — shallow equality on the
		// selector output should return the same object, preventing re-render.
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "Different" }]);
		});
		expect(result.current).toBe(first);
	});
});
