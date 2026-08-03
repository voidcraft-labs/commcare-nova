import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { asUuid, type BlueprintDoc, type LocationProperty } from "@/lib/domain";
import {
	locationValuePatch,
	PERSONA_LOCATION_PAGE_SIZE,
	personaLocationPage,
	propertiesForLevel,
	rebaseLocationValueDraft,
	requiredReverseHopDescendants,
	requiredValuesPresent,
	valuesForLevel,
} from "../organizationUi";

const REGION = asUuid("11111111-1111-4111-8111-111111111111");
const FACILITY = asUuid("22222222-2222-4222-8222-222222222222");
const EVERYWHERE = asUuid("33333333-3333-4333-8333-333333333333");
const FACILITY_ONLY = asUuid("44444444-4444-4444-8444-444444444444");

const properties: LocationProperty[] = [
	{
		uuid: EVERYWHERE,
		slug: "phone",
		label: "Phone",
		required: true,
	},
	{
		uuid: FACILITY_ONLY,
		slug: "kind",
		label: "Facility kind",
		levelUuids: [FACILITY],
		choices: ["Clinic", "Hospital"],
	},
];

describe("organization place-information UI", () => {
	it("mounts only one bounded page of a maximum-size persona assignment", () => {
		const assigned = Array.from({ length: 10_000 }, (_, index) =>
			String(index),
		);
		const page = personaLocationPage(assigned, 199);
		expect(page.ids).toHaveLength(PERSONA_LOCATION_PAGE_SIZE);
		expect(page.ids[0]).toBe("9950");
		expect(page.ids.at(-1)).toBe("9999");
		expect(page.pageCount).toBe(200);
	});

	it("projects the authored catalog to the selected level", () => {
		expect(
			propertiesForLevel(properties, REGION).map(({ uuid }) => uuid),
		).toEqual([EVERYWHERE]);
		expect(
			propertiesForLevel(properties, FACILITY).map(({ uuid }) => uuid),
		).toEqual([EVERYWHERE, FACILITY_ONLY]);
	});

	it("drops values a changed level can no longer carry", () => {
		expect(
			valuesForLevel(properties, REGION, {
				[EVERYWHERE]: "555-0100",
				[FACILITY_ONLY]: "Clinic",
			}),
		).toEqual({ [EVERYWHERE]: "555-0100" });
	});

	it("requires only applicable required values", () => {
		expect(requiredValuesPresent(properties, FACILITY, {})).toBe(false);
		expect(
			requiredValuesPresent(properties, FACILITY, { [EVERYWHERE]: "555-0100" }),
		).toBe(true);
	});

	it("rebases an async field save without erasing another in-progress draft", () => {
		expect(
			rebaseLocationValueDraft(
				{ [EVERYWHERE]: "saved A", [FACILITY_ONLY]: "peer B" },
				{ [FACILITY_ONLY]: "local B" },
			),
		).toEqual({
			[EVERYWHERE]: "saved A",
			[FACILITY_ONLY]: "local B",
		});
	});

	it("transports Clear as key deletion rather than a stored empty string", () => {
		expect(locationValuePatch("")).toBeNull();
		expect(locationValuePatch("Clinic")).toBe("Clinic");
	});

	it("plans every reverse-hop destination below a new source in one branch", () => {
		const queue = asUuid("55555555-5555-4555-8555-555555555555");
		const room = asUuid("66666666-6666-4666-8666-666666666666");
		const doc = buildDoc({
			modules: [
				{
					name: "Organization",
					forms: [{ name: "Route", type: "survey" }],
				},
			],
		}) as BlueprintDoc;
		const formUuid = doc.formOrder[doc.moduleOrder[0]]?.[0];
		if (formUuid === undefined) throw new Error("fixture form missing");
		doc.forms[formUuid].caseOperations = [
			{
				uuid: asUuid("77777777-7777-4777-8777-777777777777"),
				id: "route-to-queue",
				action: "update",
				caseType: "case",
				target: { kind: "session" },
				owner: {
					kind: "term",
					term: {
						kind: "owner-location-at-level",
						levelUuid: queue,
						ownerCaseType: "case",
					},
				},
			},
			{
				uuid: asUuid("88888888-8888-4888-8888-888888888888"),
				id: "route-to-room",
				action: "update",
				caseType: "case",
				target: { kind: "session" },
				owner: {
					kind: "term",
					term: {
						kind: "owner-location-at-level",
						levelUuid: room,
						ownerCaseType: "case",
					},
				},
			},
		];
		doc.organizationLevels = {
			[FACILITY]: {
				uuid: FACILITY,
				code: "facility",
				name: "Facility",
				caseFlow: {
					workers: "assigned" as const,
					ownsCases: true,
					descendantCases: { kind: "none" as const },
				},
				addressBook: { reach: "own-branch" as const },
			},
			[queue]: {
				uuid: queue,
				code: "queue",
				name: "Queue",
				parentLevelUuid: FACILITY,
				caseFlow: { workers: "none" as const, ownsCases: true },
				addressBook: { reach: "own-branch" as const },
			},
			[room]: {
				uuid: room,
				code: "room",
				name: "Room",
				parentLevelUuid: queue,
				caseFlow: { workers: "none" as const, ownsCases: true },
				addressBook: { reach: "own-branch" as const },
			},
		};
		doc.organizationLevelOrder = [FACILITY, queue, room];

		expect(
			requiredReverseHopDescendants(doc, FACILITY).map((entry) => ({
				level: entry.level.uuid,
				parentKey: entry.parentKey,
			})),
		).toEqual([
			{ level: queue, parentKey: null },
			{ level: room, parentKey: "required-1" },
		]);
	});
});
