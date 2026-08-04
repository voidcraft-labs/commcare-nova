// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc, Persona } from "@/lib/domain";

const PERSONA: Persona = {
	uuid: testUuid("persona-without-role"),
	name: "Asha",
};

const mocks = vi.hoisted(() => ({
	personas: [] as Persona[],
	roles: [] as never[],
	properties: [] as never[],
	addPersona: vi.fn(),
	updatePersona: vi.fn(),
	updatePersonaValue: vi.fn(),
}));

vi.mock("@/lib/doc/hooks/useUserCollections", () => ({
	usePersonas: () => mocks.personas,
	useUserTypes: () => mocks.roles,
	useUserProperties: () => mocks.properties,
}));
vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDoc: (selector: (doc: BlueprintDoc) => unknown) =>
		selector({} as BlueprintDoc),
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		addPersona: mocks.addPersona,
		updatePersona: mocks.updatePersona,
		updatePersonaValue: mocks.updatePersonaValue,
		inline: { updatePersona: mocks.updatePersona },
	}),
}));
vi.mock("@/lib/doc/hooks/useOrganizationCollections", () => ({
	useOrganizationLevelRecord: () => ({}),
}));
vi.mock("@/lib/organization/ownerTargetVerdicts", () => ({
	personaAssignmentIssue: () => undefined,
	personaAssignmentRemovalIssues: () => new Map(),
}));
vi.mock("@/lib/organization/useOrganization", () => ({
	useOrganization: () => ({
		locations: [],
		loading: false,
		refreshing: false,
		error: undefined,
		warning: undefined,
		reload: vi.fn(),
	}),
}));
vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => "app",
	useCanEdit: () => true,
}));
vi.mock("@/lib/session/provider", () => ({
	useBuilderSessionApi: () => ({
		getState: () => ({ canEdit: true }),
	}),
}));

import { PersonasSubsection } from "../PersonasSubsection";

beforeEach(() => {
	mocks.personas = [PERSONA];
	mocks.addPersona.mockReset();
	mocks.updatePersona.mockReset();
	mocks.updatePersonaValue.mockReset();
});

describe("PersonasSubsection", () => {
	it("names an empty role selection instead of exposing its numeric sentinel", async () => {
		render(<PersonasSubsection />);
		expect(
			screen
				.getByRole("button", { name: "Add persona" })
				.className.split(/\s+/),
		).toContain("nova-add-slot");

		fireEvent.click(screen.getByRole("button", { name: /Asha No role/ }));
		await settleBaseUiTransitions();

		const role = screen.getByRole("combobox", { name: "Role" });
		expect(role.textContent).toContain("No role");
		expect(role.textContent).not.toBe("0");
		expect(role.getAttribute("aria-describedby")).toBeTruthy();
		expect(
			screen.getByText("Add a role above to give this persona one."),
		).toBeDefined();
	});
});
