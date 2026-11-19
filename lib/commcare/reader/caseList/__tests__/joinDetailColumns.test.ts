/**
 * Contract: the short and the long detail join into one set of columns by the six rules: equal
 * proposals join, an `invisible` short column joins its long partner by field and header and takes
 * that column's proposal, a list-only column is hidden from the detail, and a detail-only column is
 * not on the list, in a list of either layout. The failure it catches: a detail column lost,
 * shown on the list, or written into the list as a hidden field a worker's filter then matches.
 */
import { describe, expect, it } from "vitest";
import { columnSort, plainColumn, tileCell } from "@/lib/domain/modules";
import type { ColumnProposal } from "../columns";
import { joinDetailColumns } from "../details";
import { patients, uuid } from "./fixtures";
import { codes, comparableList, listOf, readLists } from "./listReading";

function proposal(
	field: string,
	header: string,
	invisible = false,
): ColumnProposal {
	return {
		column: { kind: "plain", field, header },
		header: { en: header },
		texts: {},
		invisible,
		json: {} as ColumnProposal["json"],
	};
}

describe("joinDetailColumns", () => {
	it("joins equal columns, hides a list-only one from the detail and keeps a detail-only one off the list", () => {
		const joined = joinDetailColumns(
			[proposal("case_name", "Name"), proposal("notes", "Notes")],
			[proposal("case_name", "Name"), proposal("phone", "Phone")],
		);
		expect(
			joined.columns.map((one) => [
				one.proposal.column,
				one.visibleInList,
				one.visibleInDetail,
				one.notOnList,
			]),
		).toEqual([
			[
				{ kind: "plain", field: "case_name", header: "Name" },
				undefined,
				undefined,
				undefined,
			],
			[
				{ kind: "plain", field: "notes", header: "Notes" },
				undefined,
				false,
				undefined,
			],
			[
				{ kind: "plain", field: "phone", header: "Phone" },
				false,
				undefined,
				true,
			],
		]);
		expect(joined.listOrder).toEqual([0, 1, 2]);
		expect(joined.detailOrder).toEqual([0, 2, 1]);
	});

	it("joins an invisible short column to the long column over its field that holds its header", () => {
		const joined = joinDetailColumns(
			[proposal("phone", "Phone", true)],
			[proposal("phone", "Mobile"), proposal("phone", "Phone")],
		);
		expect(
			joined.columns.map((one) => [
				one.proposal.header,
				one.visibleInList,
				one.visibleInDetail,
				one.long,
			]),
		).toEqual([
			[{ en: "Phone" }, false, undefined, 1],
			[{ en: "Mobile" }, false, undefined, 0],
		]);
	});

	// Joined, the field would print the long column's header in its own place, which the
	// export of the list it was read from does not.
	it("joins an invisible short column to no long column over its field under another header", () => {
		const joined = joinDetailColumns(
			[proposal("phone", "", true)],
			[proposal("phone", "Phone")],
		);
		expect(
			joined.columns.map((one) => [
				one.proposal.header,
				one.visibleInList,
				one.visibleInDetail,
				one.notOnList,
			]),
		).toEqual([
			[{ en: "" }, false, false, undefined],
			[{ en: "Phone" }, false, undefined, true],
		]);
	});

	it("does not join two columns whose headers differ", () => {
		const joined = joinDetailColumns(
			[proposal("notes", "Notes")],
			[proposal("notes", "Remarks")],
		);
		expect(joined.columns).toHaveLength(2);
	});
});

describe("a column the detail alone shows", () => {
	for (const tile of [false, true])
		it(`reads not on the list in a ${tile ? "tile" : "plain"} list, and writes no short field for it`, async () => {
			const name = plainColumn(
				uuid(1),
				"case_name",
				"Name",
				tile ? { tile: tileCell(0, 0, 12, 1) } : {},
			);
			const phone = plainColumn(uuid(2), "phone", "Phone", {
				visibleInList: false,
				notOnList: true,
			});
			const reading = await readLists(
				patients([name, phone], tile ? { list: { tile: {} } } : {}),
			);
			expect(codes(reading)).toEqual([]);
			const short = reading.app.modules[0]?.case_details.short.columns.map(
				(column) => column.field,
			);
			expect(short).toEqual(["name"]);
			const read = comparableList(listOf(reading)) as {
				list: { field: string; notOnList?: true }[];
			};
			expect(
				read.list.find((column) => column.field === "phone")?.notOnList,
			).toBe(true);
		});

	it("reads a tile list's hidden unsorted column back as not on the list", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const phone = plainColumn(uuid(2), "phone", "Phone", {
			visibleInList: false,
		});
		const reading = await readLists(
			patients([name, phone], { list: { tile: {} } }),
		);
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string; notOnList?: true }[];
		};
		expect(
			read.list.find((column) => column.field === "phone")?.notOnList,
		).toBe(true);
	});

	it("reads a tile list's detail-only column a sort element names as hidden with the rule", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const phone = plainColumn(uuid(2), "phone", "Phone", {
			visibleInList: false,
			sort: columnSort("asc", 0),
		});
		const reading = await readLists(
			patients([name, phone], { list: { tile: {} } }),
		);
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string; notOnList?: true; sort?: unknown }[];
		};
		const column = read.list.find((one) => one.field === "phone");
		expect(column?.notOnList).toBeUndefined();
		expect(column?.sort).toEqual(columnSort("asc", 0));
	});
});
