// @vitest-environment happy-dom

/**
 * Tests for the `LocationRecoveryEffect` component — verifies the
 * client-side URL scrubber replaces the router URL whenever the current
 * location references a doc entity that no longer exists.
 *
 * Empty-doc regression
 * --------------------
 * An earlier version of the effect short-circuited when all three entity
 * maps were empty, to avoid firing during hydration. That guard also
 * swallowed the "user deleted every module mid-session" case — the URL
 * still pointed at dead uuids, but the effect declined to fix it.
 * This file locks in the fix: an empty doc must still trigger recovery
 * for a non-home URL, and must still no-op for a home URL.
 */

import { render, waitFor } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";

const routerReplace = vi.fn();
const mockParams = { current: new URLSearchParams() };
const pathname = "/build/app-1";

vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		useSearchParams: () => new ReadonlyURLSearchParams(mockParams.current),
		useRouter: () => ({
			push: vi.fn(),
			replace: routerReplace,
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
		usePathname: () => pathname,
	};
});

/*
 * Fixture: one module, one form, two questions. Enough to exercise
 * all recovery branches: stale selectedUuid, stale form, stale module,
 * and the delete-everything scenario.
 */
const BP = {
	app_name: "T",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			uuid: "module-1-uuid",
			name: "M",
			case_type: undefined,
			forms: [
				{
					uuid: "form-1-uuid",
					name: "F",
					type: "survey" as const,
					questions: [
						{
							uuid: "q-a-0000-0000-0000-000000000000",
							id: "a",
							type: "text" as const,
							label: "A",
						},
						{
							uuid: "q-b-0000-0000-0000-000000000000",
							id: "b",
							type: "text" as const,
							label: "B",
						},
					],
				},
			],
		},
	],
};

function makeStore() {
	const store = createBlueprintDocStore();
	store.getState().load(BP, "app-1");
	store.temporal.getState().resume();
	return store;
}

function renderEffect(store: ReturnType<typeof makeStore>) {
	return render(
		<BlueprintDocContext.Provider value={store}>
			<LocationRecoveryEffect />
		</BlueprintDocContext.Provider>,
	);
}

describe("LocationRecoveryEffect", () => {
	beforeEach(() => {
		routerReplace.mockReset();
		mockParams.current = new URLSearchParams();
	});

	it("no-op when URL is already valid (form + valid selection)", () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		mockParams.current = new URLSearchParams(
			`s=f&m=${moduleUuid}&f=${formUuid}&sel=q-a-0000-0000-0000-000000000000`,
		);

		renderEffect(store);

		expect(routerReplace).not.toHaveBeenCalled();
	});

	it("no-op on home URL with empty doc", () => {
		/* The empty-doc + home URL combination must not call
		 * router.replace — the location is already as-shallow-as-
		 * possible, and the effect's identity short-circuit should
		 * bail without touching the router. */
		const store = createBlueprintDocStore();
		mockParams.current = new URLSearchParams();

		renderEffect(store);

		expect(routerReplace).not.toHaveBeenCalled();
	});

	it("strips stale selectedUuid and keeps the form", async () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		const formUuid = state.formOrder[moduleUuid][0];
		mockParams.current = new URLSearchParams(
			`s=f&m=${moduleUuid}&f=${formUuid}&sel=does-not-exist`,
		);

		renderEffect(store);

		await waitFor(() => {
			expect(routerReplace).toHaveBeenCalledWith(
				`${pathname}?s=f&m=${moduleUuid}&f=${formUuid}`,
				{ scroll: false },
			);
		});
	});

	it("strips stale form and lands on the module", async () => {
		const store = makeStore();
		const state = store.getState();
		const moduleUuid = state.moduleOrder[0];
		mockParams.current = new URLSearchParams(
			`s=f&m=${moduleUuid}&f=missing-form-uuid`,
		);

		renderEffect(store);

		await waitFor(() => {
			expect(routerReplace).toHaveBeenCalledWith(
				`${pathname}?s=m&m=${moduleUuid}`,
				{ scroll: false },
			);
		});
	});

	it("strips stale module and lands on home", async () => {
		const store = makeStore();
		mockParams.current = new URLSearchParams("s=m&m=missing-module-uuid");

		renderEffect(store);

		await waitFor(() => {
			// Home URL = no query params → pathname alone.
			expect(routerReplace).toHaveBeenCalledWith(pathname, { scroll: false });
		});
	});

	it("redirects to home after every module is deleted mid-session", async () => {
		/* The Phase 2 Fix #5 regression: an earlier version of the effect
		 * skipped recovery when all entity maps were empty, so the user
		 * was left on a dead URL when they wiped the whole app. Fix
		 * dropped that guard — this test locks it in. */
		const store = makeStore();
		const initial = store.getState();
		const moduleUuid = initial.moduleOrder[0];
		const formUuid = initial.formOrder[moduleUuid][0];
		mockParams.current = new URLSearchParams(
			`s=f&m=${moduleUuid}&f=${formUuid}`,
		);

		const { rerender } = renderEffect(store);
		// Initial URL is valid → no redirect yet.
		expect(routerReplace).not.toHaveBeenCalled();

		// Delete the entire module. The reducer cascade drops all forms
		// and questions with it, so every entity map becomes empty.
		act(() => {
			store
				.getState()
				.apply({ kind: "removeModule", uuid: asUuid(moduleUuid) });
		});
		// Rerender so the effect's `useBlueprintDoc` subscriptions refire.
		rerender(
			<BlueprintDocContext.Provider value={store}>
				<LocationRecoveryEffect />
			</BlueprintDocContext.Provider>,
		);

		await waitFor(() => {
			// With the module gone, the form URL collapses straight to home.
			expect(routerReplace).toHaveBeenCalledWith(pathname, { scroll: false });
		});
	});
});
