import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { applyLookupAuthoringBatchInTransaction } from "../authoringBatch";
import { LookupError } from "../errors";
import {
	getAllLookupDefinitions,
	getLookupTable,
	getLookupTableRowsPage,
	LOOKUP_AUTHORING_ROW_PAGE_MAX_BYTES,
} from "../service";
import type { LookupScope } from "../types";

const h = setupAppStateTestDb("lookup_authoring_batch_");

const OWNER: LookupScope = {
	projectId: "project-authoring",
	actorId: "owner-authoring",
	role: "owner",
};

function runBatch(
	input: Parameters<typeof applyLookupAuthoringBatchInTransaction>[2],
) {
	return h
		.db()
		.transaction()
		.execute((tx) => applyLookupAuthoringBatchInTransaction(tx, OWNER, input));
}

describe("lookup atomic authoring batch", () => {
	it("creates several complete tables, advances once, and returns every minted identity", async () => {
		const receipt = await runBatch({
			createTables: [
				{
					key: "regions",
					name: "Regions",
					tag: "regions",
					columns: [
						{ key: "code", wireName: "code", label: "Code", dataType: "text" },
						{
							key: "label",
							wireName: "label",
							label: "Label",
							dataType: "text",
						},
					],
					rows: [
						{
							key: "north",
							cells: [
								{ columnKey: "code", value: "north" },
								{ columnKey: "label", value: "North" },
							],
						},
					],
				},
				{
					key: "priorities",
					name: "Priorities",
					tag: "priorities",
					columns: [
						{
							key: "value",
							wireName: "value",
							label: "Value",
							dataType: "int",
						},
					],
					rows: [{ key: "high", cells: [{ columnKey: "value", value: 3 }] }],
				},
			],
		});

		expect(receipt.projectRevision).toBe("1");
		expect(receipt.tables.map((table) => table.key)).toEqual([
			"regions",
			"priorities",
		]);
		expect(receipt.tables[0].columnIds.map(({ key }) => key)).toEqual([
			"code",
			"label",
		]);
		expect(receipt.tables[0].rowIds.map(({ key }) => key)).toEqual(["north"]);
		const regions = await getLookupTable(OWNER, receipt.tables[0].tableId);
		expect(regions.projectRevision).toBe("1");
		expect(regions.rows[0].values).toEqual({
			[receipt.tables[0].columnIds[0].id]: "north",
			[receipt.tables[0].columnIds[1].id]: "North",
		});
		const catalog = await getAllLookupDefinitions(OWNER);
		expect(catalog.definitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: regions.id,
					columnCount: 2,
					rowCount: 1,
					tableRevision: "1",
				}),
			]),
		);
	});

	it("resolves same-batch created column and row keys as targets and anchors", async () => {
		const created = await runBatch({
			createTables: [
				{
					key: "facilities",
					name: "Facilities",
					tag: "facilities",
					columns: [
						{ key: "name", wireName: "name", label: "Name", dataType: "text" },
					],
					rows: [],
				},
			],
		});
		const table = created.tables[0];
		if (table.revisions === undefined)
			throw new Error("Created table had no revisions.");
		const nameColumnId = table.columnIds[0].id;
		const edited = await runBatch({
			updateTables: [
				{
					tableId: table.tableId,
					expectedTableRevision: table.revisions.tableRevision,
					columnOperations: [
						{
							kind: "add",
							key: "code",
							column: { wireName: "code", label: "Code", dataType: "text" },
						},
						{
							kind: "move",
							columnKey: "code",
							afterColumnId: null,
						},
					],
					rowOperations: [
						{
							kind: "add",
							key: "first",
							cells: [
								{ columnId: nameColumnId, value: "Clinic A" },
								{ columnKey: "code", value: "a" },
							],
						},
						{
							kind: "add",
							key: "second",
							afterRowKey: "first",
							cells: [
								{ columnId: nameColumnId, value: "Clinic B" },
								{ columnKey: "code", value: "b" },
							],
						},
						{
							kind: "move",
							rowKey: "second",
							afterRowId: null,
						},
					],
				},
			],
		});
		expect(edited.projectRevision).toBe("2");
		const snapshot = await getLookupTable(OWNER, table.tableId);
		expect(snapshot.columns.map(({ wireName }) => wireName)).toEqual([
			"code",
			"name",
		]);
		expect(snapshot.rows.map((row) => row.values[nameColumnId])).toEqual([
			"Clinic B",
			"Clinic A",
		]);
	});

	it("validates a retype against same-batch replacement rows", async () => {
		const created = await runBatch({
			createTables: [
				{
					key: "scores",
					name: "Scores",
					tag: "scores",
					columns: [
						{
							key: "score",
							wireName: "score",
							label: "Score",
							dataType: "text",
						},
					],
					rows: [
						{
							key: "old",
							cells: [{ columnKey: "score", value: "not an integer" }],
						},
					],
				},
			],
		});
		const table = created.tables[0];
		if (table.revisions === undefined)
			throw new Error("Created table had no revisions.");
		const scoreColumnId = table.columnIds[0].id;

		const migrated = await runBatch({
			updateTables: [
				{
					tableId: table.tableId,
					expectedTableRevision: table.revisions.tableRevision,
					columnOperations: [
						{
							kind: "retype",
							columnId: scoreColumnId,
							dataType: "int",
						},
					],
					replaceRows: [
						{
							key: "replacement",
							cells: [{ columnId: scoreColumnId, value: 42 }],
						},
					],
				},
			],
		});

		expect(migrated.projectRevision).toBe("2");
		const snapshot = await getLookupTable(OWNER, table.tableId);
		expect(snapshot.columns[0].dataType).toBe("int");
		expect(snapshot.rows).toHaveLength(1);
		expect(snapshot.rows[0].values[scoreColumnId]).toBe(42);
		expect(snapshot.rows[0].id).toBe(migrated.tables[0].rowIds[0].id);
	});

	it("rolls the whole multi-table batch back when a later table is invalid", async () => {
		await expect(
			runBatch({
				createTables: [
					{
						key: "good",
						name: "Good",
						tag: "duplicate",
						columns: [
							{
								key: "value",
								wireName: "value",
								label: "Value",
								dataType: "text",
							},
						],
						rows: [],
					},
					{
						key: "bad",
						name: "Bad",
						tag: "duplicate",
						columns: [
							{
								key: "value",
								wireName: "value",
								label: "Value",
								dataType: "text",
							},
						],
						rows: [],
					},
				],
			}),
		).rejects.toMatchObject({ code: "tag_taken" });
		expect((await getAllLookupDefinitions(OWNER)).definitions).toEqual([]);
	});

	it("pages 100 ordered rows and refuses a cursor after table drift", async () => {
		const created = await runBatch({
			createTables: [
				{
					key: "many",
					name: "Many rows",
					tag: "many_rows",
					columns: [
						{
							key: "value",
							wireName: "value",
							label: "Value",
							dataType: "text",
						},
					],
					rows: Array.from({ length: 101 }, (_, index) => ({
						key: `row-${index}`,
						cells: [{ columnKey: "value", value: `value-${index}` }],
					})),
				},
			],
		});
		const table = created.tables[0];
		if (table.revisions === undefined)
			throw new Error("Created table had no revisions.");
		const valueColumnId = table.columnIds[0].id;
		const first = await getLookupTableRowsPage(OWNER, {
			tableId: table.tableId,
			columnIds: [valueColumnId],
		});
		expect(first.rows).toHaveLength(100);
		expect(first.complete).toBe(false);
		expect(first.nextCursor).toBeTypeOf("string");
		const second = await getLookupTableRowsPage(OWNER, {
			tableId: table.tableId,
			columnIds: [valueColumnId],
			cursor: first.nextCursor,
		});
		expect(second.rows).toHaveLength(1);
		expect(second.complete).toBe(true);

		await runBatch({
			updateTables: [
				{
					tableId: table.tableId,
					expectedTableRevision: table.revisions.tableRevision,
					rowOperations: [
						{
							kind: "update",
							rowId: table.rowIds[0].id,
							cells: [{ columnId: valueColumnId, value: "changed" }],
						},
					],
				},
			],
		});
		let caught: unknown;
		try {
			await getLookupTableRowsPage(OWNER, {
				tableId: table.tableId,
				columnIds: [valueColumnId],
				cursor: first.nextCursor,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(LookupError);
		expect(caught).toMatchObject({ code: "conflict" });
	});

	it("continues by byte budget when fewer than 100 large rows fit", async () => {
		const large = "x".repeat(60_000);
		const created = await runBatch({
			createTables: [
				{
					key: "large-rows",
					name: "Large rows",
					tag: "large_rows",
					columns: [
						{
							key: "value",
							wireName: "value",
							label: "Value",
							dataType: "text",
						},
					],
					rows: [0, 1].map((index) => ({
						key: `row-${index}`,
						cells: [{ columnKey: "value", value: `${index}${large}` }],
					})),
				},
			],
		});
		const table = created.tables[0];
		const columnId = table.columnIds[0].id;
		const first = await getLookupTableRowsPage(OWNER, {
			tableId: table.tableId,
			columnIds: [columnId],
		});
		expect(first.rows).toHaveLength(1);
		expect(first.complete).toBe(false);
		const second = await getLookupTableRowsPage(OWNER, {
			tableId: table.tableId,
			columnIds: [columnId],
			cursor: first.nextCursor,
		});
		expect(second.rows).toHaveLength(1);
		expect(second.complete).toBe(true);
	});

	it("budgets wide rows in the exact cell-array shape returned to both model surfaces", async () => {
		const columns = Array.from({ length: 250 }, (_, index) => ({
			key: `column-${index}`,
			wireName: `column_${index}`,
			label: `Column ${index}`,
			dataType: "text" as const,
		}));
		const created = await runBatch({
			createTables: [
				{
					key: "wide-rows",
					name: "Wide rows",
					tag: "wide_rows",
					columns,
					rows: Array.from({ length: 3 }, (_, rowIndex) => ({
						key: `row-${rowIndex}`,
						cells: columns.map((column) => ({
							columnKey: column.key,
							value: `v${rowIndex}`,
						})),
					})),
				},
			],
		});
		const table = created.tables[0];
		const columnIds = table.columnIds.map((column) => column.id);
		const first = await getLookupTableRowsPage(OWNER, {
			tableId: table.tableId,
			columnIds,
		});

		expect(first.rows.length).toBeGreaterThan(0);
		expect(first.rows.length).toBeLessThan(3);
		expect(first.complete).toBe(false);
		expect(first.nextCursor?.length).toBeLessThanOrEqual(4096);
		expect(first.rows[0]?.cells).toHaveLength(250);
		expect(JSON.stringify(first.rows)).not.toContain('"values"');
		const sharedToolBytes = Buffer.byteLength(
			JSON.stringify({ kind: "read", data: first }),
			"utf8",
		);
		const designInspectorBytes = Buffer.byteLength(
			JSON.stringify({ kind: "rows", ...first }),
			"utf8",
		);
		expect(sharedToolBytes).toBeLessThanOrEqual(
			LOOKUP_AUTHORING_ROW_PAGE_MAX_BYTES,
		);
		expect(designInspectorBytes).toBeLessThanOrEqual(
			LOOKUP_AUTHORING_ROW_PAGE_MAX_BYTES,
		);

		const second = await getLookupTableRowsPage(OWNER, {
			tableId: table.tableId,
			columnIds,
			cursor: first.nextCursor,
		});
		expect(first.rows.length + second.rows.length).toBe(3);
		expect(second.complete).toBe(true);
	});
});
