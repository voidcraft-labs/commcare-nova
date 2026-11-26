import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { proofPlaceWorkbook } from "@/proof/hq/fixtures/placeWorkbook";
import type { HqLocation } from "../hq/locations";
import {
	PlaceWorkbookMismatch,
	placeIdWorkbookMembers,
} from "../hq/placeWorkbook";

it("produces exactly the workbook HQ imports into the retained destination", async () => {
	expect(await proofPlaceWorkbook()).toEqual(
		readFileSync("proof/hq/fixtures/place-external-id.xlsx"),
	);
});

const place: HqLocation = {
	locationId: "remote",
	siteCode: "north",
	name: "North",
	parentLocationId: null,
	locationTypeCode: "region",
	longitude: null,
	latitude: null,
	values: {},
	observation: { externalId: null, nameIsNull: false, worker: {}, wire: {} },
};

it.each([
	{ externalId: " A" },
	{ externalId: "A\u0085" },
	{ place: { ...place, siteCode: "North" } },
	{ place: { ...place, name: "P\u0000lace" } },
	{ place: { ...place, values: { important: true } } },
	{ place: { ...place, values: { "already there": "yes" } } },
])(
	"refuses a native import that would overwrite the destination's data",
	(change) => {
		expect(() =>
			placeIdWorkbookMembers(
				"elsewhere",
				[],
				[{ place, externalId: "A", parentCode: null, ...change }],
			),
		).toThrow(PlaceWorkbookMismatch);
	},
);
