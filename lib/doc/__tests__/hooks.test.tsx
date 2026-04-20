// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useField, useModule } from "@/lib/doc/hooks/useEntity";
import {
	useModuleIds,
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useOrderedFields } from "@/lib/doc/hooks/useOrderedFields";
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
 * one form, and one text field. Returns the store + stable UUIDs so
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
	const fieldUuid = store.getState().fieldOrder[formUuid][0];
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper, moduleUuid, formUuid, fieldUuid };
}

describe("useModule / useForm / useField", () => {
	it("returns the entity when the uuid exists", () => {
		const { wrapper, moduleUuid } = setup();
		const { result } = renderHook(() => useModule(moduleUuid), { wrapper });
		expect(result.current?.name).toBe("Registration");
	});

	it("returns undefined for unknown uuids", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useField("missing-uuid" as never), {
			wrapper,
		});
		expect(result.current).toBeUndefined();
	});

	it("does not re-render when an unrelated entity changes", () => {
		const { store, wrapper, fieldUuid } = setup();
		let renderCount = 0;
		renderHook(
			() => {
				renderCount++;
				return useField(fieldUuid);
			},
			{ wrapper },
		);
		const initialRenders = renderCount;
		store.temporal.getState().resume();
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "Changed" }]);
		});
		// setAppName doesn't touch any field entity, so Immer preserves
		// the reference — useField must NOT re-render.
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
			store.getState().applyMany([{ kind: "setAppName", name: "Different" }]);
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

describe("useOrderedFields", () => {
	it("returns uuids of children under a given parent (form or group)", () => {
		const { wrapper, formUuid, fieldUuid } = setup();
		const { result } = renderHook(() => useOrderedFields(formUuid), {
			wrapper,
		});
		expect(result.current).toHaveLength(1);
		expect(result.current[0]).toBe(fieldUuid);
	});

	it("returns empty array when parent has no children or doesn't exist", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useOrderedFields("nope" as never), {
			wrapper,
		});
		expect(result.current).toEqual([]);
	});

	it("does not re-render when an unrelated field changes", () => {
		// Regression: the previous implementation selected the entire `fields`
		// map, so every field mutation re-rendered every container.
		const { store, wrapper, formUuid } = setup();
		let renderCount = 0;
		renderHook(
			() => {
				renderCount++;
				return useOrderedFields(formUuid);
			},
			{ wrapper },
		);
		const initial = renderCount;
		store.temporal.getState().resume();
		act(() => {
			// Add a second field under the same form — fieldOrder changes, so
			// re-render is expected. This asserts the hook DOES respond to real
			// changes in its own parent's ordering.
			store.getState().applyMany([
				{
					kind: "addField",
					parentUuid: formUuid,
					field: {
						uuid: asUuid("q-222-0000-0000-0000-000000000000"),
						id: "age",
						kind: "int",
						label: "Age",
					} as BlueprintDoc["fields"][string],
				},
			]);
		});
		expect(renderCount).toBeGreaterThan(initial);

		// Now mutate a field entity without changing any `fieldOrder` entry —
		// the hook must NOT re-render.
		const afterAdd = renderCount;
		act(() => {
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: asUuid("q-222-0000-0000-0000-000000000000"),
					patch: { label: "Changed" },
				},
			]);
		});
		expect(renderCount).toBe(afterAdd);
	});
});
