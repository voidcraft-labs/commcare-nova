/**
 * Contract: the sort elements CommCare HQ's pages write that Nova would write otherwise read by
 * their rows: a sort-only element becomes a hidden column, last, beside a detail-only column over
 * the same property that stays off the list; an unsorted list whose first column is `invisible`
 * gives that column the rule HQ's build applies; of two elements with one `field` the later
 * stands; `type: "string"` reads as Nova's derived word; a label on a sort-only element raises.
 * Each same-state reading records its first-publish row.
 */
import { describe, expect, it } from "vitest";
import { columnSort, plainColumn } from "@/lib/domain/modules";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { patients, uuid } from "./fixtures";
import {
	codes,
	comparableList,
	listOf,
	readLists as readListsOf,
} from "./listReading";

const readLists = namingFromHqPages(readListsOf);

const element = (field: string, extra: Record<string, unknown> = {}) => ({
	doc_type: "SortElement",
	field,
	type: "plain",
	direction: "ascending",
	blanks: "",
	display: {},
	sort_calculation: "",
	...extra,
});

function registers(reading: Awaited<ReturnType<typeof readLists>>): string[] {
	return reading.ctx.facts.sameStateRewrites.map((one) => one.register);
}

describe("CommCare HQ's sort elements", () => {
	it("reads a sort-only element as a hidden column, beside a detail-only column that stays off the list", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "phone", "Phone", {
				visibleInList: false,
				notOnList: true,
			}),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined) short.sort_elements = [element("phone")];
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(
			read.list.map((column) => [
				column.field,
				column.visibleInList,
				column.visibleInDetail,
				column.notOnList,
				column.sort,
			]),
		).toEqual([
			["case_name", undefined, undefined, undefined, undefined],
			["phone", false, undefined, true, undefined],
			["phone", false, false, undefined, columnSort("asc", 0)],
		]);
		expect(registers(reading)).toContain("sort-rule-kept-as-hidden-column");
	});

	it("gives an unsorted list's invisible first column HQ's default rule", async () => {
		const doc = patients([
			plainColumn(uuid(1), "notes", "Notes", { visibleInList: false }),
			plainColumn(uuid(2), "case_name", "Name"),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined) short.sort_elements = [];
			},
			firstPassOnly: true,
		});
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list[0]?.sort).toEqual(columnSort("asc", 0));
		expect(registers(reading)).toContain("list-settings-respelled");
	});

	it("reads the later of two elements with one field and drops the earlier", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("case_name"),
						element("case_name", { direction: "descending" }),
					];
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list[0]?.sort).toEqual(columnSort("desc", 0));
		expect(registers(reading)).toContain("list-settings-respelled");
	});

	it("reads `type: string` as Nova's derived word and records it", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name", { sort: columnSort("asc", 0) }),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				const first = short?.sort_elements[0];
				if (first !== undefined) first.type = "string";
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(registers(reading)).toContain("sort-rule-kept-as-hidden-column");
	});

	it("raises a label on a sort-only element", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("notes", { display: { en: "Notes" } }),
					];
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toContain(
			"menus-and-case-lists/display-lang-sort-by-label-on-a-sort-only-element",
		);
	});

	it("declares `int` on a property no writer types, so the plan derives the stored comparator", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [element("visits", { type: "int" })];
			},
		});
		expect(codes(reading)).toEqual([]);
		const visits = reading.ctx.doc?.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((property) => property.name === "visits");
		expect(visits?.data_type).toBe("int");
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list.map((column) => [column.field, column.sort])).toEqual([
			["case_name", undefined],
			["visits", columnSort("asc", 0)],
		]);
	});

	it("raises `int` on a property a text question saves", async () => {
		const doc = patients([
			plainColumn(uuid(1), "notes", "Notes", { sort: columnSort("asc", 0) }),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) first.type = "int";
			},
		});
		expect(codes(reading)).toContain(
			"menus-and-case-lists/type-int-or-double-differing-from-the-derived-type-on-a-column",
		);
	});

	for (const [stored, property] of [
		["name", "case_name"],
		["date-opened", "date_opened"],
		["external-id", "external_id"],
	] as const)
		it(`reads a sort-only element on HQ's \`${stored}\` as a hidden column over \`${property}\``, async () => {
			const doc = patients([plainColumn(uuid(1), "notes", "Notes")]);
			const reading = await readLists(doc, {
				edit: (app) => {
					const short = app.modules[0]?.case_details.short;
					if (short !== undefined) short.sort_elements = [element(stored)];
				},
			});
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				list: Record<string, unknown>[];
			};
			expect(read.list.map((column) => [column.field, column.sort])).toEqual([
				["notes", undefined],
				[property, columnSort("asc", 0)],
			]);
		});
});
