/**
 * Contract: a calculated column shown on both screens is one registration whose claim holds the
 * other screen's column too, and where the expression stage hands that claim to project data (a
 * read of a table the catalog lacks, which project data's rules raise once at the table), both
 * columns are handed off and the list raises no finding of its own for that column's field. A
 * hand-off excuses only its own slot's print: every other difference of the list is reported in
 * the same reading, whether the handed-off slot is one of the list's columns or a slot the list
 * does not print (the menu's display condition). The failures it catches: the second screen's
 * column claimed under the entry the hand-off stands for, a second finding for the one table, the
 * list's comparison naming the handed-off column's field as a difference, and a difference of the
 * list held back until the table is added and the app read again. The list's other difference is
 * planted in the reading's document once its expressions are bound, as a reader stage's wrong
 * proposal would make one: the list's comparison with Nova's print is the one check that finds it.
 */
import { describe, expect, it } from "vitest";
import { plainColumn } from "@/lib/domain/modules";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { withCandidate } from "../../candidate";
import type { ReadContext } from "../../context";
import { patients, uuid } from "./fixtures";
import { type ListReading, readLists as readListsOf } from "./listReading";

const readLists = namingFromHqPages(readListsOf);

const READS_A_MISSING_TABLE =
	"count(instance('item-list:harvests')/harvests_list/harvests)";

/** The reading's first column read under a header the source does not hold: a difference of the
 *  list's own, unrelated to the table. */
function plantHeader(ctx: ReadContext): void {
	const menu = ctx.draft.modules[0]?.uuid;
	if (ctx.doc === undefined || menu === undefined)
		throw new Error("The reading holds no document to plant a difference in.");
	ctx.doc = withCandidate(ctx.doc, (draft) => {
		const column = draft.modules[menu]?.caseListConfig?.columns[0];
		if (column === undefined) throw new Error("The list holds no column.");
		column.header = "Planted";
	});
}

/** Each `unrecognized` finding the settles raised before the close, by its key. */
const settled = (reading: ListReading) =>
	reading.findings
		.filter((finding) => finding.code === "unrecognized")
		.map((finding) => `${finding.place.kind} ${finding.detail.name ?? ""}`);
const LIST_DIFFERENCE = "case-list schema:DetailColumn.header";

describe("a calculated column on both screens reading a table the catalog lacks", () => {
	it("is handed to project data on each screen, with no finding of the list's own", async () => {
		const reading = await readLists(
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "notes", "Notes"),
			]),
			{
				edit: (app) => {
					const pair = app.modules[0]?.case_details;
					if (pair === undefined) return;
					for (const detail of [pair.short, pair.long])
						Object.assign(detail.columns[1] ?? {}, {
							useXpathExpression: true,
							field: READS_A_MISSING_TABLE,
						});
				},
				firstPassOnly: false,
			},
		);
		const closed = reading.ctx.close();
		expect(closed.findings).toEqual([]);
		expect(
			closed.claims.handOffs
				.filter((one) => one.to === "lookup-table-read")
				.map((one) => one.subject),
		).toEqual(["harvests", "harvests"]);
	});

	it("reports a difference of the list the column does not print in the same reading", async () => {
		const reading = await readLists(
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "notes", "Notes"),
			]),
			{
				edit: (app) => {
					const pair = app.modules[0]?.case_details;
					if (pair === undefined) return;
					for (const detail of [pair.short, pair.long])
						Object.assign(detail.columns[1] ?? {}, {
							useXpathExpression: true,
							field: READS_A_MISSING_TABLE,
						});
				},
				afterBinding: plantHeader,
				firstPassOnly: false,
			},
		);
		expect(settled(reading)).toEqual([LIST_DIFFERENCE]);
	});
});

describe("a menu's and a form's display condition reading a table the catalog lacks", () => {
	it.each([
		["menu", "module_filter"],
		["form", "form_filter"],
	] as const)(
		"on a %s is handed to project data alone, and leaves every difference of the menu's list reported",
		async (_, key) => {
			const read = (differs: boolean) =>
				readLists(
					patients([
						plainColumn(uuid(1), "case_name", "Name"),
						plainColumn(uuid(2), "notes", "Notes"),
					]),
					{
						edit: (app) => {
							const menu = app.modules[0];
							if (menu === undefined) return;
							const condition = `${READS_A_MISSING_TABLE} > 0`;
							if (key === "module_filter") menu.module_filter = condition;
							else
								for (const form of menu.forms as Record<string, unknown>[])
									form.form_filter = condition;
						},
						...(differs && { afterBinding: plantHeader }),
						firstPassOnly: false,
					},
				);
			const plain = (await read(false)).ctx.close();
			expect(plain.findings).toEqual([]);
			expect(
				plain.claims.handOffs
					.filter((one) => one.to === "lookup-table-read")
					.map((one) => one.subject),
			).toEqual(["harvests"]);
			expect(settled(await read(true))).toEqual([LIST_DIFFERENCE]);
		},
	);
});
