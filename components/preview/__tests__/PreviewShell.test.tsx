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
// `mode="hidden"` subtrees into the DOM: the `display: none` is
// applied at commit time, so a `screen.queryByTestId` will find
// elements from BOTH branches if both are mounted. The tests
// therefore assert visibility via the Activity's `<div>` parent
// inline style rather than presence/absence in the DOM.

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { BlueprintDocProvider } from "@/lib/doc/provider";

import type { SelectedPreviewIdentityState } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import type { Location } from "@/lib/routing/types";
import type {
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
	PreviewParentCaseRequest,
} from "@/lib/session/types";

const MODULE_UUID = testUuid("mod-1");
const CHILD_MODULE_UUID = testUuid("mod-child");
const PARENT_SELECT_MODULE_UUID = testUuid("mod-parent-select");
const FORM_UUID = testUuid("form-1");
const CHILD_FORM_UUID = testUuid("form-child");
const PARENT_SELECT_FORM_UUID = testUuid("form-parent-select");

// `useLocation` and `useEditMode` are the dispatch knobs; the rest of
// the routing/session surface is forwarded from the real module.
// `previewCaseTargetMock` drives the case-datum injection onto the form
// screen (default: no target).
const editModeMock = vi.fn(() => "edit" as "edit" | "preview");
const locationMock = vi.fn<() => Location>(() => ({
	kind: "cases" as const,
	moduleUuid: MODULE_UUID,
}));
const previewCaseTargetMock = vi.fn<() => PreviewCaseTarget | undefined>(
	() => undefined,
);
let previewMenuCaseSelectionsMock: Readonly<
	Record<string, PreviewMenuCaseSelection>
> = {};
let previewParentCaseRequestMock: PreviewParentCaseRequest | undefined;
const setPreviewParentCaseRequestMock = vi.fn();
const setPreviewingMock = vi.fn();
const setPreviewPersonaUuidMock = vi.fn();
const selectedIdentityStateMock = vi.fn<() => SelectedPreviewIdentityState>(
	() => ({
		kind: "ready",
		identity: null,
	}),
);

beforeEach(() => {
	setPreviewingMock.mockReset();
	setPreviewPersonaUuidMock.mockReset();
	previewCaseTargetMock.mockReturnValue(undefined);
	previewMenuCaseSelectionsMock = {};
	previewParentCaseRequestMock = undefined;
	setPreviewParentCaseRequestMock.mockReset();
	selectedIdentityStateMock.mockReturnValue({
		kind: "ready",
		identity: null,
	});
});

vi.mock("@/lib/routing/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/routing/hooks")>(
		"@/lib/routing/hooks",
	);
	// The mock matches the full `NavigateActions` shape so a real
	// screen mount that reaches for any method finds it. The
	// annotated return type pins the mock to the production hook's
	// shape: any drift between the two fails the build here.
	const buildNavigateMock = (): ReturnType<typeof actual.useNavigate> => ({
		goHome: vi.fn(),
		openModule: vi.fn(),
		openCaseList: vi.fn(),
		openCaseDetail: vi.fn(),
		openSearchConfig: vi.fn(),
		openDetailConfig: vi.fn(),
		openDataReview: vi.fn(),
		openProjectData: vi.fn(),
		openModuleCondition: vi.fn(),
		openFormCondition: vi.fn(),
		openAppSetup: vi.fn(),
		openFormOperations: vi.fn(),
		openFormLinks: vi.fn(),
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
		usePreviewCaseTarget: () => previewCaseTargetMock(),
		usePreviewMenuCaseSelections: () => previewMenuCaseSelectionsMock,
		usePreviewParentCaseRequest: () => previewParentCaseRequestMock,
		useSetPreviewing: () => setPreviewingMock,
		useSetPreviewParentCaseRequest: () => setPreviewParentCaseRequestMock,
		useSetPreviewPersonaUuid: () => setPreviewPersonaUuidMock,
	};
});

vi.mock("@/lib/preview/hooks/useSelectedPreviewIdentity", () => ({
	useSelectedPreviewIdentityState: () => selectedIdentityStateMock(),
}));

// Stub the screens so the PreviewShell's dispatch logic is the only subject
// under test. The workspace canvas reads its module + tab from the shared
// controller (via the URL), so PreviewShell only owns the Activity visibility
// gating asserted below, not which tab shows.
vi.mock(
	"@/components/builder/case-list-config/CaseListConfigWorkspace",
	() => ({
		CaseListWorkspaceCanvas: () => (
			<div data-testid="workspace-stub">CaseListWorkspaceCanvas</div>
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
	ModuleScreen: ({ screen }: { screen: { moduleUuid: string } }) => (
		<div data-testid="module-stub" data-module-uuid={screen.moduleUuid}>
			ModuleScreen
		</div>
	),
}));
vi.mock("../screens/FormScreen", () => ({
	// Surface the screen's `caseId` so the case-datum injection is
	// assertable: `""` when absent (an attribute can't hold undefined).
	FormScreen: ({ screen }: { screen: { caseId?: string } }) => (
		<div data-testid="form-stub" data-case-id={screen.caseId ?? ""}>
			FormScreen
		</div>
	),
}));

import { PreviewShell } from "../PreviewShell";

/**
 * Render PreviewShell with the routing/session mocks in place.
 * Mounts under a BlueprintDocProvider so the workspace's
 * BlueprintDoc-backed selectors resolve.
 */
function renderShell(options: { hideStructuralParent?: boolean } = {}) {
	const hideStructuralParent = options.hideStructuralParent ?? true;
	return render(
		<BlueprintDocProvider
			appId="app-preview-shell-test"
			initialDoc={{
				appId: "app-preview-shell-test",
				appName: "PreviewShell test app",
				connectType: null,
				caseTypes: [
					{ name: "patient", properties: [] },
					{ name: "household", properties: [] },
					{
						name: "person",
						parent_type: "household",
						properties: [],
					},
				],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: "Patient module",
						caseType: "patient",
						...(hideStructuralParent
							? { displayCondition: { kind: "match-none" as const } }
							: {}),
					},
					[CHILD_MODULE_UUID]: {
						uuid: CHILD_MODULE_UUID,
						id: "child_module",
						name: "Child module",
						parentModuleUuid: MODULE_UUID,
						caseType: "person",
					},
					[PARENT_SELECT_MODULE_UUID]: {
						uuid: PARENT_SELECT_MODULE_UUID,
						id: "household_module",
						name: "Households",
						caseType: "household",
					},
				},
				forms: {
					[FORM_UUID]: {
						uuid: FORM_UUID,
						id: "followup_form",
						name: "Follow-up",
						type: "followup",
					},
					[CHILD_FORM_UUID]: {
						uuid: CHILD_FORM_UUID,
						id: "child_followup_form",
						name: "Child follow-up",
						type: "followup",
					},
					[PARENT_SELECT_FORM_UUID]: {
						uuid: PARENT_SELECT_FORM_UUID,
						id: "household_followup_form",
						name: "Household follow-up",
						type: "followup",
					},
				},
				fields: {},
				moduleOrder: [
					MODULE_UUID,
					CHILD_MODULE_UUID,
					PARENT_SELECT_MODULE_UUID,
				],
				formOrder: {
					[MODULE_UUID]: [FORM_UUID],
					[CHILD_MODULE_UUID]: [CHILD_FORM_UUID],
					[PARENT_SELECT_MODULE_UUID]: [PARENT_SELECT_FORM_UUID],
				},
				fieldOrder: {
					[FORM_UUID]: [],
					[CHILD_FORM_UUID]: [],
					[PARENT_SELECT_FORM_UUID]: [],
				},
			}}
		>
			<BuilderLocalizationProvider>
				<PreviewShell />
			</BuilderLocalizationProvider>
		</BlueprintDocProvider>,
	);
}

/**
 * Resolve the visible sentinel by walking up to the nearest
 * Activity-rendered wrapper and reading its rendered visibility.
 *
 * React 19's Activity component renders `mode="hidden"` subtrees
 * with `display: none` applied via inline style, the test reads
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
	it("previews a child module condition on its structural parent menu", () => {
		editModeMock.mockReturnValue("preview");
		locationMock.mockReturnValue({
			kind: "module-condition",
			moduleUuid: CHILD_MODULE_UUID,
		});
		const { getByTestId } = renderShell();
		const moduleScreen = getByTestId("module-stub");
		expect(isVisible(moduleScreen)).toBe(true);
		expect(moduleScreen.getAttribute("data-module-uuid")).toBe(MODULE_UUID);
	});

	for (const location of [
		{ kind: "module" as const, moduleUuid: CHILD_MODULE_UUID },
		{ kind: "cases" as const, moduleUuid: CHILD_MODULE_UUID },
		{
			kind: "form" as const,
			moduleUuid: CHILD_MODULE_UUID,
			formUuid: CHILD_FORM_UUID,
		},
	]) {
		it(`does not run a directly addressed ${location.kind} under a hidden parent`, () => {
			editModeMock.mockReturnValue("preview");
			locationMock.mockReturnValue(location);
			const { getByTestId } = renderShell();
			expect(isVisible(getByTestId("home-stub"))).toBe(true);
		});
	}

	for (const location of [
		{ kind: "cases" as const, moduleUuid: CHILD_MODULE_UUID },
		{
			kind: "form" as const,
			moduleUuid: CHILD_MODULE_UUID,
			formUuid: CHILD_FORM_UUID,
		},
	]) {
		it(`admits a directly addressed child ${location.kind} through its module before parent selection`, () => {
			editModeMock.mockReturnValue("preview");
			locationMock.mockReturnValue(location);
			const view = renderShell({ hideStructuralParent: false });

			const moduleScreen = view.getByTestId("module-stub");
			expect(isVisible(moduleScreen)).toBe(true);
			expect(moduleScreen.getAttribute("data-module-uuid")).toBe(
				CHILD_MODULE_UUID,
			);
			expect(view.queryByTestId("legacy-case-list-stub")).toBeNull();
			expect(view.queryByTestId("form-stub")).toBeNull();
		});
	}

	it("runs a directly addressed child case list after its case parent is selected", () => {
		editModeMock.mockReturnValue("preview");
		locationMock.mockReturnValue({
			kind: "cases",
			moduleUuid: CHILD_MODULE_UUID,
		});
		previewMenuCaseSelectionsMock = {
			[PARENT_SELECT_MODULE_UUID]: {
				caseType: "household",
				caseId: "household-1",
				caseName: "Household one",
			},
		};
		const view = renderShell({ hideStructuralParent: false });

		expect(isVisible(view.getByTestId("legacy-case-list-stub"))).toBe(true);
	});

	it("uses its real scroll surface as the single main landmark", () => {
		editModeMock.mockReturnValue("edit");
		locationMock.mockReturnValue({ kind: "cases", moduleUuid: MODULE_UUID });
		const { container, getByRole } = renderShell();

		const main = getByRole("main");
		expect(main.hasAttribute("data-preview-scroll-container")).toBe(true);
		expect(container.querySelectorAll("main")).toHaveLength(1);
	});

	for (const { location, tab } of WORKSPACE_LOCATIONS) {
		it(`edit mode at ${location.kind} (tab="${tab}") → workspace visible; CaseListScreen hidden`, () => {
			editModeMock.mockReturnValue("edit");
			locationMock.mockReturnValue(location);
			const { getByTestId } = renderShell();
			const workspace = getByTestId("workspace-stub");
			expect(isVisible(workspace)).toBe(true);
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

	it("treats /cases/{caseId} as a running record and restores preview mode after reload", () => {
		editModeMock.mockReturnValue("edit");
		locationMock.mockReturnValue({
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: "case-deep-link",
		});
		const { getByTestId } = renderShell();
		expect(isVisible(getByTestId("legacy-case-list-stub"))).toBe(true);
		expect(isVisible(getByTestId("workspace-stub"))).toBe(false);
		expect(setPreviewingMock).toHaveBeenCalledWith(true);
	});

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
				<BuilderLocalizationProvider>
					<PreviewShell />
				</BuilderLocalizationProvider>
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

describe("PreviewShell — parent-case request lifecycle", () => {
	it("clears a stale selector request after navigation leaves its active module", async () => {
		editModeMock.mockReturnValue("preview");
		locationMock.mockReturnValue({ kind: "home" });
		previewParentCaseRequestMock = {
			selectingModuleUuid: MODULE_UUID,
			returnModuleUuids: [CHILD_MODULE_UUID],
			resumeLocation: {
				kind: "form",
				moduleUuid: CHILD_MODULE_UUID,
				formUuid: CHILD_FORM_UUID,
			},
		};

		renderShell({ hideStructuralParent: false });

		await waitFor(() =>
			expect(setPreviewParentCaseRequestMock).toHaveBeenCalledWith(undefined),
		);
	});

	it("clears the selector request when browser Back leaves the replace-driven flow", () => {
		editModeMock.mockReturnValue("preview");
		locationMock.mockReturnValue({ kind: "cases", moduleUuid: MODULE_UUID });
		previewParentCaseRequestMock = {
			selectingModuleUuid: MODULE_UUID,
			returnModuleUuids: [CHILD_MODULE_UUID],
		};
		renderShell({ hideStructuralParent: false });

		act(() => window.dispatchEvent(new PopStateEvent("popstate")));

		expect(setPreviewParentCaseRequestMock).toHaveBeenCalledWith(undefined);
	});
});

describe("PreviewShell — preview case-datum injection", () => {
	const FORM_LOCATION: Location = {
		kind: "form",
		moduleUuid: MODULE_UUID,
		formUuid: FORM_UUID,
	};

	it("grafts the selected caseId onto the form screen when the target names this form", () => {
		editModeMock.mockReturnValue("preview");
		locationMock.mockReturnValue(FORM_LOCATION);
		previewCaseTargetMock.mockReturnValue({
			formUuid: FORM_UUID,
			caseId: "case-xyz",
		});
		const { getByTestId } = renderShell();
		expect(getByTestId("form-stub").getAttribute("data-case-id")).toBe(
			"case-xyz",
		);
	});

	it("leaves the form caseless when the target names a different form", () => {
		editModeMock.mockReturnValue("preview");
		locationMock.mockReturnValue(FORM_LOCATION);
		previewCaseTargetMock.mockReturnValue({
			formUuid: testUuid("some-other-form"),
			caseId: "case-xyz",
		});
		const { getByTestId } = renderShell();
		expect(getByTestId("form-stub").getAttribute("data-case-id")).toBe("");
	});

	it("leaves the form caseless when there is no target", () => {
		editModeMock.mockReturnValue("preview");
		locationMock.mockReturnValue(FORM_LOCATION);
		previewCaseTargetMock.mockReturnValue(undefined);
		const { getByTestId } = renderShell();
		expect(getByTestId("form-stub").getAttribute("data-case-id")).toBe("");
	});
});

describe("PreviewShell — removed selected persona", () => {
	for (const location of [
		{ kind: "home" as const },
		{ kind: "module" as const, moduleUuid: MODULE_UUID },
		{ kind: "cases" as const, moduleUuid: MODULE_UUID },
		{
			kind: "form" as const,
			moduleUuid: MODULE_UUID,
			formUuid: FORM_UUID,
		},
	]) {
		it(`blocks ${location.kind} instead of running anonymously`, () => {
			editModeMock.mockReturnValue("preview");
			locationMock.mockReturnValue(location);
			selectedIdentityStateMock.mockReturnValue({
				kind: "persona-unavailable",
				personaUuid: "removed-persona",
			});

			const view = renderShell();

			expect(view.getByRole("alert").textContent).toContain(
				"no longer in this app",
			);
			expect(view.queryByTestId("home-stub")).toBeNull();
			expect(view.queryByTestId("module-stub")).toBeNull();
			expect(view.queryByTestId("legacy-case-list-stub")).toBeNull();
			expect(view.queryByTestId("form-stub")).toBeNull();
		});
	}

	it("offers an explicit route back to Preview as me", () => {
		editModeMock.mockReturnValue("preview");
		locationMock.mockReturnValue({ kind: "home" });
		selectedIdentityStateMock.mockReturnValue({
			kind: "persona-unavailable",
			personaUuid: "removed-persona",
		});
		const view = renderShell();

		const recovery = view.getByRole("button", { name: "Preview as me" });
		// The recovery affordance is at the one 44px control height. That is
		// the system button's own guarantee now, not something this call site
		// re-states, so assert the primitive's class rather than a duplicate.
		expect(recovery.className.split(/\s+/)).toContain("h-11");
		fireEvent.click(recovery);

		expect(setPreviewPersonaUuidMock).toHaveBeenCalledWith(undefined);
	});
});
