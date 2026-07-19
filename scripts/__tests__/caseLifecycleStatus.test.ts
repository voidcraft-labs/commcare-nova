import { describe } from "vitest";
import {
	expect,
	makeCaseRow,
	test,
} from "@/lib/case-store/sql/__tests__/setup";
import {
	migrateClosedStatusMismatches,
	scanClosedStatusMismatches,
} from "../lib/caseLifecycleStatus";

describe("case lifecycle status scan-then-migrate", () => {
	test("finds only closed rows whose built-in status is stale", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					app_id: "app-a",
					case_type: "patient",
					status: "open",
					closed_on: new Date("2026-04-03T10:30:00.000Z"),
				}),
				makeCaseRow({
					app_id: "app-a",
					case_type: "patient",
					status: null,
					closed_on: new Date("2026-04-04T10:30:00.000Z"),
				}),
				makeCaseRow({
					app_id: "app-a",
					case_type: "patient",
					status: "closed",
					closed_on: new Date("2026-04-05T10:30:00.000Z"),
				}),
				makeCaseRow({
					app_id: "app-a",
					case_type: "patient",
					status: "open",
					closed_on: null,
				}),
			])
			.execute();

		const groups = await scanClosedStatusMismatches(db);
		expect(groups).toEqual([
			{
				appId: "app-a",
				caseType: "patient",
				storedStatus: "open",
				rowCount: 1,
			},
			{
				appId: "app-a",
				caseType: "patient",
				storedStatus: null,
				rowCount: 1,
			},
		]);
	});

	test("repairs status while preserving the original lifecycle timestamps", async ({
		db,
	}) => {
		const closedOn = new Date("2026-04-03T10:30:00.000Z");
		const modifiedOn = new Date("2026-04-03T10:31:00.000Z");
		const row = makeCaseRow({
			app_id: "app-a",
			status: "open",
			closed_on: closedOn,
			modified_on: modifiedOn,
		});
		await db.insertInto("cases").values(row).execute();

		expect(await migrateClosedStatusMismatches(db)).toBe(1);
		expect(await migrateClosedStatusMismatches(db)).toBe(0);
		expect(await scanClosedStatusMismatches(db)).toEqual([]);
		const repaired = await db
			.selectFrom("cases")
			.select(["status", "closed_on", "modified_on"])
			.where("case_id", "=", row.case_id as string)
			.executeTakeFirstOrThrow();
		expect(repaired.status).toBe("closed");
		expect(repaired.closed_on).toEqual(closedOn);
		expect(repaired.modified_on).toEqual(modifiedOn);
	});

	test("supports an app-scoped repair without touching another app", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					app_id: "app-a",
					status: "open",
					closed_on: new Date("2026-04-03T10:30:00.000Z"),
				}),
				makeCaseRow({
					app_id: "app-b",
					status: "open",
					closed_on: new Date("2026-04-03T10:30:00.000Z"),
				}),
			])
			.execute();

		expect(await migrateClosedStatusMismatches(db, { appId: "app-a" })).toBe(1);
		expect(await scanClosedStatusMismatches(db, { appId: "app-a" })).toEqual(
			[],
		);
		expect(await scanClosedStatusMismatches(db, { appId: "app-b" })).toEqual([
			expect.objectContaining({ appId: "app-b", rowCount: 1 }),
		]);
	});
});
