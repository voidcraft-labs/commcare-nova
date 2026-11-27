/**
 * The case-location repair moves a `location_id` a property document still
 * holds into the case's location column, which every case-store reader now
 * reads the name from. The plausible failures: a value left in the document
 * (no reader sees it, and the next update sheds it), a newer column value
 * overwritten by the older document's, another app's rows touched by a
 * scoped run, or a run that changes the case's modification time.
 */
import type { Kysely } from "kysely";
import { describe } from "vitest";
import {
	type Database,
	expect,
	makeCaseRow,
	test,
} from "@/lib/case-store/sql/__tests__/setup";
import {
	migrateCaseLocationProperties,
	scanCaseLocationProperties,
} from "../lib/caseLocationProperties";

async function seedOwningApps(
	db: Kysely<Database>,
	...appIds: readonly string[]
): Promise<void> {
	await db
		.insertInto("apps")
		.values(
			appIds.map((appId) => ({
				id: appId,
				owner: "project-test",
				project_id: "project-test",
				app_name: appId,
				app_name_lower: appId.toLowerCase(),
				module_count: 0,
				form_count: 0,
				mutation_seq: 0,
				status: "complete",
				awaiting_input: false,
			})),
		)
		.execute();
}

describe("case location scan-then-migrate", () => {
	test("moves a document's location into the column and keeps a column a form wrote since", async ({
		db,
	}) => {
		await seedOwningApps(db, "app-a");
		const modifiedOn = new Date("2026-04-03T10:31:00.000Z");
		const moved = makeCaseRow({
			app_id: "app-a",
			modified_on: modifiedOn,
			properties: JSON.stringify({ location_id: "district-7", notes: "kept" }),
		});
		const newer = makeCaseRow({
			app_id: "app-a",
			location_id: "district-9",
			properties: JSON.stringify({ location_id: "district-1" }),
		});
		const plain = makeCaseRow({
			app_id: "app-a",
			properties: JSON.stringify({ notes: "none" }),
		});
		await db.insertInto("cases").values([moved, newer, plain]).execute();

		expect(await scanCaseLocationProperties(db)).toEqual([
			{ appId: "app-a", caseType: "patient", rowCount: 2, columnHeld: 1 },
		]);
		expect(await migrateCaseLocationProperties(db)).toBe(2);
		expect(await migrateCaseLocationProperties(db)).toBe(0);
		expect(await scanCaseLocationProperties(db)).toEqual([]);

		const rows = await db
			.selectFrom("cases")
			.select(["case_id", "location_id", "properties", "modified_on"])
			.execute();
		const byId = new Map(rows.map((row) => [row.case_id, row]));
		expect(byId.get(moved.case_id as string)).toMatchObject({
			location_id: "district-7",
			properties: { notes: "kept" },
			modified_on: modifiedOn,
		});
		expect(byId.get(newer.case_id as string)).toMatchObject({
			location_id: "district-9",
			properties: {},
		});
		expect(byId.get(plain.case_id as string)).toMatchObject({
			location_id: null,
			properties: { notes: "none" },
		});
	});

	test("repairs one app without touching another", async ({ db }) => {
		await seedOwningApps(db, "app-a", "app-b");
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					app_id: "app-a",
					properties: JSON.stringify({ location_id: "a" }),
				}),
				makeCaseRow({
					app_id: "app-b",
					properties: JSON.stringify({ location_id: "b" }),
				}),
			])
			.execute();
		expect(await migrateCaseLocationProperties(db, { appId: "app-a" })).toBe(1);
		expect(await scanCaseLocationProperties(db)).toEqual([
			{ appId: "app-b", caseType: "patient", rowCount: 1, columnHeld: 0 },
		]);
	});
});
