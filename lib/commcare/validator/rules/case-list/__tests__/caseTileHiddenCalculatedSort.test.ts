import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	type Column,
	type ColumnCommonSlots,
	calculatedColumn,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression";
import { runValidation } from "../../../runner";

const caseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "rank", label: "Rank", data_type: "text" as const },
		],
	},
];

const HIDDEN_ORDER: ColumnCommonSlots = {
	visibleInList: false,
	sort: { direction: "asc", priority: 0 },
};

const nameColumn = plainColumn(testUuid("name"), "case_name", "Name", {
	tile: tileCell(0, 0, 6, 1),
});

function findingsFor(columns: readonly Column[], tile: boolean) {
	const doc = buildDoc({
		appName: "Tile order",
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
		caseTypes,
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
}

const calculated = (slots: ColumnCommonSlots) =>
	calculatedColumn(
		testUuid("score"),
		"Score",
		term(prop("patient", "rank")),
		slots,
	);
const recordId = (slots: ColumnCommonSlots) =>
	plainColumn(testUuid("record"), "case_id", "Record", slots);

describe("hidden calculated or case_id order rules in a tile list", () => {
	it("refuses a hidden calculated column with an order rule", () => {
		const column = calculated(HIDDEN_ORDER);
		const result = findingsFor([nameColumn, column], true);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			code: "CASE_TILE_HIDDEN_CALCULATED_SORT",
			details: {
				slot: "caseListConfig.columns[1].sort",
				columnIndex: "1",
				columnUuid: column.uuid,
				shape: "calculated",
			},
		});
		expect(result[0].message).toBe(
			`Calculated column "Score" (column #2) on module "Patients" is hidden from Results and carries an order rule, and the module's list is a case tile. A tile list can't order by a calculation that isn't on the tile. Show the column on Results and place it on the tile, order by a case property instead, or remove the rule.`,
		);
	});

	it("refuses a hidden column over case_id with an order rule", () => {
		const column = recordId(HIDDEN_ORDER);
		const result = findingsFor([nameColumn, column], true);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			code: "CASE_TILE_HIDDEN_CALCULATED_SORT",
			details: {
				slot: "caseListConfig.columns[1].sort",
				columnIndex: "1",
				columnUuid: column.uuid,
				shape: "case_id",
			},
		});
		expect(result[0].message).toBe(
			`Column "Record" (column #2) on module "Patients" reads case_id, is hidden from Results and carries an order rule, and the module's list is a case tile. A tile list can't order by case_id unless the column is on the tile. Show the column on Results and place it on the tile, or remove the rule.`,
		);
	});

	it.each(["rank", "owner_id", "status"])(
		"accepts a hidden order rule over %s, which rides as a sort row",
		(property) => {
			const column = plainColumn(
				testUuid(property),
				property,
				property,
				HIDDEN_ORDER,
			);
			expect(findingsFor([nameColumn, column], true)).toEqual([]);
		},
	);

	it("accepts both refused columns hidden with no order rule", () => {
		expect(
			findingsFor(
				[
					nameColumn,
					calculated({ visibleInList: false }),
					recordId({ visibleInList: false }),
				],
				true,
			),
		).toEqual([]);
	});

	it("accepts both refused columns shown on the tile with an order rule", () => {
		expect(
			findingsFor(
				[
					nameColumn,
					calculated({
						tile: tileCell(6, 0, 6, 1),
						sort: { direction: "asc", priority: 0 },
					}),
					recordId({
						tile: tileCell(0, 1, 6, 1),
						sort: { direction: "asc", priority: 1 },
					}),
				],
				true,
			),
		).toEqual([]);
	});

	it("accepts both refused columns hidden with an order rule in a list with no tile layout", () => {
		expect(
			findingsFor(
				[
					plainColumn(testUuid("name"), "case_name", "Name"),
					calculated(HIDDEN_ORDER),
					recordId({
						visibleInList: false,
						sort: { direction: "asc", priority: 1 },
					}),
				],
				false,
			),
		).toEqual([]);
	});
});
