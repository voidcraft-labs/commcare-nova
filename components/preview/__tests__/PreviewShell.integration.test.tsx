// @vitest-environment happy-dom
//
// components/preview/__tests__/PreviewShell.integration.test.tsx
//
// One-shot integration smoke test for the case-list authoring
// flow at the React level. Renders PreviewShell against a fixture
// blueprint with a case-typed module and walks the full
// edit-mode flow:
//
//   1. Module URL → ModuleScreen renders the "Case List" affordance
//      card.
//   2. Click the affordance → `navigate.openCaseList(moduleUuid)`
//      fires.
//   3. Flip the URL to /cases (simulating the navigation
//      completing) → CaseListWorkspace renders the three section
//      sentinels.
//
// The inner sections stay stubbed — they have their own dedicated
// test files. The integration this test pins is the routing +
// dispatch wire between ModuleScreen, the navigate intent, and
// PreviewShell's Activity boundaries; the inner sections are a
// black box from this surface's perspective.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
import type { Location } from "@/lib/routing/types";

const MODULE_UUID = asUuid("mod-1");

// Mutable location state so the test can flip between module and
// cases URLs without remounting the provider. `useLocation` is
// invoked on every render, so updating the variable + rerendering
// resimulates a navigation event.
let currentLocation: Location = {
	kind: "module",
	moduleUuid: MODULE_UUID,
};

const navigateMock = {
	goHome: vi.fn(),
	openModule: vi.fn(),
	openCaseList: vi.fn((uuid: string) => {
		// Simulate the navigation completing — the side-effect of
		// `navigate.openCaseList(...)` is the URL flipping. Mirroring
		// that side-effect inside the spy lets the test re-render
		// PreviewShell and observe the post-navigation state.
		currentLocation = {
			kind: "cases",
			moduleUuid: asUuid(uuid),
		};
	}),
	openCaseDetail: vi.fn(),
	openForm: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
	back: vi.fn(),
	up: vi.fn(),
};

vi.mock("@/lib/routing/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/routing/hooks")>(
		"@/lib/routing/hooks",
	);
	return {
		...actual,
		useLocation: () => currentLocation,
		useNavigate: () => navigateMock,
	};
});

vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return {
		...actual,
		useEditMode: () => "edit" as const,
		useAppId: () => "app-integration-test",
		useBuilderIsReady: () => true,
	};
});

// Stub the three inner sections. Their internals are pinned in
// dedicated test files; this test pins the routing → workspace
// → section-shell wire.
vi.mock("@/components/builder/case-list-config/DisplaySection", () => ({
	DisplaySection: () => (
		<div data-testid="display-section-stub">DisplaySection</div>
	),
}));
vi.mock("@/components/builder/case-list-config/FiltersSection", () => ({
	FiltersSection: () => (
		<div data-testid="filters-section-stub">FiltersSection</div>
	),
}));
vi.mock("@/components/builder/case-list-config/SearchInputsSection", () => ({
	SearchInputsSection: () => (
		<div data-testid="search-inputs-section-stub">SearchInputsSection</div>
	),
}));

// Stub the running-app preview screens that aren't relevant to
// this integration test. Each renders a sentinel testid; the test
// asserts on which surface is in the DOM after each navigation.
vi.mock("../screens/CaseListScreen", () => ({
	CaseListScreen: () => (
		<div data-testid="legacy-case-list-stub">CaseListScreen</div>
	),
}));
vi.mock("../screens/HomeScreen", () => ({
	HomeScreen: () => <div data-testid="home-stub">HomeScreen</div>,
}));
vi.mock("../screens/FormScreen", () => ({
	FormScreen: () => <div data-testid="form-stub">FormScreen</div>,
}));
vi.mock("../PreviewHeader", () => ({
	PreviewHeader: () => <div data-testid="header-stub">PreviewHeader</div>,
}));

import { PreviewShell } from "../PreviewShell";

/**
 * Mount PreviewShell against the fixture blueprint. The provider
 * persists across rerenders driven by location changes, so the
 * test can re-render the same root with `rerender(...)` to
 * simulate navigation events without resetting any side state.
 */
function renderShell() {
	const tree = (
		<BlueprintDocProvider
			appId="app-integration-test"
			initialDoc={{
				appId: "app-integration-test",
				appName: "Integration test app",
				connectType: null,
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "name", label: "Name", data_type: "text" }],
					},
				],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: "Patient module",
						caseType: "patient",
					},
				},
				forms: {},
				fields: {},
				moduleOrder: [MODULE_UUID],
				formOrder: { [MODULE_UUID]: [] },
				fieldOrder: {},
			}}
		>
			<PreviewShell hideHeader />
		</BlueprintDocProvider>
	);
	return render(tree);
}

describe("PreviewShell — case-list-authoring integration", () => {
	it("ModuleScreen surfaces the Case List affordance + click fires the navigate intent", () => {
		currentLocation = {
			kind: "module",
			moduleUuid: MODULE_UUID,
		};
		navigateMock.openCaseList.mockClear();
		renderShell();

		// ModuleScreen renders the Case List affordance (the integration
		// pin: case-typed module → affordance card visible above the
		// form list).
		const card = screen.getByRole("button", { name: /Case List/i });
		expect(card).toBeDefined();

		// Clicking the card fires `navigate.openCaseList` with the
		// module's uuid — the routing intent that flips the URL to
		// /cases. The spy assertion pins the wire between ModuleScreen
		// and the navigate hook.
		fireEvent.click(card);
		expect(navigateMock.openCaseList).toHaveBeenCalledOnce();
		expect(navigateMock.openCaseList).toHaveBeenCalledWith(MODULE_UUID);
	});

	it("PreviewShell at /cases (edit mode) renders the workspace's three section sentinels", () => {
		// Render directly at the cases URL — PreviewShell's location
		// branching dispatches the workspace, the workspace mounts
		// the three section stubs. Pinning the post-navigation state
		// in a separate test avoids the `useDeferredValue` flush
		// timing that complicates a single-test "navigate then assert"
		// flow under happy-dom.
		currentLocation = {
			kind: "cases",
			moduleUuid: MODULE_UUID,
		};
		renderShell();

		expect(screen.getByTestId("display-section-stub")).toBeDefined();
		expect(screen.getByTestId("filters-section-stub")).toBeDefined();
		expect(screen.getByTestId("search-inputs-section-stub")).toBeDefined();
	});
});
