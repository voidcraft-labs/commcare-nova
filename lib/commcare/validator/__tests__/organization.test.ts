import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import {
	type BlueprintDoc,
	MAX_ATOMIC_LOCATION_DESCENDANTS,
	type OrganizationLevel,
} from "@/lib/domain";
import { ORGANIZATION_RULES } from "../rules/organization";

const REGION = testUuid("organization-rule-region");
const DISTRICT = testUuid("organization-rule-district");
const FACILITY = testUuid("organization-rule-facility");

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

function doc(): BlueprintDoc {
	const value = structuredClone(
		makeCanonicalGenesisDoc("Organization rules", "app"),
	);
	value.organizationLevels = {
		[REGION]: level(REGION, "Region"),
		[DISTRICT]: level(DISTRICT, "District", REGION),
		[FACILITY]: level(FACILITY, "Facility", DISTRICT),
	};
	value.organizationLevelOrder = [REGION, DISTRICT, FACILITY];
	return value;
}

function findings(value: BlueprintDoc) {
	return ORGANIZATION_RULES.flatMap((rule) => rule(value));
}

describe("organization address-book level references", () => {
	it("checks a shared-branch cap from its widened base, not the worker level", () => {
		const value = doc();
		const levels = value.organizationLevels;
		if (levels === undefined) throw new Error("organization levels missing");
		value.organizationLevels = {
			...levels,
			[DISTRICT]: {
				...levels[DISTRICT],
				addressBook: {
					reach: "shared-branch",
					fromLevelUuid: REGION,
					downToLevelUuid: REGION,
				},
			},
		};
		expect(findings(value)).toEqual([]);
	});

	it("allows a whole-organization cap at any current level", () => {
		const value = doc();
		const levels = value.organizationLevels;
		if (levels === undefined) throw new Error("organization levels missing");
		value.organizationLevels = {
			...levels,
			[FACILITY]: {
				...levels[FACILITY],
				addressBook: {
					reach: "whole-organization",
					downToLevelUuid: REGION,
				},
			},
		};
		expect(findings(value)).toEqual([]);
	});

	it("rejects an own-branch-limited level that can never be in the branch", () => {
		const value = doc();
		const levels = value.organizationLevels;
		if (levels === undefined) throw new Error("organization levels missing");
		value.organizationLevels = {
			...levels,
			[FACILITY]: {
				...levels[FACILITY],
				addressBook: {
					reach: "own-branch-limited",
					levelUuids: [REGION],
				},
			},
		};
		expect(findings(value)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "ORGANIZATION_LEVEL_CAP_NOT_BELOW" }),
			]),
		);
	});

	it("requires a limited own branch to include itself and every intermediate level", () => {
		const value = doc();
		const levels = value.organizationLevels;
		if (levels === undefined) throw new Error("organization levels missing");
		value.organizationLevels = {
			...levels,
			[REGION]: {
				...levels[REGION],
				addressBook: {
					reach: "own-branch-limited",
					levelUuids: [REGION, FACILITY],
				},
			},
		};
		expect(findings(value)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "ORGANIZATION_LEVEL_SCOPE_GAP" }),
			]),
		);

		value.organizationLevels = {
			...levels,
			[DISTRICT]: {
				...levels[DISTRICT],
				addressBook: {
					reach: "own-branch-limited",
					levelUuids: [FACILITY],
				},
			},
		};
		expect(findings(value)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "ORGANIZATION_LEVEL_SCOPE_GAP" }),
			]),
		);
	});
});

describe("organization reverse-hop construction bounds", () => {
	it("rejects more distinct destinations than one atomic source create can carry", () => {
		const value = doc();
		const destinationUuids = Array.from(
			{ length: MAX_ATOMIC_LOCATION_DESCENDANTS + 1 },
			(_, index) => testUuid(`reverse-destination-${index}`),
		);
		value.organizationLevels = {
			[REGION]: level(REGION, "Region"),
			...Object.fromEntries(
				destinationUuids.map((uuid, index) => [
					uuid,
					level(uuid, `Destination_${index}`, REGION),
				]),
			),
		};
		value.organizationLevelOrder = [REGION, ...destinationUuids];
		const formUuid = value.formOrder[value.moduleOrder[0]]?.[0];
		if (formUuid === undefined) throw new Error("fixture form missing");
		value.forms[formUuid].caseOperations = destinationUuids.map(
			(levelUuid, index) => ({
				uuid: testUuid(`reverse-operation-${index}`),
				id: `route_${index}`,
				action: "update" as const,
				caseType: "case",
				target: { kind: "session" as const },
				owner: {
					kind: "term" as const,
					term: {
						kind: "owner-location-at-level" as const,
						levelUuid,
						ownerCaseType: "case",
					},
				},
			}),
		);

		expect(findings(value)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "ORGANIZATION_REVERSE_OWNER_DESTINATION_LIMIT",
				}),
			]),
		);
	});
});
