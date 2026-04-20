// @vitest-environment happy-dom
//
// Tests for `useFirstFormForModule` — the narrow selector that returns
// the first form under a given module (used by module-card "default
// action" UI that opens into the module's lead form).

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useFirstFormForModule } from "@/lib/doc/hooks/useFirstFormForModule";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

const MOD_UUID = asUuid("module-1-uuid");
const EMPTY_MOD_UUID = asUuid("module-empty-uuid");
const FORM_A = asUuid("form-a-uuid");
const FORM_B = asUuid("form-b-uuid");

function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "First Form Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD_UUID]: { uuid: MOD_UUID, id: "reg", name: "Registration" },
			[EMPTY_MOD_UUID]: {
				uuid: EMPTY_MOD_UUID,
				id: "empty",
				name: "Empty Module",
			},
		},
		forms: {
			[FORM_A]: {
				uuid: FORM_A,
				id: "form_a",
				name: "Form A",
				type: "registration",
			},
			[FORM_B]: {
				uuid: FORM_B,
				id: "form_b",
				name: "Form B",
				type: "followup",
			},
		},
		fields: {},
		moduleOrder: [MOD_UUID, EMPTY_MOD_UUID],
		formOrder: {
			[MOD_UUID]: [FORM_A, FORM_B],
			[EMPTY_MOD_UUID]: [],
		},
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

describe("useFirstFormForModule", () => {
	it("returns the first form in formOrder for the module", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useFirstFormForModule(MOD_UUID), {
			wrapper,
		});
		expect(result.current?.uuid).toBe(FORM_A);
		expect(result.current?.name).toBe("Form A");
	});

	it("returns undefined for a module with no forms", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useFirstFormForModule(EMPTY_MOD_UUID), {
			wrapper,
		});
		expect(result.current).toBeUndefined();
	});

	it("returns undefined for an unknown module uuid", () => {
		const { wrapper } = setup();
		const { result } = renderHook(
			() => useFirstFormForModule(asUuid("does-not-exist")),
			{ wrapper },
		);
		expect(result.current).toBeUndefined();
	});

	it("returns undefined when called with undefined", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useFirstFormForModule(undefined), {
			wrapper,
		});
		expect(result.current).toBeUndefined();
	});
});
