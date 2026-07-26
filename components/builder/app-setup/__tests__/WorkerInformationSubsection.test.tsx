// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { asUuid, type UserProperty } from "@/lib/domain";

const PROPERTY: UserProperty = {
	uuid: asUuid("worker-region"),
	slug: "region",
	label: "Region",
};

const {
	addUserProperty,
	inspectUserPropertyRemoval,
	removeUserProperty,
	updateUserProperty,
} = vi.hoisted(() => ({
	addUserProperty: vi.fn(),
	inspectUserPropertyRemoval: vi.fn(),
	removeUserProperty: vi.fn(),
	updateUserProperty: vi.fn(),
}));

vi.mock("@/lib/doc/hooks/useUserCollections", () => ({
	useUserProperties: () => [PROPERTY],
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
});
