// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { useField } from "@/lib/doc/hooks/useEntity";
import { useOrderedModules } from "@/lib/doc/hooks/useModuleIds";
import {
	LARGE_FORM_AUTO_COLLAPSE_THRESHOLD,
	useLargeFormInitialCollapsedUuids,
	useOrderedFields,
} from "@/lib/doc/hooks/useOrderedFields";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocContext } from "@/lib/doc/provider";
import {
	type BlueprintDocStoreApi,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import type { OrganizationLevel } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

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
		...(parentLevelUuid === undefined
			? {}
			: {
					parentLevelUuid,
				}),
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: {
				kind: "none",
			},
		},
		addressBook: {
			reach: "own-branch",
		},
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
			[MOD_UUID]: {
				uuid: MOD_UUID,
				id: "registration",
				name: "Registration",
			},
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "reg_form",
				name: "Reg Form",
				type: "survey",
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
		formOrder: {
			[MOD_UUID]: [FORM_UUID],
		},
		fieldOrder: {
			[FORM_UUID]: [Q_UUID],
		},
		fieldParent: {},
		organizationLevels: {
			[ROOT_A_UUID]: organizationLevel(ROOT_A_UUID, "Root A"),
			[CHILD_UUID]: organizationLevel(CHILD_UUID, "Child", ROOT_A_UUID),
			[ROOT_B_UUID]: organizationLevel(ROOT_B_UUID, "Root B"),
		},
		organizationLevelOrder: [CHILD_UUID, ROOT_B_UUID, ROOT_A_UUID],
	};
	assertAdmittedDoc(doc);
	store.getState().load(doc);
	const moduleUuid = store.getState().moduleOrder[0];
	const formUuid = store.getState().formOrder[moduleUuid][0];
	const fieldUuid = store.getState().fieldOrder[formUuid][0];
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return {
		store,
		wrapper,
		moduleUuid,
		formUuid,
		fieldUuid,
	};
}
function applyAdmitted(
	store: BlueprintDocStoreApi,
	mutations: Mutation[],
): void {
	const verdict = mutationCommitVerdict(
		store.getState(),
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(
		verdict.ok,
		verdict.ok ? undefined : JSON.stringify(verdict.findings),
	).toBe(true);
	if (!verdict.ok) throw new Error("Fixture edit must be admitted");
	store.getState().commitDoc(verdict.nextDoc, verdict.mutations);
}
describe("useModule / useForm / useField", () => {
	it("does not re-render when an unrelated entity changes", () => {
		const { store, wrapper, fieldUuid } = setup();
		let renderCount = 0;
		const { result } = renderHook(
			() => {
				renderCount++;
				return useField(fieldUuid);
			},
			{
				wrapper,
			},
		);
		const initialRenders = renderCount;
		store.getState().startTracking();
		act(() => {
			applyAdmitted(store, [
				{
					kind: "setAppName",
					name: "Changed",
				},
			]);
		});
		// setAppName doesn't touch any field entity, so Immer preserves
		// the reference — useField must NOT re-render.
		expect(renderCount).toBe(initialRenders);
		act(() =>
			applyAdmitted(store, [
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "text",
					patch: { label: proseText("Edited label") },
				},
			]),
		);
		expect(renderCount).toBeGreaterThan(initialRenders);
		expect(result.current).toMatchObject({ label: proseText("Edited label") });
	});
});
describe("useModuleIds / useOrderedModules", () => {
	it("useOrderedModules stays reference-stable when unrelated state changes", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(() => useOrderedModules(), {
			wrapper,
		});
		const first = result.current;
		store.getState().startTracking();
		act(() => {
			applyAdmitted(store, [
				{
					kind: "setAppName",
					name: "Different",
				},
			]);
		});
		expect(result.current).toBe(first);
		act(() =>
			applyAdmitted(store, [
				{ kind: "renameModule", uuid: MOD_UUID, newId: "Edited module" },
			]),
		);
		expect(result.current).not.toBe(first);
		expect(result.current[0].name).toBe("Edited module");
	});
});
describe("useOrderedFields", () => {
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
			{
				wrapper,
			},
		);
		const initial = renderCount;
		store.getState().startTracking();
		act(() => {
			// Add a second field under the same form — fieldOrder changes, so
			// re-render is expected. This asserts the hook DOES respond to real
			// changes in its own parent's ordering.
			applyAdmitted(store, [
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
			applyAdmitted(store, [
				{
					kind: "updateField",
					uuid: testUuid("q-222-0000-0000-0000-000000000000"),
					targetKind: "int",
					patch: {
						label: proseText("Changed"),
					},
				},
			]);
		});
		expect(renderCount).toBe(afterAdd);
	});
});
describe("useLargeFormInitialCollapsedUuids", () => {
	it("keeps the projected set stable across unrelated field edits", () => {
		const { store, wrapper, formUuid, fieldUuid } = setup();
		applyAdmitted(
			store,
			Array.from(
				{
					length: LARGE_FORM_AUTO_COLLAPSE_THRESHOLD - 1,
				},
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
			{
				wrapper,
			},
		);
		expect(result.current.has(formUuid)).toBe(true);
		const initialRenderCount = renderCount;
		act(() => {
			applyAdmitted(store, [
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "text",
					patch: {
						label: proseText("Updated"),
					},
				},
			]);
		});
		expect(renderCount).toBe(initialRenderCount);
		act(() =>
			applyAdmitted(store, [
				{ kind: "removeField", uuid: testUuid("stable-large-form-field-0") },
			]),
		);
		expect(result.current.has(formUuid)).toBe(false);
		expect(renderCount).toBeGreaterThan(initialRenderCount);
	});
});
