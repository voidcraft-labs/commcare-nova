// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { fixedLocation, term } from "@/lib/domain/predicate";
import type { OrganizationView } from "@/lib/organization/useOrganization";

const LOCATION_UUID = testUuid("saved-fixed-owner-loading");

const mocks = vi.hoisted(() => ({
	doc: undefined as unknown as BlueprintDoc,
	organization: undefined as unknown as OrganizationView,
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDoc: (selector: (doc: BlueprintDoc) => unknown) =>
		selector(mocks.doc),
}));
vi.mock("@/lib/doc/hooks/useOrganizationCollections", () => ({
	useOrganizationLevels: () => [],
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
});
