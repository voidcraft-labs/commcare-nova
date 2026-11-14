/**
 * Contract: the plan of the read columns writes the stored `sort_elements`, so every order rule
 * Nova emits reads back on its column, with blanks stored only where they are not the direction's
 * own, and a list Nova writes as the source holds it records no first-publish rewrite. The failure
 * it catches: a rule joined to the second column of one text; blanks stored where they are the
 * direction's own; a rewrite declared for a list the first publish writes unchanged.
 */
import { describe, expect, it } from "vitest";
import {
	columnSort,
	dateColumn,
	plainColumn,
	type SortBlanks,
	type SortDirection,
} from "@/lib/domain/modules";
import { patients, uuid } from "./fixtures";
import { codes, comparableList, listOf, readLists } from "./listReading";

describe("order rules read back on their columns", () => {
	const cases: [SortDirection, SortBlanks | undefined][] = [
		["asc", undefined],
		["asc", "first"],
		["desc", undefined],
		["desc", "last"],
	];
	for (const [direction, blanks] of cases)
		it(`reads ${direction} with blanks ${blanks ?? "the direction's own"}`, async () => {
			const columns = [
				plainColumn(uuid(1), "case_name", "Name"),
				dateColumn(uuid(2), "dob", "Born", "%d/%m/%Y", {
					sort: columnSort(direction, 0, blanks),
				}),
				plainColumn(uuid(3), "notes", "Notes", { sort: columnSort("asc", 1) }),
			];
			const reading = await readLists(patients(columns));
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				list: { field: string; sort?: unknown }[];
			};
			expect(read.list.map((column) => [column.field, column.sort])).toEqual([
				["case_name", undefined],
				["dob", columnSort(direction, 0, blanks)],
				["notes", columnSort("asc", 1)],
			]);
			expect(
				reading.ctx.facts.sameStateRewrites.filter((one) =>
					one.entry.startsWith("menus-and-case-lists/"),
				),
			).toEqual([]);
		});

	it("reads a rule on the first of two columns over one property", async () => {
		const columns = [
			plainColumn(uuid(1), "notes", "Notes", { sort: columnSort("desc", 0) }),
			plainColumn(uuid(2), "notes", "Notes again"),
		];
		const reading = await readLists(patients(columns));
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { header: string; sort?: unknown }[];
		};
		expect(read.list.map((column) => column.sort)).toEqual([
			columnSort("desc", 0),
			undefined,
		]);
	});
});
