// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddFormMenu } from "@/components/builder/appTree/insertion/AddFormMenu";
import { AddModulePopover } from "@/components/builder/appTree/insertion/AddModulePopover";
import type { FormType, Uuid } from "@/lib/domain";

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
	it("uses the shared popover and full-size module choices", async () => {
		render(<AddModulePopover atIndex={1} prominent />);
		fireEvent.click(screen.getByRole("button", { name: "Add module" }));

		const caseList = await screen.findByRole("button", { name: /Case list/ });
		const survey = screen.getByRole("button", { name: /Survey/ });
		expect(caseList.getAttribute("data-slot")).toBe("button");
		expect(caseList.className).toContain("min-h-14");
		expect(survey.className).toContain("min-h-14");
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
			index: 1,
		});
		expect(mocks.openCaseList).toHaveBeenCalledWith("module-2");
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
