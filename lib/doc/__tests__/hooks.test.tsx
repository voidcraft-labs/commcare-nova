// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useAssembledForm } from "@/lib/doc/hooks/useAssembledForm";
import { useModule, useQuestion } from "@/lib/doc/hooks/useEntity";
import {
	useModuleIds,
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useOrderedChildren } from "@/lib/doc/hooks/useOrderedChildren";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

// ── Fixed UUIDs ────────────────────────────────────────────────────────

const MOD_UUID = asUuid("module-1-uuid");
const FORM_UUID = asUuid("form-1-uuid");
const Q_UUID = asUuid("q-111-0000-0000-0000-000000000000");

/**
 * Seed the store with a normalized `BlueprintDoc` containing one module,
 * one form, and one text question. Returns the store + stable UUIDs so
 * tests can assert on entity access without re-deriving them.
 *
 * `load()` now accepts the normalized shape directly — no `toDoc` or
 * `AppBlueprint` conversion is needed.
 */
function setup() {
	const store = createBlueprintDocStore();
	const doc: BlueprintDoc = {
		appId: "app-1",
		appName: "Hooks Test",
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
			} as BlueprintDoc["fields"][typeof Q_UUID],
		},
		moduleOrder: [MOD_UUID],
		formOrder: { [MOD_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [Q_UUID] },
		fieldParent: {},
	};
	store.getState().load(doc);
	const moduleUuid = store.getState().moduleOrder[0];
	const formUuid = store.getState().formOrder[moduleUuid][0];
	const questionUuid = store.getState().fieldOrder[formUuid][0];
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper, moduleUuid, formUuid, questionUuid };
}

describe("useModule / useForm / useQuestion", () => {
	it("returns the entity when the uuid exists", () => {
		const { wrapper, moduleUuid } = setup();
		const { result } = renderHook(() => useModule(moduleUuid), { wrapper });
		expect(result.current?.name).toBe("Registration");
	});

	it("returns undefined for unknown uuids", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useQuestion("missing-uuid" as never), {
			wrapper,
		});
		expect(result.current).toBeUndefined();
	});

	it("does not re-render when an unrelated entity changes", () => {
		const { store, wrapper, questionUuid } = setup();
		let renderCount = 0;
		renderHook(
			() => {
				renderCount++;
				return useQuestion(questionUuid);
			},
			{ wrapper },
		);
		const initialRenders = renderCount;
		store.temporal.getState().resume();
		act(() => {
			store.getState().apply({ kind: "setAppName", name: "Changed" });
		});
		// setAppName doesn't touch any question entity, so Immer preserves
		// the reference — useQuestion must NOT re-render.
		expect(renderCount).toBe(initialRenders);
	});
});

describe("useModuleIds / useOrderedModules", () => {
	it("useModuleIds returns the moduleOrder array", () => {
		const { wrapper, moduleUuid } = setup();
		const { result } = renderHook(() => useModuleIds(), { wrapper });
		expect(result.current).toEqual([moduleUuid]);
	});

	it("useOrderedModules returns modules in moduleOrder sequence", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useOrderedModules(), { wrapper });
		expect(result.current).toHaveLength(1);
		expect(result.current[0].name).toBe("Registration");
	});

	it("useOrderedModules stays reference-stable when unrelated state changes", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useOrderedModules(), { wrapper });
		const first = result.current;
		store.temporal.getState().resume();
		act(() => {
			store.getState().apply({ kind: "setAppName", name: "Different" });
		});
		expect(result.current).toBe(first);
	});
});

describe("useOrderedForms", () => {
	it("returns forms for a given module in order", () => {
		const { wrapper, moduleUuid } = setup();
		const { result } = renderHook(() => useOrderedForms(moduleUuid), {
			wrapper,
		});
		expect(result.current).toHaveLength(1);
		expect(result.current[0].name).toBe("Reg Form");
	});

	it("returns empty array when module doesn't exist", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useOrderedForms("missing" as never), {
			wrapper,
		});
		expect(result.current).toEqual([]);
	});
});

describe("useOrderedChildren", () => {
	it("returns questions under a given parent (form or group)", () => {
		const { wrapper, formUuid } = setup();
		const { result } = renderHook(() => useOrderedChildren(formUuid), {
			wrapper,
		});
		expect(result.current).toHaveLength(1);
		expect(result.current[0].id).toBe("name");
	});

	it("returns empty array when parent has no children or doesn't exist", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useOrderedChildren("nope" as never), {
			wrapper,
		});
		expect(result.current).toEqual([]);
	});
});

describe("useAssembledForm", () => {
	it("reconstructs a form with nested questions", () => {
		const { wrapper, formUuid } = setup();
		const { result } = renderHook(() => useAssembledForm(formUuid), {
			wrapper,
		});
		expect(result.current?.name).toBe("Reg Form");
		expect(result.current?.questions).toHaveLength(1);
		expect(result.current?.questions[0].id).toBe("name");
	});

	it("returns undefined for unknown form uuids", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useAssembledForm("missing" as never), {
			wrapper,
		});
		expect(result.current).toBeUndefined();
	});
});
