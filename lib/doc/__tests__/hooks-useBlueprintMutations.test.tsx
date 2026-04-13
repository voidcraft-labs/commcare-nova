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
import { describe, expect, it } from "vitest";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useOrderedForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useOrderedChildren } from "@/lib/doc/hooks/useOrderedChildren";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

// Minimal fixture: one module, one form, two top-level questions. The
// tests cover rename / update / remove at the top level — group/repeat
// nesting is tested in the mutation reducer suite; this file only needs
// to prove the hook's uuid-resolution + dispatch path works end-to-end.
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
 * Compose the mutation surface with the ordered-children read in a single
 * hook so one `renderHook` subscribes both sides to the same store
 * instance. `result.current.children` stays live — post-`act()` re-renders
 * refresh it in place.
 */
function useMutationsAndFirstFormChildren() {
	const mutations = useBlueprintMutations();
	const modules = useOrderedModules();
	const forms = useOrderedForms((modules[0]?.uuid ?? "") as Uuid);
	const children = useOrderedChildren((forms[0]?.uuid ?? "") as Uuid);
	return { mutations, children };
}

/** Composer for the app-level assertion — mutations + app name read. */
function useMutationsAndAppName() {
	const mutations = useBlueprintMutations();
	const appName = useBlueprintDoc((s) => s.appName);
	return { mutations, appName };
}

describe("useBlueprintMutations", () => {
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

		expect(result.current.children.map((q) => q.id)).toEqual(["a"]);
	});

	it("updateApp changes app-level fields", () => {
		const { result } = renderHook(() => useMutationsAndAppName(), { wrapper });

		act(() => {
			result.current.mutations.updateApp({ app_name: "New" });
		});

		expect(result.current.appName).toBe("New");
	});
});
