// @vitest-environment happy-dom
//
// components/preview/__tests__/PreviewShell.test.tsx
//
// Pins the PreviewShell dispatch contract at the three case-list
// workspace URLs (`/cases`, `/search-config`, `/detail-config`).
//
//   - Edit mode at any of the three → the unified
//     CaseListConfigWorkspace is the visible surface, with the tab
//     prop derived from the URL kind (`list` / `search` / `detail`);
//     the running-app CaseListScreen is mounted but hidden by
//     Activity so its internal state (scroll, fetched rows) survives.
//   - Preview mode at any of the three → CaseListScreen is the
//     visible surface (search and detail are facets of the same case
//     list, so the running preview is always the assembled artifact);
//     the workspace is mounted but hidden so its selection + scroll
//     survive the round-trip.
//
// Activity in React 19 renders both `mode="visible"` and
// `mode="hidden"` subtrees into the DOM — the `display: none` is
// applied at commit time, so a `screen.queryByTestId` will find
// elements from BOTH branches if both are mounted. The tests
// therefore assert visibility via the Activity's `<div>` parent
// inline style rather than presence/absence in the DOM.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
import type { Location } from "@/lib/routing/types";

const MODULE_UUID = asUuid("mod-1");

// `useLocation` and `useEditMode` are the dispatch knobs; the rest of
// the routing/session surface is forwarded from the real module.
const editModeMock = vi.fn(() => "edit" as "edit" | "preview");
const locationMock = vi.fn<() => Location>(() => ({
	kind: "cases" as const,
	moduleUuid: MODULE_UUID,
}));

vi.mock("@/lib/routing/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/routing/hooks")>(
		"@/lib/routing/hooks",
	);
	// The mock matches the full `NavigateActions` shape so a real
	// screen mount that reaches for any method finds it. The
	// annotated return type pins the mock to the production hook's
	// shape — any drift between the two fails the build here.
	const buildNavigateMock = (): ReturnType<typeof actual.useNavigate> => ({
		goHome: vi.fn(),
		openModule: vi.fn(),
		openCaseList: vi.fn(),
		openCaseDetail: vi.fn(),
		openSearchConfig: vi.fn(),
		openDetailConfig: vi.fn(),
		openForm: vi.fn(),
		push: vi.fn(),
		replace: vi.fn(),
		back: vi.fn(),
		up: vi.fn(),
	});
	return {
		...actual,
		useLocation: () => locationMock(),
		useNavigate: () => buildNavigateMock(),
	};
});

vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return {
		...actual,
		useEditMode: () => editModeMock(),
		useAppId: () => "app-preview-shell-test",
		useBuilderIsReady: () => true,
	};
});

// Stub the screens so the PreviewShell's dispatch logic is the
// only subject under test. The workspace stub surfaces its `tab`
// prop so the URL-kind → tab derivation is assertable.
vi.mock(
	"@/components/builder/case-list-config/CaseListConfigWorkspace",
	() => ({
		CaseListConfigWorkspace: ({ tab }: { tab: string }) => (
			<div data-testid="workspace-stub" data-tab={tab}>
				CaseListConfigWorkspace
			</div>
		),
	}),
);
vi.mock("../screens/CaseListScreen", () => ({
	CaseListScreen: () => (
		<div data-testid="legacy-case-list-stub">CaseListScreen</div>
	),
}));
vi.mock("../screens/HomeScreen", () => ({
	HomeScreen: () => <div data-testid="home-stub">HomeScreen</div>,
}));
vi.mock("../screens/ModuleScreen", () => ({
	ModuleScreen: () => <div data-testid="module-stub">ModuleScreen</div>,
}));
vi.mock("../screens/FormScreen", () => ({
	FormScreen: () => <div data-testid="form-stub">FormScreen</div>,
}));
vi.mock("../PreviewHeader", () => ({
	PreviewHeader: () => <div data-testid="header-stub">PreviewHeader</div>,
}));

import { PreviewShell } from "../PreviewShell";

/**
 * Render PreviewShell with the routing/session mocks in place.
 * Mounts under a BlueprintDocProvider so the workspace's
 * BlueprintDoc-backed selectors resolve.
 */
function renderShell() {
	return render(
		<BlueprintDocProvider
			appId="app-preview-shell-test"
			initialDoc={{
				appId: "app-preview-shell-test",
				appName: "PreviewShell test app",
				connectType: null,
				caseTypes: [],
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
		</BlueprintDocProvider>,
	);
}

/**
 * Resolve the visible sentinel by walking up to the nearest
 * Activity-rendered wrapper and reading its rendered visibility.
 *
 * React 19's Activity component renders `mode="hidden"` subtrees
 * with `display: none` applied via inline style — the test reads
 * the computed `display` value via `getComputedStyle` to determine
 * which arm is the visible one.
 */
function isVisible(el: Element | null): boolean {
	if (!el) return false;
	let cursor: Element | null = el;
	while (cursor) {
		const style = window.getComputedStyle(cursor);
		if (style.display === "none") return false;
		cursor = cursor.parentElement;
	}
	return true;
}

const WORKSPACE_LOCATIONS: ReadonlyArray<{
	location: Location;
	tab: string;
}> = [
	{ location: { kind: "cases", moduleUuid: MODULE_UUID }, tab: "list" },
	{
		location: { kind: "search-config", moduleUuid: MODULE_UUID },
		tab: "search",
	},
	{
		location: { kind: "detail-config", moduleUuid: MODULE_UUID },
		tab: "detail",
	},
];

describe("PreviewShell — case-list workspace dispatch", () => {
	for (const { location, tab } of WORKSPACE_LOCATIONS) {
		it(`edit mode at ${location.kind} → workspace visible with tab="${tab}"; CaseListScreen hidden`, () => {
			editModeMock.mockReturnValue("edit");
			locationMock.mockReturnValue(location);
			const { getByTestId } = renderShell();
			const workspace = getByTestId("workspace-stub");
			expect(isVisible(workspace)).toBe(true);
			expect(workspace.getAttribute("data-tab")).toBe(tab);
			expect(isVisible(getByTestId("legacy-case-list-stub"))).toBe(false);
		});

		it(`preview mode at ${location.kind} → CaseListScreen visible; workspace hidden`, () => {
			editModeMock.mockReturnValue("preview");
			locationMock.mockReturnValue(location);
			const { getByTestId } = renderShell();
			expect(isVisible(getByTestId("legacy-case-list-stub"))).toBe(true);
			expect(isVisible(getByTestId("workspace-stub"))).toBe(false);
		});
	}

	it("toggling from edit → preview at /cases keeps the workspace mounted but hidden", () => {
		// Both surfaces should retain state across mode toggles. The
		// visited-ref pattern populates one ref per visited surface;
		// once both have rendered visible at least once, both Activity
		// boundaries persist. Driving edit → preview in the same shell
		// proves the gate keeps the workspace boundary alive.
		editModeMock.mockReturnValue("edit");
		locationMock.mockReturnValue({
			kind: "cases",
			moduleUuid: MODULE_UUID,
		});
		const { getByTestId, rerender } = renderShell();
		expect(isVisible(getByTestId("workspace-stub"))).toBe(true);
		// Toggle to preview mode, re-render the same root. The
		// caseListWorkspaceRef ref persists across the re-render so
		// the workspace boundary stays mounted (now hidden by
		// Activity). The running CaseListScreen mounts visible.
		editModeMock.mockReturnValue("preview");
		rerender(
			<BlueprintDocProvider
				appId="app-preview-shell-test"
				initialDoc={{
					appId: "app-preview-shell-test",
					appName: "PreviewShell test app",
					connectType: null,
					caseTypes: [],
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
			</BlueprintDocProvider>,
		);
		// Workspace is still mounted (Activity-hidden); legacy is
		// now the visible arm. Both surfaces survive the toggle.
		const workspace = getByTestId("workspace-stub");
		const legacy = getByTestId("legacy-case-list-stub");
		expect(isVisible(legacy)).toBe(true);
		expect(isVisible(workspace)).toBe(false);
	});
});
