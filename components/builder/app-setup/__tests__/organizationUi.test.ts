import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	LEVEL_CODE_MAX_LENGTH,
	type LocationProperty,
	type OrganizationLevel,
} from "@/lib/domain";
import { organizationLevelSchema } from "@/lib/domain/organization";
import {
	flattenRequiredReverseHopDescendants,
	personaLocationPage,
	propertiesForLevel,
	requiredReverseHopDescendants,
	requiredValuesPresent,
	uniqueLevelCode,
	valuesForLevel,
} from "../organizationUi";

const region = testUuid("plan-region"),
	facility = testUuid("plan-facility"),
	queue = testUuid("plan-queue"),
	room = testUuid("plan-room"),
	bay = testUuid("plan-bay");
const phone = testUuid("plan-phone"),
	kind = testUuid("plan-kind");
function level(
	uuid: OrganizationLevel["uuid"],
	code: string,
	parentLevelUuid?: OrganizationLevel["uuid"],
): OrganizationLevel {
	return {
		uuid,
		code,
		name: code,
		...(parentLevelUuid === undefined ? {} : { parentLevelUuid }),
		caseFlow: { workers: "none", ownsCases: true },
		addressBook: { reach: "own-branch" },
	};
}
const properties: readonly LocationProperty[] = [
	{ uuid: phone, slug: "phone", label: "Phone", required: true },
	{
		uuid: kind,
		slug: "kind",
		label: "Facility kind",
		required: true,
		levelUuids: [facility],
		choices: ["Clinic", "Hospital"],
	},
];

describe("organization authoring projections", () => {
	it("derives schema-accepted level codes and searches collisions within the length limit", () => {
		for (const [name, expected] of [
			["North Coast", "north_coast"],
			["12 wards", "l_12_wards"],
			["!!!", "level"],
			[" RÉGION / North ", "r_gion_north"],
		]) {
			const code = uniqueLevelCode(name, []);
			expect(code).toBe(expected);
			expect(
				organizationLevelSchema.safeParse(level(region, code)).success,
			).toBe(true);
		}
		const long = "a".repeat(LEVEL_CODE_MAX_LENGTH);
		const peers = [
			level(region, long),
			level(facility, `${long.slice(0, -2)}_2`),
			level(queue, `${long.slice(0, -2)}_3`),
		];
		expect(uniqueLevelCode(`${long} plus`, peers)).toBe(
			`${long.slice(0, -2)}_4`,
		);
		expect(peers.map((peer) => peer.code)).toEqual([
			long,
			`${long.slice(0, -2)}_2`,
			`${long.slice(0, -2)}_3`,
		]);
	});

	it("returns bounded assignment slices and clamps a removed last page", () => {
		const ids = Array.from(
			{ length: 10_000 },
			(_, index) => `assignment-${index}`,
		);
		expect(personaLocationPage(ids, 199)).toEqual({
			ids: ids.slice(9950),
			page: 199,
			pageCount: 200,
			start: 9950,
		});
		expect(personaLocationPage(ids.slice(0, 50), 199)).toEqual({
			ids: ids.slice(0, 50),
			page: 0,
			pageCount: 1,
			start: 0,
		});
		expect(personaLocationPage(ids, -1)).toEqual({
			ids: ids.slice(0, 50),
			page: 0,
			pageCount: 200,
			start: 0,
		});
		expect(personaLocationPage([], 3)).toEqual({
			ids: [],
			page: 0,
			pageCount: 1,
			start: 0,
		});
	});

	it("projects the ordered applicable catalog and values without mutating either", () => {
		const values = {
			[phone]: "555-0100",
			[kind]: "Clinic",
			[testUuid("removed-property")]: "old value",
		};
		const before = structuredClone({ properties, values });
		expect(propertiesForLevel(properties, region)).toEqual([properties[0]]);
		expect(propertiesForLevel(properties, facility)).toEqual(properties);
		expect(valuesForLevel(properties, region, values)).toEqual({
			[phone]: "555-0100",
		});
		expect(valuesForLevel(properties, facility, values)).toEqual({
			[phone]: "555-0100",
			[kind]: "Clinic",
		});
		expect({ properties, values }).toEqual(before);
	});

	it("requires every applicable mandatory value while leaving accepted-value admission to the writer", () => {
		expect(requiredValuesPresent(properties, region, {})).toBe(false);
		expect(requiredValuesPresent(properties, region, { [phone]: "" })).toBe(
			false,
		);
		expect(
			requiredValuesPresent(properties, region, { [phone]: "555-0100" }),
		).toBe(true);
		expect(
			requiredValuesPresent(properties, facility, { [phone]: "555-0100" }),
		).toBe(false);
		expect(
			requiredValuesPresent(properties, facility, {
				[phone]: "555-0100",
				[kind]: "Clinic",
			}),
		).toBe(true);
		expect(
			requiredValuesPresent(
				properties.map((property) => ({ ...property, required: false })),
				region,
				{},
			),
		).toBe(true);
	});

	it("plans branched and chained reverse-owner destinations in authored order without duplicate requests", () => {
		const formUuid = testUuid("plan-form");
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: formUuid,
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		doc.organizationLevels = {
			[region]: level(region, "region"),
			[facility]: level(facility, "facility", region),
			[queue]: level(queue, "queue", facility),
			[room]: level(room, "room", queue),
			[bay]: level(bay, "bay", facility),
		};
		doc.organizationLevelOrder = [region, facility, bay, queue, room];
		doc.forms[formUuid].caseOperations = [queue, room, bay, queue].map(
			(uuid, index) => ({
				uuid: testUuid(`plan-owner-${index}`),
				id: `route_${index}`,
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: {
					kind: "term",
					term: {
						kind: "owner-location-at-level",
						levelUuid: uuid,
						ownerCaseType: "patient",
					},
				},
			}),
		);
		const before = structuredClone(doc);
		const branch = requiredReverseHopDescendants(doc, facility);
		expect(branch).toEqual([
			{
				uiPath: "0",
				level: doc.organizationLevels[bay],
				depth: 0,
				descendants: [],
			},
			{
				uiPath: "1",
				level: doc.organizationLevels[queue],
				depth: 0,
				descendants: [
					{
						uiPath: "1.0",
						level: doc.organizationLevels[room],
						depth: 1,
						descendants: [],
					},
				],
			},
		]);
		expect(
			flattenRequiredReverseHopDescendants(branch).map(
				({ level, depth, uiPath }) => ({ level: level.uuid, depth, uiPath }),
			),
		).toEqual([
			{ level: bay, depth: 0, uiPath: "0" },
			{ level: queue, depth: 0, uiPath: "1" },
			{ level: room, depth: 1, uiPath: "1.0" },
		]);
		expect(requiredReverseHopDescendants(doc, region)).toEqual([]);
		expect(requiredReverseHopDescendants(doc, room)).toEqual([]);
		expect(doc).toEqual(before);
	});
});
