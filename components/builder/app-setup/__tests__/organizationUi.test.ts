import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	LEVEL_CODE_MAX_LENGTH,
	type LocationProperty,
	type OrganizationLevel,
} from "@/lib/domain";
import {
	flattenRequiredReverseHopDescendants,
	localValueSaveDisposition,
	locationValuePatch,
	PERSONA_LOCATION_PAGE_SIZE,
	personaLocationPage,
	placementSaveDraftDisposition,
	propertiesForLevel,
	rebaseLocationValueDraft,
	requiredReverseHopDescendants,
	requiredValuesPresent,
	scalarDraftStillMatchesSave,
	uniqueLevelCode,
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
	it("bounds derived level codes and reserves space for collision suffixes", () => {
		const longName = "A".repeat(LEVEL_CODE_MAX_LENGTH + 20);
		const first = uniqueLevelCode(longName, []);
		const peers = [{ code: first }] as OrganizationLevel[];
		const second = uniqueLevelCode(longName, peers);

		expect(first).toHaveLength(LEVEL_CODE_MAX_LENGTH);
		expect(second).toHaveLength(LEVEL_CODE_MAX_LENGTH);
		expect(second.endsWith("_2")).toBe(true);
		expect(second).not.toBe(first);
		expect(first).toMatch(/^[a-z_][a-z0-9_-]*$/);
		expect(second).toMatch(/^[a-z_][a-z0-9_-]*$/);
	});

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

	it("does not settle a scalar save after the author typed a newer draft", () => {
		expect(scalarDraftStillMatchesSave("newer name", "submitted name")).toBe(
			false,
		);
		expect(
			scalarDraftStillMatchesSave("submitted name", "submitted name"),
		).toBe(true);
	});

	it("records an accepted value save before a staged retype without settling its draft", () => {
		expect(
			localValueSaveDisposition({
				currentBaseLevelUuid: REGION,
				beforeLevelUuid: REGION,
				currentDraftLevelUuid: FACILITY,
				submittedLevelUuid: REGION,
			}),
		).toBe("record-only");
		expect(
			localValueSaveDisposition({
				currentBaseLevelUuid: FACILITY,
				beforeLevelUuid: REGION,
				currentDraftLevelUuid: FACILITY,
				submittedLevelUuid: REGION,
			}),
		).toBe("obsolete");
	});

	it("requires a second apply for values authored during a placement save", () => {
		expect(
			placementSaveDraftDisposition({
				responseIsLatest: true,
				levelMatches: true,
				parentMatches: true,
				valuesMatch: false,
				dirtyValueCount: 1,
			}),
		).toEqual({ current: false, valuesNeedApply: true });
		expect(
			placementSaveDraftDisposition({
				responseIsLatest: true,
				levelMatches: true,
				parentMatches: true,
				valuesMatch: true,
				dirtyValueCount: 0,
			}),
		).toEqual({ current: true, valuesNeedApply: false });
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

		const branch = requiredReverseHopDescendants(doc, FACILITY);
		expect(branch).toHaveLength(1);
		expect(branch[0]?.level.uuid).toBe(queue);
		expect(branch[0]?.descendants[0]?.level.uuid).toBe(room);
		expect(
			flattenRequiredReverseHopDescendants(branch).map((entry) => ({
				level: entry.level.uuid,
				uiPath: entry.uiPath,
			})),
		).toEqual([
			{ level: queue, uiPath: "0" },
			{ level: room, uiPath: "0.0" },
		]);
	});
});
