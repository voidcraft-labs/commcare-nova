// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc, OrganizationLevel, Persona } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";

const LEVEL_UUID = testUuid("worker-level");
const BRANCH_A_UUID = testUuid("branch-a");
const BRANCH_B_UUID = testUuid("branch-b");

const PERSONA: Persona = {
	uuid: testUuid("persona"),
	name: "Asha",
	locations: {
		primaryUuid: BRANCH_A_UUID,
		additionalUuids: [BRANCH_B_UUID],
	},
};

const LEVEL: OrganizationLevel = {
	uuid: LEVEL_UUID,
	code: "facility",
	name: "Facility",
	caseFlow: {
		workers: "assigned",
		ownsCases: true,
		descendantCases: { kind: "none" },
	},
	addressBook: { reach: "own-branch" },
};

function location(
	id: StoredLocation["id"],
	name: string,
	siteCode: string,
): StoredLocation {
	return {
		id,
		levelUuid: LEVEL_UUID,
		parentId: null,
		siteCode,
		name,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: id,
	};
}

const LOCATIONS = [
	location(BRANCH_A_UUID, "Branch A", "branch-a"),
	location(BRANCH_B_UUID, "Branch B", "branch-b"),
];

const mocks = vi.hoisted(() => ({
	doc: {} as BlueprintDoc,
	setPersonaLocations: vi.fn(),
	personaAssignmentIssue: vi.fn(),
	personaAssignmentRemovalIssues: vi.fn(),
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDoc: (selector: (doc: BlueprintDoc) => unknown) =>
		selector(mocks.doc),
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		setPersonaLocations: mocks.setPersonaLocations,
	}),
}));
vi.mock("@/lib/doc/hooks/useOrganizationCollections", () => ({
	useOrganizationLevelRecord: () => ({ [LEVEL_UUID]: LEVEL }),
}));
vi.mock("@/lib/organization/ownerTargetVerdicts", () => ({
	personaAssignmentIssue: mocks.personaAssignmentIssue,
	personaAssignmentRemovalIssues: mocks.personaAssignmentRemovalIssues,
}));
vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => true,
}));

import { PersonaLocations } from "../PersonaLocations";

beforeEach(() => {
	mocks.setPersonaLocations.mockReset();
	mocks.personaAssignmentIssue.mockReset();
	mocks.personaAssignmentRemovalIssues.mockReset();
	// Branch B is the only assignment whose address-book footprint reaches a
	// saved fixed owner. Removing it is invalid; removing Branch A is valid.
	mocks.personaAssignmentIssue.mockImplementation(
		(
			_doc: BlueprintDoc,
			_locations: readonly StoredLocation[],
			_personaUuid: string,
			candidate: readonly string[],
		) =>
			candidate.includes(BRANCH_B_UUID)
				? undefined
				: "A saved fixed owner would fall outside Asha's address book.",
	);
	mocks.personaAssignmentRemovalIssues.mockReturnValue(
		new Map([
			[
				BRANCH_B_UUID,
				"A saved fixed owner would fall outside Asha's address book.",
			],
		]),
	);
});

describe("PersonaLocations", () => {
	it("preflights removals and explains an assignment that must stay", () => {
		render(
			<PersonaLocations
				persona={PERSONA}
				locations={LOCATIONS}
				loading={false}
				error={undefined}
			/>,
		);

		const blocked = screen.getByRole("button", {
			name: /Remove Branch B · branch-b/,
		});
		expect(blocked.hasAttribute("disabled")).toBe(true);
		expect(
			screen.getByText(
				"Keep this assignment: A saved fixed owner would fall outside Asha's address book.",
			),
		).toBeDefined();
		expect(mocks.personaAssignmentRemovalIssues).toHaveBeenCalledWith(
			mocks.doc,
			LOCATIONS,
			PERSONA.uuid,
			[BRANCH_A_UUID, BRANCH_B_UUID],
			[BRANCH_A_UUID, BRANCH_B_UUID],
		);

		fireEvent.click(blocked);
		expect(mocks.setPersonaLocations).not.toHaveBeenCalled();

		fireEvent.click(
			screen.getByRole("button", {
				name: /Remove Branch A · branch-a/,
			}),
		);
		expect(mocks.setPersonaLocations).toHaveBeenCalledWith(PERSONA.uuid, [
			BRANCH_B_UUID,
		]);
	});

	it("focuses the surviving row even when its remove action is blocked", async () => {
		const { rerender } = render(
			<PersonaLocations
				persona={PERSONA}
				locations={LOCATIONS}
				loading={false}
				error={undefined}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: /Remove Branch A · branch-a/,
			}),
		);
		const remaining: Persona = {
			...PERSONA,
			locations: { primaryUuid: BRANCH_B_UUID },
		};
		rerender(
			<PersonaLocations
				persona={remaining}
				locations={LOCATIONS}
				loading={false}
				error={undefined}
			/>,
		);
		await settleBaseUiTransitions();

		const focused = document.activeElement;
		expect(focused?.tagName).toBe("LI");
		expect(focused?.textContent).toContain("Branch B · branch-b");
	});

	it("preflights removals only for the visible assignment page", () => {
		const manyLocations = Array.from({ length: 60 }, (_, index) =>
			location(
				testUuid(`persona-page-${index}`),
				`Place ${index}`,
				`place-${index}`,
			),
		);
		const manyPersona: Persona = {
			...PERSONA,
			locations: {
				primaryUuid: manyLocations[0].id,
				additionalUuids: manyLocations.slice(1).map(({ id }) => id),
			},
		};
		mocks.personaAssignmentRemovalIssues.mockReturnValue(new Map());

		render(
			<PersonaLocations
				persona={manyPersona}
				locations={manyLocations}
				loading={false}
				error={undefined}
			/>,
		);

		expect(mocks.personaAssignmentRemovalIssues).toHaveBeenCalledWith(
			mocks.doc,
			manyLocations,
			PERSONA.uuid,
			manyLocations.map(({ id }) => id),
			manyLocations.slice(0, 50).map(({ id }) => id),
		);
	});
});
