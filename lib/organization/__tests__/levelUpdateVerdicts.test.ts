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

	it("refuses turning off workers while a persona remains assigned", () => {
		const { doc, locations } = fixture();
		expect(
			organizationLevelPatchIssue(doc, locations, FACILITY, {
				caseFlow: { workers: "none", ownsCases: true },
			}),
		).toMatch(/Asha is assigned/);
	});
});
