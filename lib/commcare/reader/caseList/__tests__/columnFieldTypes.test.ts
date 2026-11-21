/**
 * A property column's field, read under the entry of the property it names, at the field, where
 * the proof lane's manifest check extracts its `detail-field-type:property` use beside the field's
 * own key: a case property, the case's `last_modified`, or one of the names CommCare HQ's build
 * reads under another (`detail_screen.py::CASE_PROPERTY_MAP`); and a long detail stored with no
 * column, read at its default.
 *
 * Plausible failures: the field's type use left unclaimed, so the claim log counts none of the
 * three entries and parity finds the use unclaimed; a renamed name read as a plain property; an
 * empty long detail counted under no entry.
 */
import { describe, expect, it } from "vitest";
import { plainColumn } from "@/lib/domain/modules";
import type { ClaimRecord } from "../../accounting";
import { patients, uuid } from "./fixtures";
import { closedCodes, readLists } from "./listReading";

const M = "menus-and-case-lists";

function records(
	reading: Awaited<ReturnType<typeof readLists>>,
): ClaimRecord[] {
	return [...reading.ctx.close().claims.records()];
}

describe("a property column's field type", () => {
	it("is claimed at the field under the entry of the property it names", async () => {
		const reading = await readLists(
			patients([plainColumn(uuid(1), "notes", "Notes")]),
			{
				edit: (app) => {
					const [notes] = app.modules[0]?.case_details.short.columns ?? [];
					if (notes === undefined) throw new Error("The list holds notes.");
					// The case's name as CommCare HQ's page names it, and its own modification time.
					app.modules[0]?.case_details.short.columns.push(
						{ ...notes, field: "name", header: { en: "Name" } },
						{ ...notes, field: "last_modified", header: { en: "Changed" } },
					);
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		const types = records(reading)
			.filter(
				(one) =>
					one.key === "detail-field-type:property" &&
					one.where.startsWith("/modules/0/case_details/short/columns/"),
			)
			.map(({ where, entry }) => ({ where, entry }));
		expect(types).toEqual([
			{
				where: "/modules/0/case_details/short/columns/0/field",
				entry: `${M}/prop`,
			},
			{
				where: "/modules/0/case_details/short/columns/1/field",
				entry: `${M}/name-date-opened-external-id-status-owner-id-hq-renames-to-case`,
			},
			{
				where: "/modules/0/case_details/short/columns/2/field",
				entry: `${M}/last-modified`,
			},
		]);
	});

	it("counts a long detail stored with no column at its default", async () => {
		const reading = await readLists(
			patients([plainColumn(uuid(1), "notes", "Notes")]),
			{
				edit: (app) => {
					const menu = app.modules[0];
					if (menu !== undefined) menu.case_details.long.columns = [];
				},
			},
		);
		expect(
			records(reading)
				.filter((one) => one.entry === `${M}/long-columns-empty`)
				.map(({ where, key }) => ({ where, key })),
		).toEqual([{ where: "/modules/0/case_details/long/columns", key: null }]);
	});
});
