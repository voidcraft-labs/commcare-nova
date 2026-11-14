// A column that is not on the list (`notOnList`) holds `visibleInList: false`
// and no order rule. The gate refuses each other pairing with its reason, and
// Default order's Add menu asks the same rule about a choice
// (`caseListOrderChoiceRefusal`), so the menu withholds exactly what the gate
// would refuse, with the code's builder line.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { caseListOrderChoiceRefusal } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type Column,
	type ColumnCommonSlots,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import { runValidation } from "../../../runner";

const NAME = testUuid("not-on-list-name");
const VILLAGE = testUuid("not-on-list-village");
const SORT = { direction: "asc", priority: 0 } as const;

const nameColumn = plainColumn(NAME, "case_name", "Name", {
	tile: tileCell(0, 0, 6, 1),
});
const village = (slots: ColumnCommonSlots) =>
	plainColumn(VILLAGE, "village", "Village", slots);

function docWith(columns: readonly Column[], tile: boolean): BlueprintDoc {
	const doc = buildDoc({
		appName: "Villages",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "village", label: "Village", data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [...columns],
					searchInputs: [],
					...(tile && { tile: {} }),
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}

const findingsFor = (columns: readonly Column[], tile = false) =>
	runValidation(docWith(columns, tile), LOOKUP_CONTEXT_UNAVAILABLE);

describe("CASE_LIST_COLUMN_NOT_ON_LIST_INVALID", () => {
	it.each([
		["shown with no visibleInList", { notOnList: true } as const],
		[
			"shown with visibleInList true",
			{ notOnList: true, visibleInList: true } as const,
		],
	])("refuses a column off the list and %s, as shown", (_case, slots) => {
		const result = findingsFor([nameColumn, village(slots)]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			code: "CASE_LIST_COLUMN_NOT_ON_LIST_INVALID",
			details: {
				slot: "caseListConfig.columns[1].notOnList",
				columnUuid: VILLAGE,
				reason: "shown",
			},
		});
		expect(result[0].message).toBe(
			'The "Village" column is set to show on Results and also to stay off the list. A column that is off the list is hidden on Results. You can hide it on Results, or put it back on the list.',
		);
	});

	it.each([
		["with no tile", false],
		["in a tile list", true],
	])(
		"refuses a column off the list with an order rule %s, as sorted",
		(_case, tile) => {
			const result = findingsFor(
				[
					nameColumn,
					village({ visibleInList: false, notOnList: true, sort: SORT }),
				],
				tile,
			);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				code: "CASE_LIST_COLUMN_NOT_ON_LIST_INVALID",
				details: { columnUuid: VILLAGE, reason: "sorted" },
			});
			expect(result[0].message).toBe(
				`The "Village" column isn't on the list, so the list can't sort by it. You can remove its sort rule, or keep the column on the list as a hidden one, which the list's search then matches.`,
			);
		},
	);

	it("names a column with a blank header by its property", () => {
		const result = findingsFor([
			nameColumn,
			plainColumn(VILLAGE, "village", "", { notOnList: true }),
		]);
		expect(result[0]?.message).toMatch(/^The "village" column is set to show/);
	});

	it.each([
		["shown on Details", {}],
		["hidden from Details too", { visibleInDetail: false } as const],
	])("admits a column off the list and %s", (_case, slots) => {
		for (const tile of [false, true]) {
			expect(
				findingsFor(
					[
						nameColumn,
						village({ visibleInList: false, notOnList: true, ...slots }),
					],
					tile,
				),
			).toEqual([]);
		}
	});

	it("admits a hidden column on the list with an order rule, which the off-list state may not hold", () => {
		expect(
			findingsFor([nameColumn, village({ visibleInList: false, sort: SORT })]),
		).toEqual([]);
	});
});

describe("caseListOrderChoiceRefusal over a column that is not on the list", () => {
	const offList = village({ visibleInList: false, notOnList: true });

	it("answers the code's builder line in a list with no tile", () => {
		const doc = docWith([nameColumn, offList], false);
		expect(
			caseListOrderChoiceRefusal(doc, doc.moduleOrder[0], {
				...offList,
				sort: SORT,
			} as Column),
		).toBe(
			"This isn't on the list, so the list can't sort by it. You can turn on List search matches this to sort by it.",
		);
	});

	it("answers nothing in a tile list for the same column without notOnList, the choice the menu offers there", () => {
		const doc = docWith([nameColumn, offList], true);
		const { notOnList: _notOnList, ...onTheList } = offList;
		expect(
			caseListOrderChoiceRefusal(doc, doc.moduleOrder[0], {
				...onTheList,
				sort: SORT,
			} as Column),
		).toBeUndefined();
	});
});
