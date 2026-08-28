// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { useField, useModule } from "@/lib/doc/hooks/useEntity";
import {
	useModuleIds,
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import {
	LARGE_FORM_AUTO_COLLAPSE_THRESHOLD,
	useLargeFormInitialCollapsedUuids,
	useOrderedFields,
} from "@/lib/doc/hooks/useOrderedFields";
import { useOrganizationLevels } from "@/lib/doc/hooks/useOrganizationCollections";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import type { OrganizationLevel } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

// ── Fixed UUIDs ────────────────────────────────────────────────────────

const MOD_UUID = testUuid("module-1-uuid");
const FORM_UUID = testUuid("form-1-uuid");
const Q_UUID = testUuid("q-111-0000-0000-0000-000000000000");
const ROOT_A_UUID = testUuid("organization-root-a");
const CHILD_UUID = testUuid("organization-child");
const ROOT_B_UUID = testUuid("organization-root-b");

function organizationLevel(
	uuid: OrganizationLevel["uuid"],
	name: string,
	parentLevelUuid?: OrganizationLevel["uuid"],
): OrganizationLevel {
	return {
		uuid,
		code: name.toLocaleLowerCase().replaceAll(" ", "_"),
		name,
		...(parentLevelUuid === undefined ? {} : { parentLevelUuid }),
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
}

/**
 * Seed the store with a normalized `BlueprintDoc` containing one module,
 * one form, and one text field. Returns the store + stable UUIDs so
 * tests can assert on entity access without re-deriving them.
 *
 * `load()` accepts the normalized shape directly.
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
				label: proseText("Name"),
			} as BlueprintDoc["fields"][typeof Q_UUID],
		},
		moduleOrder: [MOD_UUID],
		formOrder: { [MOD_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [Q_UUID] },
		fieldParent: {},
		organizationLevels: {
			[ROOT_A_UUID]: organizationLevel(ROOT_A_UUID, "Root A"),
			[CHILD_UUID]: organizationLevel(CHILD_UUID, "Child", ROOT_A_UUID),
			[ROOT_B_UUID]: organizationLevel(ROOT_B_UUID, "Root B"),
		},
		organizationLevelOrder: [CHILD_UUID, ROOT_B_UUID, ROOT_A_UUID],
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
		store.getState().startTracking();
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
		store.getState().startTracking();
		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "Different" }]);
		});
		expect(result.current).toBe(first);
	});
});

describe("useOrganizationLevels", () => {
	it("preserves the canonical membership-array sequence", () => {
		const { wrapper } = setup();
		const { result } = renderHook(() => useOrganizationLevels(), { wrapper });
		expect(result.current.map((level) => level.uuid)).toEqual([
			CHILD_UUID,
			ROOT_B_UUID,
			ROOT_A_UUID,
		]);
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
		store.getState().startTracking();
		act(() => {
			// Add a second field under the same form — fieldOrder changes, so
			// re-render is expected. This asserts the hook DOES respond to real
			// changes in its own parent's ordering.
			store.getState().applyMany([
				{
					kind: "addField",
					parentUuid: formUuid,
					field: {
						uuid: testUuid("q-222-0000-0000-0000-000000000000"),
						id: "age",
						kind: "int",
						label: proseText("Age"),
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
					uuid: testUuid("q-222-0000-0000-0000-000000000000"),
					targetKind: "text",
					patch: { label: proseText("Changed") },
				},
			]);
		});
		expect(renderCount).toBe(afterAdd);
	});
});

describe("useLargeFormInitialCollapsedUuids", () => {
	it("includes a form once its complete field tree reaches the threshold", () => {
		const { store, wrapper, formUuid } = setup();
		const extraFieldCount = LARGE_FORM_AUTO_COLLAPSE_THRESHOLD - 1;
		const extraFields = Array.from({ length: extraFieldCount }, (_, index) => ({
			kind: "addField" as const,
			parentUuid: formUuid,
			field: {
				uuid: testUuid(`large-form-field-${index}`),
				id: `profile_${index}`,
				kind: "text" as const,
				label: proseText(`Profile ${index}`),
			},
		}));

		store.getState().applyMany(extraFields.slice(0, -1));
		const { result } = renderHook(() => useLargeFormInitialCollapsedUuids(), {
			wrapper,
		});
		expect(result.current.has(formUuid)).toBe(false);

		act(() => {
			store.getState().applyMany(extraFields.slice(-1));
		});
		expect(result.current.has(formUuid)).toBe(true);
	});

	it("includes every nested container once a form reaches the threshold", () => {
		const { store, wrapper, formUuid } = setup();
		const groupUuid = testUuid("large-form-nested-group");
		const repeatUuid = testUuid("large-form-nested-repeat");
		store.getState().applyMany([
			{
				kind: "addField",
				parentUuid: formUuid,
				field: {
					uuid: groupUuid,
					id: "details",
					kind: "group",
					label: proseText("Details"),
				},
			},
			{
				kind: "addField",
				parentUuid: groupUuid,
				field: {
					uuid: repeatUuid,
					id: "visits",
					kind: "repeat",
					repeat_mode: "user_controlled",
					label: proseText("Visits"),
				},
			},
			...Array.from(
				{ length: LARGE_FORM_AUTO_COLLAPSE_THRESHOLD - 2 },
				(_, index) => ({
					kind: "addField" as const,
					parentUuid: repeatUuid,
					field: {
						uuid: testUuid(`nested-large-form-field-${index}`),
						id: `nested_profile_${index}`,
						kind: "text" as const,
						label: proseText(`Nested profile ${index}`),
					},
				}),
			),
		]);

		const { result } = renderHook(() => useLargeFormInitialCollapsedUuids(), {
			wrapper,
		});
		expect(result.current).toEqual(new Set([formUuid, groupUuid, repeatUuid]));
	});

	it("keeps the projected set stable across unrelated field edits", () => {
		const { store, wrapper, formUuid, fieldUuid } = setup();
		store.getState().applyMany(
			Array.from(
				{ length: LARGE_FORM_AUTO_COLLAPSE_THRESHOLD - 1 },
				(_, index) => ({
					kind: "addField" as const,
					parentUuid: formUuid,
					field: {
						uuid: testUuid(`stable-large-form-field-${index}`),
						id: `stable_profile_${index}`,
						kind: "text" as const,
						label: proseText(`Stable profile ${index}`),
					},
				}),
			),
		);

		let renderCount = 0;
		const { result } = renderHook(
			() => {
				renderCount += 1;
				return useLargeFormInitialCollapsedUuids();
			},
			{ wrapper },
		);
		expect(result.current.has(formUuid)).toBe(true);
		const initialRenderCount = renderCount;

		act(() => {
			store.getState().applyMany([
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "text",
					patch: { label: proseText("Updated") },
				},
			]);
		});
		expect(renderCount).toBe(initialRenderCount);
	});
});
