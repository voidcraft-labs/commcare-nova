/**
 * Contract: each column format CommCare HQ's page offers reads or raises as its manifest row
 * says, and a finding names the format by the label HQ's page shows. The failure it catches: a
 * format Nova cannot write back read as held.
 */
import { describe, expect, it } from "vitest";
import { plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "./fixtures";
import { codes, comparableList, listOf, readLists } from "./listReading";

const M = "menus-and-case-lists/";

async function readFormat(change: Record<string, unknown>) {
	return readLists(
		patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Notes"),
		]),
		{
			edit: (app) => {
				for (const detail of [
					app.modules[0]?.case_details.short,
					app.modules[0]?.case_details.long,
				]) {
					const column = detail?.columns[1];
					if (column !== undefined) Object.assign(column, change);
				}
			},
			firstPassOnly: true,
		},
	);
}

describe("CommCare HQ's column formats", () => {
	const findings: [string, Record<string, unknown>, string][] = [
		[
			"late-flag",
			{ format: "late-flag", late_flag: 30 },
			`${M}6-late-flag-late-flag-1`,
		],
		[
			"late-flag of 0",
			{ format: "late-flag", late_flag: 0 },
			`${M}6p-late-flag-late-flag-0`,
		],
		[
			"time-ago",
			{ format: "time-ago" },
			`${M}3-time-ago-time-ago-interval-the-7-menu-values-years-months`,
		],
		["address", { format: "address" }, `${M}8-address`],
		["distance", { format: "distance" }, `${M}9-distance`],
		["picture", { format: "picture" }, `${M}17-picture`],
		[
			"a date pattern Core does not format",
			{ format: "date", date_format: "%Q" },
			`${M}2p-date-any-other-date-format`,
		],
		[
			"an enum key holding a space",
			{ format: "enum", enum: [{ key: "a b", value: { en: "A" } }] },
			`${M}5pp-enum-key-that-is-empty-or-holds-whitespace`,
		],
		["a product column", { model: "product" }, `${M}model-product`],
		[
			"a relation path",
			{ field: "parent/notes" },
			`${M}idx-prop-parent-host-any-index-names-other-than-a-first-step`,
		],
		["the owner's name", { field: "#owner_name" }, `${M}owner-name`],
		[
			"markdown outside the link shape",
			{ format: "markdown" },
			`${M}10-markdown-outside-the-link-shape`,
		],
	];
	for (const [name, change, entry] of findings)
		it(`raises ${name}`, async () => {
			const reading = await readFormat(change);
			expect(codes(reading)).toContain(entry);
		});

	it("names a late flag by the label HQ's page shows", async () => {
		const reading = await readFormat({ format: "late-flag", late_flag: 30 });
		const finding = reading.findings.find(
			(one) => one.code === `${M}6-late-flag-late-flag-1`,
		);
		expect(finding?.detail.name).toBe("Late Flag");
	});

	it("reads a slug HQ registers no format for as a plain column", async () => {
		const reading = await readFormat({ format: "calculate" });
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { kind: string; field: string }[];
		};
		expect(read.list[1]).toMatchObject({ kind: "plain", field: "notes" });
	});

	it("reads HQ's renamed names as Nova's standard properties", async () => {
		const reading = await readFormat({ field: "date-opened" });
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string }[];
		};
		expect(read.list[1]?.field).toBe("date_opened");
	});
});
