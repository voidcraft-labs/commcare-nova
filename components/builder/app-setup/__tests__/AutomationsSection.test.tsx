// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Automation } from "@/lib/domain";

const RULE_UUID = testUuid("ui-automation");
const UPDATE_UUID = testUuid("ui-automation-update");
const rule: Automation = {
	uuid: RULE_UUID,
	kind: "case-update",
	name: "Close resolved visits",
	caseType: "visit",
	criteriaOperator: "all",
	criteria: [],
	setupOnlyCriteria: [],
	runOnSave: false,
	updates: [
		{
			uuid: UPDATE_UUID,
			target: { scope: "case", property: "state" },
			value: { kind: "literal", value: "resolved" },
		},
	],
	closeCase: true,
};

const mocks = vi.hoisted(() => ({
	automations: [] as Automation[],
	canEdit: true,
	addAutomation: vi.fn(() => ({ ok: true, uuid: "new" })),
	replaceAutomation: vi.fn(() => ({ ok: true })),
	removeAutomation: vi.fn(() => ({ ok: true })),
	preview: vi.fn(),
}));

vi.mock("@/lib/automations/actions", () => ({
	previewAutomationAction: (...args: unknown[]) => mocks.preview(...args),
}));
vi.mock("@/lib/doc/hooks/useAutomationCollections", () => ({
	useAutomations: () => mocks.automations,
	useAutomationForms: () => [],
}));
vi.mock("@/lib/doc/hooks/useCaseTypes", () => ({
	useEffectiveCaseTypes: () => [
		{
			name: "visit",
			properties: [],
		},
	],
}));
vi.mock("@/lib/doc/hooks/useOrganizationCollections", () => ({
	useOrganizationLevels: () => [],
}));
vi.mock("@/lib/doc/hooks/useUserCollections", () => ({
	useUserProperties: () => [],
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		addAutomation: mocks.addAutomation,
		replaceAutomation: mocks.replaceAutomation,
		removeAutomation: mocks.removeAutomation,
	}),
}));
vi.mock("@/lib/organization/useOrganization", () => ({
	useOrganization: () => ({
		locations: [],
		loading: false,
		error: undefined,
		warning: undefined,
		refreshing: false,
		revision: "1",
		reload: vi.fn(),
	}),
}));
vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => "app-automations",
	useCanEdit: () => mocks.canEdit,
}));
vi.mock("@/lib/session/provider", () => ({
	useBuilderSessionApi: () => ({
		getState: () => ({ canEdit: mocks.canEdit }),
	}),
}));

import { AutomationsSection } from "../AutomationsSection";

beforeEach(() => {
	mocks.automations = [];
	mocks.canEdit = true;
	mocks.addAutomation.mockClear();
	mocks.replaceAutomation.mockClear();
	mocks.removeAutomation.mockClear();
	mocks.preview.mockReset();
	mocks.preview.mockResolvedValue({
		success: true,
		data: {
			automationUuid: RULE_UUID,
			blueprintSeq: 3,
			organizationRevision: "1",
			currentMatchCount: 4,
			omittedCriteria: ["HQ server-modified age of at least 30 days"],
			setupGuide: {
				title: "Close resolved visits",
				requiredPlan: "Data Cleanup (Pro or higher)",
				steps: ["Open the rule editor."],
				caveats: ["Nova does not run this automation in Preview."],
			},
			executesLocally: false,
		},
	});
});

describe("AutomationsSection", () => {
	it("owns an honest empty state and a keyboard-focused add editor", async () => {
		render(<AutomationsSection />);
		expect(screen.getByText(/No automations yet/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		const name = screen.getByRole("textbox", { name: "Name" });
		expect(document.activeElement).toBe(name);
		expect(
			screen.getByRole("combobox", { name: "Automation type" }),
		).toBeDefined();
		fireEvent.change(name, { target: { value: "Resolve old visits" } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "case-update",
				name: "Resolve old visits",
				caseType: "visit",
			}),
		);
	});

	it("refuses an invalid draft with human validation copy", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Enter an automation name.",
		);
		expect(mocks.addAutomation).not.toHaveBeenCalled();
	});

	it("counts current matches, names omissions, and exposes regenerated guidance", async () => {
		mocks.automations = [rule];
		render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(
			screen.getByRole("button", { name: "Count matching cases" }),
		);
		await waitFor(() => expect(screen.getByText("4")).toBeDefined());
		expect(screen.getByText(/Count excludes:/)).toBeDefined();
		expect(screen.getByText(/Data Cleanup \(Pro or higher\)/)).toBeDefined();
		expect(
			screen.getByText(/Nova does not run this automation in Preview/),
		).toBeDefined();
		expect(mocks.preview).toHaveBeenCalledWith({
			appId: "app-automations",
			automationUuid: RULE_UUID,
			expectedAutomation: rule,
		});
	});

	it("keeps every definition readable for a Project viewer and hides edits", async () => {
		mocks.automations = [rule];
		mocks.canEdit = false;
		render(<AutomationsSection />);
		expect(screen.queryByRole("button", { name: "Add automation" })).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		expect(
			screen.queryByRole("button", { name: "Edit automation" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Count matching cases" }),
		).toBeDefined();
	});

	it("shows an authoritative conflict instead of overwriting a co-editor", async () => {
		mocks.automations = [rule];
		const { rerender } = render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		mocks.automations = [{ ...rule, name: "Peer changed this" }];
		rerender(<AutomationsSection />);
		expect(screen.getByText(/A co-editor changed or removed/)).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Save automation" }),
		).toHaveProperty("disabled", true);
		expect(
			screen.getByRole("button", { name: "Remove automation" }),
		).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("button", { name: "Remove automation" }));
		expect(mocks.replaceAutomation).not.toHaveBeenCalled();
		expect(mocks.removeAutomation).not.toHaveBeenCalled();
	});

	it("returns focus to Add automation after removal", async () => {
		mocks.automations = [rule];
		render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Remove automation" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove automation" }));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add automation" }),
			),
		);
		expect(mocks.removeAutomation).toHaveBeenCalledWith(RULE_UUID);
	});
});
