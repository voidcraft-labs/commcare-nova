/**
 * Contract: a calculated column shown on both screens is one registration whose claim holds the
 * other screen's column too, and where the expression stage hands that claim to project data (a
 * read of a table the catalog lacks, which project data's rules raise once at the table), both
 * columns are handed off and the list raises no finding of its own. The failures it catches: the
 * second screen's column claimed under the entry the hand-off stands for, a second finding for
 * the one table, and the list's comparison naming the handed-off column's field as a difference.
 */
import { describe, expect, it } from "vitest";
import { plainColumn } from "@/lib/domain/modules";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { patients, uuid } from "./fixtures";
import { readLists as readListsOf } from "./listReading";

const readLists = namingFromHqPages(readListsOf);

const READS_A_MISSING_TABLE =
	"count(instance('item-list:harvests')/harvests_list/harvests)";

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
});
