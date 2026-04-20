// @vitest-environment happy-dom
//
// Tests for `useHasFieldsInForm` — boolean "does this form have any
// questions?" selector used by form cards to toggle empty-state UI.

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

const MOD_UUID = asUuid("module-1-uuid");
const FORM_WITH_FIELDS = asUuid("form-with-uuid");
const FORM_EMPTY = asUuid("form-empty-uuid");
const Q_UUID = asUuid("q-111-0000-0000-0000-000000000000");

function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "Has Fields Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD_UUID]: { uuid: MOD_UUID, id: "reg", name: "Registration" },
		},
		forms: {
			[FORM_WITH_FIELDS]: {
				uuid: FORM_WITH_FIELDS,
				id: "form_with",
				name: "Form With",
				type: "registration",
			},
			[FORM_EMPTY]: {
				uuid: FORM_EMPTY,
				id: "form_empty",
				name: "Form Empty",
				type: "followup",
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
		formOrder: { [MOD_UUID]: [FORM_WITH_FIELDS, FORM_EMPTY] },
		// One form has a child, the other is explicitly empty ([]).
		fieldOrder: { [FORM_WITH_FIELDS]: [Q_UUID], [FORM_EMPTY]: [] },
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

describe("useHasFieldsInForm", () => {
	it("returns true when the form has at least one field", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useHasFieldsInForm(FORM_WITH_FIELDS), {
			wrapper,
		});
		expect(result.current).toBe(true);
	});

	it("returns false when the form has an empty fieldOrder entry", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useHasFieldsInForm(FORM_EMPTY), {
			wrapper,
		});
		expect(result.current).toBe(false);
	});

	it("returns false when the form has no fieldOrder entry at all", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useHasFieldsInForm(asUuid("no-entry-uuid")),
			{ wrapper },
		);
		expect(result.current).toBe(false);
	});

	it("returns false when called with undefined", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useHasFieldsInForm(undefined), {
			wrapper,
		});
		expect(result.current).toBe(false);
	});
});
