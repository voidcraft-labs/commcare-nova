/**
 * A tile's rows are the rows CommCare HQ's own pages keep: `max(n, 6)`, n
 * the columns the page counts for that screen (proof 4 over
 * `targeted-tile-row-bound`). The Results count must be the short detail's
 * fields the export writes, which `caseListOrderPlan` states, and a Details
 * tile counts its tabs.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type CaseListConfig,
	type Column,
	caseListOrderPlan,
	detailsTileFieldCount,
	plainColumn,
	resultsTileFieldCount,
	tileCell,
	tileRowLimit,
} from "@/lib/domain";
import { fitTileCellIntoRows } from "@/lib/domain/tilePlacement";

function config(columns: Column[], rest: Partial<CaseListConfig> = {}) {
	const order = columns.map((column) => column.uuid);
	return {
		columns,
		listColumnOrder: order,
		detailColumnOrder: [...order],
		searchInputs: [],
		...rest,
	} satisfies CaseListConfig;
}

const col = (id: string, slots: Parameters<typeof plainColumn>[3] = {}) =>
	plainColumn(testUuid(id), id, id, slots);

describe("tileRowLimit", () => {
	it("is at least six and otherwise a row for each field", () => {
		expect([0, 1, 6, 7, 13].map(tileRowLimit)).toEqual([6, 6, 6, 7, 13]);
	});
});

describe("resultsTileFieldCount", () => {
	it("counts the fields a tile's short detail holds, as the export plans them", () => {
		const columns = [
			col("a", { tile: tileCell(0, 0, 12, 1) }),
			col("hidden", { visibleInList: false }),
			col("ordering", {
				visibleInList: false,
				sort: { direction: "asc", priority: 0 },
			}),
			col("off-list", { visibleInList: false, notOnList: true }),
			col("android", { tile: tileCell(0, 1, 12, 1, { androidOnly: true }) }),
			col("b", { tile: tileCell(0, 2, 12, 1) }),
		];
		const tiled = config(columns, { tile: {} });
		const plan = caseListOrderPlan(tiled, [], {
			mediaOn: false,
			calculatedType: () => undefined,
			expressionText: () => "",
		});
		expect(resultsTileFieldCount(tiled)).toBe(3);
		expect(plan.fields).toHaveLength(resultsTileFieldCount(tiled));
		// The count holds while the layout is off, so a kept cell still fits
		// when the tile comes back on.
		expect(resultsTileFieldCount(config(columns))).toBe(3);
	});
});

describe("detailsTileFieldCount", () => {
	it("counts each field shown in Details and each tab, as HQ's Case Detail page does", () => {
		const columns = [
			col("a"),
			col("b"),
			col("c", { visibleInDetail: false }),
			col("d"),
		];
		expect(detailsTileFieldCount(config(columns))).toBe(3);
		expect(
			detailsTileFieldCount(
				config(columns, {
					detailTabs: [
						{
							uuid: testUuid("tab-1"),
							title: "One",
							startColumnUuid: columns[0].uuid,
						},
						{
							uuid: testUuid("tab-2"),
							title: "Two",
							startColumnUuid: columns[3].uuid,
						},
					],
				}),
			),
		).toBe(5);
	});
});

describe("fitTileCellIntoRows", () => {
	const styled = tileCell(4, 7, 4, 2, { fontSize: "large" });

	it("leaves a cell that fits where it is", () => {
		expect(fitTileCellIntoRows(tileCell(0, 5, 12, 1), [], 6)).toEqual(
			tileCell(0, 5, 12, 1),
		);
	});

	it("raises a cell in its own columns to the bottom of the rows, keeping its style", () => {
		expect(fitTileCellIntoRows(styled, [], 6)).toEqual({
			...styled,
			y: 4,
		});
	});

	it("takes the first free place of its size where its own columns are taken", () => {
		expect(fitTileCellIntoRows(styled, [tileCell(0, 2, 12, 4)], 6)).toEqual({
			...styled,
			x: 0,
			y: 0,
		});
	});

	it("shortens it where no place of its height is free", () => {
		expect(fitTileCellIntoRows(styled, [tileCell(0, 0, 12, 5)], 6)).toEqual({
			...styled,
			y: 5,
			height: 1,
		});
	});

	it("answers none where every square is taken", () => {
		expect(fitTileCellIntoRows(styled, [tileCell(0, 0, 12, 6)], 6)).toBeNull();
	});
});
