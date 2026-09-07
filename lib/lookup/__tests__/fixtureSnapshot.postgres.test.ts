// Live-Postgres coverage for the compile boundary's definitions-plus-rows
// reader. `getLookupFixtureData` must return every requested table's
// definition AND complete ordered row body from one REPEATABLE READ
// snapshot — the compile path may not loop `getLookupTable`, whose
// per-call snapshots could mix generations.

import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	createLookupRow,
	createLookupTable,
	getLookupFixtureData,
	getLookupManifest,
} from "../service";
import type { LookupScope } from "../types";

const h = setupAppStateTestDb("lookup_fixture_");

const OWNER_A: LookupScope = {
	projectId: "project-a",
	actorId: "owner-a",
	role: "owner",
};
const OWNER_B: LookupScope = {
	projectId: "project-b",
	actorId: "owner-b",
	role: "owner",
};

const MISSING_TABLE_ID = lookupTableIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789ab",
);

describe("getLookupFixtureData", () => {
	it("returns complete definitions and typed rows in authored order", async () => {
		const regions = await createLookupTable(OWNER_A, {
			name: "Regions",
			tag: "regions",
			columns: [
				{ wireName: "value", label: "Value", dataType: "text" },
				{ wireName: "pop", label: "Population", dataType: "int" },
			],
		});
		const statuses = await createLookupTable(OWNER_A, {
			name: "Statuses",
			tag: "statuses",
			columns: [{ wireName: "code", label: "Code", dataType: "text" }],
		});
		const [valueColumn, popColumn] = regions.columns;

		const first = await createLookupRow(OWNER_A, {
			tableId: regions.id,
			expectedTableRevision: regions.tableRevision,
			toIndex: 0,
			values: {
				[valueColumn.id]: "north",
				[popColumn.id]: 120,
			},
		});
		const second = await createLookupRow(OWNER_A, {
			tableId: regions.id,
			expectedTableRevision: first.tableRevision,
			toIndex: 1,
			values: { [valueColumn.id]: "south" },
		});
		/* Insert at the front so authored order diverges from insertion order:
		 * the reader must sort by `(order_key, id)`, not creation time. */
		const inserted = await createLookupRow(OWNER_A, {
			tableId: regions.id,
			expectedTableRevision: second.tableRevision,
			toIndex: 0,
			values: {
				[valueColumn.id]: "west",
				[popColumn.id]: -5,
			},
		});

		const snapshot = await getLookupFixtureData(OWNER_A, [
			statuses.id,
			regions.id,
		]);

		expect(snapshot.projectId).toBe(OWNER_A.projectId);
		expect(snapshot.definitions.map((table) => table.id)).toEqual(
			[regions.id, statuses.id].sort(),
		);
		expect(
			snapshot.definitions.find((table) => table.id === regions.id)?.columns,
		).toEqual(regions.columns);
		const manifest = await getLookupManifest(OWNER_A);
		expect(snapshot.projectRevision).toBe(manifest.projectRevision);

		const regionRows = snapshot.rowsByTable.get(regions.id);
		expect(regionRows?.map((row) => row.id)).toEqual([
			inserted.rowId,
			first.rowId,
			second.rowId,
		]);
		expect(regionRows?.map((row) => row.values[valueColumn.id])).toEqual([
			"west",
			"north",
			"south",
		]);
		/* Stored numbers stay numbers; a missing cell stays absent. */
		expect(regionRows?.[0].values[popColumn.id]).toBe(-5);
		expect(regionRows?.[2].values[popColumn.id]).toBeUndefined();

		const statusRows = snapshot.rowsByTable.get(statuses.id);
		expect(statusRows).toEqual([]);
	});

	it("treats missing and foreign requested ids identically: absent from both axes", async () => {
		const local = await createLookupTable(OWNER_A, {
			name: "Local",
			tag: "local_only",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});
		const foreign = await createLookupTable(OWNER_B, {
			name: "Foreign",
			tag: "foreign_only",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		});

		const snapshot = await getLookupFixtureData(OWNER_A, [
			local.id,
			foreign.id,
			MISSING_TABLE_ID,
		]);

		expect(snapshot.definitions.map((table) => table.id)).toEqual([local.id]);
		expect([...snapshot.rowsByTable.keys()]).toEqual([local.id]);
		expect(snapshot.rowsByTable.get(foreign.id)).toBeUndefined();
		expect(snapshot.rowsByTable.get(MISSING_TABLE_ID)).toBeUndefined();
	});

	it("reads the Project clock even for the empty request", async () => {
		await createLookupTable(OWNER_A, {
			name: "Existing",
			tag: "existing",
			columns: [{ wireName: "value", label: "Value", dataType: "text" }],
		});
		const snapshot = await getLookupFixtureData(OWNER_A, []);
		expect(snapshot.definitions).toEqual([]);
		expect(snapshot.rowsByTable.size).toBe(0);
		const manifest = await getLookupManifest(OWNER_A);
		expect(snapshot.projectRevision).toBe(manifest.projectRevision);
	});
});

it("keeps definitions and rows in one generation when a writer commits between reads", async () => {
	const table = await createLookupTable(OWNER_A, {
		name: "Snapshot",
		tag: "snapshot",
		columns: [{ wireName: "value", label: "Value", dataType: "text" }],
	});
	const column = table.columns[0];
	const row = await createLookupRow(OWNER_A, {
		tableId: table.id,
		expectedTableRevision: table.tableRevision,
		toIndex: 0,
		values: { [column.id]: "before" },
	});
	const before = await getLookupFixtureData(OWNER_A, [table.id]);
	const nextRevision = (BigInt(before.projectRevision) + BigInt(1)).toString();
	const writer = new Client({ connectionString: h.uri() });
	let pending:
		| Promise<
				PromiseSettledResult<Awaited<ReturnType<typeof getLookupFixtureData>>>[]
		  >
		| undefined;
	try {
		await writer.connect();
		await writer.query("BEGIN");
		// Only the second read touches lookup_rows. Holding its table lock lets
		// the reader finish the definition snapshot before we commit new data.
		await writer.query("LOCK TABLE lookup_rows IN ACCESS EXCLUSIVE MODE");
		const {
			rows: [{ pid }],
		} = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
		pending = Promise.allSettled([getLookupFixtureData(OWNER_A, [table.id])]);
		await vi.waitFor(async () => {
			await writer.query("SELECT pg_stat_clear_snapshot()");
			const blocked = await writer.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))",
				[pid],
			);
			expect(blocked.rows[0].count).toBe(1);
		});
		await writer.query(
			'UPDATE lookup_rows SET "values" = $1::jsonb WHERE id = $2',
			[JSON.stringify({ [column.id]: "after!" }), row.rowId],
		);
		await writer.query(
			"UPDATE lookup_columns SET label = 'After' WHERE id = $1",
			[column.id],
		);
		await writer.query(
			"UPDATE lookup_tables SET definition_revision = $1, rows_revision = $1 WHERE id = $2",
			[nextRevision, table.id],
		);
		await writer.query(
			"UPDATE lookup_project_state SET revision = $1 WHERE project_id = $2",
			[nextRevision, OWNER_A.projectId],
		);
		await writer.query("COMMIT");
		const [outcome] = await pending;
		if (outcome.status === "rejected") throw outcome.reason;
		expect(outcome.value).toEqual(before);
		const after = await getLookupFixtureData(OWNER_A, [table.id]);
		expect(after.projectRevision).toBe(nextRevision);
		expect(after.definitions[0].columns[0].label).toBe("After");
		expect(after.rowsByTable.get(table.id)).toEqual([
			{ id: row.rowId, values: { [column.id]: "after!" } },
		]);
	} finally {
		await writer.end();
		await pending;
	}
});
