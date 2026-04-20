// @vitest-environment happy-dom
//
// Tests for `useFieldsAndOrder` — the shallow-stable paired selector
// that returns the field map + fieldOrder map together. Primary
// consumer is CloseConditionSection's recursive id lookup (it needs
// both to walk a subtree and resolve ids).

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useFieldsAndOrder } from "@/lib/doc/hooks/useFieldsAndOrder";
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
		appName: "Fields And Order Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD_UUID]: { uuid: MOD_UUID, id: "reg", name: "Registration" },
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

describe("useFieldsAndOrder", () => {
	it("returns the fields and fieldOrder maps together", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useFieldsAndOrder(), { wrapper });
		expect(Object.keys(result.current.fields)).toEqual([Q_UUID]);
		expect(result.current.fieldOrder).toEqual({ [FORM_UUID]: [Q_UUID] });
	});

	it("stays reference-stable when unrelated state changes", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useFieldsAndOrder(), { wrapper });
		const first = result.current;
		store.temporal.getState().resume();
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "Different" }]);
		});
		expect(result.current).toBe(first);
	});
});
