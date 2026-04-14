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
 * chains `useOrderedModules → useOrderedForms → useOrderedChildren`.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useContext } from "react";
import { describe, expect, it } from "vitest";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useOrderedChildren } from "@/lib/doc/hooks/useOrderedChildren";
import {
	BlueprintDocContext,
	BlueprintDocProvider,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { AppBlueprint, Question } from "@/lib/schemas/blueprint";

// Minimal fixture: one module, one form, two top-level questions plus a
// group with a single child. The tests cover top-level mutations AND
// nested (group-child) paths so the resolver behavior is exercised end
// to end. Group/repeat nesting semantics themselves are tested in the
// mutation reducer suite; this file only needs to prove the hook's
// uuid-validation + dispatch path works for both depths.
const bp: AppBlueprint = {
	app_name: "Test",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			name: "M0",
			forms: [
				{
					name: "F0",
					type: "survey",
					questions: [
						{
							uuid: "q-a-0000-0000-0000-000000000000",
							id: "a",
							type: "text",
							label: "A",
						},
						{
							uuid: "q-b-0000-0000-0000-000000000000",
							id: "b",
							type: "text",
							label: "B",
						},
						{
							uuid: "q-g-0000-0000-0000-000000000000",
							id: "grp",
							type: "group",
							label: "Group",
							children: [
								{
									uuid: "q-c-0000-0000-0000-000000000000",
									id: "c",
									type: "text",
									label: "C",
								},
							],
						},
					],
				},
				{
					// Second form so moveQuestion / replaceForm can distinguish
					// same-form from cross-form dispatches.
					name: "F1",
					type: "survey",
					questions: [
						{
							uuid: "q-x-0000-0000-0000-000000000000",
							id: "x",
							type: "text",
							label: "X",
						},
					],
				},
			],
		},
	],
};

/** Well-known question uuids from the fixture, branded for type safety. */
const Q_A = asUuid("q-a-0000-0000-0000-000000000000");
const Q_B = asUuid("q-b-0000-0000-0000-000000000000");
const Q_GRP = asUuid("q-g-0000-0000-0000-000000000000");

function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="t" initialBlueprint={bp}>
			{children}
		</BlueprintDocProvider>
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
	const children = useOrderedChildren((forms[0]?.uuid ?? "") as Uuid);
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
	const topLevel = useOrderedChildren((forms[0]?.uuid ?? "") as Uuid);
	const group = topLevel.find((q) => q.id === "grp");
	const groupChildren = useOrderedChildren((group?.uuid ?? "") as Uuid);
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
	const children = useOrderedChildren((forms[0]?.uuid ?? "") as Uuid);
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
	const s = store!.getState();
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
			result.current.mutations.updateQuestion(Q_A, { label: "Renamed" });
		});

		expect(result.current.children.find((q) => q.id === "a")?.label).toBe(
			"Renamed",
		);
	});

	it("renameQuestion rewrites the id in order", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.renameQuestion(Q_A, "alpha");
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
			result.current.mutations.removeQuestion(Q_B);
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
			returned = result.current.mutations.addQuestion(formUuid, {
				id: "d",
				type: "text",
				label: "D",
			} as unknown as Question);
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
			result.current.mutations.addQuestion(Q_GRP, {
				id: "c2",
				type: "text",
				label: "C2",
			} as unknown as Question);
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
			result.current.mutations.addQuestion(
				formUuid,
				{ id: "a2", type: "text", label: "A2" } as unknown as Question,
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
			result.current.mutations.addQuestion(
				formUuid,
				{ id: "a3", type: "text", label: "A3" } as unknown as Question,
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
			result.current.mutations.moveQuestion(Q_A, { afterUuid: Q_B });
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	it("moveQuestion with toParentUuid crosses parents", () => {
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		// Move `a` from the form root into the group.
		act(() => {
			result.current.mutations.moveQuestion(Q_A, {
				toParentUuid: Q_GRP,
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
			dup = result.current.mutations.duplicateQuestion(Q_A);
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
			value?: ReturnType<typeof result.current.mutations.renameQuestion>;
		} = {};
		act(() => {
			captured.value = result.current.mutations.renameQuestion(Q_A, "b");
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
			result.current.mutations.replaceForm(formUuid, {
				name: "F0",
				type: "survey",
				questions: [
					{
						uuid: "q-z-0000-0000-0000-000000000000",
						id: "z",
						type: "text",
						label: "Z",
					},
					{
						uuid: "q-y-0000-0000-0000-000000000000",
						id: "y",
						type: "text",
						label: "Y",
					},
				],
			});
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
			const s = result.current.store!.getState();
			const moduleUuid = s.moduleOrder[0];
			returned = result.current.mutations.addForm(moduleUuid, {
				name: "F2",
				type: "survey",
				questions: [],
			});
		});

		expect(returned).toMatch(/[0-9a-f-]/);
		// Verify the form was actually added to the store.
		const s = result.current.store!.getState();
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
			returned = result.current.mutations.addModule({ name: "M1", forms: [] });
		});

		expect(returned).toMatch(/[0-9a-f-]/);
		// Verify the module was actually added to the store.
		const s = result.current.store!.getState();
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

	// ── moveQuestion result metadata ─────────────────────────────────────

	it("moveQuestion returns MoveQuestionResult with renamed on cross-parent dedup", () => {
		// Use the fixture that has form F0 with [a, b, grp > [c]].
		// Add a question with id "a" inside the group, then move Q_A into the
		// group — it should dedup to "a_2".
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		// Seed a question inside the group with id "a" to force dedup.
		act(() => {
			result.current.mutations.addQuestion(Q_GRP, {
				id: "a",
				type: "text",
				label: "duplicate-a",
			} as unknown as Question);
		});

		const captured: {
			value?: ReturnType<typeof result.current.mutations.moveQuestion>;
		} = {};
		act(() => {
			captured.value = result.current.mutations.moveQuestion(Q_A, {
				toParentUuid: Q_GRP,
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
		// Use a custom blueprint with xpath refs to get a nonzero count.
		const bpWithRefs: AppBlueprint = {
			app_name: "Refs",
			connect_type: undefined,
			case_types: null,
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							questions: [
								{
									uuid: "q-src-0000-0000-0000-000000000000",
									id: "source",
									type: "text",
									label: "Source",
								},
								{
									uuid: "q-dep-0000-0000-0000-000000000000",
									id: "dep",
									type: "text",
									label: "Dep",
									calculate: "/data/source + 1",
								},
							],
						},
					],
				},
			],
		};
		const refWrapper = ({ children }: { children: ReactNode }) => (
			<BlueprintDocProvider appId="t" initialBlueprint={bpWithRefs}>
				{children}
			</BlueprintDocProvider>
		);

		const { result } = renderHook(() => useBlueprintMutations(), {
			wrapper: refWrapper,
		});

		const captured: {
			value?: ReturnType<typeof result.current.renameQuestion>;
		} = {};
		act(() => {
			captured.value = result.current.renameQuestion(
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
			result.current.mutations.moveQuestion(Q_B, { beforeUuid: Q_A });
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
			result.current.mutations.moveQuestion(Q_A, { toIndex: 1 });
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	// ── Unresolved uuid no-op ─────────────────────────────────────────────

	it("unresolved uuid silently no-ops (no throw)", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		expect(() => {
			act(() => {
				// Bogus uuids should all silently no-op.
				result.current.mutations.updateQuestion(asUuid("bogus-uuid"), {
					label: "x",
				});
				result.current.mutations.removeQuestion(asUuid("bogus-uuid"));
				result.current.mutations.renameQuestion(
					asUuid("bogus-uuid"),
					"also_nope",
				);
				result.current.mutations.moveQuestion(asUuid("bogus-uuid"), {});
				result.current.mutations.duplicateQuestion(asUuid("bogus-uuid"));
				result.current.mutations.addQuestion(asUuid("bogus-parent"), {
					id: "should_not_exist",
					type: "text",
					label: "Nope",
				} as unknown as Question);
				result.current.mutations.updateForm(asUuid("bogus-uuid"), {
					name: "nope",
				});
				result.current.mutations.removeForm(asUuid("bogus-uuid"));
				result.current.mutations.replaceForm(asUuid("bogus-uuid"), {
					name: "nope",
					type: "survey",
					questions: [],
				});
				result.current.mutations.updateModule(asUuid("bogus-uuid"), {
					name: "nope",
				});
				result.current.mutations.removeModule(asUuid("bogus-uuid"));
				result.current.mutations.addForm(asUuid("bogus-module"), {
					name: "nope",
					type: "survey",
					questions: [],
				});
			});
		}).not.toThrow();

		// Store should be unchanged.
		expect(result.current.children.map((q) => q.id)).toEqual(["a", "b", "grp"]);
	});
});
