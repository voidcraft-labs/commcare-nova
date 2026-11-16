import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import type { BlueprintDoc, OrganizationLevel } from "@/lib/domain";
import { organizationLevelPatchIssue } from "../levelUpdateVerdicts";
import type { StoredLocation } from "../types";

const REGION = testUuid("level-verdict-region");
const FACILITY = testUuid("level-verdict-facility");
const REGION_PLACE = testUuid("level-verdict-region-place");
const FACILITY_PLACE = testUuid("level-verdict-facility-place");
const PERSONA = testUuid("level-verdict-persona");

function level(
	uuid: typeof REGION,
	name: string,
	parentLevelUuid?: typeof REGION,
): OrganizationLevel {
	return {
		uuid,
		code: name.toLowerCase(),
		name,
		...(parentLevelUuid === undefined ? {} : { parentLevelUuid }),
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
}

function fixture(): {
	doc: BlueprintDoc;
	locations: readonly StoredLocation[];
} {
	const base = makeCanonicalGenesisDoc("Organization", "level-verdict-app");
	const doc: BlueprintDoc = {
		...base,
		organizationLevels: {
			[REGION]: level(REGION, "Region"),
			[FACILITY]: level(FACILITY, "Facility", REGION),
		},
		organizationLevelOrder: [REGION, FACILITY],
		personas: {
			[PERSONA]: {
				uuid: PERSONA,
				name: "Asha",
				locations: { primaryUuid: FACILITY_PLACE },
			},
		},
		personaOrder: [PERSONA],
	};
	const baseLocation = {
		siteCode: "place",
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: "1",
	} as const;
	return {
		doc,
		locations: [
			{
				...baseLocation,
				id: REGION_PLACE,
				levelUuid: REGION,
				parentId: null,
				name: "North",
			},
			{
				...baseLocation,
				id: FACILITY_PLACE,
				levelUuid: FACILITY,
				parentId: REGION_PLACE,
				name: "Clinic",
			},
		],
	};
}

describe("organizationLevelPatchIssue", () => {
	it("refuses a parent gesture that would invalidate existing places", () => {
		const { doc, locations } = fixture();
		expect(
			organizationLevelPatchIssue(doc, locations, FACILITY, {
				parentLevelUuid: null,
			}),
		).toMatch(/Clinic.*level above|Clinic.*parent place/);
	});

	it("explains how to move an archived place before changing its level", () => {
		const { doc, locations } = fixture();
		const archived = locations.map((location) =>
			location.id === FACILITY_PLACE
				? { ...location, archivedAt: new Date("2026-08-03T00:00:00.000Z") }
				: location,
		);
		expect(
			organizationLevelPatchIssue(doc, archived, FACILITY, {
				parentLevelUuid: null,
			}),
		).toMatch(/bring it back.*move it to a valid parent/i);
	});

	it("sends the person to CommCare HQ where it manages the places, and passes over places it no longer lists", () => {
		const { doc, locations } = fixture();
		expect(
			organizationLevelPatchIssue(
				doc,
				locations,
				FACILITY,
				{ parentLevelUuid: null },
				{ domain: "district-health", goneIds: new Set() },
			),
		).toBe(
			"“Clinic” wouldn't fit where it stands after this level change, and this app's places are managed in CommCare HQ (district-health). You can move it there and refresh, then try the change again.",
		);
		// Archived in a managed copy: a place CommCare HQ no longer lists.
		const archived = locations.map((location) =>
			location.id === FACILITY_PLACE
				? { ...location, archivedAt: new Date("2026-08-03T00:00:00.000Z") }
				: location,
		);
		const unassigned: BlueprintDoc = {
			...doc,
			personas: { [PERSONA]: { uuid: PERSONA, name: "Asha" } },
		};
		expect(
			organizationLevelPatchIssue(
				unassigned,
				archived,
				FACILITY,
				{ parentLevelUuid: null },
				{ domain: "district-health", goneIds: new Set() },
			),
		).toBeUndefined();
		// Without a managing project space the archived place still counts.
		expect(
			organizationLevelPatchIssue(unassigned, archived, FACILITY, {
				parentLevelUuid: null,
			}),
		).toMatch(/bring it back.*move it to a valid parent/i);
	});

	it("sends the person to what uses a live place CommCare HQ no longer has", () => {
		const { doc, locations } = fixture();
		expect(
			organizationLevelPatchIssue(
				doc,
				locations,
				FACILITY,
				{ parentLevelUuid: null },
				{ domain: "district-health", goneIds: new Set([FACILITY_PLACE]) },
			),
		).toBe(
			"“Clinic” wouldn't fit where it stands after this level change. CommCare HQ (district-health) no longer has it, and Nova keeps it only while something in this app uses it or a place below it. You can move or change what uses it and refresh, then try the change again.",
		);
	});

	it("refuses turning off workers while a persona remains assigned", () => {
		const { doc, locations } = fixture();
		expect(
			organizationLevelPatchIssue(doc, locations, FACILITY, {
				caseFlow: { workers: "none", ownsCases: true },
			}),
		).toMatch(/Asha is assigned/);
	});
	it("permits a label-only change and leaves the input document intact", () => {
		const { doc, locations } = fixture();
		const before = structuredClone(doc);
		expect(
			organizationLevelPatchIssue(doc, locations, FACILITY, {
				name: "Health facility",
			}),
		).toBeUndefined();
		expect(doc).toEqual(before);
	});
	it("refuses a level that disappeared after the view loaded", () => {
		const { doc, locations } = fixture();
		expect(
			organizationLevelPatchIssue(doc, locations, testUuid("missing-level"), {
				name: "Missing",
			}),
		).toBe("This level no longer exists.");
	});
});
