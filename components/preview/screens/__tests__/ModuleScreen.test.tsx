// @vitest-environment happy-dom
//
// components/preview/screens/__tests__/ModuleScreen.test.tsx
//
// Pins the ModuleScreen's shape after the case-list entry point moved
// to the structure tree: the module screen lists FORMS only — no
// "Case List & Search" card — and case-loading forms route through
// the case list so the worker journey starts from a case.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";

/** Edit/preview knob — defaults to edit; the redirect test flips it. */
const editModeMock = vi.fn<() => "edit" | "preview">(() => "edit");

const navigateMock = {
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
};

/** Mocked `useSetPreviewCaseTarget` — asserts a case-loading form click
 *  seeds the case list's continue target with that form. */
const setPreviewCaseTargetMock = vi.fn();

vi.mock("@/lib/routing/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/routing/hooks")>(
		"@/lib/routing/hooks",
	);
	return {
		...actual,
		useLocation: () => ({ kind: "module", moduleUuid: MODULE_UUID }),
		useNavigate: () => navigateMock,
	};
});

vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return {
		...actual,
		useEditMode: () => editModeMock(),
		useBuilderIsReady: () => true,
		useSetPreviewCaseTarget: () => setPreviewCaseTargetMock,
	};
});

import { ModuleScreen } from "../ModuleScreen";

const MODULE_UUID = asUuid("mod-1");
const REG_FORM_UUID = asUuid("form-reg");
const FOLLOWUP_FORM_UUID = asUuid("form-fup");

function renderModuleScreen(
	opts: { caseType?: string; caseFirst?: boolean } = {},
) {
	/* caseFirst drops the registration form so every form is case-loading —
	 * the shape that makes the running app hoist the case selection. */
	const forms = opts.caseFirst
		? {
				[FOLLOWUP_FORM_UUID]: {
					uuid: FOLLOWUP_FORM_UUID,
					id: "followup_patient",
					name: "Follow Up",
					type: "followup" as const,
				},
			}
		: {
				[REG_FORM_UUID]: {
					uuid: REG_FORM_UUID,
					id: "register_patient",
					name: "Register Patient",
					type: "registration" as const,
				},
				[FOLLOWUP_FORM_UUID]: {
					uuid: FOLLOWUP_FORM_UUID,
					id: "followup_patient",
					name: "Follow Up",
					type: "followup" as const,
				},
			};
	const order = opts.caseFirst
		? [FOLLOWUP_FORM_UUID]
		: [REG_FORM_UUID, FOLLOWUP_FORM_UUID];
	return render(
		<BlueprintDocProvider
			appId="app-module-screen-test"
			initialDoc={{
				appId: "app-module-screen-test",
				appName: "Module screen test app",
				connectType: null,
				caseTypes: [],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: "Patient module",
						caseType: opts.caseType,
					},
				},
				forms,
				fields: {},
				moduleOrder: [MODULE_UUID],
				formOrder: { [MODULE_UUID]: order },
				fieldOrder: Object.fromEntries(order.map((u) => [u, []])),
			}}
		>
			<ModuleScreen screen={{ type: "module", moduleIndex: 0 }} />
		</BlueprintDocProvider>,
	);
}

beforeEach(() => {
	editModeMock.mockReturnValue("edit");
});

describe("ModuleScreen", () => {
	it("renders the form list without a Case List & Search card (the tree owns that entry)", () => {
		renderModuleScreen({ caseType: "patient" });
		expect(screen.getByText("Register Patient")).toBeDefined();
		expect(screen.getByText("Follow Up")).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /Case List & Search/i }),
		).toBeNull();
	});

	it("routes a case-loading form click through the case list and seeds it as the continue target", () => {
		navigateMock.openCaseList.mockClear();
		navigateMock.openForm.mockClear();
		setPreviewCaseTargetMock.mockClear();
		renderModuleScreen({ caseType: "patient" });
		fireEvent.click(screen.getByText("Follow Up"));
		// The clicked form is recorded so the case list continues into THIS
		// form, not the module's first case-loading form.
		expect(setPreviewCaseTargetMock).toHaveBeenCalledWith({
			formUuid: FOLLOWUP_FORM_UUID,
		});
		expect(navigateMock.openCaseList).toHaveBeenCalledWith(MODULE_UUID);
		expect(navigateMock.openForm).not.toHaveBeenCalled();
	});

	it("opens a registration form directly", () => {
		navigateMock.openCaseList.mockClear();
		navigateMock.openForm.mockClear();
		renderModuleScreen({ caseType: "patient" });
		fireEvent.click(screen.getByText("Register Patient"));
		expect(navigateMock.openForm).toHaveBeenCalledWith(
			MODULE_UUID,
			REG_FORM_UUID,
		);
	});

	it("in preview, redirects a case-first module (all forms case-loading) to its case list", () => {
		// Every form is case-loading → the running app's landing is the case
		// list, not this form menu. The home screen already routes there; this
		// covers landing on the module URL directly in preview.
		editModeMock.mockReturnValue("preview");
		navigateMock.openCaseList.mockClear();
		renderModuleScreen({ caseType: "patient", caseFirst: true });
		expect(navigateMock.openCaseList).toHaveBeenCalledWith(MODULE_UUID);
	});

	it("does NOT redirect a case-first module in edit mode (the form menu is the authoring surface)", () => {
		editModeMock.mockReturnValue("edit");
		navigateMock.openCaseList.mockClear();
		renderModuleScreen({ caseType: "patient", caseFirst: true });
		expect(navigateMock.openCaseList).not.toHaveBeenCalled();
		// The form list still renders.
		expect(screen.getByText("Follow Up")).toBeDefined();
	});
});
