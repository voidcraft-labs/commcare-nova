// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	focusElement,
	settleBaseUiTransitions,
} from "@/__tests__/helpers/baseUiInteractions";
import { asUuid, type UserProperty } from "@/lib/domain";

const PROPERTY: UserProperty = {
	uuid: asUuid("worker-region"),
	slug: "region",
	label: "Region",
};
const SECOND_PROPERTY: UserProperty = {
	uuid: asUuid("worker-cadre"),
	slug: "cadre",
	label: "Cadre",
};

const {
	addUserProperty,
	inspectUserPropertyRemoval,
	removeUserProperty,
	updateUserProperty,
	userProperties,
} = vi.hoisted(() => ({
	addUserProperty: vi.fn(),
	inspectUserPropertyRemoval: vi.fn(),
	removeUserProperty: vi.fn(),
	updateUserProperty: vi.fn(),
	userProperties: vi.fn(),
}));

vi.mock("@/lib/doc/hooks/useUserCollections", () => ({
	useUserProperties: () => userProperties(),
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		addUserProperty,
		inspectUserPropertyRemoval,
		inline: {
			removeUserProperty,
			updateUserProperty,
		},
	}),
}));
vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => true,
}));
vi.mock("@/lib/session/provider", () => ({
	useBuilderSessionApi: () => ({
		getState: () => ({ canEdit: true }),
	}),
}));

import { WorkerInformationSubsection } from "../WorkerInformationSubsection";

beforeEach(() => {
	addUserProperty.mockReset();
	inspectUserPropertyRemoval.mockReset();
	removeUserProperty.mockReset();
	updateUserProperty.mockReset();
	userProperties.mockReset();
	userProperties.mockReturnValue([PROPERTY]);
});

describe("WorkerInformationSubsection", () => {
	it("explains every blocking reference and offers no destructive action", async () => {
		inspectUserPropertyRemoval.mockReturnValue({
			ok: false,
			referenceCount: 2,
			references: [
				"condition in module “Patients”",
				"condition on “supervisor_note”",
			],
			userMessage: "Region is still used.",
		});
		render(<WorkerInformationSubsection />);

		fireEvent.click(screen.getByRole("button", { name: /Region region/ }));
		const removeTrigger = screen.getByRole("button", {
			name: "Remove worker information",
		});
		expect(removeTrigger.className.split(/\s+/)).toContain("h-11");
		fireEvent.click(removeTrigger);
		await settleBaseUiTransitions();

		expect(screen.getByText("Can’t remove Region yet")).toBeDefined();
		expect(screen.getByText(/2 saved settings use/)).toBeDefined();
		expect(screen.getByText("condition in module “Patients”")).toBeDefined();
		expect(screen.getByText("condition on “supervisor_note”")).toBeDefined();
		expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
		const close = screen.getByRole("button", { name: "Close" });
		expect(close.className.split(/\s+/)).toContain("h-11");
		expect(removeUserProperty).not.toHaveBeenCalled();
		fireEvent.click(close);
		await settleBaseUiTransitions();
	});

	it("keeps refused name, key, and accepted-value drafts mounted across collapse and row switches", async () => {
		userProperties.mockReturnValue([PROPERTY, SECOND_PROPERTY]);
		updateUserProperty.mockImplementation(
			(_uuid: string, patch: { choices?: readonly string[] }) =>
				patch.choices === undefined
					? { ok: true }
					: {
							ok: false,
							messages: ["Those accepted values could not be saved."],
						},
		);
		render(<WorkerInformationSubsection />);

		const regionTrigger = screen.getByRole("button", {
			name: /Region region/,
		});
		fireEvent.click(regionTrigger);
		await settleBaseUiTransitions();

		const name = screen.getByRole("textbox", {
			name: "Name people see",
		}) as HTMLInputElement;
		const slug = screen.getByRole("textbox", {
			name: "Name it saves under",
		}) as HTMLInputElement;
		const choices = screen.getByRole("textbox", {
			name: "Accepted values",
		}) as HTMLTextAreaElement;

		fireEvent.change(name, { target: { value: "" } });
		fireEvent.blur(name);
		fireEvent.change(slug, { target: { value: "-area" } });
		fireEvent.blur(slug);
		fireEvent.change(choices, { target: { value: "north\nsouth" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Apply accepted values" }),
		);

		expect(screen.getByText("Enter a name people can see.")).toBeDefined();
		expect(screen.getByText(/Start with a letter or underscore/)).toBeDefined();
		expect(
			screen.getByText("Those accepted values could not be saved."),
		).toBeDefined();

		focusElement(regionTrigger);
		fireEvent.click(regionTrigger);
		await settleBaseUiTransitions();
		expect(document.activeElement).toBe(regionTrigger);
		expect(name.isConnected).toBe(true);
		expect(slug.isConnected).toBe(true);
		expect(choices.isConnected).toBe(true);

		fireEvent.click(
			screen.getByRole("button", {
				name: /Cadre cadre/,
			}),
		);
		await settleBaseUiTransitions();
		fireEvent.click(regionTrigger);
		await settleBaseUiTransitions();

		expect(
			screen.getByRole("textbox", {
				name: "Name people see",
			}),
		).toBe(name);
		expect(name.value).toBe("");
		expect(slug.value).toBe("-area");
		expect(choices.value).toBe("north\nsouth");
		expect(screen.getByText("Enter a name people can see.")).toBeDefined();
		expect(screen.getByText(/Start with a letter or underscore/)).toBeDefined();
		expect(
			screen.getByText("Those accepted values could not be saved."),
		).toBeDefined();
	});
});
