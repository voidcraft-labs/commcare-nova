import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { type Column, plainColumn, tileCell } from "@/lib/domain";
import { loadPersistedBlueprintSnapshot } from "../loadPersistedBlueprint";
import { repairAuthoringBaseline } from "../repairAuthoringBaselines";
import { inspectTileRows, migrateTileRows } from "../tileRowRepair";

const h = setupAppStateTestDb("tile_rows_repair_");
const MENU = testUuid("tile-rows-menu");
const col = (id: string, cell?: ReturnType<typeof tileCell>) =>
	plainColumn(testUuid(id), id === "name" ? "case_name" : id, id, {
		...(cell && { tile: cell }),
	});

/** A saved app from before the row rule: a tile of three fields, one ending on
 *  the eighth row past an empty band, and a Details tile of three with no
 *  empty row whose last field runs from the fifth row to the eighth. */
async function legacy() {
	const columns: Column[] = [
		col("name", tileCell(0, 0, 12, 1)),
		col("village", tileCell(0, 1, 12, 1)),
		col("phone", tileCell(0, 7, 12, 1)),
	];
	const order = columns.map((column) => column.uuid);
	// Historical data intentionally predates the strengthened admission rule.
	const appId = await h.seedAppWithBlueprint(
		buildDoc({
			caseTypes: [
				{
					name: "visit",
					properties: ["case_name", "village", "phone"].map((name) => ({
						name,
						label: name,
						data_type: "text" as const,
					})),
				},
			],
			modules: [
				{
					uuid: MENU,
					name: "Visits",
					caseType: "visit",
					caseListConfig: {
						columns,
						listColumnOrder: order,
						detailColumnOrder: [...order],
						searchInputs: [],
						tile: {},
						detailTile: {
							cells: {
								[columns[0].uuid]: tileCell(0, 0, 6, 4),
								[columns[1].uuid]: tileCell(6, 0, 6, 4),
								[columns[2].uuid]: tileCell(0, 4, 12, 4),
							},
						},
					},
					forms: [
						{
							name: "Record visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
		}),
	);
	await repairAuthoringBaseline(appId);
	return appId;
}

it("plans the least move each runtime draws, applies it once, and leaves a reloadable history", async () => {
	const appId = await legacy();
	const inspected = await inspectTileRows(appId);
	expect(inspected.findings.map((finding) => finding.code).sort()).toEqual([
		"CASE_DETAIL_TILE_LAYOUT_INVALID",
		"CASE_LIST_TILE_CELL_OUT_OF_GRID",
	]);
	const plan = inspected.plan;
	if (plan === null) throw new Error("The app needs a repair.");
	expect(inspected.left).toEqual([]);
	expect(plan.moves).toEqual([
		// Results: two of the five empty rows under the second field go, which no
		// Web Apps row draws; the third field keeps its place relative to the rest.
		{
			moduleUuid: MENU,
			screen: "results",
			columnUuid: testUuid("phone"),
			before: tileCell(0, 7, 12, 1),
			after: tileCell(0, 5, 12, 1),
			how: "empty-rows-removed",
		},
		// Details: no row is empty, so the last field is fitted, two rows shorter,
		// and the plan says so.
		{
			moduleUuid: MENU,
			screen: "details",
			columnUuid: testUuid("phone"),
			before: tileCell(0, 4, 12, 4),
			after: tileCell(0, 4, 12, 2),
			how: "fitted",
		},
	]);
	await migrateTileRows(plan);
	expect((await inspectTileRows(appId)).plan).toBeNull();
	const loaded = await loadApp(appId);
	const config = loaded?.blueprint.modules[MENU]?.caseListConfig;
	expect(
		config?.columns.find((column) => column.uuid === testUuid("phone"))?.tile,
	).toEqual(tileCell(0, 5, 12, 1));
	expect(await migrateTileRows(plan)).toMatchObject({
		status: "already-applied",
	});
	const changes = await h
		.db()
		.selectFrom("app_changes")
		.selectAll()
		.where("app_id", "=", appId)
		.execute();
	expect(
		changes.filter((change) => change.kind === "blueprint-migration"),
	).toEqual([
		expect.objectContaining({
			kind: "blueprint-migration",
			actor_id: "system:tile-rows",
		}),
	]);
});

it("refuses a stale plan without a partial write", async () => {
	const appId = await legacy();
	const plan = (await inspectTileRows(appId)).plan;
	if (plan === null) throw new Error("The app needs a repair.");
	await expect(
		migrateTileRows({ ...plan, baseDigest: "stale" }),
	).rejects.toThrow("reviewed repair basis");
	await expect(
		migrateTileRows({
			...plan,
			moves: plan.moves.map((move) => ({
				...move,
				after: tileCell(0, 2, 12, 1),
			})),
		}),
	).rejects.toThrow("do not match");
	const snapshot = await loadPersistedBlueprintSnapshot(appId);
	expect(snapshot?.mutationSeq).toBe(plan.expectedBaseSeq);
});

it("leaves a tile that fits untouched", async () => {
	const appId = await legacy();
	const plan = (await inspectTileRows(appId)).plan;
	if (plan === null) throw new Error("The app needs a repair.");
	await migrateTileRows(plan);
	const again = await inspectTileRows(appId);
	expect(again).toMatchObject({ plan: null, findings: [] });
});
