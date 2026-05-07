// @vitest-environment happy-dom
//
// components/preview/__tests__/PreviewShell.test.tsx
//
// Pins the PreviewShell dispatch contract at the case list URL.
// Per Task 8.5:
//
//   - Edit mode + cases location → CaseListWorkspace is the visible
//     surface; the legacy CaseListScreen is mounted but hidden by
//     Activity so its internal state (scroll, fetched rows) survives.
//   - Live mode + cases location → CaseListScreen is the visible
//     surface; the workspace is mounted but hidden so its scroll
//     position survives the round-trip.
//
// Activity in React 19 renders both `mode="visible"` and
// `mode="hidden"` subtrees into the DOM — the `display: none` is
// applied at commit time, so a `screen.queryByTestId` will find
// elements from BOTH branches if both are mounted. The tests
// therefore assert visibility via the Activity's `<div>` parent
// `aria-hidden` / inline style rather than presence/absence in
// the DOM.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";

const MODULE_UUID = asUuid("mod-1");

// `useLocation` and `useEditMode` are the dispatch knobs; the rest
// of the routing/session surface is forwarded from the real module.
const editModeMock = vi.fn(() => "edit" as "edit" | "test");
const locationMock = vi.fn(() => ({
	kind: "cases" as const,
	moduleUuid: MODULE_UUID,
}));

vi.mock("@/lib/routing/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/routing/hooks")>(
		"@/lib/routing/hooks",
	);
	return {
		...actual,
		useLocation: () => locationMock(),
		useNavigate: () => ({
			goHome: vi.fn(),
			openModule: vi.fn(),
			openCaseList: vi.fn(),
			openCaseDetail: vi.fn(),
			openForm: vi.fn(),
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			up: vi.fn(),
		}),
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
// only subject under test. Each stub renders a sentinel
// data-testid; assertions inspect which sentinels are visible
// (their Activity ancestor's mode resolved to "visible") vs
// merely mounted (Activity ancestor `hidden`).
vi.mock("@/components/builder/case-list-config/CaseListWorkspace", () => ({
	CaseListWorkspace: () => (
		<div data-testid="workspace-stub">CaseListWorkspace</div>
	),
}));
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

describe("PreviewShell — case list dispatch", () => {
	it("edit mode at /cases → CaseListWorkspace is the visible surface; legacy is hidden", () => {
		editModeMock.mockReturnValue("edit");
		locationMock.mockReturnValue({
			kind: "cases",
			moduleUuid: MODULE_UUID,
		});
		const { getByTestId } = renderShell();
		// Both Activity boundaries are mounted on first visit to /cases
		// (visited-ref gates fire for both surfaces in the same render
		// pass). Activity then resolves visibility via its `mode` prop:
		// edit-mode → workspace visible, legacy hidden.
		expect(isVisible(getByTestId("workspace-stub"))).toBe(true);
		expect(isVisible(getByTestId("legacy-case-list-stub"))).toBe(false);
	});

	it("test mode at /cases → legacy CaseListScreen is the visible surface; workspace is hidden", () => {
		editModeMock.mockReturnValue("test");
		locationMock.mockReturnValue({
			kind: "cases",
			moduleUuid: MODULE_UUID,
		});
		const { getByTestId } = renderShell();
		expect(isVisible(getByTestId("legacy-case-list-stub"))).toBe(true);
		expect(isVisible(getByTestId("workspace-stub"))).toBe(false);
	});

	it("toggling from edit → test at /cases keeps the workspace mounted but hidden", () => {
		// Both surfaces should retain state across mode toggles. The
		// visited-ref pattern populates one ref per visited surface;
		// once both have rendered visible at least once, both Activity
		// boundaries persist. Driving edit → test in the same shell
		// proves the gate keeps the workspace boundary alive.
		editModeMock.mockReturnValue("edit");
		locationMock.mockReturnValue({
			kind: "cases",
			moduleUuid: MODULE_UUID,
		});
		const { getByTestId, rerender } = renderShell();
		expect(isVisible(getByTestId("workspace-stub"))).toBe(true);
		// Toggle to test mode, re-render the same root. The
		// caseListWorkspaceRef ref persists across the re-render so
		// the workspace boundary stays mounted (now hidden by
		// Activity). The legacy CaseListScreen mounts visible.
		editModeMock.mockReturnValue("test");
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
