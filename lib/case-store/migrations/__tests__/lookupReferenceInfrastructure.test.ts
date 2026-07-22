// Live-Postgres contract tests for S02a's dormant lookup-reference storage.
// The shared harness applies the exact production migration chain; each test
// runs in its rollback transaction. A separate sibling suite owns the two-
// connection floor/write races and connection-reuse GUC reset checks.

import type { Insertable, Selectable, Transaction } from "kysely";
import type { PoolClient } from "pg";
import { describe } from "vitest";
import type {
	AppDatabase,
	LookupColumnReferencesTable,
	LookupReferenceCompatibilityTable,
	LookupStreamCapabilityLeasesTable,
	LookupTableReferencesTable,
} from "@/lib/db/pg";
import { setTransactionWriterVersion } from "@/lib/db/pg";
import { expect, test } from "../../sql/__tests__/setup";

const ACTOR = "lookup-reference-test";

async function expectSqlState(
	client: PoolClient,
	expectedCode: string,
	statement: string,
	parameters: unknown[] = [],
): Promise<void> {
	await client.query("SAVEPOINT lookup_reference_expected_error");
	let error: unknown;
	try {
		await client.query(statement, parameters);
	} catch (caught) {
		error = caught;
	}
	await client.query("ROLLBACK TO SAVEPOINT lookup_reference_expected_error");
	await client.query("RELEASE SAVEPOINT lookup_reference_expected_error");
	expect((error as { code?: string } | undefined)?.code).toBe(expectedCode);
}

async function insertApp(
	client: PoolClient,
	projectId: string,
	appId = `app-${crypto.randomUUID()}`,
): Promise<string> {
	await client.query(
		`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		 VALUES ($1, $2, $3, 'Reference test', 'reference test')`,
		[appId, ACTOR, projectId],
	);
	return appId;
}

async function insertLookupTable(
	client: PoolClient,
	projectId: string,
): Promise<string> {
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
	const result = await client.query<{ id: string }>(
		`INSERT INTO lookup_tables
			(project_id, name, tag, definition_revision, rows_revision,
			 column_count, created_by, updated_by)
		 VALUES ($1, $2, $3, 0, 0, 1, $4, $4)
		 RETURNING id`,
		[projectId, `Table ${suffix}`, `table_${suffix}`, ACTOR],
	);
	const id = result.rows[0]?.id;
	if (!id) throw new Error("lookup table insert returned no id");
	return id;
}

async function insertLookupColumn(
	client: PoolClient,
	projectId: string,
	tableId: string,
	dataType = "text",
): Promise<string> {
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
	const result = await client.query<{ id: string }>(
		`INSERT INTO lookup_columns
			(project_id, table_id, wire_name, label, data_type, order_key)
		 VALUES ($1, $2, $3, $4, $5, 'V')
		 RETURNING id`,
		[projectId, tableId, `column_${suffix}`, `Column ${suffix}`, dataType],
	);
	const id = result.rows[0]?.id;
	if (!id) throw new Error("lookup column insert returned no id");
	return id;
}

async function insertEntity(
	client: PoolClient,
	appId: string,
	uuid = `module-${crypto.randomUUID()}`,
): Promise<string> {
	await client.query(
		`INSERT INTO blueprint_entities
			(app_id, uuid, kind, parent_uuid, ordinal, data)
		 VALUES ($1, $2, 'module', NULL, 0, '{}'::jsonb)`,
		[appId, uuid],
	);
	return uuid;
}

async function insertAcceptedMutation(
	client: PoolClient,
	appId: string,
	seq = 1,
): Promise<void> {
	await client.query(
		`INSERT INTO accepted_mutations
			(app_id, seq, batch_id, actor_id, kind, mutations)
		 VALUES ($1, $2, $3, $4, 'human', '[]'::jsonb)`,
		[appId, seq, crypto.randomUUID(), ACTOR],
	);
}

describe("lookup-reference infrastructure migration", () => {
	test("keeps AppDatabase insert/select shapes aligned with the DDL", () => {
		const tableEdge = {
			project_id: "project-a",
			table_id: crypto.randomUUID(),
			app_id: "app-a",
		} satisfies Insertable<LookupTableReferencesTable>;
		const columnEdge = {
			...tableEdge,
			column_id: crypto.randomUUID(),
		} satisfies Insertable<LookupColumnReferencesTable>;
		const lease = {
			app_id: "app-a",
			receiver_version: 2,
			expires_at: new Date("2026-07-22T12:00:00Z"),
		} satisfies Insertable<LookupStreamCapabilityLeasesTable>;
		const forbiddenCallerIdentity: Insertable<LookupStreamCapabilityLeasesTable> =
			{
				...lease,
				// @ts-expect-error — connection identity is server-generated only.
				connection_id: crypto.randomUUID(),
			};
		const compatibility = {
			id: 1,
			minimum_writer_version: 0,
			minimum_stream_receiver_version: 0,
			minimum_runtime_reader_version: 0,
			carrier_commits_enabled: false,
			destructive_schema_actions_enabled: false,
			project_moves_enabled: false,
			updated_at: new Date("2026-07-22T12:00:00Z"),
		} satisfies Selectable<LookupReferenceCompatibilityTable>;

		expect(columnEdge.table_id).toBe(tableEdge.table_id);
		expect("connection_id" in lease).toBe(false);
		expect(forbiddenCallerIdentity.connection_id).toBeTypeOf("string");
		expect(compatibility).toMatchObject({
			id: 1,
			carrier_commits_enabled: false,
		});
	});

	test("creates the exact constraints, covering indexes, and statement guards", async ({
		pgClient,
	}) => {
		const constraints = await pgClient.query<{
			conname: string;
			definition: string;
		}>(
			`SELECT conname, pg_get_constraintdef(oid) AS definition
			 FROM pg_constraint
			 WHERE conname = ANY($1::text[])`,
			[
				[
					"apps_project_id_id_key",
					"lookup_table_references_table_fk",
					"lookup_table_references_app_fk",
					"lookup_column_references_column_fk",
					"lookup_column_references_table_edge_fk",
				],
			],
		);
		const byName = new Map(
			constraints.rows.map(({ conname, definition }) => [conname, definition]),
		);
		expect(byName.get("apps_project_id_id_key")).toContain(
			"UNIQUE (project_id, id)",
		);
		expect(byName.get("lookup_table_references_table_fk")).toContain(
			"ON UPDATE RESTRICT ON DELETE RESTRICT",
		);
		expect(byName.get("lookup_table_references_app_fk")).toContain(
			"REFERENCES apps(project_id, id) ON UPDATE RESTRICT ON DELETE CASCADE",
		);
		expect(byName.get("lookup_column_references_column_fk")).toContain(
			"ON UPDATE RESTRICT ON DELETE RESTRICT",
		);
		expect(byName.get("lookup_column_references_table_edge_fk")).toContain(
			"ON UPDATE RESTRICT ON DELETE CASCADE",
		);

		const indexes = await pgClient.query<{
			indexname: string;
			indexdef: string;
		}>(
			`SELECT indexname, indexdef
			 FROM pg_indexes
			 WHERE schemaname = 'public'
			   AND indexname = ANY($1::text[])`,
			[
				[
					"lookup_table_references_app_idx",
					"lookup_column_references_app_idx",
					"lookup_stream_capability_leases_admission_idx",
					"lookup_stream_capability_leases_expiry_idx",
					"lookup_stream_capability_leases_floor_drain_idx",
				],
			],
		);
		const indexByName = new Map(
			indexes.rows.map(({ indexname, indexdef }) => [indexname, indexdef]),
		);
		expect(indexByName.get("lookup_table_references_app_idx")).toContain(
			"(app_id, project_id)",
		);
		expect(indexByName.get("lookup_column_references_app_idx")).toContain(
			"(app_id, project_id, table_id)",
		);
		expect(
			indexByName.get("lookup_stream_capability_leases_admission_idx"),
		).toContain("(app_id, receiver_version, expires_at)");
		expect(
			indexByName.get("lookup_stream_capability_leases_expiry_idx"),
		).toContain("(expires_at)");
		expect(
			indexByName.get("lookup_stream_capability_leases_floor_drain_idx"),
		).toContain("(receiver_version, expires_at)");

		const expectedTriggerNames = [
			"apps_lookup_reference_writer_guard_insert",
			"apps_lookup_reference_writer_guard_update",
			"apps_lookup_reference_writer_guard_delete",
			"blueprint_entities_lookup_reference_writer_guard",
			"accepted_mutations_lookup_reference_writer_guard",
			"lookup_tables_reference_writer_guard_delete",
			"lookup_columns_reference_writer_guard_delete",
			"lookup_columns_reference_writer_guard_retype",
		] as const;
		const triggers = await pgClient.query<{ tgname: string; level: string }>(
			`SELECT tgname,
				CASE WHEN (tgtype & 1) = 1 THEN 'row' ELSE 'statement' END AS level
			 FROM pg_trigger
			 WHERE NOT tgisinternal
			   AND tgname = ANY($1::text[])
			 ORDER BY tgname`,
			[[...expectedTriggerNames]],
		);
		expect(triggers.rows).toEqual(
			expect.arrayContaining([
				{
					tgname: "apps_lookup_reference_writer_guard_insert",
					level: "statement",
				},
				{
					tgname: "apps_lookup_reference_writer_guard_update",
					level: "statement",
				},
				{
					tgname: "apps_lookup_reference_writer_guard_delete",
					level: "statement",
				},
				{
					tgname: "blueprint_entities_lookup_reference_writer_guard",
					level: "statement",
				},
				{
					tgname: "accepted_mutations_lookup_reference_writer_guard",
					level: "statement",
				},
				{
					tgname: "lookup_tables_reference_writer_guard_delete",
					level: "statement",
				},
				{
					tgname: "lookup_columns_reference_writer_guard_delete",
					level: "statement",
				},
				{
					tgname: "lookup_columns_reference_writer_guard_retype",
					level: "statement",
				},
			]),
		);
	});

	test("enforces composite tenancy, implied table edges, restricts, and cascades", async ({
		pgClient,
	}) => {
		const projectA = `project-a-${crypto.randomUUID()}`;
		const projectB = `project-b-${crypto.randomUUID()}`;
		const appA = await insertApp(pgClient, projectA);
		const appB = await insertApp(pgClient, projectB);
		const appAWithoutTableEdge = await insertApp(pgClient, projectA);
		const tableId = await insertLookupTable(pgClient, projectA);
		const columnId = await insertLookupColumn(pgClient, projectA, tableId);

		await pgClient.query(
			`INSERT INTO lookup_table_references (project_id, table_id, app_id)
			 VALUES ($1, $2, $3)`,
			[projectA, tableId, appA],
		);
		await pgClient.query(
			`INSERT INTO lookup_column_references
				(project_id, table_id, column_id, app_id)
			 VALUES ($1, $2, $3, $4)`,
			[projectA, tableId, columnId, appA],
		);

		await expectSqlState(
			pgClient,
			"23503",
			`INSERT INTO lookup_column_references
				(project_id, table_id, column_id, app_id)
			 VALUES ($1, $2, $3, $4)`,
			[projectA, tableId, columnId, appAWithoutTableEdge],
		);
		await expectSqlState(
			pgClient,
			"23503",
			`INSERT INTO lookup_table_references (project_id, table_id, app_id)
			 VALUES ($1, $2, $3)`,
			[projectA, tableId, appB],
		);
		await expectSqlState(
			pgClient,
			"23503",
			`INSERT INTO lookup_table_references (project_id, table_id, app_id)
			 VALUES ($1, $2, $3)`,
			[projectB, tableId, appB],
		);

		await expectSqlState(
			pgClient,
			"23001",
			"DELETE FROM lookup_columns WHERE project_id = $1 AND table_id = $2 AND id = $3",
			[projectA, tableId, columnId],
		);
		await expectSqlState(
			pgClient,
			"23001",
			"DELETE FROM lookup_tables WHERE project_id = $1 AND id = $2",
			[projectA, tableId],
		);
		await expectSqlState(
			pgClient,
			"23001",
			"UPDATE apps SET project_id = $1 WHERE id = $2",
			[projectB, appA],
		);
		await expectSqlState(
			pgClient,
			"23503",
			"UPDATE lookup_tables SET id = uuidv7() WHERE project_id = $1 AND id = $2",
			[projectA, tableId],
		);
		await expectSqlState(
			pgClient,
			"23001",
			`UPDATE lookup_columns SET id = uuidv7()
			 WHERE project_id = $1 AND table_id = $2 AND id = $3`,
			[projectA, tableId, columnId],
		);

		await pgClient.query(
			`DELETE FROM lookup_table_references
			 WHERE project_id = $1 AND table_id = $2 AND app_id = $3`,
			[projectA, tableId, appA],
		);
		const childAfterEdgeDelete = await pgClient.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM lookup_column_references WHERE app_id = $1",
			[appA],
		);
		expect(childAfterEdgeDelete.rows[0]?.count).toBe("0");

		await pgClient.query(
			`INSERT INTO lookup_table_references (project_id, table_id, app_id)
			 VALUES ($1, $2, $3)`,
			[projectA, tableId, appA],
		);
		await pgClient.query(
			`INSERT INTO lookup_column_references
				(project_id, table_id, column_id, app_id)
			 VALUES ($1, $2, $3, $4)`,
			[projectA, tableId, columnId, appA],
		);
		await pgClient.query(
			`INSERT INTO lookup_stream_capability_leases
				(app_id, receiver_version, expires_at)
			 VALUES ($1, 1, now() + interval '2 hours')`,
			[appA],
		);
		await pgClient.query("DELETE FROM apps WHERE id = $1", [appA]);
		const afterAppDelete = await pgClient.query<{
			table_edges: string;
			column_edges: string;
			leases: string;
		}>(
			`SELECT
				(SELECT count(*)::text FROM lookup_table_references WHERE app_id = $1)
					AS table_edges,
				(SELECT count(*)::text FROM lookup_column_references WHERE app_id = $1)
					AS column_edges,
				(SELECT count(*)::text FROM lookup_stream_capability_leases WHERE app_id = $1)
					AS leases`,
			[appA],
		);
		expect(afterAppDelete.rows[0]).toEqual({
			table_edges: "0",
			column_edges: "0",
			leases: "0",
		});
	});

	test("mints lease identity server-side and enforces receiver, expiry, and app bounds", async ({
		pgClient,
	}) => {
		const appId = await insertApp(
			pgClient,
			`lease-project-${crypto.randomUUID()}`,
		);
		const lease = await pgClient.query<{
			connection_id: string;
			receiver_version: number;
			expires_at: Date;
			created_at: Date;
		}>(
			`INSERT INTO lookup_stream_capability_leases
				(app_id, receiver_version, expires_at)
			 VALUES ($1, 0, now() + interval '1 hour')
			 RETURNING connection_id, receiver_version, expires_at, created_at`,
			[appId],
		);
		expect(lease.rows[0]?.connection_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(lease.rows[0]?.receiver_version).toBe(0);
		expect(lease.rows[0]?.expires_at.getTime()).toBeGreaterThan(
			lease.rows[0]?.created_at.getTime() ?? Number.POSITIVE_INFINITY,
		);

		await expectSqlState(
			pgClient,
			"23514",
			`INSERT INTO lookup_stream_capability_leases
				(app_id, receiver_version, expires_at)
			 VALUES ($1, -1, now() + interval '1 hour')`,
			[appId],
		);
		await expectSqlState(
			pgClient,
			"23514",
			`INSERT INTO lookup_stream_capability_leases
				(app_id, receiver_version, expires_at)
			 VALUES ($1, 1, now())`,
			[appId],
		);
		await expectSqlState(
			pgClient,
			"23503",
			`INSERT INTO lookup_stream_capability_leases
				(app_id, receiver_version, expires_at)
			 VALUES ('missing-app', 1, now() + interval '1 hour')`,
		);
	});

	test("keeps one permanent monotonic compatibility row and constrains activation", async ({
		pgClient,
	}) => {
		const initial = await pgClient.query<
			Selectable<LookupReferenceCompatibilityTable>
		>("SELECT * FROM lookup_reference_compatibility");
		expect(initial.rows).toHaveLength(1);
		expect(initial.rows[0]).toMatchObject({
			id: 1,
			minimum_writer_version: 0,
			minimum_stream_receiver_version: 0,
			minimum_runtime_reader_version: 0,
			carrier_commits_enabled: false,
			destructive_schema_actions_enabled: false,
			project_moves_enabled: false,
		});

		await expectSqlState(
			pgClient,
			"23514",
			"INSERT INTO lookup_reference_compatibility (id) VALUES (2)",
		);
		for (const column of [
			"minimum_writer_version",
			"minimum_stream_receiver_version",
			"minimum_runtime_reader_version",
		]) {
			await expectSqlState(
				pgClient,
				"23514",
				`UPDATE lookup_reference_compatibility SET ${column} = -1 WHERE id = 1`,
			);
		}

		for (const flag of [
			"carrier_commits_enabled",
			"destructive_schema_actions_enabled",
			"project_moves_enabled",
		]) {
			await expectSqlState(
				pgClient,
				"23514",
				`UPDATE lookup_reference_compatibility SET ${flag} = true WHERE id = 1`,
			);
		}

		await pgClient.query(
			`UPDATE lookup_reference_compatibility
			 SET minimum_writer_version = 1,
				 minimum_stream_receiver_version = 1,
				 destructive_schema_actions_enabled = true,
				 project_moves_enabled = true
			 WHERE id = 1`,
		);
		await expectSqlState(
			pgClient,
			"23514",
			`UPDATE lookup_reference_compatibility
			 SET carrier_commits_enabled = true WHERE id = 1`,
		);
		await pgClient.query(
			`UPDATE lookup_reference_compatibility
			 SET minimum_stream_receiver_version = 3,
				 minimum_runtime_reader_version = 1,
				 carrier_commits_enabled = true
			 WHERE id = 1`,
		);
		await pgClient.query(
			`UPDATE lookup_reference_compatibility
			 SET carrier_commits_enabled = false,
				 destructive_schema_actions_enabled = false,
				 project_moves_enabled = false
			 WHERE id = 1`,
		);
		const raised = await pgClient.query<
			Selectable<LookupReferenceCompatibilityTable>
		>("SELECT * FROM lookup_reference_compatibility WHERE id = 1");
		expect(raised.rows[0]).toMatchObject({
			minimum_writer_version: 1,
			minimum_stream_receiver_version: 3,
			minimum_runtime_reader_version: 1,
			carrier_commits_enabled: false,
			destructive_schema_actions_enabled: false,
			project_moves_enabled: false,
		});

		for (const [column, value] of [
			["minimum_writer_version", 0],
			["minimum_stream_receiver_version", 2],
			["minimum_runtime_reader_version", 0],
		] as const) {
			await expectSqlState(
				pgClient,
				"23514",
				`UPDATE lookup_reference_compatibility SET ${column} = $1 WHERE id = 1`,
				[value],
			);
		}

		await expectSqlState(
			pgClient,
			"55000",
			"DELETE FROM lookup_reference_compatibility WHERE id = 1",
		);
		await expectSqlState(
			pgClient,
			"55000",
			"TRUNCATE lookup_reference_compatibility",
		);
	});

	test("defaults unset writers to version zero and guards every target at a raised floor", async ({
		pgClient,
		db,
	}) => {
		const legacyProject = `legacy-project-${crypto.randomUUID()}`;
		const legacyApp = await insertApp(pgClient, legacyProject);
		await pgClient.query(
			"UPDATE apps SET mutation_seq = 1, project_id = $1 WHERE id = $2",
			[`${legacyProject}-moved`, legacyApp],
		);
		const legacyEntity = await insertEntity(pgClient, legacyApp);
		await pgClient.query(
			"UPDATE blueprint_entities SET data = '{\"updated\":true}'::jsonb WHERE app_id = $1 AND uuid = $2",
			[legacyApp, legacyEntity],
		);
		await pgClient.query(
			"DELETE FROM blueprint_entities WHERE app_id = $1 AND uuid = $2",
			[legacyApp, legacyEntity],
		);
		await insertAcceptedMutation(pgClient, legacyApp);

		const legacyDeleteApp = await insertApp(pgClient, legacyProject);
		await pgClient.query("DELETE FROM apps WHERE id = $1", [legacyDeleteApp]);
		const legacyTable = await insertLookupTable(pgClient, legacyProject);
		const legacyColumn = await insertLookupColumn(
			pgClient,
			legacyProject,
			legacyTable,
		);
		await pgClient.query(
			`UPDATE lookup_columns SET data_type = 'int'
			 WHERE project_id = $1 AND table_id = $2 AND id = $3`,
			[legacyProject, legacyTable, legacyColumn],
		);
		await pgClient.query(
			"DELETE FROM lookup_columns WHERE project_id = $1 AND table_id = $2 AND id = $3",
			[legacyProject, legacyTable, legacyColumn],
		);
		await pgClient.query(
			"DELETE FROM lookup_tables WHERE project_id = $1 AND id = $2",
			[legacyProject, legacyTable],
		);

		const guardedProject = `guarded-project-${crypto.randomUUID()}`;
		const updateApp = await insertApp(pgClient, guardedProject);
		const deleteApp = await insertApp(pgClient, guardedProject);
		const entityApp = await insertApp(pgClient, guardedProject);
		const existingEntity = await insertEntity(pgClient, entityApp);
		const mutationApp = await insertApp(pgClient, guardedProject);
		const deleteTable = await insertLookupTable(pgClient, guardedProject);
		await insertLookupColumn(pgClient, guardedProject, deleteTable);
		const columnTable = await insertLookupTable(pgClient, guardedProject);
		const deleteColumn = await insertLookupColumn(
			pgClient,
			guardedProject,
			columnTable,
		);
		const retypeTable = await insertLookupTable(pgClient, guardedProject);
		const retypeColumn = await insertLookupColumn(
			pgClient,
			guardedProject,
			retypeTable,
		);

		await pgClient.query(
			`UPDATE lookup_reference_compatibility
			 SET minimum_writer_version = 1 WHERE id = 1`,
		);

		// The cutoff is deliberately narrow: ordinary projections that cannot
		// change reference identity remain writable by an unset/version-0 server.
		await pgClient.query(
			`UPDATE apps
			 SET app_name = 'Allowed projection',
				 app_name_lower = 'allowed projection',
				 status = 'complete'
			 WHERE id = $1`,
			[updateApp],
		);
		await pgClient.query(
			`UPDATE lookup_tables SET name = 'Allowed table projection'
			 WHERE project_id = $1 AND id = $2`,
			[guardedProject, retypeTable],
		);
		await pgClient.query(
			`UPDATE lookup_columns SET label = 'Allowed column projection'
			 WHERE project_id = $1 AND table_id = $2 AND id = $3`,
			[guardedProject, retypeTable, retypeColumn],
		);
		const allowedProjection = await pgClient.query<{
			app_name: string;
			status: string;
			table_name: string;
			column_label: string;
		}>(
			`SELECT app.app_name, app.status,
				lookup_table.name AS table_name,
				lookup_column.label AS column_label
			 FROM apps AS app
			 CROSS JOIN lookup_tables AS lookup_table
			 JOIN lookup_columns AS lookup_column
				ON lookup_column.project_id = lookup_table.project_id
				AND lookup_column.table_id = lookup_table.id
			 WHERE app.id = $1
				AND lookup_table.project_id = $2
				AND lookup_table.id = $3
				AND lookup_column.id = $4`,
			[updateApp, guardedProject, retypeTable, retypeColumn],
		);
		expect(allowedProjection.rows[0]).toEqual({
			app_name: "Allowed projection",
			status: "complete",
			table_name: "Allowed table projection",
			column_label: "Allowed column projection",
		});

		const blocked: ReadonlyArray<readonly [string, unknown[]]> = [
			[
				`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
				 VALUES ('blocked-insert', $1, $2, 'Blocked', 'blocked')`,
				[ACTOR, guardedProject],
			],
			[
				"UPDATE apps SET mutation_seq = mutation_seq + 1 WHERE id = $1",
				[updateApp],
			],
			[
				"UPDATE apps SET project_id = $1 WHERE id = $2",
				[`${guardedProject}-moved`, updateApp],
			],
			["DELETE FROM apps WHERE id = $1", [deleteApp]],
			[
				`INSERT INTO blueprint_entities
					(app_id, uuid, kind, parent_uuid, ordinal, data)
				 VALUES ($1, 'blocked-entity', 'module', NULL, 0, '{}'::jsonb)`,
				[entityApp],
			],
			[
				"UPDATE blueprint_entities SET ordinal = 1 WHERE app_id = $1 AND uuid = $2",
				[entityApp, existingEntity],
			],
			[
				"DELETE FROM blueprint_entities WHERE app_id = $1 AND uuid = $2",
				[entityApp, existingEntity],
			],
			["TRUNCATE blueprint_entities", []],
			[
				`INSERT INTO accepted_mutations
					(app_id, seq, batch_id, actor_id, kind, mutations)
				 VALUES ($1, 1, $2, $3, 'human', '[]'::jsonb)`,
				[mutationApp, crypto.randomUUID(), ACTOR],
			],
			[
				"DELETE FROM lookup_tables WHERE project_id = $1 AND id = $2",
				[guardedProject, deleteTable],
			],
			["TRUNCATE lookup_tables CASCADE", []],
			[
				"DELETE FROM lookup_columns WHERE project_id = $1 AND table_id = $2 AND id = $3",
				[guardedProject, columnTable, deleteColumn],
			],
			["TRUNCATE lookup_columns CASCADE", []],
			[
				`UPDATE lookup_columns SET data_type = 'int'
				 WHERE project_id = $1 AND table_id = $2 AND id = $3`,
				[guardedProject, retypeTable, retypeColumn],
			],
		];
		for (const [statement, parameters] of blocked) {
			await expectSqlState(pgClient, "55000", statement, parameters);
		}

		await setTransactionWriterVersion(
			db as unknown as Transaction<AppDatabase>,
			1,
		);
		const capableApp = await insertApp(pgClient, guardedProject);
		await pgClient.query(
			"UPDATE apps SET mutation_seq = mutation_seq + 1, project_id = $1 WHERE id = $2",
			[`${guardedProject}-capable`, updateApp],
		);
		const capableEntity = await insertEntity(pgClient, entityApp);
		await pgClient.query(
			"UPDATE blueprint_entities SET ordinal = 2 WHERE app_id = $1 AND uuid = $2",
			[entityApp, capableEntity],
		);
		await pgClient.query(
			"DELETE FROM blueprint_entities WHERE app_id = $1 AND uuid = $2",
			[entityApp, capableEntity],
		);
		await insertAcceptedMutation(pgClient, mutationApp);
		await pgClient.query(
			`UPDATE lookup_columns SET data_type = 'int'
			 WHERE project_id = $1 AND table_id = $2 AND id = $3`,
			[guardedProject, retypeTable, retypeColumn],
		);
		await pgClient.query(
			"DELETE FROM lookup_columns WHERE project_id = $1 AND table_id = $2 AND id = $3",
			[guardedProject, columnTable, deleteColumn],
		);
		await pgClient.query(
			"DELETE FROM lookup_tables WHERE project_id = $1 AND id = $2",
			[guardedProject, deleteTable],
		);
		await pgClient.query("DELETE FROM apps WHERE id = $1", [capableApp]);
	});

	test("rejects malformed versions, resets SET LOCAL at a savepoint, and fails if state is missing", async ({
		pgClient,
		db,
	}) => {
		await pgClient.query(
			`UPDATE lookup_reference_compatibility
			 SET minimum_writer_version = 1 WHERE id = 1`,
		);

		for (const malformed of ["-1", "01", "1.0", " 1", "bogus", "2147483648"]) {
			await pgClient.query("SAVEPOINT malformed_writer_version");
			await pgClient.query(
				"SELECT set_config('nova.writer_version', $1, true)",
				[malformed],
			);
			await expectSqlState(
				pgClient,
				"22023",
				`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
				 VALUES ($1, $2, 'malformed-project', 'Malformed', 'malformed')`,
				[`malformed-${crypto.randomUUID()}`, ACTOR],
			);
			await pgClient.query("ROLLBACK TO SAVEPOINT malformed_writer_version");
			await pgClient.query("RELEASE SAVEPOINT malformed_writer_version");
		}

		for (const invalid of [-1, 1.5, Number.NaN, 2_147_483_648]) {
			await expect(
				setTransactionWriterVersion(
					db as unknown as Transaction<AppDatabase>,
					invalid,
				),
			).rejects.toThrow(RangeError);
		}

		await pgClient.query("SAVEPOINT local_writer_version");
		await setTransactionWriterVersion(
			db as unknown as Transaction<AppDatabase>,
			1,
		);
		await insertApp(pgClient, "local-project", "local-setting-pass");
		await pgClient.query("ROLLBACK TO SAVEPOINT local_writer_version");
		await pgClient.query("RELEASE SAVEPOINT local_writer_version");
		await expectSqlState(
			pgClient,
			"55000",
			`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
			 VALUES ('local-setting-reset', $1, 'local-project', 'Reset', 'reset')`,
			[ACTOR],
		);

		await pgClient.query("SET LOCAL session_replication_role = replica");
		await pgClient.query(
			"DELETE FROM lookup_reference_compatibility WHERE id = 1",
		);
		await pgClient.query("SET LOCAL session_replication_role = origin");
		await expectSqlState(
			pgClient,
			"55000",
			`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
			 VALUES ('missing-compatibility', $1, 'missing-project', 'Missing', 'missing')`,
			[ACTOR],
		);
	});
});
