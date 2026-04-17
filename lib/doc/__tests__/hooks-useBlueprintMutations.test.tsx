// @vitest-environment happy-dom

/**
 * Tests for the user-facing mutation hook `useBlueprintMutations`.
 *
 * The hook takes uuid-first parameters — every test resolves uuids from
 * the doc store state before dispatching mutations. This mirrors the
 * real call pattern where callers read uuids from `useLocation()` or
 * direct doc store subscriptions.
 *
 * Provider-per-mount gotcha
 * -------------------------
 * `BlueprintDocProvider` mints a fresh store on every mount via a `useRef`
 * factory. If two separate `renderHook` calls both wrap in the provider,
 * they wind up with two independent stores — a mutation dispatched through
 * one will never affect the other. All assertions in this file therefore
 * use a single `renderHook` call that composes both the mutation surface
 * and the read hooks into a single tuple. React's live `result` object
 * reflects the post-`act()` state, so downstream assertions see the
 * updated values.
 *
 * React's Rules of Hooks also forbid nested hook calls as arguments, so
 * the read-side composition is expressed via a locally defined hook that
 * chains `useOrderedModules → useOrderedForms → useOrderedFields`.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useContext } from "react";
import { assert, describe, expect, it } from "vitest";
import {
	useBlueprintDoc,
	useBlueprintDocShallow,
} from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useOrderedFields } from "@/lib/doc/hooks/useOrderedFields";
import {
	BlueprintDocContext,
	BlueprintDocProvider,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { FieldKind } from "@/lib/domain";

// ── Fixed UUIDs ────────────────────────────────────────────────────────
// Declared here (not inside the fixture) so tests can reference them
// without extracting from store state.

const MOD1 = asUuid("module-1-uuid");
const FORM1 = asUuid("form-1-uuid");
const FORM2 = asUuid("form-2-uuid");
const Q_A = asUuid("q-a-0000-0000-0000-000000000000");
const Q_B = asUuid("q-b-0000-0000-0000-000000000000");
const Q_G = asUuid("q-g-0000-0000-0000-000000000000");
const Q_C = asUuid("q-c-0000-0000-0000-000000000000");
const Q_X = asUuid("q-x-0000-0000-0000-000000000000");

/**
 * Normalized `BlueprintDoc` fixture. One module, two forms:
 *  - F0: [a, b, grp { c }]
 *  - F1: [x]
 *
 * Tests cover top-level mutations AND nested (group-child) paths.
 * Group/repeat nesting semantics are tested in the mutation reducer
 * suite; this file only proves the hook's uuid-validation + dispatch
 * path works for both depths.
 */
const bp: BlueprintDoc = {
	appId: "t",
	appName: "Test",
	connectType: null,
	caseTypes: null,
	modules: {
		[MOD1]: { uuid: MOD1, id: "m0", name: "M0" },
	},
	forms: {
		[FORM1]: { uuid: FORM1, id: "f0", name: "F0", type: "survey" },
		[FORM2]: { uuid: FORM2, id: "f1", name: "F1", type: "survey" },
	},
	fields: {
		[Q_A]: {
			uuid: Q_A,
			id: "a",
			kind: "text",
			label: "A",
		} as BlueprintDoc["fields"][typeof Q_A],
		[Q_B]: {
			uuid: Q_B,
			id: "b",
			kind: "text",
			label: "B",
		} as BlueprintDoc["fields"][typeof Q_B],
		[Q_G]: {
			uuid: Q_G,
			id: "grp",
			kind: "group",
			label: "Group",
		} as BlueprintDoc["fields"][typeof Q_G],
		[Q_C]: {
			uuid: Q_C,
			id: "c",
			kind: "text",
			label: "C",
		} as BlueprintDoc["fields"][typeof Q_C],
		[Q_X]: {
			uuid: Q_X,
			id: "x",
			kind: "text",
			label: "X",
		} as BlueprintDoc["fields"][typeof Q_X],
	},
	moduleOrder: [MOD1],
	formOrder: { [MOD1]: [FORM1, FORM2] },
	fieldOrder: {
		[FORM1]: [Q_A, Q_B, Q_G],
		[FORM2]: [Q_X],
		[Q_G]: [Q_C],
	},
	fieldParent: {},
};

function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="t" initialDoc={bp}>
			{children}
		</BlueprintDocProvider>
	);
}

/**
 * `useOrderedFields` returns uuids only (perf — unrelated field edits
 * would force a re-render if the whole `fields` map were selected). Tests
 * want to assert on field entities (`.id`, `.label`, …), so the composers
 * below materialize uuids into entities via `useBlueprintDocShallow`. The
 * shallow comparator keeps the returned array reference-stable when every
 * resolved field is still the same reference — prevents the infinite
 * re-render loop that plain `useStore` would cause, since the selector
 * allocates a fresh array on every call.
 */
function useMaterialize(uuids: readonly Uuid[]): Array<{
	uuid: Uuid;
	id: string;
	label?: string;
}> {
	return useBlueprintDocShallow((s) =>
		uuids
			.map((u) => s.fields[u])
			.filter((f): f is NonNullable<typeof f> => !!f),
	);
}

/**
 * Compose the mutation surface with the ordered-children read for the
 * first form in a single hook so one `renderHook` subscribes both sides
 * to the same store instance. `result.current.children` stays live —
 * post-`act()` re-renders refresh it in place.
 *
 * Also exposes the raw store handle so tests can read `moduleOrder`,
 * `formOrder`, etc. for uuid resolution.
 */
function useMutationsAndFirstFormChildren() {
	const mutations = useBlueprintMutations();
	const modules = useOrderedModules();
	const forms = useOrderedForms((modules[0]?.uuid ?? "") as Uuid);
	const childUuids = useOrderedFields((forms[0]?.uuid ?? "") as Uuid);
	const children = useMaterialize(childUuids);
	const firstForm = forms[0];
	const store = useContext(BlueprintDocContext);
	return { mutations, children, firstForm, store };
}

/**
 * Composer that also exposes the group's children — used by tests that
 * insert into or read from the nested group entity.
 */
function useMutationsFormsAndGroupChildren() {
	const mutations = useBlueprintMutations();
	const modules = useOrderedModules();
	const forms = useOrderedForms((modules[0]?.uuid ?? "") as Uuid);
	const topLevelUuids = useOrderedFields((forms[0]?.uuid ?? "") as Uuid);
	const topLevel = useMaterialize(topLevelUuids);
	const group = topLevel.find((q) => q.id === "grp");
	const groupChildUuids = useOrderedFields((group?.uuid ?? "") as Uuid);
	const groupChildren = useMaterialize(groupChildUuids);
	const store = useContext(BlueprintDocContext);
	return { mutations, topLevel, groupChildren, store };
}

/** Composer for the app-level assertion — mutations + app name + connect. */
function useMutationsAndAppFields() {
	const mutations = useBlueprintMutations();
	const appName = useBlueprintDoc((s) => s.appName);
	const connectType = useBlueprintDoc((s) => s.connectType);
	return { mutations, appName, connectType };
}

/**
 * Composer that exposes both the ordered children of form 0 and the raw
 * store handle — needed by undo-history tests that inspect zundo state.
 */
function useMutationsWithStore() {
	const mutations = useBlueprintMutations();
	const modules = useOrderedModules();
	const forms = useOrderedForms((modules[0]?.uuid ?? "") as Uuid);
	const childUuids = useOrderedFields((forms[0]?.uuid ?? "") as Uuid);
	const children = useMaterialize(childUuids);
	// We read the store directly (not via hook) because zundo's temporal
	// state isn't part of the data slice — assertions go through
	// `store.temporal.getState().pastStates`.
	const store = useContext(BlueprintDocContext);
	return { mutations, children, store };
}

/**
 * Helper: resolve the first form's uuid from the store snapshot. Used
 * by most tests as the `parentUuid` for question mutations.
 */
function getFormUuid(store: BlueprintDocStore | null): Uuid {
	if (!store) throw new Error("getFormUuid: store is null");
	const s = store.getState();
	const moduleUuid = s.moduleOrder[0];
	return s.formOrder[moduleUuid][0];
}

describe("useBlueprintMutations", () => {
	// ── Pre-existing coverage ──────────────────────────────────────────────

	it("updateQuestion edits fields via uuid", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.updateField(Q_A, { label: "Renamed" });
		});

		// Cast to a loose variant-agnostic shape to read `label` — the domain
		// `Field` union includes variants (hidden) that omit label at the
		// type level, even though the reducer merges it unconditionally.
		const renamed = result.current.children.find((q) => q.id === "a") as
			| { label?: string }
			| undefined;
		expect(renamed?.label).toBe("Renamed");
	});

	it("renameQuestion rewrites the id in order", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.renameField(Q_A, "alpha");
		});

		const ids = result.current.children.map((q) => q.id);
		expect(ids).toContain("alpha");
		expect(ids).not.toContain("a");
	});

	it("removeQuestion drops the question from order", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.removeField(Q_B);
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["a", "grp"]);
	});

	it("updateApp changes app-level fields", () => {
		const { result } = renderHook(() => useMutationsAndAppFields(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.updateApp({ app_name: "New" });
		});

		expect(result.current.appName).toBe("New");
	});

	// ── addQuestion ────────────────────────────────────────────────────────

	it("addQuestion returns the new question's uuid", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let returned: Uuid = "" as Uuid;
		act(() => {
			const formUuid = getFormUuid(result.current.store);
			returned = result.current.mutations.addField(formUuid, {
				id: "d",
				kind: "text",
				label: "D",
			});
		});

		// Returned value is a uuid (non-empty string) and matches the newly
		// inserted question in the form's children.
		expect(returned).toMatch(/[0-9a-f-]/);
		const inserted = result.current.children.find((q) => q.id === "d");
		expect(inserted?.uuid).toBe(returned);
	});

	it("addQuestion with parentUuid inserts into a group", () => {
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.addField(Q_G, {
				id: "c2",
				kind: "text",
				label: "C2",
			});
		});

		expect(result.current.groupChildren.map((q) => q.id)).toEqual(["c", "c2"]);
	});

	it("addQuestion with afterUuid/beforeUuid positions correctly", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Insert between `a` and `b` via `afterUuid`.
		act(() => {
			const formUuid = getFormUuid(result.current.store);
			result.current.mutations.addField(
				formUuid,
				{ id: "a2", kind: "text", label: "A2" },
				{ afterUuid: Q_A },
			);
		});
		expect(result.current.children.map((q) => q.id)).toEqual([
			"a",
			"a2",
			"b",
			"grp",
		]);

		// Insert before `b` — should land between `a2` and `b`.
		act(() => {
			const formUuid = getFormUuid(result.current.store);
			result.current.mutations.addField(
				formUuid,
				{ id: "a3", kind: "text", label: "A3" },
				{ beforeUuid: Q_B },
			);
		});
		expect(result.current.children.map((q) => q.id)).toEqual([
			"a",
			"a2",
			"a3",
			"b",
			"grp",
		]);
	});

	// ── moveQuestion ──────────────────────────────────────────────────────

	it("moveQuestion with afterUuid reorders within the same parent", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Move `a` to after `b`. Result should be [b, a, grp].
		act(() => {
			result.current.mutations.moveField(Q_A, { afterUuid: Q_B });
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	it("moveQuestion with toParentUuid crosses parents", () => {
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		// Move `a` from the form root into the group.
		act(() => {
			result.current.mutations.moveField(Q_A, {
				toParentUuid: Q_G,
			});
		});

		// Top level should no longer contain `a`; group now has both `c` and `a`.
		expect(result.current.topLevel.map((q) => q.id)).toEqual(["b", "grp"]);
		expect(result.current.groupChildren.map((q) => q.id)).toContain("a");
	});

	// ── duplicateQuestion ─────────────────────────────────────────────────

	it("duplicateQuestion returns { newPath, newUuid }", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let dup: { newPath: string; newUuid: string } | undefined;
		act(() => {
			dup = result.current.mutations.duplicateField(Q_A);
		});

		expect(dup).toBeDefined();
		expect(dup?.newUuid).toMatch(/[0-9a-f-]/);
		// The duplicated question's path is top-level (no slashes) and its id
		// should be either `a` + dedup suffix.
		expect(dup?.newPath.startsWith("a")).toBe(true);
		// The new uuid should actually exist in the current form's children.
		const newUuid = dup?.newUuid;
		expect(result.current.children.some((q) => q.uuid === newUuid)).toBe(true);
	});

	// ── renameQuestion conflict detection ─────────────────────────────────

	it("renameQuestion returns conflict: true when sibling id clashes", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Attempt to rename `a` → `b`, which already exists.
		const captured: {
			value?: ReturnType<typeof result.current.mutations.renameField>;
		} = {};
		act(() => {
			captured.value = result.current.mutations.renameField(Q_A, "b");
		});

		expect(captured.value?.conflict).toBe(true);
		// And the store should be unchanged — `a` is still present.
		expect(result.current.children.map((q) => q.id)).toEqual(["a", "b", "grp"]);
	});

	// ── updateApp undo atomicity ──────────────────────────────────────────

	it("updateApp with both fields produces a single undo entry", () => {
		const { result } = renderHook(() => useMutationsWithStore(), { wrapper });

		// Resume temporal so edits after load() are tracked. `load()` inside
		// the provider's constructor pauses temporal, but the provider then
		// resumes it (startTracking=true default). Still double-check.
		act(() => {
			result.current.store?.temporal.getState().resume();
		});
		const before =
			result.current.store?.temporal.getState().pastStates.length ?? 0;

		act(() => {
			result.current.mutations.updateApp({
				app_name: "Combo",
				connect_type: "learn",
			});
		});

		const after =
			result.current.store?.temporal.getState().pastStates.length ?? 0;

		// Exactly ONE new undo entry should have been added.
		expect(after - before).toBe(1);
	});

	// ── replaceForm ───────────────────────────────────────────────────────

	it("replaceForm wholesale-swaps a form's questions", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			const formUuid = getFormUuid(result.current.store);
			const Q_Z = asUuid("q-z-0000-0000-0000-000000000000");
			const Q_Y = asUuid("q-y-0000-0000-0000-000000000000");
			result.current.mutations.replaceForm(
				formUuid,
				{ id: "f0", name: "F0", type: "survey" },
				[
					{ uuid: Q_Z, id: "z", kind: "text", label: "Z" },
					{ uuid: Q_Y, id: "y", kind: "text", label: "Y" },
				],
				{ [formUuid]: [Q_Z, Q_Y] },
			);
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["z", "y"]);
	});

	// ── addForm returns uuid ──────────────────────────────────────────────

	it("addForm returns the new form's uuid", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let returned: Uuid = "" as Uuid;
		act(() => {
			const s = result.current.store?.getState();
			assert(s);
			const moduleUuid = s.moduleOrder[0];
			returned = result.current.mutations.addForm(moduleUuid, {
				uuid: "form-3-uuid",
				id: "f2",
				name: "F2",
				type: "survey",
			});
		});

		expect(returned).toMatch(/[0-9a-f-]/);
		const s = result.current.store?.getState();
		assert(s);
		expect(s.forms[returned]).toBeDefined();
		expect(s.forms[returned].name).toBe("F2");
	});

	// ── addModule returns uuid ────────────────────────────────────────────

	it("addModule returns the new module's uuid", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let returned: Uuid = "" as Uuid;
		act(() => {
			returned = result.current.mutations.addModule({
				uuid: "module-1-uuid",
				id: "m1",
				name: "M1",
			});
		});

		expect(returned).toMatch(/[0-9a-f-]/);
		const s = result.current.store?.getState();
		assert(s);
		expect(s.modules[returned]).toBeDefined();
		expect(s.modules[returned].name).toBe("M1");
	});

	// ── updateForm ────────────────────────────────────────────────────────

	it("updateForm patches camelCase fields on an existing form", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			const formUuid = getFormUuid(result.current.store);
			result.current.mutations.updateForm(formUuid, {
				name: "Renamed Form",
			});
		});

		const s = result.current.store?.getState();
		const formUuid = getFormUuid(result.current.store);
		expect(s?.forms[formUuid].name).toBe("Renamed Form");
	});

	// ── removeForm ────────────────────────────────────────────────────────

	it("removeForm drops the form entity and its formOrder entry", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let formUuid: Uuid = "" as Uuid;
		act(() => {
			formUuid = getFormUuid(result.current.store);
			result.current.mutations.removeForm(formUuid);
		});

		const s = result.current.store?.getState();
		expect(s?.forms[formUuid]).toBeUndefined();
		// The module's formOrder should no longer reference the removed form.
		const moduleUuid = s?.moduleOrder[0] ?? ("" as Uuid);
		expect(s?.formOrder[moduleUuid]).not.toContain(formUuid);
	});

	// ── updateModule ──────────────────────────────────────────────────────

	it("updateModule patches fields on an existing module", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			const s = result.current.store?.getState();
			const moduleUuid = s?.moduleOrder[0];
			if (!moduleUuid) return;
			result.current.mutations.updateModule(moduleUuid, {
				name: "Renamed Module",
			});
		});

		const s = result.current.store?.getState();
		const moduleUuid = s?.moduleOrder[0] ?? ("" as Uuid);
		expect(s?.modules[moduleUuid].name).toBe("Renamed Module");
	});

	// ── removeModule ──────────────────────────────────────────────────────

	it("removeModule drops the module entity and its moduleOrder entry", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let moduleUuid: Uuid = "" as Uuid;
		act(() => {
			const firstUuid = result.current.store?.getState().moduleOrder[0];
			if (!firstUuid) return;
			moduleUuid = firstUuid;
			result.current.mutations.removeModule(moduleUuid);
		});

		const s = result.current.store?.getState();
		expect(s?.modules[moduleUuid]).toBeUndefined();
		expect(s?.moduleOrder).not.toContain(moduleUuid);
	});

	// ── setCaseTypes ──────────────────────────────────────────────────────

	it("setCaseTypes replaces the app-level case types array", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		const nextTypes = [
			{ name: "patient", properties: [] },
			{ name: "visit", properties: [] },
		];

		act(() => {
			result.current.mutations.setCaseTypes(nextTypes);
		});

		const s = result.current.store?.getState();
		expect(s?.caseTypes).toEqual(nextTypes);
	});

	it("setCaseTypes with null clears the app-level case types", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.setCaseTypes(null);
		});

		expect(result.current.store?.getState().caseTypes).toBeNull();
	});

	// ── updateCaseProperty ───────────────────────────────────────────────

	it("updateCaseProperty updates a property on a case type", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Seed case types with a property to update.
		act(() => {
			result.current.mutations.setCaseTypes([
				{
					name: "person",
					properties: [
						{ name: "dob", label: "Date of Birth", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
					],
				},
			]);
		});

		act(() => {
			result.current.mutations.updateCaseProperty("person", "dob", {
				data_type: "date",
			});
		});

		const s = result.current.store?.getState();
		const personType = s?.caseTypes?.find((ct) => ct.name === "person");
		const dob = personType?.properties.find((p) => p.name === "dob");
		expect(dob?.data_type).toBe("date");
		// Ensure the other property is untouched.
		const age = personType?.properties.find((p) => p.name === "age");
		expect(age?.data_type).toBe("int");
	});

	it("updateCaseProperty on a non-existent case type is a silent no-op", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.setCaseTypes([
				{
					name: "person",
					properties: [{ name: "dob", label: "DOB", data_type: "text" }],
				},
			]);
		});

		// Should not throw even though "animal" doesn't exist.
		expect(() => {
			act(() => {
				result.current.mutations.updateCaseProperty("animal", "dob", {
					data_type: "date",
				});
			});
		}).not.toThrow();

		// Case types should be unchanged.
		const s = result.current.store?.getState();
		expect(s?.caseTypes).toEqual([
			{
				name: "person",
				properties: [{ name: "dob", label: "DOB", data_type: "text" }],
			},
		]);
	});

	it("updateCaseProperty on a non-existent property is a silent no-op", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.setCaseTypes([
				{
					name: "person",
					properties: [{ name: "dob", label: "DOB", data_type: "text" }],
				},
			]);
		});

		// Should not throw even though "nonexistent" doesn't exist.
		expect(() => {
			act(() => {
				result.current.mutations.updateCaseProperty("person", "nonexistent", {
					label: "Nope",
				});
			});
		}).not.toThrow();

		// Case types should be unchanged.
		const s = result.current.store?.getState();
		expect(s?.caseTypes).toEqual([
			{
				name: "person",
				properties: [{ name: "dob", label: "DOB", data_type: "text" }],
			},
		]);
	});

	// ── applyMany ─────────────────────────────────────────────────────────

	it("applyMany collapses two mutations into a single undo entry", () => {
		const { result } = renderHook(() => useMutationsWithStore(), { wrapper });

		// Make sure temporal is resumed (BlueprintDocProvider already does
		// this, but it's harmless to call again).
		act(() => {
			result.current.store?.temporal.getState().resume();
		});
		const before =
			result.current.store?.temporal.getState().pastStates.length ?? 0;

		act(() => {
			result.current.mutations.applyMany([
				{ kind: "setAppName", name: "Batched" },
				{ kind: "setConnectType", connectType: "deliver" },
			]);
		});

		const after =
			result.current.store?.temporal.getState().pastStates.length ?? 0;
		// Exactly ONE new undo entry should have been added, despite two
		// mutations dispatching.
		expect(after - before).toBe(1);

		const s = result.current.store?.getState();
		expect(s?.appName).toBe("Batched");
		expect(s?.connectType).toBe("deliver");
	});

	// ── moveField result metadata ────────────────────────────────────────

	it("moveField returns MoveFieldResult with renamed on cross-parent dedup", () => {
		// Use the fixture that has form F0 with [a, b, grp > [c]].
		// Add a question with id "a" inside the group, then move Q_A into the
		// group — it should dedup to "a_2".
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		// Seed a question inside the group with id "a" to force dedup.
		act(() => {
			result.current.mutations.addField(Q_G, {
				id: "a",
				kind: "text",
				label: "duplicate-a",
			});
		});

		const captured: {
			value?: ReturnType<typeof result.current.mutations.moveField>;
		} = {};
		act(() => {
			captured.value = result.current.mutations.moveField(Q_A, {
				toParentUuid: Q_G,
			});
		});

		expect(captured.value).toBeDefined();
		expect(captured.value?.renamed).toBeDefined();
		expect(captured.value?.renamed?.oldId).toBe("a");
		expect(captured.value?.renamed?.newId).toBe("a_2");
		expect(typeof captured.value?.renamed?.xpathFieldsRewritten).toBe("number");
	});

	// ── renameQuestion xpathFieldsRewritten ──────────────────────────────

	it("renameQuestion returns xpathFieldsRewritten from the reducer", () => {
		// Use a normalized doc with xpath refs to get a nonzero rewrite count.
		const MOD4 = asUuid("module-4-uuid");
		const FORM3 = asUuid("form-3-uuid");
		const Q_SRC = asUuid("q-src-0000-0000-0000-000000000000");
		const Q_DEP = asUuid("q-dep-0000-0000-0000-000000000000");
		const bpWithRefs: BlueprintDoc = {
			appId: "t",
			appName: "Refs",
			connectType: null,
			caseTypes: null,
			modules: { [MOD4]: { uuid: MOD4, id: "m", name: "M" } },
			forms: { [FORM3]: { uuid: FORM3, id: "f", name: "F", type: "survey" } },
			fields: {
				[Q_SRC]: {
					uuid: Q_SRC,
					id: "source",
					kind: "text",
					label: "Source",
				} as BlueprintDoc["fields"][typeof Q_SRC],
				[Q_DEP]: {
					uuid: Q_DEP,
					id: "dep",
					kind: "text",
					label: "Dep",
					calculate: "/data/source + 1",
				} as BlueprintDoc["fields"][typeof Q_DEP],
			},
			moduleOrder: [MOD4],
			formOrder: { [MOD4]: [FORM3] },
			fieldOrder: { [FORM3]: [Q_SRC, Q_DEP] },
			fieldParent: {},
		};
		const refWrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocProvider appId="t" initialDoc={bpWithRefs}>
				{children}
			</BlueprintDocProvider>
		);

		const { result } = renderHook(() => useBlueprintMutations(), {
			wrapper: refWrapper,
		});

		const captured: {
			value?: ReturnType<typeof result.current.renameField>;
		} = {};
		act(() => {
			captured.value = result.current.renameField(
				asUuid("q-src-0000-0000-0000-000000000000"),
				"primary",
			);
		});

		expect(captured.value).toBeDefined();
		expect(captured.value?.xpathFieldsRewritten).toBeGreaterThan(0);
	});

	// ── moveQuestion — extra options ──────────────────────────────────────

	it("moveQuestion with beforeUuid reorders within the same parent", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Move `b` to before `a`. Same-parent: result should be [b, a, grp].
		act(() => {
			result.current.mutations.moveField(Q_B, { beforeUuid: Q_A });
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	it("moveQuestion with toIndex reorders to the specified slot", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		/* Same-parent move: base is [a, b, grp], virtual after removing `a`
		 * is [b, grp], so toIndex=1 should place `a` at virtual[1] →
		 * [b, a, grp]. This mirrors the virtual-post-splice semantics the
		 * hook documents. */
		act(() => {
			result.current.mutations.moveField(Q_A, { toIndex: 1 });
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	// ── convertField ─────────────────────────────────────────────────────

	describe("convertField", () => {
		it("swaps the kind and reflects the new kind in doc state", () => {
			// Q_A starts as `text`; `text` can convert to `secret` per the registry.
			// After the dispatch the store should contain Q_A with kind === "secret".
			const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
				wrapper,
			});

			act(() => {
				result.current.mutations.convertField(Q_A, "secret" as FieldKind);
			});

			const s = result.current.store?.getState();
			const converted = s?.fields[Q_A];
			expect(converted).toBeDefined();
			expect(converted?.kind).toBe("secret");
			// The field's semantic id should be preserved across the kind swap.
			expect(converted?.id).toBe("a");
		});

		it("is visible in useMaterialize after dispatch", () => {
			// Confirm that the live `children` array (read via the hook composer)
			// reflects the post-dispatch kind — proves the reactive subscription
			// picks up the state change.
			const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
				wrapper,
			});

			act(() => {
				result.current.mutations.convertField(Q_A, "secret" as FieldKind);
			});

			// The children array is derived from the live form order — the converted
			// field should still appear at the same position.
			const convertedChild = result.current.children.find((q) => q.id === "a");
			expect(convertedChild).toBeDefined();
			expect(convertedChild?.uuid).toBe(Q_A);
		});

		it("no-ops silently when uuid is unknown", () => {
			// An unrecognized uuid must not throw and must leave the store
			// unchanged — matches the fail-open contract the other mutation methods
			// follow.
			const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
				wrapper,
			});

			const before = result.current.store?.getState().fields[Q_A]?.kind;

			expect(() => {
				act(() => {
					result.current.mutations.convertField(
						asUuid("bogus-uuid-convert"),
						"secret" as FieldKind,
					);
				});
			}).not.toThrow();

			// Existing field is untouched.
			const after = result.current.store?.getState().fields[Q_A]?.kind;
			expect(after).toBe(before);
			// Order is also unchanged.
			expect(result.current.children.map((q) => q.id)).toEqual([
				"a",
				"b",
				"grp",
			]);
		});
	});

	// ── Unresolved uuid no-op ─────────────────────────────────────────────

	it("unresolved uuid silently no-ops (no throw)", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		expect(() => {
			act(() => {
				// Bogus uuids should all silently no-op.
				result.current.mutations.updateField(asUuid("bogus-uuid"), {
					label: "x",
				});
				result.current.mutations.removeField(asUuid("bogus-uuid"));
				result.current.mutations.renameField(asUuid("bogus-uuid"), "also_nope");
				result.current.mutations.moveField(asUuid("bogus-uuid"), {});
				result.current.mutations.duplicateField(asUuid("bogus-uuid"));
				result.current.mutations.addField(asUuid("bogus-parent"), {
					id: "should_not_exist",
					kind: "text",
					label: "Nope",
				});
				result.current.mutations.updateForm(asUuid("bogus-uuid"), {
					name: "nope",
				});
				result.current.mutations.removeForm(asUuid("bogus-uuid"));
				result.current.mutations.replaceForm(
					asUuid("bogus-uuid"),
					{ id: "nope", name: "nope", type: "survey" },
					[],
					{},
				);
				result.current.mutations.updateModule(asUuid("bogus-uuid"), {
					name: "nope",
				});
				result.current.mutations.removeModule(asUuid("bogus-uuid"));
				result.current.mutations.addForm(asUuid("bogus-module"), {
					uuid: "form-6-uuid",
					id: "nope",
					name: "nope",
					type: "survey",
				});
			});
		}).not.toThrow();

		// Store should be unchanged.
		expect(result.current.children.map((q) => q.id)).toEqual(["a", "b", "grp"]);
	});
});
