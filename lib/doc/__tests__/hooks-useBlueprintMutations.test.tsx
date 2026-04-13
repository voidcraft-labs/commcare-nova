// @vitest-environment happy-dom

/**
 * Tests for the user-facing mutation hook `useBlueprintMutations`.
 *
 * The hook translates legacy (mIdx, fIdx, path) coordinates into uuid-keyed
 * `Mutation` dispatches so Phase 1b call sites can migrate with a near
 * drop-in rename. Each test exercises one representative mutation and
 * verifies the doc state was updated by reading through a reactive hook.
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
import { BlueprintDocContext, BlueprintDocProvider } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import type { AppBlueprint, Question } from "@/lib/schemas/blueprint";

// Minimal fixture: one module, one form, two top-level questions plus a
// group with a single child. The tests cover top-level mutations AND
// nested (group-child) paths so the resolver behavior is exercised end
// to end. Group/repeat nesting semantics themselves are tested in the
// mutation reducer suite; this file only needs to prove the hook's
// uuid-resolution + dispatch path works for both depths.
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
 */
function useMutationsAndFirstFormChildren() {
	const mutations = useBlueprintMutations();
	const modules = useOrderedModules();
	const forms = useOrderedForms((modules[0]?.uuid ?? "") as Uuid);
	const children = useOrderedChildren((forms[0]?.uuid ?? "") as Uuid);
	const firstForm = forms[0];
	return { mutations, children, firstForm };
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
	return { mutations, topLevel, groupChildren };
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

describe("useBlueprintMutations", () => {
	// ── Pre-existing coverage ──────────────────────────────────────────────

	it("updateQuestion edits fields via (mIdx, fIdx, path)", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.updateQuestion(0, 0, "a", { label: "Renamed" });
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
			result.current.mutations.renameQuestion(0, 0, "a", "alpha");
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
			result.current.mutations.removeQuestion(0, 0, "b");
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

		let returned = "";
		act(() => {
			returned = result.current.mutations.addQuestion(0, 0, {
				// Legacy callers pass a `NewQuestion`-ish shape without `uuid`;
				// the hook mints one and returns it.
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

	it("addQuestion with parentPath inserts into a group", () => {
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.addQuestion(
				0,
				0,
				{
					id: "c2",
					type: "text",
					label: "C2",
				} as unknown as Question,
				{ parentPath: "grp" },
			);
		});

		expect(result.current.groupChildren.map((q) => q.id)).toEqual(["c", "c2"]);
	});

	it("addQuestion with afterPath/beforePath positions correctly", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Insert between `a` and `b` via `afterPath`.
		act(() => {
			result.current.mutations.addQuestion(
				0,
				0,
				{ id: "a2", type: "text", label: "A2" } as unknown as Question,
				{ afterPath: "a" },
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
			result.current.mutations.addQuestion(
				0,
				0,
				{ id: "a3", type: "text", label: "A3" } as unknown as Question,
				{ beforePath: "b" },
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

	it("moveQuestion with afterPath reorders within the same parent", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		// Move `a` to after `b`. Result should be [b, a, grp].
		act(() => {
			result.current.mutations.moveQuestion(0, 0, "a", { afterPath: "b" });
		});

		expect(result.current.children.map((q) => q.id)).toEqual(["b", "a", "grp"]);
	});

	it("moveQuestion with targetParentPath crosses parents", () => {
		const { result } = renderHook(() => useMutationsFormsAndGroupChildren(), {
			wrapper,
		});

		// Move `a` from the form root into the group.
		act(() => {
			result.current.mutations.moveQuestion(0, 0, "a", {
				targetParentPath: "grp",
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
			dup = result.current.mutations.duplicateQuestion(0, 0, "a");
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

		// Attempt to rename `a` → `b`, which already exists. The result is
		// wrapped in a container so we can inspect it after `act()` without
		// tripping the "definitely assigned" check on a narrowed `let`.
		const captured: {
			value?: ReturnType<typeof result.current.mutations.renameQuestion>;
		} = {};
		act(() => {
			captured.value = result.current.mutations.renameQuestion(0, 0, "a", "b");
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

		// Exactly ONE new undo entry should have been added — the prior
		// implementation produced two because it dispatched `setAppName` and
		// `setConnectType` as separate `apply()` calls.
		expect(after - before).toBe(1);
	});

	// ── replaceForm ───────────────────────────────────────────────────────

	it("replaceForm wholesale-swaps a form's questions", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		act(() => {
			result.current.mutations.replaceForm(0, 0, {
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

	// ── Unresolved path no-op ─────────────────────────────────────────────

	it("unresolved path silently no-ops (no throw)", () => {
		const { result } = renderHook(() => useMutationsAndFirstFormChildren(), {
			wrapper,
		});

		expect(() => {
			act(() => {
				// Out-of-range indices and bogus paths should all silently no-op.
				result.current.mutations.updateQuestion(99, 99, "missing", {
					label: "x",
				});
				result.current.mutations.removeQuestion(0, 0, "does/not/exist");
				result.current.mutations.renameQuestion(0, 0, "nope", "also_nope");
				result.current.mutations.moveQuestion(0, 0, "nope", {});
				result.current.mutations.duplicateQuestion(0, 0, "nope");
			});
		}).not.toThrow();

		// Store should be unchanged.
		expect(result.current.children.map((q) => q.id)).toEqual(["a", "b", "grp"]);
	});
});
