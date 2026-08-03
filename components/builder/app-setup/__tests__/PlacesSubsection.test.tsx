// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
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
const OTHER_LEVEL_UUID = testUuid("warehouse-level");
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

const OTHER_LEVEL: OrganizationLevel = {
	uuid: OTHER_LEVEL_UUID,
	code: "warehouse",
	name: "Warehouse",
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
	levels: [] as OrganizationLevel[],
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDoc: (selector: (doc: BlueprintDoc) => unknown) =>
		selector(mocks.doc),
}));
vi.mock("@/lib/doc/hooks/useOrganizationCollections", () => ({
	useOrganizationLevels: () => mocks.levels,
	useLocationProperties: () => [],
}));
vi.mock("@/lib/session/hooks", () => ({
	useCanEdit: () => true,
}));

import { PlacesSubsection } from "../PlacesSubsection";

function pressSelectOption(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse" });
	fireEvent.click(option);
}

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
	mocks.levels = [LEVEL];
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

	it("adopts the server's normalized scalar spelling", async () => {
		const update = vi.fn().mockResolvedValue({
			ok: true,
			location: { ...LOCATION, name: "Clinic North" },
		});
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
		fireEvent.change(name, { target: { value: "  Clinic North  " } });
		fireEvent.blur(name);

		await waitFor(() => expect(name.value).toBe("Clinic North"));
	});

	it("keeps a conflicted draft mounted and blocks paging until recovery", async () => {
		const extraLocations = Array.from({ length: 100 }, (_, index) => ({
			...LOCATION,
			id: testUuid(`extra-place-${index}`),
			siteCode: `extra-${index}`,
			name: `Extra ${index}`,
			orderKey: `b${String(index).padStart(2, "0")}`,
		}));
		const update = vi.fn();
		const initial = organization([LOCATION, ...extraLocations], update);
		const { rerender } = render(<PlacesSubsection organization={initial} />);

		const row = screen.getByRole("button", {
			name: /Clinic clinic Depth 1 Facility/,
		});
		fireEvent.click(row);
		await settleBaseUiTransitions();
		const name = screen.getByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: "Local draft" } });
		const peer = { ...LOCATION, name: "Peer name" };
		rerender(
			<PlacesSubsection
				organization={organization([peer, ...extraLocations], update)}
			/>,
		);

		await screen.findByText(/This place changed while you were editing/);
		const pager = screen.getByRole("group", { name: "Place pages" });
		expect(
			(within(pager).getByRole("button", { name: "Next" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.click(
			screen.getByRole("button", {
				name: /Peer name clinic Depth 1 Facility/,
			}),
		);
		await settleBaseUiTransitions();
		expect(
			(screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value,
		).toBe("Local draft");
	});

	it("invalidates an older scalar response after explicit conflict recovery", async () => {
		let resolveUpdate:
			| ((value: { ok: boolean; location: StoredLocation }) => void)
			| undefined;
		const update = vi.fn(
			() =>
				new Promise<{ ok: boolean; location: StoredLocation }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		const { rerender } = render(
			<PlacesSubsection organization={organization([LOCATION], update)} />,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /Clinic clinic Depth 1 Facility/ }),
		);
		await settleBaseUiTransitions();
		const name = screen.getByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: "Older local save" } });
		fireEvent.blur(name);
		const peer = { ...LOCATION, name: "Peer name" };
		rerender(<PlacesSubsection organization={organization([peer], update)} />);
		fireEvent.click(
			await screen.findByRole("button", { name: "Use latest saved values" }),
		);
		expect((name as HTMLInputElement).value).toBe("Peer name");

		await act(async () => {
			resolveUpdate?.({
				ok: true,
				location: { ...LOCATION, name: "Older local save" },
			});
		});
		expect((name as HTMLInputElement).value).toBe("Peer name");
	});

	it("preserves a newer retype draft when an older level save returns", async () => {
		mocks.levels = [LEVEL, OTHER_LEVEL];
		mocks.doc.organizationLevels = {
			[LEVEL_UUID]: LEVEL,
			[OTHER_LEVEL_UUID]: OTHER_LEVEL,
		};
		mocks.doc.organizationLevelOrder = [LEVEL_UUID, OTHER_LEVEL_UUID];
		let resolveUpdate:
			| ((value: { ok: boolean; location: StoredLocation }) => void)
			| undefined;
		const update = vi.fn(
			() =>
				new Promise<{ ok: boolean; location: StoredLocation }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		render(
			<PlacesSubsection organization={organization([LOCATION], update)} />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Clinic clinic Depth 1 Facility/ }),
		);
		await settleBaseUiTransitions();

		const level = screen.getByRole("combobox", { name: "Level" });
		fireEvent.click(level);
		await settleBaseUiTransitions();
		pressSelectOption(await screen.findByRole("option", { name: "Warehouse" }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Apply level change" }));
		fireEvent.click(level);
		await settleBaseUiTransitions();
		pressSelectOption(await screen.findByRole("option", { name: "Facility" }));
		await settleBaseUiTransitions();

		await act(async () => {
			resolveUpdate?.({
				ok: true,
				location: { ...LOCATION, levelUuid: OTHER_LEVEL_UUID },
			});
		});
		expect(level.textContent).toContain("Facility");
		expect(
			(
				screen.getByRole("button", {
					name: "Apply level change",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});
});
