import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	MAX_ATOMIC_LOCATION_DESCENDANTS,
	MAX_LOCATION_VALUES,
	type OrganizationLevel,
	plainColumn,
} from "@/lib/domain";
import { runValidation } from "../runner";

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
	return expectAdmittedDoc(value);
}

function findings(value: BlueprintDoc) {
	return runValidation(value, LOOKUP_CONTEXT_UNAVAILABLE);
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
		let value = doc();
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
		const workflows = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("org-column"), "case_name", "Name")],
						searchInputs: [],
					},
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: "Name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
						...destinationUuids.map((_levelUuid, index) => ({
							name: `Route ${index}`,
							type: "followup" as const,
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						})),
					],
				},
			],
		});
		for (const [index, levelUuid] of destinationUuids.entries()) {
			const formUuid = workflows.formOrder[workflows.moduleOrder[0]][index + 1];
			workflows.forms[formUuid].caseOperations = [
				{
					uuid: testUuid(`reverse-operation-${index}`),
					id: `route_${index}`,
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					owner: {
						kind: "term",
						term: {
							kind: "owner-location-at-level",
							levelUuid,
							ownerCaseType: "patient",
						},
					},
				},
			];
		}
		value = {
			...value,
			caseTypes: workflows.caseTypes,
			modules: workflows.modules,
			forms: workflows.forms,
			fields: workflows.fields,
			moduleOrder: workflows.moduleOrder,
			formOrder: workflows.formOrder,
			fieldOrder: workflows.fieldOrder,
			fieldParent: workflows.fieldParent,
		};
		const lastFormUuid = value.formOrder[value.moduleOrder[0]].at(-1);
		if (!lastFormUuid) throw new Error("Missing final routing form");
		const accepted = structuredClone(value);
		delete accepted.forms[lastFormUuid].caseOperations;
		expectAdmittedDoc(accepted);
		expect(findings(value).map((finding) => finding.code)).toEqual([
			"ORGANIZATION_REVERSE_OWNER_DESTINATION_LIMIT",
		]);

		expect(findings(value)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "ORGANIZATION_REVERSE_OWNER_DESTINATION_LIMIT",
				}),
			]),
		);
	});
});

describe("place-information row capacity", () => {
	it("rejects more applicable required properties than one place can store", () => {
		const value = doc();
		const properties = Array.from(
			{ length: MAX_LOCATION_VALUES + 1 },
			(_, index) => {
				const uuid = testUuid(`required-location-property-${index}`);
				return {
					uuid,
					property: {
						uuid,
						slug: `required_${index}`,
						label: `Required ${index}`,
						required: true as const,
						levelUuids: [FACILITY],
					},
				};
			},
		);
		value.locationProperties = Object.fromEntries(
			properties.map(({ uuid, property }) => [uuid, property]),
		);
		value.locationPropertyOrder = properties.map(({ uuid }) => uuid);

		expect(findings(value)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "LOCATION_PROPERTY_REQUIRED_CAPACITY",
				}),
			]),
		);

		const last = properties.at(-1)?.property;
		if (last === undefined) throw new Error("property fixture missing");
		last.levelUuids = [REGION];
		expectAdmittedDoc(value);
		expect(findings(value)).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "LOCATION_PROPERTY_REQUIRED_CAPACITY",
				}),
			]),
		);
	});
});
