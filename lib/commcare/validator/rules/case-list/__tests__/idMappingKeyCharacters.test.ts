import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import {
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withColumns,
} from "./caseListRuleFixture";

const caseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "zone", label: proseText("Zone"), data_type: "text" as const },
		],
	},
];

describe("ID-mapping key characters", () => {
	it.each(["&", "<", ">", '"', "'"])(
		"refuses a saved value holding %s beside an accepted neighbour",
		(character) => {
			const column = idMappingColumn(testUuid("zone"), "zone", "Zone", [
				idMappingEntry("a.b", "Accepted"),
				idMappingEntry(`a${character}b`, "Refused"),
			]);
			const result = findings(
				withColumns(admittedCaseListDoc({ caseTypes }), [column]),
			);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				code: "CASE_LIST_ID_MAPPING_KEY_CHARACTERS",
				location: { moduleName: "Patients" },
				details: {
					slot: "caseListConfig.columns[0].mapping[1].value",
					columnIndex: "0",
					rowIndex: "1",
					columnUuid: column.uuid,
					value: `a${character}b`,
				},
			});
			expect(result[0].message).toBe(
				`ID-mapping column "Zone" (column #1) on module "Patients" maps the value "a${character}b" (row 2). An ID mapping value can't hold &, <, >, " or ': CommCare HQ's ID mapping has no way to store one. Change the value or remove the row.`,
			);
		},
	);

	it("accepts an image-map value holding a straight apostrophe", () => {
		const column = imageMapColumn(testUuid("zone-image"), "zone", "Zone", [
			imageMapEntry("it's.x", testMediaAssetId("zone-image")),
		]);
		expect(
			findings(withColumns(admittedCaseListDoc({ caseTypes }), [column])),
		).toEqual([]);
	});
});
