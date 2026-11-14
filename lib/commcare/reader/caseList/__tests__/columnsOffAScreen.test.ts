/**
 * Contract: a column the detail does not show, or that is not on the list, has no place in that
 * screen's detail, so a document that holds it anywhere in that screen's order prints what the
 * canonical choice `columns-off-a-screen-last-in-its-order` returns, and the reading of Nova's
 * export holds the canonical order. The failure it catches: a column off the detail held at its
 * authored place in the detail order, which no export carries, with no canonical choice naming the
 * pair; a canonical choice that changes what the export prints or moves a column a screen shows.
 */
import { expect, it } from "vitest";
import type { BlueprintDoc, Column } from "@/lib/domain";
import { plainColumn } from "@/lib/domain/modules";
import { columnsOffAScreenLast } from "../details";
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
