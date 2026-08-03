import { describe, expect, it } from "vitest";
import { asUuid, type LocationProperty } from "@/lib/domain";
import {
	PERSONA_LOCATION_PAGE_SIZE,
	personaLocationPage,
	propertiesForLevel,
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
});
