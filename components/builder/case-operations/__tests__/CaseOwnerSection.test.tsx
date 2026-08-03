// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, OrganizationLevel } from "@/lib/domain";
import {
	actingUser,
	fixedLocation,
	ownerLocationAtLevel,
	term,
} from "@/lib/domain/predicate";
import type { StoredLocation } from "@/lib/organization/types";
import type { OrganizationView } from "@/lib/organization/useOrganization";

const LOCATION_UUID = testUuid("saved-fixed-owner-loading");
const LEVEL_UUID = testUuid("saved-fixed-owner-level");
const PEER_LEVEL_UUID = testUuid("peer-owner-level");

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

const LOCATION: StoredLocation = {
	id: LOCATION_UUID,
	levelUuid: LEVEL_UUID,
	parentId: null,
	siteCode: "clinic",
	name: "Clinic",
	externalId: null,
	latitude: null,
	longitude: null,
	values: {},
	archivedAt: null,
	orderKey: "1",
};

const mocks = vi.hoisted(() => ({
	doc: undefined as unknown as BlueprintDoc,
	organization: undefined as unknown as OrganizationView,
	levels: [] as OrganizationLevel[],
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDoc: (selector: (doc: BlueprintDoc) => unknown) =>
		selector(mocks.doc),
}));
vi.mock("@/lib/doc/hooks/useOrganizationCollections", () => ({
	useOrganizationLevels: () => mocks.levels,
}));
vi.mock("@/lib/organization/useOrganization", () => ({
	useOrganization: () => mocks.organization,
}));
vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => "app",
}));
vi.mock("@/lib/ui/hooks/useClearedSlotFocus", () => ({
	useClearedSlotFocus: () => ({
		addRef: { current: null },
		onCleared: vi.fn(),
	}),
}));

import { CaseOwnerSection } from "../CaseOperationDetailCanvas";

const editorScope: Parameters<typeof CaseOwnerSection>[0]["editorScope"] = {
	caseTypes: [],
	currentCaseType: "case",
	userProperties: [],
	formFields: [],
	operationScope: { creates: [] },
	caseDataScope: "per-case",
};

function organization(patch: Partial<OrganizationView>): OrganizationView {
	return {
		locations: [],
		revision: "0",
		loading: false,
		error: undefined,
		warning: undefined,
		refreshing: false,
		reload: vi.fn(),
		...patch,
	};
}

beforeEach(() => {
	mocks.doc = buildDoc() as BlueprintDoc;
	mocks.levels = [LEVEL];
});

describe("CaseOwnerSection", () => {
	it("does not call a saved fixed owner missing while the first read is unresolved", () => {
		mocks.organization = organization({ loading: true });
		const props: Parameters<typeof CaseOwnerSection>[0] = {
			action: "create",
			value: term(fixedLocation(LOCATION_UUID)),
			canEdit: true,
			onChange: vi.fn(),
			editorScope,
		};
		const { rerender } = render(<CaseOwnerSection {...props} />);

		expect(screen.getByText("Loading saved place")).toBeDefined();
		expect(
			screen.queryByText("A place that is no longer available"),
		).toBeNull();

		mocks.organization = organization({ error: "Connection failed." });
		rerender(<CaseOwnerSection {...props} />);
		expect(
			screen.getByText("Saved place unavailable until places reload"),
		).toBeDefined();
		expect(
			screen.queryByText("A place that is no longer available"),
		).toBeNull();

		mocks.organization = organization({});
		rerender(<CaseOwnerSection {...props} />);
		expect(
			screen.getByText("A place that is no longer available"),
		).toBeDefined();
	});

	it("shows a peer owner change instead of preserving a stale staged mode", async () => {
		mocks.organization = organization({ locations: [LOCATION] });
		const props: Parameters<typeof CaseOwnerSection>[0] = {
			action: "create",
			value: actingUser(),
			canEdit: true,
			onChange: vi.fn(),
			editorScope,
		};
		const { rerender } = render(<CaseOwnerSection {...props} />);

		fireEvent.click(
			screen.getByRole("combobox", { name: "How to choose the owner" }),
		);
		await settleBaseUiTransitions();
		const fixedOption = screen.getByRole("option", {
			name: "A particular place",
		});
		fireEvent.pointerDown(fixedOption, { pointerType: "mouse" });
		fireEvent.click(fixedOption);
		await settleBaseUiTransitions();
		expect(screen.getByText("Place that owns the case")).toBeDefined();

		rerender(
			<CaseOwnerSection
				{...props}
				value={term(ownerLocationAtLevel(PEER_LEVEL_UUID, "case"))}
			/>,
		);
		await settleBaseUiTransitions();
		expect(
			screen.getByText("Level to find beneath the current owner"),
		).toBeDefined();
		expect(screen.queryByText("Place that owns the case")).toBeNull();
	});
});
