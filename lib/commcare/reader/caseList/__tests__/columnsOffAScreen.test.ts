/**
 * Contract: a column the detail does not show, or that is not on the list, has no place in that
 * screen's detail, so a document that holds it anywhere in that screen's order prints what the
 * canonical choice `columns-off-a-screen-last-in-its-order` returns, and the reading of Nova's
 * export holds the canonical order. The failure it catches: a column off the detail held at its
 * authored place in the detail order, which no export carries, with no canonical choice naming the
 * pair; a canonical choice that changes what the export prints or moves a column a screen shows.
 */
import { expect, it } from "vitest";
import type { BlueprintDoc, CaseTileLayout, Column } from "@/lib/domain";
import { NAMED_TILE_SLOTS, plainColumn, tileCell } from "@/lib/domain/modules";
import { columnsJoinedAsRead, columnsOffAScreenLast } from "../details";
import { patients, uuid } from "./fixtures";
import { codes, emittedApp, listOf, readLists } from "./listReading";

const shown = plainColumn(uuid(1), "case_name", "Name");
const offDetail: Column = {
	...plainColumn(uuid(2), "notes", "Notes"),
	visibleInDetail: false,
};
const offList: Column = {
	...plainColumn(uuid(3), "phone", "Phone"),
	visibleInList: false,
	notOnList: true,
};
const both = plainColumn(uuid(4), "dob", "Born");

function authored(): BlueprintDoc {
	return patients([shown, offDetail, offList, both], {
		listOrder: [uuid(3), uuid(2), uuid(1), uuid(4)],
		detailOrder: [uuid(2), uuid(4), uuid(3), uuid(1)],
	});
}

async function details(doc: BlueprintDoc) {
	return (await emittedApp(doc)).modules.map((module) => module.case_details);
}

it("puts each column a screen does not show last in that screen's order", async () => {
	const doc = authored();
	const chosen = columnsOffAScreenLast(doc);
	const config = chosen.modules[chosen.moduleOrder[0] ?? ""]?.caseListConfig;
	expect(config?.listColumnOrder).toEqual([uuid(2), uuid(1), uuid(4), uuid(3)]);
	expect(config?.detailColumnOrder).toEqual([
		uuid(4),
		uuid(3),
		uuid(1),
		uuid(2),
	]);
	expect(await details(chosen)).toEqual(await details(doc));
	expect(columnsOffAScreenLast(chosen)).toBe(chosen);
});

it("reads Nova's export of either order as the canonical one", async () => {
	const doc = authored();
	const chosen = columnsOffAScreenLast(doc);
	const reading = await readLists(doc);
	expect(codes(reading)).toEqual([]);
	const read = listOf(reading);
	const fieldOf = (order: readonly string[], columns: readonly Column[]) =>
		order.map(
			(id) =>
				(columns.find((one) => one.uuid === id) as { field?: string }).field,
		);
	const want = chosen.modules[chosen.moduleOrder[0] ?? ""]?.caseListConfig;
	if (want === undefined) throw new Error("The fixture holds no case list.");
	expect(fieldOf(read.listColumnOrder, read.columns)).toEqual(
		fieldOf(want.listColumnOrder, want.columns),
	);
	expect(fieldOf(read.detailColumnOrder, read.columns)).toEqual(
		fieldOf(want.detailColumnOrder, want.columns),
	);
});

it("preserves named Results positions and Details cells when an off-list twin swaps identities", async () => {
	const offListTwin: Column = {
		...plainColumn(uuid(21), "case_name", "Details only"),
		visibleInList: false,
		notOnList: true,
	};
	const namedColumns = NAMED_TILE_SLOTS.map((slot, index) =>
		plainColumn(uuid(index + 22), index === 0 ? "case_name" : "notes", slot),
	);
	const namedSlots = Object.fromEntries(
		NAMED_TILE_SLOTS.map((slot, index) => [slot, namedColumns[index].uuid]),
	) as NonNullable<CaseTileLayout["namedSlots"]>;
	const doc = patients([offListTwin, ...namedColumns], {
		list: {
			tile: { namedSlots },
			detailTile: {
				cells: Object.fromEntries(
					[offListTwin, ...namedColumns].map((column, index) => [
						column.uuid,
						tileCell(0, index, 12, 1),
					]),
				),
			},
		},
	});
	const chosen = columnsOffAScreenLast(doc);
	const config = chosen.modules[chosen.moduleOrder[0]]?.caseListConfig;
	expect(config?.tile?.namedSlots?.[NAMED_TILE_SLOTS[0]]).toBe(
		offListTwin.uuid,
	);
	expect(config?.detailTile?.cells[offListTwin.uuid]).toEqual(
		tileCell(0, 1, 12, 1),
	);
	expect(await details(chosen)).toEqual(await details(doc));
});

it("preserves independent Details cells when identical displayed columns join in a different order", async () => {
	const first = {
		...plainColumn(uuid(41), "case_name", "Name"),
		tile: tileCell(0, 0, 12, 1),
	};
	const second = {
		...plainColumn(uuid(42), "case_name", "Name"),
		tile: tileCell(0, 1, 12, 1),
	};
	const doc = patients([first, second], {
		detailOrder: [second.uuid, first.uuid],
		list: {
			tile: {},
			detailTile: {
				cells: {
					[first.uuid]: tileCell(0, 4, 12, 1),
					[second.uuid]: tileCell(0, 2, 12, 1),
				},
			},
		},
	});
	const joined = columnsJoinedAsRead(doc);
	expect(joined).not.toBe(doc);
	expect(await details(joined)).toEqual(await details(doc));
});
