// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, OrganizationLevel } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import type {
	OrganizationView,
	OrganizationWriter,
} from "@/lib/organization/useOrganization";

const LEVEL_UUID = testUuid("facility-level");
const LOCATION_UUID = testUuid("clinic");

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
	orderKey: "a",
};

const mocks = vi.hoisted(() => ({
	doc: undefined as unknown as BlueprintDoc,
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDoc: (selector: (doc: BlueprintDoc) => unknown) =>
		selector(mocks.doc),
}));
vi.mock("@/lib/doc/hooks/useOrganizationCollections", () => ({
	useOrganizationLevels: () => [LEVEL],
	useLocationProperties: () => [],
}));
vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => true,
}));

import { PlacesSubsection } from "../PlacesSubsection";

function organization(
	locations: readonly StoredLocation[],
	update: OrganizationWriter["update"],
): OrganizationView & OrganizationWriter {
	return {
		locations,
		revision: "1",
		loading: false,
		error: undefined,
		warning: undefined,
		refreshing: false,
		reload: vi.fn(),
		create: vi.fn(),
		update,
		move: vi.fn(),
		describeArchive: vi.fn(),
		setArchived: vi.fn(),
	};
}

beforeEach(() => {
	const doc = buildDoc() as BlueprintDoc;
	doc.organizationLevels = { [LEVEL_UUID]: LEVEL };
	doc.organizationLevelOrder = [LEVEL_UUID];
	mocks.doc = doc;
});

describe("PlacesSubsection", () => {
	it("preserves a newer scalar draft across an older save response and refresh", async () => {
		let resolveUpdate:
			| ((value: { ok: boolean; location: StoredLocation }) => void)
			| undefined;
		const update = vi.fn(
			() =>
				new Promise<{ ok: boolean; location: StoredLocation }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		const initial = organization([LOCATION], update);
		const { rerender } = render(<PlacesSubsection organization={initial} />);

		fireEvent.click(
			screen.getByRole("button", { name: /Clinic clinic Depth 1 Facility/ }),
		);
		await settleBaseUiTransitions();
		const name = screen.getByRole("textbox", {
			name: "Name",
		}) as HTMLInputElement;
		fireEvent.change(name, { target: { value: "Submitted name" } });
		fireEvent.blur(name);
		expect(update).toHaveBeenCalledWith(LOCATION_UUID, {
			name: "Submitted name",
		});

		fireEvent.change(name, { target: { value: "Newer local name" } });
		const saved = { ...LOCATION, name: "Submitted name" };
		await act(async () => {
			resolveUpdate?.({ ok: true, location: saved });
		});
		expect(name.value).toBe("Newer local name");

		rerender(<PlacesSubsection organization={organization([saved], update)} />);
		await waitFor(() => expect(name.value).toBe("Newer local name"));
	});

	it("saves a revert typed while an older scalar save is still pending", async () => {
		const resolvers: Array<
			(value: { ok: boolean; location: StoredLocation }) => void
		> = [];
		const update = vi.fn(
			() =>
				new Promise<{ ok: boolean; location: StoredLocation }>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		render(
			<PlacesSubsection organization={organization([LOCATION], update)} />,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /Clinic clinic Depth 1 Facility/ }),
		);
		await settleBaseUiTransitions();
		const name = screen.getByRole("textbox", {
			name: "Name",
		}) as HTMLInputElement;
		fireEvent.change(name, { target: { value: "Older pending name" } });
		fireEvent.blur(name);
		fireEvent.change(name, { target: { value: LOCATION.name } });
		fireEvent.blur(name);

		expect(update).toHaveBeenNthCalledWith(1, LOCATION_UUID, {
			name: "Older pending name",
		});
		expect(update).toHaveBeenNthCalledWith(2, LOCATION_UUID, {
			name: LOCATION.name,
		});

		await act(async () => {
			resolvers[0]?.({
				ok: true,
				location: { ...LOCATION, name: "Older pending name" },
			});
		});
		expect(name.value).toBe(LOCATION.name);
		await act(async () => {
			resolvers[1]?.({ ok: true, location: LOCATION });
		});
	});
});
