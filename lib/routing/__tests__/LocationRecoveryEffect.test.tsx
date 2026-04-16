// @vitest-environment happy-dom

/**
 * Tests for the `LocationRecoveryEffect` component — verifies the
 * client-side URL scrubber replaces the URL whenever the current
 * location references a doc entity that no longer exists.
 *
 * With path-based URLs, stale UUID cleanup happens at two layers:
 * 1. `parsePathToLocation` degrades unresolvable UUIDs at parse time
 *    (e.g. deleted form UUID → home).
 * 2. `LocationRecoveryEffect` detects the mismatch between the parsed
 *    location's canonical path and the actual URL segments, then issues
 *    `replaceState` to fix the URL.
 */

import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
import { toDoc } from "@/lib/doc/converter";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";

const replaceStateSpy = vi.spyOn(window.history, "replaceState");
const pathname = "/build/app-1";

/* Mock the client path hook — segments control the current location. */
const mockSegments = { current: [] as string[] };
vi.mock("@/lib/routing/useClientPath", () => ({
	useBuilderPathSegments: () => mockSegments.current,
	notifyPathChange: vi.fn(),
}));

vi.mock("next/navigation", async () => {
	const actual =
		await vi.importActual<typeof import("next/navigation")>("next/navigation");
	return {
		...actual,
		usePathname: () => pathname,
		useRouter: () => ({
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
	};
});

/* Stub EditGuardContext — needed by useSelect in the hooks module. */
vi.mock("@/components/builder/contexts/EditGuardContext", () => ({
	useConsultEditGuard: () => () => true,
}));

/*
 * Fixture: one module, one form, two questions.
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
	/* Convert the legacy nested AppBlueprint fixture to a normalized
	 * PersistableDoc before loading — load() no longer accepts the
	 * nested format directly. */
	store.getState().load(toDoc(BP, "app-1"));
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
		replaceStateSpy.mockClear();
		mockSegments.current = [];
	});

	it("no-op when URL is already valid (form + valid selection)", () => {
		const store = makeStore();
		/* Flat URL: single question UUID — parser derives the parent form. */
		mockSegments.current = ["q-a-0000-0000-0000-000000000000"];

		renderEffect(store);

		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it("no-op on home URL with empty doc", () => {
		const store = createBlueprintDocStore();
		mockSegments.current = [];

		renderEffect(store);

		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it("strips stale selectedUuid and keeps the form", async () => {
		const store = makeStore();
		const state = store.getState();
		const formUuid = state.formOrder[state.moduleOrder[0]][0];
		/* The second segment is a stale question UUID. The parser degrades
		 * to form-without-selection; the effect detects the URL mismatch
		 * and replaces the path with the canonical form URL. */
		mockSegments.current = [formUuid, "does-not-exist"];

		renderEffect(store);

		await waitFor(() => {
			expect(replaceStateSpy).toHaveBeenCalledWith(
				null,
				"",
				`${pathname}/${formUuid}`,
			);
		});
	});

	it("strips stale form UUID and lands on home", async () => {
		const store = makeStore();
		/* A form UUID that doesn't exist in the doc. The parser can't
		 * resolve it, so it returns home. The effect detects the URL
		 * mismatch (segments = ["missing-form-uuid"], canonical = [])
		 * and replaces with the home URL. */
		mockSegments.current = ["missing-form-uuid"];

		renderEffect(store);

		await waitFor(() => {
			expect(replaceStateSpy).toHaveBeenCalledWith(null, "", pathname);
		});
	});

	it("strips stale module UUID and lands on home", async () => {
		const store = makeStore();
		/* A module UUID that doesn't exist in the doc. Same as above:
		 * parser returns home, effect fixes the URL. */
		mockSegments.current = ["missing-module-uuid"];

		renderEffect(store);

		await waitFor(() => {
			expect(replaceStateSpy).toHaveBeenCalledWith(null, "", pathname);
		});
	});

	it("redirects to home after every module is deleted mid-session", async () => {
		const store = makeStore();
		const initial = store.getState();
		const moduleUuid = initial.moduleOrder[0];
		const formUuid = initial.formOrder[moduleUuid][0];
		mockSegments.current = [formUuid];

		const { rerender } = renderEffect(store);
		// Initial URL is valid → no redirect yet.
		expect(replaceStateSpy).not.toHaveBeenCalled();

		// Delete the entire module. The reducer cascade drops all forms
		// and questions with it.
		act(() => {
			store
				.getState()
				.apply({ kind: "removeModule", uuid: asUuid(moduleUuid) });
		});

		/* Force rerender with the updated store. */
		rerender(
			<BlueprintDocContext.Provider value={store}>
				<LocationRecoveryEffect />
			</BlueprintDocContext.Provider>,
		);

		/* The form UUID no longer exists → parser returns home. But the
		 * URL segments still show [formUuid], so the effect detects the
		 * mismatch and replaces with the home URL. */
		await waitFor(() => {
			expect(replaceStateSpy).toHaveBeenCalledWith(null, "", pathname);
		});
	});
});
