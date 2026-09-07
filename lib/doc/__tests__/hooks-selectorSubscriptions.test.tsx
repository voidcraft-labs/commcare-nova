// @vitest-environment happy-dom

/** Real React subscriptions over admitted document transitions. Domain reducers
 * have separate tests; these observations catch stale selectors and excess work. */
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useAppStructure } from "@/lib/doc/hooks/useAppStructure";
import { useDocEntityMaps } from "@/lib/doc/hooks/useDocEntityMaps";
import { useChildFieldCount, useFieldKind } from "@/lib/doc/hooks/useFieldKind";
import { useFieldsAndOrder } from "@/lib/doc/hooks/useFieldsAndOrder";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import { useSearchBlueprint } from "@/lib/doc/hooks/useSearchBlueprint";
import { useCanRedo, useCanUndo } from "@/lib/doc/hooks/useUndoRedo";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { proseText } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const MOD = testUuid("selector-module");
const FORM = testUuid("selector-form");
const OTHER_FORM = testUuid("selector-other-form");
const NAME = testUuid("selector-name");
const GROUP = testUuid("selector-group");
const AGE = testUuid("selector-age");
const OTHER = testUuid("selector-other");

function setup() {
	const doc = buildDoc({
		appName: "Interview",
		modules: [
			{
				uuid: MOD,
				name: "Survey",
				forms: [
					{
						uuid: FORM,
						name: "Profile",
						type: "survey",
						fields: [
							{ uuid: NAME, id: "name", kind: "text", label: "Full name" },
							{
								uuid: GROUP,
								id: "details",
								kind: "group",
								children: [
									{ uuid: AGE, id: "age", kind: "int", label: "Age in years" },
								],
							},
						],
					},
					{
						uuid: OTHER_FORM,
						name: "Notes",
						type: "survey",
						fields: [{ uuid: OTHER, id: "note", kind: "text" }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	store.getState().startTracking();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	function commit(mutations: Mutation[]): void {
		const verdict = mutationCommitVerdict(
			store.getState(),
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
		store.getState().commitDoc(verdict.nextDoc, verdict.mutations);
	}
	return { store, wrapper, commit };
}

describe("named document subscriptions", () => {
	it("publishes app-name edits, undo, redo, and a new history branch", () => {
		const { store, wrapper, commit } = setup();
		const { result } = renderHook(
			() => ({ name: useAppName(), undo: useCanUndo(), redo: useCanRedo() }),
			{ wrapper },
		);
		expect(result.current).toEqual({
			name: "Interview",
			undo: false,
			redo: false,
		});
		act(() => commit([{ kind: "setAppName", name: "Follow up" }]));
		expect(result.current).toEqual({
			name: "Follow up",
			undo: true,
			redo: false,
		});
		act(() => store.getState().undo());
		expect(result.current).toEqual({
			name: "Interview",
			undo: false,
			redo: true,
		});
		act(() => store.getState().redo());
		expect(result.current).toEqual({
			name: "Follow up",
			undo: true,
			redo: false,
		});
		act(() => store.getState().undo());
		act(() => commit([{ kind: "setAppName", name: "New branch" }]));
		expect(result.current).toEqual({
			name: "New branch",
			undo: true,
			redo: false,
		});
	});

	it("keeps paired projections quiet until their actual data changes", () => {
		const { wrapper, commit } = setup();
		let renders = 0;
		const { result } = renderHook(
			() => {
				renders++;
				return {
					structure: useAppStructure(),
					maps: useDocEntityMaps(),
					fields: useFieldsAndOrder(),
				};
			},
			{ wrapper },
		);
		const initial = result.current;
		const initialRenders = renders;
		expect(initial.structure).toEqual({
			moduleOrder: [MOD],
			formOrder: { [MOD]: [FORM, OTHER_FORM] },
		});
		expect(Object.keys(initial.maps.fields)).toEqual([NAME, GROUP, AGE, OTHER]);
		expect(initial.fields.fieldOrder).toEqual({
			[FORM]: [NAME, GROUP],
			[GROUP]: [AGE],
			[OTHER_FORM]: [OTHER],
		});
		act(() => commit([{ kind: "setAppName", name: "Unrelated" }]));
		expect(renders).toBe(initialRenders);
		expect(result.current).toBe(initial);

		act(() =>
			commit([
				{
					kind: "updateField",
					uuid: AGE,
					targetKind: "int",
					patch: { label: proseText("Years old") },
				},
			]),
		);
		expect(result.current.structure).toBe(initial.structure);
		expect(result.current.maps).not.toBe(initial.maps);
		expect(result.current.fields).not.toBe(initial.fields);
		expect(result.current.fields.fields[AGE]).toMatchObject({
			label: proseText("Years old"),
		});
		const afterLabel = result.current;
		act(() =>
			commit([
				{ kind: "moveField", uuid: NAME, toParentUuid: GROUP, after: AGE },
			]),
		);
		expect(result.current.fields.fieldOrder[GROUP]).toEqual([AGE, NAME]);
		expect(result.current.structure).toBe(afterLabel.structure);

		act(() =>
			commit([
				{ kind: "moveForm", uuid: OTHER_FORM, toModuleUuid: MOD, after: null },
			]),
		);
		expect(result.current.structure.formOrder[MOD]).toEqual([OTHER_FORM, FORM]);
		expect(result.current.structure).not.toBe(initial.structure);
	});

	it("updates field kinds and direct child counts while ignoring label-only writes", () => {
		const { wrapper, commit } = setup();
		let renders = 0;
		const { result } = renderHook(
			() => {
				renders++;
				return {
					kind: useFieldKind(NAME),
					formCount: useChildFieldCount(FORM),
					groupCount: useChildFieldCount(GROUP),
					hasOther: useHasFieldsInForm(OTHER_FORM),
				};
			},
			{ wrapper },
		);
		expect(result.current).toEqual({
			kind: "text",
			formCount: 2,
			groupCount: 1,
			hasOther: true,
		});
		const before = renders;
		act(() =>
			commit([
				{
					kind: "updateField",
					uuid: NAME,
					targetKind: "text",
					patch: { label: proseText("New label") },
				},
			]),
		);
		expect(renders).toBe(before);
		act(() => commit([{ kind: "convertField", uuid: NAME, toKind: "secret" }]));
		expect(result.current.kind).toBe("secret");
		act(() =>
			commit([
				{ kind: "moveField", uuid: NAME, toParentUuid: GROUP, after: AGE },
			]),
		);
		expect(result.current).toEqual({
			kind: "secret",
			formCount: 1,
			groupCount: 2,
			hasOther: true,
		});
		act(() =>
			commit([
				{ kind: "removeForm", uuid: OTHER_FORM },
				{ kind: "removeField", uuid: NAME },
			]),
		);
		expect(result.current).toEqual({
			kind: undefined,
			formCount: 1,
			groupCount: 1,
			hasOther: false,
		});
	});

	it("keeps an imperative search callback stable while it reads the latest committed document", () => {
		const { wrapper, commit } = setup();
		let renders = 0;
		const { result } = renderHook(
			() => {
				renders++;
				return useSearchBlueprint();
			},
			{ wrapper },
		);
		const search = result.current;
		const before = renders;
		expect(search("years")).toEqual([
			expect.objectContaining({
				type: "field",
				fieldUuid: AGE,
				field: "label",
				value: "Age in years",
			}),
		]);
		act(() =>
			commit([
				{
					kind: "updateField",
					uuid: AGE,
					targetKind: "int",
					patch: { label: proseText("Completed birthdays") },
				},
			]),
		);
		expect(renders).toBe(before);
		expect(result.current).toBe(search);
		expect(search("years")).toEqual([]);
		expect(search("birthdays")).toEqual([
			expect.objectContaining({
				type: "field",
				fieldUuid: AGE,
				field: "label",
				value: "Completed birthdays",
			}),
		]);
	});
});
