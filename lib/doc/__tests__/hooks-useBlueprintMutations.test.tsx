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
import { assert, describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	useBlueprintDoc,
	useBlueprintDocShallow,
} from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type AddCommitOutcome,
	useBlueprintMutations,
} from "@/lib/doc/hooks/useBlueprintMutations";
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
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import type { Automation, CommitOutcome, FieldKind } from "@/lib/domain";
import { printProseTemplate, proseText } from "@/lib/domain/prose";
import { toastStore } from "@/lib/ui/toastStore";

// ── Fixed UUIDs ────────────────────────────────────────────────────────
// Declared here (not inside the fixture) so tests can reference them
// without extracting from store state.

const MOD1 = testUuid("module-1-uuid");
const FORM1 = testUuid("form-1-uuid");
const FORM2 = testUuid("form-2-uuid");
const Q_A = testUuid("q-a-0000-0000-0000-000000000000");
const Q_B = testUuid("q-b-0000-0000-0000-000000000000");
const Q_G = testUuid("q-g-0000-0000-0000-000000000000");
const Q_C = testUuid("q-c-0000-0000-0000-000000000000");
const Q_X = testUuid("q-x-0000-0000-0000-000000000000");

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
			label: proseText("A"),
		} as BlueprintDoc["fields"][typeof Q_A],
		[Q_B]: {
			uuid: Q_B,
			id: "b",
			kind: "text",
			label: proseText("B"),
		} as BlueprintDoc["fields"][typeof Q_B],
		[Q_G]: {
			uuid: Q_G,
			id: "grp",
			kind: "group",
			label: proseText("Group"),
		} as BlueprintDoc["fields"][typeof Q_G],
		[Q_C]: {
			uuid: Q_C,
			id: "c",
			kind: "text",
			label: proseText("C"),
		} as BlueprintDoc["fields"][typeof Q_C],
		[Q_X]: {
			uuid: Q_X,
			id: "x",
			kind: "text",
			label: proseText("X"),
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

/** Every dispatch runs the one commit gate — the wrapper is just the
 *  doc-store provider. */
function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="t" initialDoc={bp}>
			{children}
		</BlueprintDocProvider>
	);
}

const connectBp: BlueprintDoc = {
	...bp,
	connectType: "learn",
	forms: {
		...bp.forms,
		[FORM1]: {
			...bp.forms[FORM1],
			connect: {
				learn_module: {
					id: "intro",
					name: "Introduction",
					description: "Initial content",
					time_estimate: 5,
				},
			},
		},
	},
};

function connectWrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="t" initialDoc={connectBp}>
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
function useMaterialize(uuids: readonly Uuid[]) {
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
	// The store is read directly (not via a hook) so assertions can drive
	// `undo()` / `redo()` and the birth-pause release.
	const store = useContext(BlueprintDocContext);
	return { mutations, children, store };
}

/**
 * Helper: resolve the first form's uuid from the store snapshot. Used
 * by most tests as the `parentUuid` for field mutations.
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
			result.current.mutations.updateField(Q_A, "text", {
				label: proseText("Renamed"),
			});
		});

		// Cast to a loose variant-agnostic shape to read `label` — the domain
		// `Field` union includes variants (hidden) that omit label at the
		// type level, even though the reducer merges it unconditionally.
		const renamed = result.current.children.find((q) => q.id === "a") as
			| { label?: ReturnType<typeof proseText> }
			| undefined;
		const store = result.current.store;
		if (!renamed?.label || !store) {
			throw new Error("expected renamed field label and initialized store");
		}
		expect(printProseTemplate(renamed.label, store.getState())).toBe("Renamed");
	});

	it("normalizes an explicit undefined field clear to JSON-stable null", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});
		const store = result.current.store;
		assert(store);

		act(() => {
			result.current.mutations.updateField(Q_A, "text", {
				hint: proseText("Temporary hint"),
			});
		});
		store.getState().takeCommandBatches();

		act(() => {
			result.current.mutations.updateField(Q_A, "text", {
				hint: undefined,
			});
		});

		expect(
			(store.getState().fields[Q_A] as { hint?: unknown }).hint,
		).toBeUndefined();
		const commands = store.getState().peekCommandBatches();
		expect(commands).toEqual([
			[
				{
					kind: "updateField",
					uuid: Q_A,
					targetKind: "text",
					patch: { hint: null },
				},
			],
		]);
		expect(JSON.parse(JSON.stringify(commands))).toEqual(commands);
	});

	it("renameQuestion rewrites the id in order", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});
		const store = result.current.store;
		assert(store);

		act(() => {
			result.current.mutations.renameField(Q_A, "alpha");
		});

		const ids = result.current.children.map((q) => q.id);
		expect(ids).toContain("alpha");
		expect(ids).not.toContain("a");
		expect(store.getState().peekCommandBatches()).toEqual([
			[
				{
					kind: "updateField",
					uuid: Q_A,
					targetKind: "text",
					patch: { id: "alpha" },
				},
			],
		]);
	});

	it("removeField drops the field from order", () => {
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

	// ── addField ────────────────────────────────────────────────────────

	it("addField returns the new field's uuid", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let returned = { ok: false, messages: [] } as AddCommitOutcome;
		act(() => {
			const formUuid = getFormUuid(result.current.store);
			returned = result.current.mutations.addField(formUuid, {
				id: "d",
				kind: "text",
				label: proseText("D"),
			});
		});

		// The outcome carries the minted uuid, matching the newly inserted
		// field in the form's children.
		assert(returned.ok);
		expect(returned.uuid).toMatch(/[0-9a-f-]/);
		const inserted = result.current.children.find((q) => q.id === "d");
		expect(inserted?.uuid).toBe(returned.uuid);
	});

	it("addField with parentUuid inserts into a group", () => {
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.addField(Q_G, {
				id: "c2",
				kind: "text",
				label: proseText("C2"),
			});
		});

		expect(result.current.groupChildren.map((q) => q.id)).toEqual(["c", "c2"]);
	});

	it("addField with afterUuid/beforeUuid positions correctly", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Insert between `a` and `b` via `afterUuid`.
		act(() => {
			const formUuid = getFormUuid(result.current.store);
			result.current.mutations.addField(
				formUuid,
				{ id: "a2", kind: "text", label: proseText("A2") },
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
				{ id: "a3", kind: "text", label: proseText("A3") },
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

	// ── moveField ─────────────────────────────────────────────────────────

	it("moveField with afterUuid reorders within the same parent", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Move `a` to after `b`. Result should be [b, a, grp].
		act(() => {
			result.current.mutations.moveField(Q_A, { afterUuid: Q_B });
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	it("moveField with toParentUuid crosses parents", () => {
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
		// The duplicated field's path is top-level (no slashes) and its id
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

	it("renameQuestion is local even when another writer saves to the same property", () => {
		// Two fields in separate forms may save to the same case property.
		// Renaming one field id changes only its friendly form path; it must not
		// rename the peer or inspect the peer's sibling scope.
		const CP_M = testUuid("cp-mod-uuid");
		const CP_F1 = testUuid("cp-form-1-uuid");
		const CP_F2 = testUuid("cp-form-2-uuid");
		const CP_PRIMARY = testUuid("cp-primary-uuid");
		const CP_PEER = testUuid("cp-peer-uuid");
		const CP_BLOCKER = testUuid("cp-blocker-uuid");
		const CP_COLUMN = testUuid("cp-column-uuid");

		const peerDoc: BlueprintDoc = {
			appId: "t",
			appName: "Test",
			connectType: null,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "age", label: proseText("Age") },
						{ name: "age_new", label: proseText("Age new") },
					],
				},
			],
			modules: {
				[CP_M]: {
					uuid: CP_M,
					id: "cp_m",
					name: "CPM",
					caseType: "patient",
					caseListConfig: resolveCaseListConfig({
						columns: [
							{
								uuid: CP_COLUMN,
								kind: "plain",
								field: "age",
								header: "Age",
							},
						],
						searchInputs: [],
					}),
				},
			},
			forms: {
				[CP_F1]: { uuid: CP_F1, id: "cp_f1", name: "F1", type: "followup" },
				[CP_F2]: { uuid: CP_F2, id: "cp_f2", name: "F2", type: "followup" },
			},
			fields: {
				// Primary and peer share the same independent caseWrite pair.
				[CP_PRIMARY]: {
					uuid: CP_PRIMARY,
					id: "age",
					kind: "text",
					label: proseText("Age"),
					caseWrite: { caseType: "patient", property: "age" },
				} as BlueprintDoc["fields"][typeof CP_PRIMARY],
				[CP_PEER]: {
					uuid: CP_PEER,
					id: "age",
					kind: "text",
					label: proseText("Age"),
					caseWrite: { caseType: "patient", property: "age" },
				} as BlueprintDoc["fields"][typeof CP_PEER],
				// This sibling blocks only a local rename of CP_PEER, not the
				// unrelated primary field in F1.
				[CP_BLOCKER]: {
					uuid: CP_BLOCKER,
					id: "age_new",
					kind: "text",
					label: proseText("Existing"),
				} as BlueprintDoc["fields"][typeof CP_BLOCKER],
			},
			moduleOrder: [CP_M],
			formOrder: { [CP_M]: [CP_F1, CP_F2] },
			fieldOrder: {
				[CP_F1]: [CP_PRIMARY],
				[CP_F2]: [CP_PEER, CP_BLOCKER],
			},
			fieldParent: {},
		};

		function peerWrapper({ children }: { children: ReactNode }) {
			return (
				<BlueprintDocProvider appId="t" initialDoc={peerDoc}>
					{children}
				</BlueprintDocProvider>
			);
		}

		const { result } = renderHook(
			() => ({
				mutations: useBlueprintMutations(),
				store: useContext(BlueprintDocContext),
			}),
			{ wrapper: peerWrapper },
		);

		const captured: {
			value?: ReturnType<typeof result.current.mutations.renameField>;
		} = {};
		act(() => {
			captured.value = result.current.mutations.renameField(
				CP_PRIMARY,
				"age_new",
			);
		});

		expect(captured.value).toEqual({});

		// Only the selected field's local id changes.
		const state = result.current.store?.getState();
		assert(state);
		expect(state.fields[CP_PRIMARY]?.id).toBe("age_new");
		expect(state.fields[CP_PEER]?.id).toBe("age");
		expect(state.fields[CP_BLOCKER]?.id).toBe("age_new");
	});

	// ── updateApp undo ────────────────────────────────────────────────────

	it("updateApp renames the app in a single undo entry", () => {
		const { result } = renderHook(() => useMutationsWithStore(), { wrapper });

		// The provider releases the birth pause (startTracking=true default);
		// double-check so a change there fails here rather than silently.
		act(() => {
			result.current.store?.getState().startTracking();
		});

		act(() => {
			result.current.mutations.updateApp({
				app_name: "Combo",
			});
		});

		// ONE step: a single undo takes back the rename.
		expect(result.current.store?.getState().canUndo).toBe(true);
		act(() => {
			result.current.store?.getState().undo();
		});
		expect(result.current.store?.getState().appName).not.toBe("Combo");
		expect(result.current.store?.getState().canUndo).toBe(false);
	});

	// ── addForm returns uuid ──────────────────────────────────────────────

	it("addForm of a bare (fieldless) form is rejected — a form lands with its content", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let returned = { ok: true, uuid: "" } as unknown as AddCommitOutcome;
		act(() => {
			const s = result.current.store?.getState();
			assert(s);
			const moduleUuid = s.moduleOrder[0];
			returned = result.current.mutations.addForm(moduleUuid, {
				uuid: testUuid("form-3-uuid"),
				id: "f2",
				name: "F2",
				type: "survey",
			});
		});

		assert(!returned.ok);
		expect(returned.messages.length).toBeGreaterThan(0);
		const s = result.current.store?.getState();
		assert(s);
		expect(s.forms[testUuid("form-3-uuid")]).toBeUndefined();
	});

	it("applyMany lands a new form together with its first field in one gated batch", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			const s = result.current.store?.getState();
			assert(s);
			const moduleUuid = s.moduleOrder[0];
			result.current.mutations.applyMany([
				{
					kind: "addForm",
					moduleUuid,
					form: {
						uuid: testUuid("form-3-uuid"),
						id: "f2",
						name: "F2",
						type: "survey",
					},
				},
				{
					kind: "addField",
					parentUuid: testUuid("form-3-uuid"),
					field: {
						uuid: testUuid("q-n-0000-0000-0000-000000000000"),
						id: "note",
						kind: "text",
						label: proseText("Note"),
					} as never,
				},
			]);
		});

		const s = result.current.store?.getState();
		assert(s);
		expect(s.forms[testUuid("form-3-uuid")]).toBeDefined();
		expect(s.forms[testUuid("form-3-uuid")].name).toBe("F2");
	});

	// ── addModule returns uuid ────────────────────────────────────────────

	it("createSurveyModule returns the new module's uuid, born with a form", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let returned = { ok: false, messages: [] } as AddCommitOutcome;
		act(() => {
			returned = result.current.mutations.createSurveyModule({ name: "M1" });
		});

		// A bare module would be rejected (NO_FORMS_OR_CASE_LIST); createSurveyModule
		// lands a survey form with it, so the commit is valid by construction.
		assert(returned.ok);
		expect(returned.uuid).toMatch(/[0-9a-f-]/);
		const s = result.current.store?.getState();
		assert(s);
		expect(s.modules[returned.uuid]).toBeDefined();
		expect(s.modules[returned.uuid].name).toBe("M1");
		expect(s.formOrder[returned.uuid]).toHaveLength(1);
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
		expect(s?.peekCommandBatches()).toEqual([
			[
				{
					kind: "renameForm",
					uuid: formUuid,
					newId: "Renamed Form",
				},
			],
		]);
	});

	it("normalizes an explicit undefined form clear to JSON-stable null", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});
		const store = result.current.store;
		assert(store);
		const formUuid = getFormUuid(store);

		act(() => {
			result.current.mutations.updateForm(formUuid, {
				purpose: "Temporary purpose",
			});
		});
		store.getState().takeCommandBatches();

		act(() => {
			result.current.mutations.updateForm(formUuid, {
				purpose: undefined,
			});
		});

		expect(store.getState().forms[formUuid].purpose).toBeUndefined();
		const commands = store.getState().peekCommandBatches();
		expect(commands).toEqual([
			[
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: { purpose: null },
				},
			],
		]);
		expect(JSON.parse(JSON.stringify(commands))).toEqual(commands);
	});

	it("confines Connect membership outside generic form add/update and permits only explicit existing-participant refinement", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper: connectWrapper,
		});
		const store = result.current.store;
		assert(store);
		const initialParticipant = store.getState().forms[FORM1].connect;

		let addOutcome: AddCommitOutcome | undefined;
		let addParticipantOutcome:
			| ReturnType<typeof result.current.mutations.inline.updateForm>
			| undefined;
		let removeParticipantOutcome:
			| ReturnType<typeof result.current.mutations.inline.updateForm>
			| undefined;
		act(() => {
			/* Casts model a stale bundle or untyped JavaScript caller. The public
			 * TypeScript signatures omit these slots; the runtime boundary must
			 * still refuse them before the absolute gate can accept a valid
			 * participant-bearing candidate. */
			addOutcome = result.current.mutations.inline.addForm(MOD1, {
				id: "alternate",
				name: "Alternate",
				type: "survey",
				connect: initialParticipant,
			} as never);
			addParticipantOutcome = result.current.mutations.inline.updateForm(
				FORM2,
				{ connect: initialParticipant } as never,
			);
			removeParticipantOutcome = result.current.mutations.inline.updateForm(
				FORM1,
				{ connect: null } as never,
			);
		});

		for (const outcome of [
			addOutcome,
			addParticipantOutcome,
			removeParticipantOutcome,
		]) {
			expect(outcome?.ok).toBe(false);
			if (outcome?.ok === false) {
				expect(outcome.messages[0]).toContain("app-wide Connect");
			}
		}
		expect(store.getState().forms[FORM1].connect).toEqual(initialParticipant);
		expect(store.getState().forms[FORM2].connect).toBeUndefined();
		expect(store.getState().formOrder[MOD1]).toEqual([FORM1, FORM2]);

		let refineOutcome:
			| ReturnType<typeof result.current.mutations.inline.refineFormConnect>
			| undefined;
		act(() => {
			refineOutcome = result.current.mutations.inline.refineFormConnect(FORM1, {
				learn_module: {
					id: "intro",
					name: "Introduction",
					description: "Refined content",
					time_estimate: 9,
				},
			});
		});
		expect(refineOutcome).toEqual({ ok: true });
		expect(
			(
				store.getState().forms[FORM1].connect as {
					learn_module?: { description: string; time_estimate: number };
				}
			).learn_module,
		).toMatchObject({
			description: "Refined content",
			time_estimate: 9,
		});

		let nonparticipantRefine: typeof refineOutcome;
		act(() => {
			nonparticipantRefine = result.current.mutations.inline.refineFormConnect(
				FORM2,
				{
					learn_module: {
						id: "other",
						name: "Other",
						description: "Should not land",
						time_estimate: 5,
					},
				},
			);
		});
		expect(nonparticipantRefine?.ok).toBe(false);
		expect(store.getState().forms[FORM2].connect).toBeUndefined();
	});

	it("setFormMedia sets and clears form media through explicit nulls", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		const formUuid = getFormUuid(result.current.store);
		act(() => {
			result.current.mutations.setFormMedia(formUuid, {
				icon: testMediaAssetId("image-asset"),
				audioLabel: testMediaAssetId("audio-asset"),
			});
		});
		expect(result.current.store?.getState().forms[formUuid]).toMatchObject({
			icon: testMediaAssetId("image-asset"),
			audioLabel: testMediaAssetId("audio-asset"),
		});

		act(() => {
			result.current.mutations.setFormMedia(formUuid, {
				icon: null,
				audioLabel: testMediaAssetId("audio-asset"),
			});
		});
		const form = result.current.store?.getState().forms[formUuid];
		expect(form?.icon).toBeUndefined();
		expect(form?.audioLabel).toBe(testMediaAssetId("audio-asset"));
	});

	it("setModuleMedia sets and clears module media through explicit nulls", () => {
		// Mirrors `setFormMedia`: the dedicated `setModuleMedia` kind carries
		// an explicit `MediaAssetId | null` per slot so a clear survives JSON over
		// the SSE wire (a generic `updateModule` patch would encode the clear
		// as `{ key: undefined }`, which `JSON.stringify` drops). The reducer
		// maps `null → undefined`, so a cleared slot drops off the module.
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Set both slots.
		act(() => {
			result.current.mutations.setModuleMedia(MOD1, {
				icon: testMediaAssetId("image-asset"),
				audioLabel: testMediaAssetId("audio-asset"),
			});
		});
		expect(result.current.store?.getState().modules[MOD1]).toMatchObject({
			icon: testMediaAssetId("image-asset"),
			audioLabel: testMediaAssetId("audio-asset"),
		});

		// Clear only the icon (null) and keep the audio — proves per-slot
		// clear independence, not an all-or-nothing wipe.
		act(() => {
			result.current.mutations.setModuleMedia(MOD1, {
				icon: null,
				audioLabel: testMediaAssetId("audio-asset"),
			});
		});
		const mod = result.current.store?.getState().modules[MOD1];
		expect(mod?.icon).toBeUndefined();
		expect(mod?.audioLabel).toBe(testMediaAssetId("audio-asset"));
	});

	it("setAppLogo sets and clears the app logo through an explicit null", () => {
		// The doc's `logo` slot is `.optional()` (no stored `null`), so a
		// clear must DROP the key — the `setAppLogo` payload carries an
		// explicit `MediaAssetId | null` and the reducer maps `null → undefined`.
		// Unlike the entity-scoped media mutations, `setAppLogo` takes no
		// uuid (the logo is a single app-level slot), so there is no
		// unresolved-uuid guard to exercise.
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.setAppLogo(testMediaAssetId("logo-asset"));
		});
		expect(result.current.store?.getState().logo).toBe(
			testMediaAssetId("logo-asset"),
		);

		act(() => {
			result.current.mutations.setAppLogo(null);
		});
		expect(result.current.store?.getState().logo).toBeUndefined();
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

	it("creates and reorders submenus with stable sibling anchors", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});
		let firstChild = "" as Uuid;
		let secondChild = "" as Uuid;
		act(() => {
			const first = result.current.mutations.createSurveyModule({
				name: "First child",
				parentModuleUuid: MOD1,
				after: null,
			});
			assert(first.ok);
			firstChild = first.uuid;
			const second = result.current.mutations.createSurveyModule({
				name: "Second child",
				parentModuleUuid: MOD1,
				after: firstChild,
			});
			assert(second.ok);
			secondChild = second.uuid;
		});

		act(() => {
			result.current.mutations.moveModule(secondChild, { after: null });
		});

		const state = result.current.store?.getState();
		expect(state?.moduleOrder.slice(0, 3)).toEqual([
			MOD1,
			secondChild,
			firstChild,
		]);
		expect(state?.modules[secondChild].parentModuleUuid).toBe(MOD1);
	});

	it("names child menus before refusing parent removal", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});
		let childUuid = "" as Uuid;
		act(() => {
			const child = result.current.mutations.createSurveyModule({
				name: "Follow-up menu",
				parentModuleUuid: MOD1,
				after: null,
			});
			assert(child.ok);
			childUuid = child.uuid;
		});

		let outcome: CommitOutcome | undefined;
		act(() => {
			outcome = result.current.mutations.removeModule(MOD1);
		});

		expect(outcome?.ok).toBe(false);
		if (outcome === undefined || outcome.ok) {
			throw new Error("parent removal unexpectedly committed");
		}
		expect(outcome.messages.join(" ")).toContain('"Follow-up menu"');
		expect(outcome.messages.join(" ")).toContain("Move or remove");
		expect(result.current.store?.getState().modules[childUuid]).toBeDefined();
		expect(result.current.store?.getState().modules[MOD1]).toBeDefined();
	});

	// ── removeModule ──────────────────────────────────────────────────────

	it("removeModule drops the module entity and its moduleOrder entry", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		/* Add a second module first — removing the app's ONLY module would
		 * re-introduce NO_MODULES and the gate rightly rejects it (pinned
		 * below). createSurveyModule lands it valid (a form comes with it). */
		let secondUuid: Uuid = "" as Uuid;
		act(() => {
			const added = result.current.mutations.createSurveyModule({ name: "M1" });
			assert(added.ok);
			secondUuid = added.uuid;
		});

		act(() => {
			result.current.mutations.removeModule(secondUuid);
		});

		const s = result.current.store?.getState();
		expect(s?.modules[secondUuid]).toBeUndefined();
		expect(s?.moduleOrder).not.toContain(secondUuid);
	});

	it("removeModule of the app's ONLY module is rejected — it would re-introduce NO_MODULES", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		let moduleUuid: Uuid = "" as Uuid;
		let outcome: { ok: boolean } = { ok: true };
		act(() => {
			const firstUuid = result.current.store?.getState().moduleOrder[0];
			if (!firstUuid) return;
			moduleUuid = firstUuid;
			outcome = result.current.mutations.removeModule(moduleUuid);
		});

		expect(outcome.ok).toBe(false);
		const s = result.current.store?.getState();
		expect(s?.modules[moduleUuid]).toBeDefined();
	});

	// ── Granular case-type catalog ────────────────────────────────────────

	it("commitMany creates and retires catalog records without a whole-catalog setter", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.commitMany([
				{ kind: "declareCaseType", caseType: "patient" },
				{ kind: "declareCaseType", caseType: "visit" },
			]);
		});

		const s = result.current.store?.getState();
		expect(s?.caseTypes).toEqual([
			{ name: "patient", properties: [] },
			{ name: "visit", properties: [] },
		]);
		act(() => {
			result.current.mutations.commitMany([
				{ kind: "retireCaseType", caseType: "patient" },
				{ kind: "retireCaseType", caseType: "visit" },
			]);
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
			result.current.mutations.commitMany([
				{
					kind: "declareCaseType",
					caseType: "person",
				},
				{
					kind: "addCaseProperty",
					caseType: "person",
					property: {
						name: "dob",
						label: proseText("Date of Birth"),
						data_type: "text",
					},
				},
				{
					kind: "addCaseProperty",
					caseType: "person",
					property: { name: "age", label: proseText("Age"), data_type: "int" },
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
			result.current.mutations.commitMany([
				{
					kind: "declareCaseType",
					caseType: "person",
				},
				{
					kind: "addCaseProperty",
					caseType: "person",
					property: {
						name: "dob",
						label: proseText("DOB"),
						data_type: "text",
					},
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
				properties: [
					{ name: "dob", label: proseText("DOB"), data_type: "text" },
				],
			},
		]);
	});

	it("updateCaseProperty on a non-existent property is a silent no-op", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.commitMany([
				{
					kind: "declareCaseType",
					caseType: "person",
				},
				{
					kind: "addCaseProperty",
					caseType: "person",
					property: {
						name: "dob",
						label: proseText("DOB"),
						data_type: "text",
					},
				},
			]);
		});

		// Should not throw even though "nonexistent" doesn't exist.
		expect(() => {
			act(() => {
				result.current.mutations.updateCaseProperty("person", "nonexistent", {
					label: proseText("Nope"),
				});
			});
		}).not.toThrow();

		// Case types should be unchanged.
		const s = result.current.store?.getState();
		expect(s?.caseTypes).toEqual([
			{
				name: "person",
				properties: [
					{ name: "dob", label: proseText("DOB"), data_type: "text" },
				],
			},
		]);
	});

	// ── applyMany ─────────────────────────────────────────────────────────

	it("applyMany collapses two mutations into a single undo entry", () => {
		const { result } = renderHook(() => useMutationsWithStore(), { wrapper });

		act(() => {
			result.current.store?.getState().startTracking();
		});

		act(() => {
			/* `null` keeps the batch introduction-free — flipping Connect ON
			 * would rightly bounce on the fixture's block-less forms. */
			result.current.mutations.applyMany([
				{ kind: "setAppName", name: "Batched" },
				{ kind: "setConnectType", connectType: null },
			]);
		});

		const s = result.current.store?.getState();
		expect(s?.appName).toBe("Batched");
		expect(s?.connectType).toBeNull();

		// ONE step, despite two mutations dispatching.
		act(() => {
			result.current.store?.getState().undo();
		});
		expect(result.current.store?.getState().appName).not.toBe("Batched");
		expect(result.current.store?.getState().canUndo).toBe(false);
	});

	// ── moveField collision admission ───────────────────────────────────

	it("moveField rejects a destination sibling-id collision without renaming", () => {
		// Use the fixture that has form F0 with [a, b, grp > [c]].
		// Add a field with id "a" inside the group, then move Q_A into the
		// group. The move preserves local field id, so admission rejects the
		// collision instead of inventing a new id.
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		// Seed a field inside the group with id "a" to force dedup.
		act(() => {
			result.current.mutations.addField(Q_G, {
				id: "a",
				kind: "text",
				label: proseText("duplicate-a"),
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
		expect(captured.value?.ok).toBe(false);
		expect(result.current.store?.getState().fields[Q_A].id).toBe("a");
		expect(result.current.store?.getState().fieldParent[Q_A]).toBe(FORM1);
	});

	// ── moveField — extra options ─────────────────────────────────────────

	it("moveField with beforeUuid reorders within the same parent", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Move `b` to before `a`. Same-parent: result should be [b, a, grp].
		act(() => {
			result.current.mutations.moveField(Q_B, { beforeUuid: Q_A });
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	it("moveField with toIndex reorders to the specified slot", () => {
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
			// Snapshot the pre-dispatch kind and pin the fixture invariant so
			// a future fixture drift (e.g. Q_A seeded as `"secret"`) can't mask
			// a no-op short-circuit inside the reducer — `convertField` returns
			// early when source kind already equals target kind.
			const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
				wrapper,
			});

			const before = result.current.store?.getState().fields[Q_A]?.kind;
			// Pin the fixture invariant — if this fails the test below doesn't
			// prove anything meaningful about the dispatch.
			expect(before).toBe("text");

			act(() => {
				result.current.mutations.convertField(Q_A, "secret" as FieldKind);
			});

			const after = result.current.store?.getState().fields[Q_A]?.kind;
			expect(after).toBe("secret");
			// Guard against the reducer no-op path masking a successful dispatch —
			// the kind MUST have changed, not merely equal the target by accident.
			expect(after).not.toBe(before);

			// The field's semantic id should be preserved across the kind swap.
			const converted = result.current.store?.getState().fields[Q_A];
			expect(converted?.id).toBe("a");
		});

		it("seeds the starter option pair on text → single_select", () => {
			// The select schemas require `.min(2)` options the text source
			// can't carry, and the convert menu has no option-authoring step —
			// the hook attaches the same starter pair a picker-inserted select
			// gets, fully minted (uuid + order) at dispatch so the reducer
			// never invents identity.
			const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
				wrapper,
			});

			expect(result.current.store?.getState().fields[Q_A]?.kind).toBe("text");

			act(() => {
				result.current.mutations.convertField(
					Q_A,
					"single_select" as FieldKind,
				);
			});

			const converted = result.current.store?.getState().fields[Q_A];
			expect(converted?.kind).toBe("single_select");
			const options =
				converted?.kind === "single_select" &&
				converted.optionsSource.kind === "inline"
					? converted.optionsSource.options
					: [];
			expect(options.map((o) => o.value)).toEqual(["option_1", "option_2"]);
			for (const opt of options) {
				expect(opt.uuid).toBeTruthy();
			}
		});

		it("seeds the picker's inert default on text → hidden with no value source", () => {
			// HIDDEN_NO_VALUE would reject a bare convert; the gesture seeds
			// the same `''` default a picker-inserted hidden is born with (in
			// the SAME gated batch), so every offered target lands and the
			// user authors the real calculate in the inspector afterwards.
			const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
				wrapper,
			});

			act(() => {
				result.current.mutations.convertField(Q_A, "hidden" as FieldKind);
			});

			const converted = result.current.store?.getState().fields[Q_A];
			expect(converted?.kind).toBe("hidden");
			expect(
				converted && "default_value" in converted
					? converted.default_value
					: undefined,
			).toEqual({ parts: [{ kind: "text", text: "''" }] });
			expect(
				converted && "label" in converted ? converted.label : undefined,
			).toBeUndefined();
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
			// unchanged — matches the fail-open contract the other mutation
			// methods follow. The hook also promises a `console.warn` on
			// every unresolved uuid (`console`, NOT the structured logger:
			// this hook is client-only and the logger's production path
			// throws in the browser). That warning is the ONLY observability
			// the fail-open contract offers, so we spy on it here to lock
			// the contract against a future refactor dropping the
			// `warnUnresolved` call.
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
				wrapper,
			});

			const before = result.current.store?.getState().fields[Q_A]?.kind;

			expect(() => {
				act(() => {
					result.current.mutations.convertField(
						testUuid("bogus-uuid-convert"),
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

			// Lock the fail-open contract: the warn must fire and include both
			// `uuid` and `toKind` so a dev debugging a silent no-op can tell
			// which call site produced it.
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(
					"[useBlueprintMutations.convertField] unresolved uuid",
				),
				expect.objectContaining({
					uuid: testUuid("bogus-uuid-convert"),
					toKind: "secret",
				}),
			);
			warn.mockRestore();
		});
	});

	// ── Unresolved uuid no-op ─────────────────────────────────────────────

	it("unresolved uuid silently no-ops (no throw)", () => {
		// Every unresolved dispatch console.warns; silence the expected
		// noise while keeping the no-throw + unchanged-store assertions.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		expect(() => {
			act(() => {
				// Bogus uuids should all silently no-op.
				result.current.mutations.updateField(testUuid("bogus-uuid"), "text", {
					label: proseText("x"),
				});
				result.current.mutations.removeField(testUuid("bogus-uuid"));
				result.current.mutations.renameField(
					testUuid("bogus-uuid"),
					"also_nope",
				);
				result.current.mutations.moveField(testUuid("bogus-uuid"), {});
				result.current.mutations.duplicateField(testUuid("bogus-uuid"));
				result.current.mutations.addField(testUuid("bogus-parent"), {
					id: "should_not_exist",
					kind: "text",
					label: proseText("Nope"),
				});
				result.current.mutations.updateForm(testUuid("bogus-uuid"), {
					name: "nope",
				});
				result.current.mutations.removeForm(testUuid("bogus-uuid"));
				result.current.mutations.updateModule(testUuid("bogus-uuid"), {
					name: "nope",
				});
				result.current.mutations.removeModule(testUuid("bogus-uuid"));
				result.current.mutations.addForm(testUuid("bogus-module"), {
					uuid: "form-6-uuid",
					id: "nope",
					name: "nope",
					type: "survey",
				});
			});
		}).not.toThrow();
		warn.mockRestore();

		// Store should be unchanged.
		expect(result.current.children.map((q) => q.id)).toEqual(["a", "b", "grp"]);
	});
});

// ── Commit gate (complete phase) ──────────────────────────────────────────
//
// The dedicated gating coverage. The
// verdict semantics themselves are pinned in
// `lib/doc/__tests__/commitVerdicts.test.ts`; what must hold HERE is the
// hook wiring — a rejected dispatch never reaches the store, the method
// returns its no-op shape, and the rejection surfaces as an error toast.

describe("useBlueprintMutations — commit gate", () => {
	it("rejects an edit whose complete candidate has a finding: store untouched, no-op return, error toast", () => {
		toastStore.clear();
		const { result } = renderHook(() => useMutationsWithStore(), {
			wrapper: wrapper,
		});

		let returned = { ok: true, uuid: "unset" as Uuid } as AddCommitOutcome;
		act(() => {
			const s = result.current.store?.getState();
			assert(s);
			// The resulting candidate has an empty survey form, so the absolute
			// gate rejects its EMPTY_FORM finding.
			returned = result.current.mutations.addForm(s.moduleOrder[0], {
				uuid: testUuid("form-gated-uuid"),
				id: "gated",
				name: "Gated",
				type: "survey",
			});
		});

		// The rejection is honest — no fabricated uuid, the findings ride
		// along for inline display.
		assert(!returned.ok);
		expect(returned.messages[0]).toContain("doesn't have any fields");
		const s = result.current.store?.getState();
		expect(s?.forms[testUuid("form-gated-uuid")]).toBeUndefined();
		// The rejection surfaced person-to-person, not silently — each
		// finding rides the toast's structured lines.
		const toast = toastStore.toasts.at(-1);
		expect(toast?.severity).toBe("error");
		expect(toast?.title).toBe("Change not applied");
		expect(toast?.lines?.[0]).toContain("doesn't have any fields");
		toastStore.clear();
	});

	it("inline flavor: same rejection, same no-op return, NO toast (the caller presents it)", () => {
		toastStore.clear();
		const { result } = renderHook(() => useMutationsWithStore(), {
			wrapper: wrapper,
		});

		let returned = { ok: true, uuid: "unset" as Uuid } as AddCommitOutcome;
		act(() => {
			const s = result.current.store?.getState();
			assert(s);
			returned = result.current.mutations.inline.addForm(s.moduleOrder[0], {
				uuid: testUuid("form-gated-inline-uuid"),
				id: "gated_inline",
				name: "Gated Inline",
				type: "survey",
			});
		});

		// Identical gate semantics — findings returned for the caller's
		// contextual surface…
		assert(!returned.ok);
		expect(returned.messages[0]).toContain("doesn't have any fields");
		const s = result.current.store?.getState();
		expect(s?.forms[testUuid("form-gated-inline-uuid")]).toBeUndefined();
		// …and the toast stays quiet: one rejection, one presentation.
		expect(toastStore.toasts).toHaveLength(0);
	});

	it("reviews the exact candidate without committing it", () => {
		toastStore.clear();
		const { result } = renderHook(() => useMutationsWithStore(), {
			wrapper,
		});
		const formUuid = testUuid("form-reviewed-without-commit");

		const state = result.current.store?.getState();
		assert(state);
		const outcome = result.current.mutations.inline.reviewMany([
			{
				kind: "addForm",
				moduleUuid: state.moduleOrder[0],
				form: {
					uuid: formUuid,
					id: "reviewed",
					name: "Reviewed",
					type: "survey",
				},
				after: null,
			},
		]);

		assert(!outcome.ok);
		expect(outcome.messages[0]).toContain("doesn't have any fields");
		expect(outcome.findings?.[0]).toMatchObject({
			code: "EMPTY_FORM",
			scope: "form",
			location: { formUuid },
		});
		expect(result.current.store?.getState().forms[formUuid]).toBeUndefined();
		expect(toastStore.toasts).toHaveLength(0);
	});

	it("returns a passing review without changing the live document", () => {
		const { result } = renderHook(() => useMutationsWithStore(), {
			wrapper,
		});

		const outcome = result.current.mutations.inline.reviewMany([
			{ kind: "setAppName", name: "Reviewed name" },
		]);

		expect(outcome).toEqual({ ok: true });
		expect(result.current.store?.getState().appName).toBe("Test");
	});

	it("dispatches a clean edit unchanged (the gate is transparent on pass)", () => {
		toastStore.clear();
		const { result } = renderHook(() => useMutationsWithStore(), {
			wrapper: wrapper,
		});

		act(() => {
			const s = result.current.store?.getState();
			assert(s);
			result.current.mutations.updateModule(s.moduleOrder[0], {
				name: "Renamed Module",
			});
		});

		const s = result.current.store?.getState();
		assert(s);
		expect(s.modules[s.moduleOrder[0]]?.name).toBe("Renamed Module");
		expect(toastStore.toasts).toHaveLength(0);
	});

	it("retains structured automation findings for an inline gate refusal", () => {
		const automationUuid = testUuid("hook-gate-automation");
		const updateUuid = testUuid("hook-gate-update");
		const automation: Automation = {
			uuid: automationUuid,
			kind: "case-update",
			name: "Existing rule",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: updateUuid,
					target: { scope: "case", property: "state" },
					value: { kind: "literal", value: "resolved" },
				},
			],
			closeCase: false,
		};
		const automationDoc: BlueprintDoc = {
			...bp,
			caseTypes: [
				{
					name: "visit",
					properties: [
						{
							name: "state",
							label: proseText("State"),
							data_type: "text",
						},
					],
				},
			],
			automations: { [automationUuid]: automation },
			automationOrder: [automationUuid],
		};
		function automationWrapper({ children }: { children: ReactNode }) {
			return (
				<BlueprintDocProvider appId="t" initialDoc={automationDoc}>
					{children}
				</BlueprintDocProvider>
			);
		}
		const { result } = renderHook(
			() => ({
				mutations: useBlueprintMutations(),
				store: useContext(BlueprintDocContext),
			}),
			{ wrapper: automationWrapper },
		);
		const duplicateUuid = testUuid("hook-gate-automation-duplicate");
		let outcome!: ReturnType<
			typeof result.current.mutations.inline.addAutomation
		>;
		act(() => {
			outcome = result.current.mutations.inline.addAutomation({
				...automation,
				uuid: duplicateUuid,
				updates: [
					{
						...automation.updates[0],
						uuid: testUuid("hook-gate-update-duplicate"),
					},
				],
			});
		});

		assert(!outcome.ok);
		expect(outcome.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "AUTOMATION_INVALID",
					details: { automationUuid: duplicateUuid, path: "name" },
				}),
			]),
		);
		expect(
			result.current.store?.getState().automations?.[duplicateUuid],
		).toBeUndefined();
	});

	it("atomically refuses stale full automation replacement and removal", () => {
		const automationUuid = testUuid("hook-automation");
		const updateUuid = testUuid("hook-automation-update");
		const automation: Automation = {
			uuid: automationUuid,
			kind: "case-update",
			name: "Original rule",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: updateUuid,
					target: { scope: "case", property: "state" },
					value: { kind: "literal", value: "resolved" },
				},
			],
			closeCase: false,
		};
		const automationDoc: BlueprintDoc = {
			...bp,
			caseTypes: [
				{
					name: "visit",
					properties: [
						{
							name: "state",
							label: proseText("State"),
							data_type: "text",
						},
					],
				},
			],
			automations: { [automationUuid]: automation },
			automationOrder: [automationUuid],
		};
		function automationWrapper({ children }: { children: ReactNode }) {
			return (
				<BlueprintDocProvider appId="t" initialDoc={automationDoc}>
					{children}
				</BlueprintDocProvider>
			);
		}
		const { result } = renderHook(
			() => ({
				mutations: useBlueprintMutations(),
				store: useContext(BlueprintDocContext),
			}),
			{ wrapper: automationWrapper },
		);
		const openedFingerprint = JSON.stringify(automation);

		act(() => {
			result.current.mutations.updateAutomation({
				uuid: automationUuid,
				targetKind: "case-update",
				patch: { name: "Peer rename" },
			});
		});
		let replaceOutcome!: ReturnType<
			typeof result.current.mutations.replaceAutomation
		>;
		let removeOutcome!: ReturnType<
			typeof result.current.mutations.removeAutomation
		>;
		act(() => {
			replaceOutcome = result.current.mutations.replaceAutomation(
				{ ...automation, name: "My rename" },
				openedFingerprint,
			);
			removeOutcome = result.current.mutations.removeAutomation(
				automationUuid,
				openedFingerprint,
			);
		});

		expect(replaceOutcome).toMatchObject({
			ok: false,
			messages: [expect.stringContaining("changed while you were editing")],
		});
		expect(removeOutcome).toMatchObject({
			ok: false,
			messages: [expect.stringContaining("changed while you were editing")],
		});
		expect(
			result.current.store?.getState().automations?.[automationUuid]?.name,
		).toBe("Peer rename");
	});

	it("captures the current automation kind in a successful Builder removal", () => {
		const automationUuid = testUuid("hook-remove-automation");
		const automation: Automation = {
			uuid: automationUuid,
			kind: "case-update",
			name: "Remove this rule",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: testUuid("hook-remove-automation-update"),
					target: { scope: "case", property: "state" },
					value: { kind: "literal", value: "resolved" },
				},
			],
			closeCase: false,
		};
		const automationDoc: BlueprintDoc = {
			...bp,
			caseTypes: [
				{
					name: "visit",
					properties: [
						{
							name: "state",
							label: proseText("State"),
							data_type: "text",
						},
					],
				},
			],
			automations: { [automationUuid]: automation },
			automationOrder: [automationUuid],
		};
		function automationWrapper({ children }: { children: ReactNode }) {
			return (
				<BlueprintDocProvider appId="t" initialDoc={automationDoc}>
					{children}
				</BlueprintDocProvider>
			);
		}
		const { result } = renderHook(
			() => ({
				mutations: useBlueprintMutations(),
				store: useContext(BlueprintDocContext),
			}),
			{ wrapper: automationWrapper },
		);

		act(() => {
			result.current.mutations.removeAutomation(
				automationUuid,
				JSON.stringify(automation),
			);
		});

		expect(result.current.store?.getState().automations).toBeUndefined();
		expect(result.current.store?.getState().takeCommandBatches()).toEqual([
			[
				{
					kind: "removeAutomation",
					uuid: automationUuid,
					targetKind: "case-update",
				},
			],
		]);
	});
});
