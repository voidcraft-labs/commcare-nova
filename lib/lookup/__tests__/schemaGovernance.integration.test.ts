// Live-Postgres coverage for S02b's package-private schema-governance seam.
// The production wrapper deliberately remains a v0 closed gate. Successful
// destructive operations enter only through the transaction core after the
// test has explicitly declared writer v1 and enabled the compatibility row.

import { sql } from "kysely";
import { Client, type Notification } from "pg";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	LOOKUP_STREAM_CHANNEL,
	setTransactionWriterVersion,
} from "@/lib/db/pg";
import {
	type LookupColumnId,
	lookupColumnIdSchema,
} from "@/lib/domain/lookupIds";
import {
	applyLookupSchemaGovernance,
	applyLookupSchemaGovernanceInTransaction,
	LookupSchemaGovernanceError,
	type LookupSchemaGovernanceOperation,
} from "../schemaGovernance";
import { createLookupRow, createLookupTable, getLookupTable } from "../service";
import type {
	LookupColumnDraft,
	LookupRowValues,
	LookupScope,
	LookupTableSnapshot,
} from "../types";

const h = setupAppStateTestDb("lookup_schema_governance_");

const GOVERNOR: LookupScope = {
	projectId: "project-governance",
	actorId: "schema-governor",
	role: "owner",
};
const ROW_WRITER: LookupScope = {
	...GOVERNOR,
	actorId: "row-seed-writer",
};
const EDITOR: LookupScope = {
	...GOVERNOR,
	actorId: "schema-editor",
	role: "editor",
};

const TEXT_COLUMN: LookupColumnDraft = {
	wireName: "name",
	label: "Name",
	dataType: "text",
};
const MISSING_COLUMN_ID = lookupColumnIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789ab",
);

function rowValues(
	entries: readonly (readonly [LookupColumnId, string | number])[],
): LookupRowValues {
	const values: LookupRowValues = {};
	for (const [id, value] of entries) values[id] = value;
	return values;
}

async function createTable(
	columns: LookupColumnDraft[] = [
		TEXT_COLUMN,
		{ wireName: "code", label: "Code", dataType: "text" },
	],
): Promise<LookupTableSnapshot> {
	return createLookupTable(ROW_WRITER, {
		name: "Governed table",
		tag: "governed_table",
		columns,
	});
}

async function enableSchemaActions(): Promise<void> {
	await h
		.db()
		.updateTable("lookup_reference_compatibility")
		.set({
			minimum_writer_version: 1,
			destructive_schema_actions_enabled: true,
			updated_at: new Date(),
		})
		.where("id", "=", 1)
		.execute();
}

async function runV1Core(
	operation: LookupSchemaGovernanceOperation,
	scope: LookupScope = GOVERNOR,
): ReturnType<typeof applyLookupSchemaGovernanceInTransaction> {
	return h
		.db()
		.transaction()
		.execute(async (tx) => {
			await setTransactionWriterVersion(tx, 1);
			return applyLookupSchemaGovernanceInTransaction(tx, scope, operation, 1);
		});
}

async function expectGovernanceError(
	promise: Promise<unknown>,
	code: LookupSchemaGovernanceError["code"],
): Promise<LookupSchemaGovernanceError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(LookupSchemaGovernanceError);
	expect(caught).toMatchObject({ code });
	return caught as LookupSchemaGovernanceError;
}

async function nextLookupNotification(
	listener: Client,
): Promise<{ projectId: string; revision: string }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			listener.off("notification", onNotification);
			reject(new Error("Timed out waiting for lookup schema notification."));
		}, 2_000);
		timeout.unref();
		const onNotification = (notification: Notification) => {
			if (
				notification.channel !== LOOKUP_STREAM_CHANNEL ||
				!notification.payload
			) {
				return;
			}
			clearTimeout(timeout);
			listener.off("notification", onNotification);
			resolve(JSON.parse(notification.payload));
		};
		listener.on("notification", onNotification);
	});
}

async function backendPid(client: Client): Promise<number> {
	const result = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = result.rows[0]?.pid;
	if (pid === undefined) throw new Error("backend pid query returned no row");
	return pid;
}

async function waitUntilBackendBlockedBy(
	observer: Client,
	blockingPid: number,
): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const result = await observer.query<{ pid: number }>(
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
				AND pid <> pg_backend_pid()
				AND $1 = ANY(pg_blocking_pids(pid))
			 ORDER BY pid
			 LIMIT 1`,
			[blockingPid],
		);
		const pid = result.rows[0]?.pid;
		if (pid !== undefined) return pid;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`No backend blocked behind ${blockingPid} within one second.`,
	);
}

async function waitUntilBlockedBy(
	observer: Client,
	waitingPid: number,
	blockingPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const result = await observer.query<{ blockers: number[] }>(
			"SELECT pg_blocking_pids($1) AS blockers",
			[waitingPid],
		);
		if (result.rows[0]?.blockers.includes(blockingPid)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`Backend ${waitingPid} did not block behind ${blockingPid} within one second.`,
	);
}

describe("lookup schema governance", () => {
	it("keeps the production v0 wrapper write-free before and after floor-1 activation", async () => {
		const table = await createTable();
		const created = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			toIndex: 0,
			values: rowValues([
				[table.columns[0].id, "Alpha"],
				[table.columns[1].id, "A"],
			]),
		});
		const before = await getLookupTable(GOVERNOR, table.id);
		const operation = {
			kind: "remove-column",
			tableId: table.id,
			columnId: table.columns[1].id,
			expectedTableRevision: created.tableRevision,
		} satisfies LookupSchemaGovernanceOperation;

		const denied = await expectGovernanceError(
			applyLookupSchemaGovernance(EDITOR, operation),
			"not_found",
		);
		await expectGovernanceError(
			applyLookupSchemaGovernance(GOVERNOR, operation),
			"schema_actions_disabled",
		);
		expect(await getLookupTable(GOVERNOR, table.id)).toEqual(before);

		await enableSchemaActions();
		const deniedCore = await expectGovernanceError(
			runV1Core(operation, EDITOR),
			"not_found",
		);
		const missing = await expectGovernanceError(
			runV1Core({ ...operation, columnId: MISSING_COLUMN_ID }),
			"not_found",
		);
		expect(denied.message).toBe(missing.message);
		expect(deniedCore.message).toBe(missing.message);
		await expectGovernanceError(
			applyLookupSchemaGovernance(GOVERNOR, operation),
			"schema_actions_disabled",
		);
		expect(await getLookupTable(GOVERNOR, table.id)).toEqual(before);
	});

	it("reports only exact blocking app ids and ignores edges to another column", async () => {
		const table = await createTable([
			TEXT_COLUMN,
			{ wireName: "rank", label: "Rank", dataType: "int" },
			{ wireName: "notes", label: "Notes", dataType: "text" },
		]);
		const appA = await h.seedApp({
			id: "app-a",
			project_id: GOVERNOR.projectId,
		});
		const appZ = await h.seedApp({
			id: "app-z",
			project_id: GOVERNOR.projectId,
		});
		await h
			.db()
			.insertInto("lookup_table_references")
			.values(
				[appZ, appA].map((appId) => ({
					project_id: GOVERNOR.projectId,
					table_id: table.id,
					app_id: appId,
				})),
			)
			.execute();
		await h
			.db()
			.insertInto("lookup_column_references")
			.values({
				project_id: GOVERNOR.projectId,
				table_id: table.id,
				column_id: table.columns[1].id,
				app_id: appZ,
			})
			.execute();
		await enableSchemaActions();

		const tableBlocked = await expectGovernanceError(
			runV1Core({
				kind: "delete-table",
				tableId: table.id,
				expectedTableRevision: table.tableRevision,
			}),
			"referenced",
		);
		expect(tableBlocked.blockingAppIds).toEqual([appA, appZ]);

		for (const operation of [
			{
				kind: "remove-column" as const,
				tableId: table.id,
				columnId: table.columns[1].id,
				expectedTableRevision: table.tableRevision,
			},
			{
				kind: "retype-column" as const,
				tableId: table.id,
				columnId: table.columns[1].id,
				dataType: "decimal" as const,
				expectedTableRevision: table.tableRevision,
			},
		]) {
			const blocked = await expectGovernanceError(
				runV1Core(operation),
				"referenced",
			);
			expect(blocked.blockingAppIds).toEqual([appZ]);
		}

		const unreferenced = await runV1Core({
			kind: "remove-column",
			tableId: table.id,
			columnId: table.columns[2].id,
			expectedTableRevision: table.tableRevision,
		});
		expect(unreferenced).toMatchObject({
			kind: "remove-column",
			columnId: table.columns[2].id,
		});
	});

	it("refuses the last column before changing any row or revision", async () => {
		const table = await createTable([TEXT_COLUMN]);
		const row = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			toIndex: 0,
			values: rowValues([[table.columns[0].id, "Alpha"]]),
		});
		const before = await getLookupTable(GOVERNOR, table.id);
		await enableSchemaActions();

		await expectGovernanceError(
			runV1Core({
				kind: "remove-column",
				tableId: table.id,
				columnId: table.columns[0].id,
				expectedTableRevision: row.tableRevision,
			}),
			"last_column",
		);
		expect(await getLookupTable(GOVERNOR, table.id)).toEqual(before);
	});

	it("removes only the immutable column key with exact SQL byte accounting and one notification", async () => {
		const table = await createTable([
			TEXT_COLUMN,
			{ wireName: "rank", label: "Rank", dataType: "int" },
		]);
		const [nameId, rankId] = table.columns.map(({ id }) => id);
		const first = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			toIndex: 0,
			values: rowValues([
				[nameId, "Alpha"],
				[rankId, 1],
			]),
		});
		const second = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: first.tableRevision,
			toIndex: 1,
			values: rowValues([[nameId, "Beta"]]),
		});
		const third = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: second.tableRevision,
			toIndex: 2,
			values: rowValues([[rankId, 300]]),
		});
		const before = await getLookupTable(GOVERNOR, table.id);
		const rawBefore = await h
			.db()
			.selectFrom("lookup_rows")
			.selectAll()
			.where("project_id", "=", GOVERNOR.projectId)
			.where("table_id", "=", table.id)
			.execute();
		const beforeById = new Map(rawBefore.map((row) => [row.id, row]));
		await enableSchemaActions();

		const listener = new Client({ connectionString: h.uri() });
		await listener.connect();
		const notifications: Array<{ projectId: string; revision: string }> = [];
		const collect = (notification: Notification) => {
			if (
				notification.channel === LOOKUP_STREAM_CHANNEL &&
				notification.payload
			) {
				notifications.push(JSON.parse(notification.payload));
			}
		};
		listener.on("notification", collect);
		try {
			await listener.query(`LISTEN ${LOOKUP_STREAM_CHANNEL}`);
			const notification = nextLookupNotification(listener);
			const result = await runV1Core({
				kind: "remove-column",
				tableId: table.id,
				columnId: rankId,
				expectedTableRevision: third.tableRevision,
			});
			expect(await notification).toEqual({
				projectId: GOVERNOR.projectId,
				revision: result.projectRevision,
			});
			await listener.query("SELECT 1");
			expect(notifications).toEqual([
				{
					projectId: GOVERNOR.projectId,
					revision: result.projectRevision,
				},
			]);

			const after = await getLookupTable(GOVERNOR, table.id);
			const rawAfter = await h
				.db()
				.selectFrom("lookup_rows")
				.selectAll()
				.where("project_id", "=", GOVERNOR.projectId)
				.where("table_id", "=", table.id)
				.execute();
			const afterById = new Map(rawAfter.map((row) => [row.id, row]));
			const changedRowIds = [first.rowId, third.rowId];
			const expectedFreedBytes = changedRowIds.reduce((total, rowId) => {
				const oldRow = beforeById.get(rowId);
				const newRow = afterById.get(rowId);
				if (!oldRow || !newRow) throw new Error("accounting row disappeared");
				return total + oldRow.value_bytes - newRow.value_bytes;
			}, 0);

			expect(result.projectRevision).toBe(
				String(BigInt(before.projectRevision) + BigInt(1)),
			);
			expect(result).toMatchObject({
				kind: "remove-column",
				affectedRows: 2,
				affectedCells: 2,
				freedBytes: expectedFreedBytes,
				definitionRevision: result.projectRevision,
				rowsRevision: result.projectRevision,
				tableRevision: result.projectRevision,
			});
			expect(after).toMatchObject({
				columnCount: 1,
				rowCount: 3,
				dataBytes: before.dataBytes - expectedFreedBytes,
				definitionRevision: result.projectRevision,
				rowsRevision: result.projectRevision,
			});
			expect(after.columns.map(({ id }) => id)).toEqual([nameId]);
			for (const row of after.rows) {
				expect(row.values).not.toHaveProperty(rankId);
			}
			for (const rowId of changedRowIds) {
				expect(afterById.get(rowId)).toMatchObject({
					created_by: ROW_WRITER.actorId,
					updated_by: GOVERNOR.actorId,
				});
			}
			expect(afterById.get(second.rowId)).toEqual(beforeById.get(second.rowId));
		} finally {
			await listener.query("UNLISTEN *");
			listener.off("notification", collect);
			await listener.end();
		}
	});

	it("retypes only after all present cells already satisfy the target and never rewrites values", async () => {
		const table = await createTable([
			{ wireName: "rank", label: "Rank", dataType: "int" },
			TEXT_COLUMN,
		]);
		const [rankId, nameId] = table.columns.map(({ id }) => id);
		const first = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			toIndex: 0,
			values: rowValues([
				[rankId, 7],
				[nameId, "Alpha"],
			]),
		});
		const second = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: first.tableRevision,
			toIndex: 1,
			values: rowValues([[nameId, "Missing rank"]]),
		});
		const before = await getLookupTable(GOVERNOR, table.id);
		const storedBefore = await sql<{
			id: string;
			values_text: string;
			value_bytes: number;
			updated_by: string;
			updated_at: Date;
		}>`
			SELECT id::text, "values"::text AS values_text, value_bytes,
				updated_by, updated_at
			FROM lookup_rows
			WHERE project_id = ${GOVERNOR.projectId}
				AND table_id = ${table.id}
			ORDER BY id
		`.execute(h.db());
		await enableSchemaActions();

		const result = await runV1Core({
			kind: "retype-column",
			tableId: table.id,
			columnId: rankId,
			dataType: "decimal",
			expectedTableRevision: second.tableRevision,
		});
		const after = await getLookupTable(GOVERNOR, table.id);
		const storedAfter = await sql<{
			id: string;
			values_text: string;
			value_bytes: number;
			updated_by: string;
			updated_at: Date;
		}>`
			SELECT id::text, "values"::text AS values_text, value_bytes,
				updated_by, updated_at
			FROM lookup_rows
			WHERE project_id = ${GOVERNOR.projectId}
				AND table_id = ${table.id}
			ORDER BY id
		`.execute(h.db());

		expect(result.projectRevision).toBe(
			String(BigInt(before.projectRevision) + BigInt(1)),
		);
		expect(result).toMatchObject({
			kind: "retype-column",
			changed: true,
			checkedCells: 1,
			definitionRevision: result.projectRevision,
			rowsRevision: before.rowsRevision,
		});
		expect(after.columns.find(({ id }) => id === rankId)?.dataType).toBe(
			"decimal",
		);
		expect(after.dataBytes).toBe(before.dataBytes);
		expect(after.rows).toEqual(before.rows);
		expect(storedAfter.rows).toEqual(storedBefore.rows);
	});

	it("rejects coercible-only and otherwise incompatible cells while missing cells stay irrelevant", async () => {
		const table = await createTable([
			TEXT_COLUMN,
			{
				wireName: "notes",
				label: "Notes",
				dataType: "text",
			},
		]);
		const [nameId, notesId] = table.columns.map(({ id }) => id);
		const coercibleOnly = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			toIndex: 0,
			values: rowValues([[nameId, "12"]]),
		});
		const missing = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: coercibleOnly.tableRevision,
			toIndex: 1,
			values: rowValues([[notesId, "No name cell"]]),
		});
		const before = await getLookupTable(GOVERNOR, table.id);
		await enableSchemaActions();

		const error = await expectGovernanceError(
			runV1Core({
				kind: "retype-column",
				tableId: table.id,
				columnId: nameId,
				dataType: "int",
				expectedTableRevision: missing.tableRevision,
			}),
			"incompatible_values",
		);
		expect(error.incompatibleRowIds).toEqual([coercibleOnly.rowId]);
		expect(await getLookupTable(GOVERNOR, table.id)).toEqual(before);
	});

	it("hard-deletes an unreferenced table through cascades while retaining and advancing Project state", async () => {
		const table = await createTable();
		const row = await createLookupRow(ROW_WRITER, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			toIndex: 0,
			values: rowValues([[table.columns[0].id, "Alpha"]]),
		});
		const before = await getLookupTable(GOVERNOR, table.id);
		await enableSchemaActions();

		const result = await runV1Core({
			kind: "delete-table",
			tableId: table.id,
			expectedTableRevision: row.tableRevision,
		});
		expect(result).toEqual({
			kind: "delete-table",
			tableId: table.id,
			projectRevision: String(BigInt(before.projectRevision) + BigInt(1)),
			deletedColumnCount: before.columnCount,
			deletedRowCount: before.rowCount,
			freedBytes: before.dataBytes,
		});
		const state = await h
			.db()
			.selectFrom("lookup_project_state")
			.selectAll()
			.where("project_id", "=", GOVERNOR.projectId)
			.executeTakeFirst();
		expect(state?.revision).toBe(result.projectRevision);
		const remaining = await sql<{
			tables: number;
			columns: number;
			rows: number;
		}>`
			SELECT
				(SELECT count(*)::integer FROM lookup_tables) AS tables,
				(SELECT count(*)::integer FROM lookup_columns) AS columns,
				(SELECT count(*)::integer FROM lookup_rows) AS rows
		`.execute(h.db());
		expect(remaining.rows[0]).toEqual({ tables: 0, columns: 0, rows: 0 });
	});

	it("lets an admitted removal finish before a concurrent compatibility disable", async () => {
		const table = await createTable();
		await enableSchemaActions();
		const blocker = new Client({ connectionString: h.uri() });
		const disabler = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([
			blocker.connect(),
			disabler.connect(),
			observer.connect(),
		]);
		try {
			await blocker.query("BEGIN");
			await blocker.query(
				`SELECT id FROM lookup_columns
				 WHERE project_id = $1 AND table_id = $2 AND id = $3
				 FOR UPDATE`,
				[GOVERNOR.projectId, table.id, table.columns[1].id],
			);
			const blockerPid = await backendPid(blocker);
			const operation = runV1Core({
				kind: "remove-column",
				tableId: table.id,
				columnId: table.columns[1].id,
				expectedTableRevision: table.tableRevision,
			}).then(
				(value) => ({ ok: true as const, value, error: undefined }),
				(error: unknown) => ({ ok: false as const, value: undefined, error }),
			);
			const operationPid = await waitUntilBackendBlockedBy(
				observer,
				blockerPid,
			);
			const disablerPid = await backendPid(disabler);
			const disable = disabler
				.query(
					`UPDATE lookup_reference_compatibility
					 SET destructive_schema_actions_enabled = false
					 WHERE id = 1`,
				)
				.then(
					() => ({ ok: true as const, error: undefined }),
					(error: unknown) => ({ ok: false as const, error }),
				);
			await waitUntilBlockedBy(observer, disablerPid, operationPid);
			await blocker.query("COMMIT");

			const operationOutcome = await operation;
			const disableOutcome = await disable;
			expect(operationOutcome.ok).toBe(true);
			expect(disableOutcome.ok).toBe(true);
			expect((await getLookupTable(GOVERNOR, table.id)).columnCount).toBe(1);
			const compatibility = await h
				.db()
				.selectFrom("lookup_reference_compatibility")
				.select("destructive_schema_actions_enabled")
				.where("id", "=", 1)
				.executeTakeFirstOrThrow();
			expect(compatibility.destructive_schema_actions_enabled).toBe(false);
		} finally {
			await Promise.allSettled([
				blocker.query("ROLLBACK"),
				disabler.query("ROLLBACK"),
				observer.query("ROLLBACK"),
			]);
			await Promise.all([blocker.end(), disabler.end(), observer.end()]);
		}
	});

	it("observes a compatibility disable that wins before the core's FOR SHARE lock and writes nothing", async () => {
		const table = await createTable();
		await enableSchemaActions();
		const before = await getLookupTable(GOVERNOR, table.id);
		const disabler = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([disabler.connect(), observer.connect()]);
		try {
			await disabler.query("BEGIN");
			await disabler.query(
				`UPDATE lookup_reference_compatibility
				 SET destructive_schema_actions_enabled = false
				 WHERE id = 1`,
			);
			const disablerPid = await backendPid(disabler);
			const operation = runV1Core({
				kind: "remove-column",
				tableId: table.id,
				columnId: table.columns[1].id,
				expectedTableRevision: table.tableRevision,
			}).then(
				(value) => ({ ok: true as const, value, error: undefined }),
				(error: unknown) => ({ ok: false as const, value: undefined, error }),
			);
			await waitUntilBackendBlockedBy(observer, disablerPid);
			await disabler.query("COMMIT");
			const outcome = await operation;
			expect(outcome.ok).toBe(false);
			expect(outcome.error).toMatchObject({
				code: "schema_actions_disabled",
			});
			expect(await getLookupTable(GOVERNOR, table.id)).toEqual(before);
		} finally {
			await Promise.allSettled([
				disabler.query("ROLLBACK"),
				observer.query("ROLLBACK"),
			]);
			await Promise.all([disabler.end(), observer.end()]);
		}
	});
});
