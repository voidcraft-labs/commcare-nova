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
import { testUuid } from "@/__tests__/helpers/uuid";
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain/prose";

const replaceStateSpy = vi.spyOn(window.history, "replaceState");
const pathname = "/build/app-1";

/* Mock the client path hook — segments control the current location. */
const mockSegments = { current: [] as string[] };
vi.mock("@/lib/routing/useClientPath", async () => {
	const actual = await vi.importActual<
		typeof import("@/lib/routing/useClientPath")
	>("@/lib/routing/useClientPath");
	return {
		...actual,
		pushBuilderHistory: (url: string, replace = false) => {
			if (replace) window.history.replaceState(null, "", url);
			else window.history.pushState(null, "", url);
		},
		getBuilderPathSegmentsSnapshot: () => mockSegments.current,
		useBuilderPathSegments: () => mockSegments.current,
	};
});

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
 * Fixture: one module, one form, two fields.
 */
function makeStore() {
	const store = createBlueprintDocStore();
	store.getState().load(
		buildDoc({
			appId: "app-1",
			appName: "T",
			modules: [
				{
					uuid: "module-1-uuid",
					name: "M",
					caseType: "patient",
					forms: [
						{
							uuid: "form-1-uuid",
							name: "F",
							type: "survey",
							fields: [
								f({
									uuid: "q-a-0000-0000-0000-000000000000",
									kind: "text",
									id: "a",
									label: proseText("A"),
								}),
								f({
									uuid: "q-b-0000-0000-0000-000000000000",
									kind: "text",
									id: "b",
									label: proseText("B"),
								}),
							],
						},
					],
				},
			],
		}),
	);
	store.getState().startTracking();
	return store;
}

function makeNestedStore() {
	const rootUuid = testUuid("root-menu-0000-4000-8000-000000000001");
	const childUuid = testUuid("child-menu-0000-4000-8000-000000000002");
	const doc = buildDoc({
		appId: "app-1",
		appName: "T",
		modules: [
			{
				uuid: rootUuid,
				name: "Care",
				forms: [{ name: "Intake", type: "survey" }],
			},
			{
				uuid: childUuid,
				name: "Visits",
				forms: [{ name: "Follow up", type: "survey" }],
			},
		],
	});
	doc.modules[childUuid].parentModuleUuid = rootUuid;
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.getState().startTracking();
	return { store, rootUuid, childUuid };
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
		/* Flat URL: single field UUID — parser derives the parent form. */
		mockSegments.current = [testUuid("q-a-0000-0000-0000-000000000000")];

		renderEffect(store);

		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it("no-op on home URL with empty doc", () => {
		const store = createBlueprintDocStore();
		mockSegments.current = [];

		renderEffect(store);

		expect(replaceStateSpy).not.toHaveBeenCalled();
	});

	it.each(["cases", "search-config", "detail-config"] as const)(
		"does not parse or redirect the retired /%s authoring token",
		(retiredSegment) => {
			const store = makeStore();
			const moduleUuid = store.getState().moduleOrder[0];
			mockSegments.current = [moduleUuid, retiredSegment];

			renderEffect(store);

			expect(replaceStateSpy).not.toHaveBeenCalled();
		},
	);

	it("strips stale selectedUuid and keeps the form", async () => {
		const store = makeStore();
		const state = store.getState();
		const formUuid = state.formOrder[state.moduleOrder[0]][0];
		/* The second segment is a stale field UUID. The parser degrades
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
		// and fields with it.
		act(() => {
			store
				.getState()
				.applyMany([{ kind: "removeModule", uuid: testUuid(moduleUuid) }]);
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

	it("recovers a remotely deleted submenu to its former parent", async () => {
		const { store, rootUuid, childUuid } = makeNestedStore();
		mockSegments.current = [childUuid];
		const { rerender } = renderEffect(store);
		expect(replaceStateSpy).not.toHaveBeenCalled();

		act(() => {
			store.getState().applyMany([{ kind: "removeModule", uuid: childUuid }]);
		});
		rerender(
			<BlueprintDocContext.Provider value={store}>
				<LocationRecoveryEffect />
			</BlueprintDocContext.Provider>,
		);

		await waitFor(() => {
			expect(replaceStateSpy).toHaveBeenCalledWith(
				null,
				"",
				`${pathname}/${rootUuid}`,
			);
		});
	});
});
