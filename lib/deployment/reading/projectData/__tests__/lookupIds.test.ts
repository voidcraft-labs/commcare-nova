/**
 * The derived ids of a brought-in lookup table: the read and the create
 * derive them separately, so equal inputs must give equal ids, and every id
 * must be one the lookup schemas take inside the birth.
 */
import { describe, expect, it } from "vitest";
import {
	LOOKUP_UUID_V7_PATTERN,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { broughtInLookupColumnId, broughtInLookupTableId } from "../lookupIds";

const APP = "0b4f6a52-7c55-5a35-9d1e-3c2f8a1b4e6d";
const READING = "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b";

describe("broughtInLookupTableId and broughtInLookupColumnId", () => {
	it("give equal ids for equal inputs, and another for a change of any one input", () => {
		const table = broughtInLookupTableId(APP, READING, "clinics");
		expect(broughtInLookupTableId(APP, READING, "clinics")).toBe(table);
		expect(
			broughtInLookupTableId(
				"0b4f6a52-7c55-5a35-9d1e-3c2f8a1b4e6e",
				READING,
				"clinics",
			),
		).not.toBe(table);
		// A reading's id reaches the hash through the app's id, which derives
		// from it, and the time bits directly.
		expect(
			broughtInLookupTableId(
				APP,
				"019a7f3d-2b1d-7e40-8a9b-0c1d2e3f4a5b",
				"clinics",
			),
		).not.toBe(table);
		expect(broughtInLookupTableId(APP, READING, "clinic")).not.toBe(table);

		const column = broughtInLookupColumnId(APP, READING, "clinics", "code");
		expect(broughtInLookupColumnId(APP, READING, "clinics", "code")).toBe(
			column,
		);
		expect(broughtInLookupColumnId(APP, READING, "clinics", "name")).not.toBe(
			column,
		);
		expect(broughtInLookupColumnId(APP, READING, "districts", "code")).not.toBe(
			column,
		);
		expect(
			broughtInLookupColumnId(
				"0b4f6a52-7c55-5a35-9d1e-3c2f8a1b4e6e",
				READING,
				"clinics",
				"code",
			),
		).not.toBe(column);
		expect(column).not.toBe(table);
	});

	it("are UUIDv7 ids the lookup schemas take, whose time is the reading's", () => {
		const table = broughtInLookupTableId(APP, READING, "clinics");
		const column = broughtInLookupColumnId(APP, READING, "clinics", "code");
		for (const id of [table, column]) {
			expect(id).toMatch(LOOKUP_UUID_V7_PATTERN);
			expect(id.slice(0, 13)).toBe(READING.slice(0, 13));
		}
		expect(lookupTableIdSchema.parse(table)).toBe(table);
		expect(lookupColumnIdSchema.parse(column)).toBe(column);

		const later = "01a00000-0000-7000-8000-000000000000";
		expect(broughtInLookupTableId(APP, later, "clinics").slice(0, 13)).toBe(
			later.slice(0, 13),
		);
	});

	it("refuses a reading id that is no UUIDv7, which has no time to give", () => {
		expect(() =>
			broughtInLookupTableId(
				APP,
				"0b4f6a52-7c55-5a35-9d1e-3c2f8a1b4e6d",
				"clinics",
			),
		).toThrow(/UUIDv7/);
	});

	it("gives two fields of one table, and one field under two tags, different ids", () => {
		const ids = new Set([
			broughtInLookupColumnId(APP, READING, "clinics", "code"),
			broughtInLookupColumnId(APP, READING, "clinics", "name"),
			broughtInLookupColumnId(APP, READING, "districts", "code"),
			broughtInLookupTableId(APP, READING, "clinics"),
			broughtInLookupTableId(APP, READING, "districts"),
		]);
		expect(ids.size).toBe(5);
	});
});
