// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { AddFormMenu } from "@/components/builder/appTree/insertion/AddFormMenu";
import { AddModulePopover } from "@/components/builder/appTree/insertion/AddModulePopover";
import type { FormType, Uuid } from "@/lib/domain";
import { POPOVER_ROW_CLS } from "@/lib/styles";

afterEach(async () => {
	await settleBaseUiTransitions();
});

const mocks = vi.hoisted(() => ({
	createCaseListModule: vi.fn(),
	createForm: vi.fn(),
	createSurveyModule: vi.fn(),
	openCaseList: vi.fn(),
	openForm: vi.fn(),
	openModule: vi.fn(),
}));

vi.mock(
	"@/components/builder/appTree/insertion/TreeInsertionAffordance",
	() => ({
		INSERTION_TRIGGER_CLS: "h-11",
		insertionTriggerStyle: () => ({}),
		TreeInsertionLine: ({ label }: { label: string }) => <span>{label}</span>,
		useTreeInsertionZone: () => ({
			revealed: true,
			progress: 1,
			ref: (() => {}) as Ref<HTMLElement>,
		}),
	}),
);

vi.mock("@/components/builder/shared/CaseTypePicker", () => ({
	CaseTypePickerContent: ({
		onChange,
	}: {
		onChange: (caseType: string) => void;
	}) => (
		<button type="button" onClick={() => onChange("client")}>
			Client
		</button>
	),
}));

vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		createForm: mocks.createForm,
		inline: {
			createCaseListModule: mocks.createCaseListModule,
			createSurveyModule: mocks.createSurveyModule,
		},
	}),
}));

vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({
		openCaseList: mocks.openCaseList,
		openForm: mocks.openForm,
		openModule: mocks.openModule,
	}),
}));

vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => true,
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createCaseListModule.mockReturnValue({
		ok: true,
		uuid: "module-2" as Uuid,
	});
	mocks.createSurveyModule.mockReturnValue({
		ok: true,
		uuid: "module-3" as Uuid,
	});
	mocks.createForm.mockReturnValue({ ok: true, uuid: "form-2" as Uuid });
});

describe("structure insertion menus", () => {
	it("uses the shared popover and menu-row module choices", async () => {
		render(
			<AddModulePopover
				parentModuleUuid={null}
				afterSiblingUuid={"module-1" as Uuid}
				prominent
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add module" }));

		const caseList = await screen.findByRole("button", { name: /Case list/ });
		const survey = screen.getByRole("button", { name: /Survey/ });
		// Each choice is a row in a popover, so it wears the one menu-row
		// treatment: the 44px floor, growing for its second line, and the
		// same inset highlight the real menu items get.
		expect(caseList.className).toBe(POPOVER_ROW_CLS);
		expect(survey.className).toBe(POPOVER_ROW_CLS);
		expect(screen.getByText("Manages a case type").className).toContain(
			"text-xs",
		);

		fireEvent.click(caseList);
		expect(
			await screen.findByRole("button", { name: "Back to module choices" }),
		).toBeDefined();
		fireEvent.click(await screen.findByRole("button", { name: "Client" }));
		expect(mocks.createCaseListModule).toHaveBeenCalledWith({
			caseType: "client",
			after: "module-1",
		});
		expect(mocks.openCaseList).toHaveBeenCalledWith("module-2");
	});

	it("creates a submenu with stable parent and sibling identities", async () => {
		render(
			<AddModulePopover
				parentModuleUuid={"module-1" as Uuid}
				afterSiblingUuid={null}
				prominent
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add submenu" }));
		fireEvent.click(await screen.findByRole("button", { name: /Survey/ }));
		expect(mocks.createSurveyModule).toHaveBeenCalledWith({
			parentModuleUuid: "module-1",
			after: null,
		});
		expect(mocks.openModule).toHaveBeenCalledWith("module-3");
	});

	it("uses the shared dropdown and explains disabled form choices", async () => {
		render(
			<AddFormMenu
				moduleUuid={"module-1" as Uuid}
				hasCaseType={false}
				atIndex={2}
				prominent
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add form" }));

		const registration = await screen.findByRole("menuitem", {
			name: /Registration/,
		});
		const survey = screen.getByRole("menuitem", { name: /Survey/ });
		expect(registration.getAttribute("data-slot")).toBe("dropdown-menu-item");
		expect(registration.className).toContain("min-h-14");
		expect(registration.getAttribute("data-disabled")).not.toBeNull();
		expect(screen.getAllByText("Needs a case type")[0]?.className).toContain(
			"text-xs",
		);

		fireEvent.click(survey);
		expect(mocks.createForm).toHaveBeenCalledWith(
			"module-1",
			"survey" satisfies FormType,
			2,
		);
		expect(mocks.openForm).toHaveBeenCalledWith("module-1", "form-2");
	});
});
