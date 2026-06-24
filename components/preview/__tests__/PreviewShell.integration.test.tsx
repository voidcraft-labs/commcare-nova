// @vitest-environment happy-dom
//
// components/preview/__tests__/PreviewShell.integration.test.tsx
//
// One-shot integration smoke test for the case-list authoring flow at
// the React level. Renders PreviewShell against a fixture blueprint
// with a case-typed module at /cases (edit mode) and pins:
//
//   1. The unified CaseListConfigWorkspace renders its tab row +
//      the case-list canvas — and carries NO Preview affordance of
//      its own (the run-through lives behind the chrome's global
//      Preview toggle, outside PreviewShell).
//   2. The Case Detail tab fires `navigate.openDetailConfig`.
//
// The case-store Server Actions are stubbed — the integration this
// test pins is the routing + dispatch wire between the navigate
// intents and PreviewShell's Activity boundaries; live data loading
// is a black box from this surface's perspective.

import { act, fireEvent, render, screen } from "@testing-library/react";
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
	openSearchConfig: vi.fn(),
	openDetailConfig: vi.fn(),
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
		usePreviewCaseTarget: () => undefined,
		useSetPreviewCaseTarget: () => vi.fn(),
	};
});

// Stub the case-store Server Actions the workspace's live preview
// fires on mount — a vitest render has no session or case store.
// The empty arm exercises the canvas's no-data notice path.
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCaseListPreviewAction: vi.fn(async () => ({ kind: "empty" as const })),
	loadFilterPreviewAction: vi.fn(async () => ({ kind: "empty" as const })),
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
			<PreviewShell />
		</BlueprintDocProvider>
	);
	return render(tree);
}

describe("PreviewShell — case-list-authoring integration", () => {
	it("at /cases (edit mode) renders the workspace tabs + case-list canvas, with no Preview affordance", async () => {
		currentLocation = {
			kind: "cases",
			moduleUuid: MODULE_UUID,
		};
		// The real workspace fires `loadCaseListPreviewAction` (stubbed) in a
		// mount effect; its resolution sets state after the synchronous
		// render. Render inside `act(async)` so that settle happens in scope —
		// otherwise React warns the update was not wrapped in act(...).
		await act(async () => {
			renderShell();
		});

		// The three config tabs are present…
		expect(screen.getByRole("button", { name: /Search/ })).toBeDefined();
		expect(screen.getByRole("button", { name: /Case List/ })).toBeDefined();
		expect(screen.getByRole("button", { name: /Case Detail/ })).toBeDefined();
		// …the workspace carries no Preview button of its own (the
		// global toggle lives in the subheader, outside PreviewShell)…
		expect(screen.queryByRole("button", { name: /Preview/ })).toBeNull();
		// …and the case-list canvas renders the module name as the
		// artifact's title.
		expect(screen.getByText("Patient module")).toBeDefined();
	});

	it("the Case Detail tab fires navigate.openDetailConfig", async () => {
		currentLocation = {
			kind: "cases",
			moduleUuid: MODULE_UUID,
		};
		navigateMock.openDetailConfig.mockClear();
		// Settle the mount-effect preview load inside act() before
		// interacting — see the sibling test above.
		await act(async () => {
			renderShell();
		});
		fireEvent.click(screen.getByRole("button", { name: /Case Detail/ }));
		expect(navigateMock.openDetailConfig).toHaveBeenCalledOnce();
		expect(navigateMock.openDetailConfig).toHaveBeenCalledWith(MODULE_UUID);
	});
});
