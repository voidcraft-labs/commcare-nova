/**
 * The project-data migration, over the production chain before it, with the
 * lookup tables, places and organization state rows the previous revision
 * writes. The plausible failures: a migration that fails over existing rows
 * or on a replay; a CHECK the revision still serving can break with an insert
 * or update that names none of the new columns; a CHECK that admits half an
 * origin or a takeover nobody made; a `down` that leaves a column behind; a
 * lock request that waits with no bound behind a reader of the serving
 * revision; and a lock timeout left set for the next migration of the batch.
 */

import { type Kysely, type RawBuilder, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { down, up } from "../20261202000000_hq_bring_in_project_data";

const MIGRATION = "20261202000000_hq_bring_in_project_data";

/* Every migration before this one: the three tables as the previous revision
 * writes them. */
const database = setupPerTestDatabase({
	databaseNamePrefix: "hq_bring_in_project_data_migration_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < MIGRATION,
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

const TABLES = ["lookup_tables", "app_organization_state", "app_locations"];

const PROJECT = "project-a";
const APP = "app-a";
const LEVEL = "01992000-0000-7000-8000-00000000c001";
const DIGEST = "a".repeat(64);

/** Column to the SQL value an update sets it to. */
type Assignments = Readonly<Record<string, RawBuilder<unknown>>>;

function assignments(columns: Assignments) {
	return sql.join(
		Object.entries(columns).map(
			([column, value]) => sql`${sql.id(column)} = ${value}`,
		),
	);
}

/** The SQLSTATE and constraint a statement fails with, or `undefined` when it succeeds. */
async function refusal(
	run: () => Promise<unknown>,
): Promise<{ code: string; constraint?: string } | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		const { code, constraint } = error as {
			code?: unknown;
			constraint?: unknown;
		};
		if (typeof code !== "string") throw error;
		return typeof constraint === "string" ? { code, constraint } : { code };
	}
}

async function runUp(db: Kysely<unknown>) {
	await db.transaction().execute((tx) => up(tx));
}

async function seedApp(db: Kysely<unknown>) {
	await sql`INSERT INTO public.apps (id, owner, project_id, app_name, app_name_lower,
		module_count, form_count, mutation_seq, status, awaiting_input)
		VALUES (${APP}, 'owner', ${PROJECT}, ${APP}, ${APP}, 0, 0, 0, 'complete', false)`.execute(
		db,
	);
}

/* The previous revision's statements on the three tables, each naming only the
 * columns it knows. */

async function insertTable(db: Kysely<unknown>, tag: string): Promise<string> {
	const inserted = await sql<{ id: string }>`
		INSERT INTO public.lookup_tables
			(project_id, name, tag, definition_revision, rows_revision,
			 column_count, created_by, updated_by)
		VALUES (${PROJECT}, 'Facilities', ${tag}, 1, 1, 1, 'owner', 'owner')
		RETURNING id`.execute(db);
	const id = inserted.rows[0]?.id;
	if (id === undefined) throw new Error("The table insert returned no id.");
	return id;
}

async function updateTable(db: Kysely<unknown>, id: string) {
	await sql`
		UPDATE public.lookup_tables
			SET name = 'Clinics', definition_revision = definition_revision + 1,
				rows_revision = rows_revision + 1, row_count = 2, data_bytes = 40,
				updated_by = 'editor', updated_at = now()
			WHERE project_id = ${PROJECT} AND id = ${id}::uuid`.execute(db);
}

async function insertState(db: Kysely<unknown>) {
	await sql`
		INSERT INTO public.app_organization_state (app_id) VALUES (${APP})
			ON CONFLICT (app_id) DO NOTHING`.execute(db);
}

async function updateState(db: Kysely<unknown>) {
	await sql`
		UPDATE public.app_organization_state
			SET revision = revision + 1, location_count = location_count + 1, updated_at = now()
			WHERE app_id = ${APP}`.execute(db);
}

async function insertPlace(
	db: Kysely<unknown>,
	siteCode: string,
	orderKey: string,
	parent: string | null = null,
): Promise<string> {
	const inserted = await sql<{ id: string }>`
		INSERT INTO public.app_locations
			(app_id, level_uuid, parent_id, site_code, name, "values", order_key,
			 created_by, updated_by)
		VALUES (${APP}, ${LEVEL}::uuid, ${parent}::uuid, ${siteCode}, ${siteCode},
			'{"region": "north"}'::jsonb, ${orderKey}, 'owner', 'owner')
		RETURNING id`.execute(db);
	const id = inserted.rows[0]?.id;
	if (id === undefined) throw new Error("The place insert returned no id.");
	return id;
}

async function updatePlace(db: Kysely<unknown>, id: string) {
	await sql`
		UPDATE public.app_locations
			SET name = 'Renamed', archived_at = now(), updated_by = 'editor', updated_at = now()
			WHERE app_id = ${APP} AND id = ${id}::uuid`.execute(db);
}

/** What the new code writes: a whole origin on each of the three tables. */
async function setOrigins(
	db: Kysely<unknown>,
	tableId: string,
	placeId: string,
) {
	await sql`
		UPDATE public.lookup_tables
			SET hq_server = 'production', hq_domain = 'clinic', hq_remote_id = 'hq-table-1',
				hq_canonical = ${JSON.stringify({ digest: DIGEST, fields: [] })}::jsonb,
				hq_brought_in_at = now(), hq_brought_in_by = 'owner',
				hq_refreshed_at = now(), hq_refreshed_by = 'owner',
				hq_taken_over_at = now(), hq_taken_over_by = 'owner'
			WHERE project_id = ${PROJECT} AND id = ${tableId}::uuid`.execute(db);
	await sql`
		UPDATE public.app_organization_state
			SET hq_server = 'eu', hq_domain = 'clinic', hq_places_digest = ${DIGEST},
				hq_left_out = '{"ward": 2}'::jsonb,
				hq_brought_in_at = now(), hq_brought_in_by = 'owner',
				hq_refreshed_at = now(), hq_refreshed_by = 'owner'
			WHERE app_id = ${APP}`.execute(db);
	await sql`
		UPDATE public.app_locations SET hq_location_id = 'hq-place-1'
			WHERE app_id = ${APP} AND id = ${placeId}::uuid`.execute(db);
}

/** Every catalog row of the three tables this migration could touch, by name. */
async function catalog(db: Kysely<unknown>) {
	const rows = await sql<{ name: string; definition: string }>`
		SELECT 'column ' || c.relname || '.' || a.attname AS name,
			format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
				|| ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS definition
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}::text[])
			AND a.attnum > 0 AND NOT a.attisdropped
		UNION ALL
		SELECT 'constraint ' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
			|| ' validated=' || k.convalidated
		FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
		WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}::text[])
		UNION ALL
		SELECT 'index ' || indexname, indexdef FROM pg_indexes
		WHERE schemaname = 'public' AND tablename = ANY(${TABLES}::text[])
		ORDER BY 1
	`.execute(db);
	return rows.rows;
}

/** Every data row of the three tables, in a stable order. */
async function data(db: Kysely<unknown>) {
	const rows = await sql<{ name: string; rows: unknown }>`
		SELECT 'lookup_tables' AS name,
			(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
				FROM public.lookup_tables t) AS rows
		UNION ALL
		SELECT 'app_organization_state',
			(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.app_id), '[]'::jsonb)
				FROM public.app_organization_state t)
		UNION ALL
		SELECT 'app_locations',
			(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
				FROM public.app_locations t)
	`.execute(db);
	return rows.rows;
}

/** The `hq_*` columns the three tables hold now. */
async function originColumns(db: Kysely<unknown>) {
	const rows = await sql<{ name: string }>`
		SELECT c.relname || '.' || a.attname AS name
		FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
		WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}::text[])
			AND a.attnum > 0 AND NOT a.attisdropped AND a.attname LIKE 'hq\\_%'
		ORDER BY 1
	`.execute(db);
	return rows.rows.map((row) => row.name);
}

/** The previous revision's rows: two tables, a state row and a parent and child place. */
async function seedPlainRows(db: Kysely<unknown>) {
	await seedApp(db);
	const tableId = await insertTable(db, "facilities");
	await insertTable(db, "health-facility-v2");
	await insertState(db);
	await updateState(db);
	const parent = await insertPlace(db, "north", "a1");
	const child = await insertPlace(db, "north-ward", "a2", parent);
	return { tableId, parent, child };
}

const NINETEEN_COLUMNS = [
	"app_locations.hq_location_id",
	"app_organization_state.hq_brought_in_at",
	"app_organization_state.hq_brought_in_by",
	"app_organization_state.hq_domain",
	"app_organization_state.hq_left_out",
	"app_organization_state.hq_places_digest",
	"app_organization_state.hq_refreshed_at",
	"app_organization_state.hq_refreshed_by",
	"app_organization_state.hq_server",
	"lookup_tables.hq_brought_in_at",
	"lookup_tables.hq_brought_in_by",
	"lookup_tables.hq_canonical",
	"lookup_tables.hq_domain",
	"lookup_tables.hq_refreshed_at",
	"lookup_tables.hq_refreshed_by",
	"lookup_tables.hq_remote_id",
	"lookup_tables.hq_server",
	"lookup_tables.hq_taken_over_at",
	"lookup_tables.hq_taken_over_by",
];

describe(MIGRATION, () => {
	it("leaves every plain table, state row and place valid, with each new column null", async () => {
		const db = database.db;
		await seedPlainRows(db);
		expect(await originColumns(db)).toEqual([]);

		await runUp(db);

		expect(await originColumns(db)).toEqual(NINETEEN_COLUMNS);
		const constraints = await sql<{ name: string; validated: boolean }>`
			SELECT conname AS name, convalidated AS validated FROM pg_constraint
			WHERE conname IN ('lookup_tables_hq_origin_whole',
				'lookup_tables_hq_takeover_attributed', 'app_organization_state_hq_origin_whole',
				'app_locations_hq_location_id_check')
			ORDER BY conname`.execute(db);
		expect(constraints.rows).toEqual([
			{ name: "app_locations_hq_location_id_check", validated: true },
			{ name: "app_organization_state_hq_origin_whole", validated: true },
			{ name: "lookup_tables_hq_origin_whole", validated: true },
			{ name: "lookup_tables_hq_takeover_attributed", validated: true },
		]);
		const held = await sql<{ origins: number; rows: number }>`
			SELECT count(*)::int AS rows,
				count(*) FILTER (WHERE hq_server IS NOT NULL OR hq_canonical IS NOT NULL
					OR hq_taken_over_at IS NOT NULL OR hq_taken_over_by IS NOT NULL)::int AS origins
			FROM public.lookup_tables`.execute(db);
		expect(held.rows).toEqual([{ rows: 2, origins: 0 }]);
		const places = await sql<{ rows: number; ids: number }>`
			SELECT count(*)::int AS rows, count(hq_location_id)::int AS ids
			FROM public.app_locations`.execute(db);
		expect(places.rows).toEqual([{ rows: 2, ids: 0 }]);
		const index = await sql<{ definition: string }>`
			SELECT indexdef AS definition FROM pg_indexes
			WHERE schemaname = 'public' AND indexname = 'lookup_tables_hq_origin'`.execute(
			db,
		);
		expect(index.rows).toEqual([
			{
				definition:
					"CREATE INDEX lookup_tables_hq_origin ON public.lookup_tables USING btree (project_id, hq_server, hq_domain) WHERE (hq_server IS NOT NULL)",
			},
		]);
	});

	it("passes the previous revision's inserts and updates on a plain row, and its updates on a row with an origin", async () => {
		const db = database.db;
		const { tableId, child } = await seedPlainRows(db);
		await runUp(db);

		// On plain rows, as the previous revision writes them after the deploy.
		const fresh = await insertTable(db, "wards");
		expect(await refusal(() => updateTable(db, fresh))).toBeUndefined();
		const freshPlace = await insertPlace(db, "south", "a3");
		expect(await refusal(() => updatePlace(db, freshPlace))).toBeUndefined();
		expect(await refusal(() => updateState(db))).toBeUndefined();

		// On rows the new code gave an origin.
		await setOrigins(db, tableId, child);
		const before = await sql<{ origin: unknown }>`
			SELECT jsonb_build_object('table', (SELECT to_jsonb(t) - 'name' - 'definition_revision'
					- 'rows_revision' - 'row_count' - 'data_bytes' - 'updated_by' - 'updated_at'
					FROM public.lookup_tables t WHERE t.id = ${tableId}::uuid),
				'state', (SELECT to_jsonb(s) - 'revision' - 'location_count' - 'updated_at'
					FROM public.app_organization_state s),
				'place', (SELECT l.hq_location_id FROM public.app_locations l
					WHERE l.id = ${child}::uuid)) AS origin`.execute(db);
		expect(await refusal(() => updateTable(db, tableId))).toBeUndefined();
		expect(await refusal(() => updateState(db))).toBeUndefined();
		expect(await refusal(() => updatePlace(db, child))).toBeUndefined();
		const after = await sql<{ origin: unknown }>`
			SELECT jsonb_build_object('table', (SELECT to_jsonb(t) - 'name' - 'definition_revision'
					- 'rows_revision' - 'row_count' - 'data_bytes' - 'updated_by' - 'updated_at'
					FROM public.lookup_tables t WHERE t.id = ${tableId}::uuid),
				'state', (SELECT to_jsonb(s) - 'revision' - 'location_count' - 'updated_at'
					FROM public.app_organization_state s),
				'place', (SELECT l.hq_location_id FROM public.app_locations l
					WHERE l.id = ${child}::uuid)) AS origin`.execute(db);
		expect(after.rows).toEqual(before.rows);
		expect(after.rows[0]?.origin).toMatchObject({
			table: { hq_server: "production", hq_taken_over_by: "owner" },
			state: { hq_server: "eu", hq_left_out: { ward: 2 } },
			place: "hq-place-1",
		});
	});

	it("refuses half an origin, a column the origin leaves null, a server the ledger does not name, a takeover nobody made or with no origin, and a blank place id", async () => {
		const db = database.db;
		const { tableId, child } = await seedPlainRows(db);
		await runUp(db);

		const tableRefusal = (columns: Assignments) =>
			refusal(() =>
				db.transaction().execute(async (tx) => {
					await sql`UPDATE public.lookup_tables SET ${assignments(columns)}
						WHERE project_id = ${PROJECT} AND id = ${tableId}::uuid`.execute(
						tx,
					);
				}),
			);
		const whole: Assignments = {
			hq_server: sql`'production'`,
			hq_domain: sql`'clinic'`,
			hq_remote_id: sql`'hq-table-1'`,
			hq_canonical: sql`${JSON.stringify({ digest: DIGEST })}::jsonb`,
			hq_brought_in_at: sql`now()`,
			hq_brought_in_by: sql`'owner'`,
			hq_refreshed_at: sql`now()`,
			hq_refreshed_by: sql`'owner'`,
		};
		const originWhole = {
			code: "23514",
			constraint: "lookup_tables_hq_origin_whole",
		};
		const takeover = {
			code: "23514",
			constraint: "lookup_tables_hq_takeover_attributed",
		};

		expect(await tableRefusal({ hq_server: sql`'production'` })).toEqual(
			originWhole,
		);
		for (const column of Object.keys(whole)) {
			expect(await tableRefusal({ ...whole, [column]: sql`NULL` })).toEqual(
				originWhole,
			);
		}
		const tableChanges: Assignments[] = [
			{ hq_server: sql`'staging'` },
			{ hq_domain: sql`' '` },
			{ hq_domain: sql`${"d".repeat(256)}` },
			{ hq_remote_id: sql`''` },
			{ hq_canonical: sql`'["x"]'::jsonb` },
			{ hq_canonical: sql`'{"fields": []}'::jsonb` },
			{ hq_canonical: sql`'{"digest": "ABC"}'::jsonb` },
			{ hq_brought_in_by: sql`' '` },
			{ hq_refreshed_by: sql`''` },
		];
		for (const changed of tableChanges) {
			expect(await tableRefusal({ ...whole, ...changed })).toEqual(originWhole);
		}
		expect(
			await tableRefusal({
				hq_taken_over_at: sql`now()`,
				hq_taken_over_by: sql`'owner'`,
			}),
		).toEqual(takeover);
		expect(
			await tableRefusal({ ...whole, hq_taken_over_at: sql`now()` }),
		).toEqual(takeover);
		expect(
			await tableRefusal({ ...whole, hq_taken_over_by: sql`'owner'` }),
		).toEqual(takeover);
		expect(
			await tableRefusal({
				...whole,
				hq_taken_over_at: sql`now()`,
				hq_taken_over_by: sql`'owner'`,
			}),
		).toBeUndefined();

		const stateRefusal = (columns: Assignments) =>
			refusal(() =>
				db.transaction().execute(async (tx) => {
					await sql`UPDATE public.app_organization_state SET ${assignments(columns)}
						WHERE app_id = ${APP}`.execute(tx);
				}),
			);
		const stateWhole: Assignments = {
			hq_server: sql`'india'`,
			hq_domain: sql`'clinic'`,
			hq_places_digest: sql`${DIGEST}`,
			hq_left_out: sql`'{}'::jsonb`,
			hq_brought_in_at: sql`now()`,
			hq_brought_in_by: sql`'owner'`,
			hq_refreshed_at: sql`now()`,
			hq_refreshed_by: sql`'owner'`,
		};
		const stateOrigin = {
			code: "23514",
			constraint: "app_organization_state_hq_origin_whole",
		};
		expect(await stateRefusal({ hq_domain: sql`'clinic'` })).toEqual(
			stateOrigin,
		);
		for (const column of Object.keys(stateWhole)) {
			expect(
				await stateRefusal({ ...stateWhole, [column]: sql`NULL` }),
			).toEqual(stateOrigin);
		}
		const stateChanges: Assignments[] = [
			{ hq_server: sql`'staging'` },
			{ hq_domain: sql`''` },
			{ hq_places_digest: sql`'abc'` },
			{ hq_left_out: sql`'[]'::jsonb` },
			{ hq_refreshed_by: sql`' '` },
		];
		for (const changed of stateChanges) {
			expect(await stateRefusal({ ...stateWhole, ...changed })).toEqual(
				stateOrigin,
			);
		}
		expect(await stateRefusal(stateWhole)).toBeUndefined();

		const placeRefusal = (id: string) =>
			refusal(() =>
				db.transaction().execute(async (tx) => {
					await sql`UPDATE public.app_locations SET hq_location_id = ${id}
						WHERE app_id = ${APP} AND id = ${child}::uuid`.execute(tx);
				}),
			);
		expect(await placeRefusal(" ")).toEqual({
			code: "23514",
			constraint: "app_locations_hq_location_id_check",
		});
		expect(await placeRefusal("hq-place-1")).toBeUndefined();
	});

	it("runs again over its own result with its ledger row erased, and changes no catalog row and no data row", async () => {
		const db = database.db;
		const { tableId, child } = await seedPlainRows(db);
		const migrator = new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name <= MIGRATION,
						),
					),
			},
		});
		const first = await migrator.migrateToLatest();
		expect(first.error).toBeUndefined();
		expect(first.results?.map((one) => one.migrationName)).toEqual([MIGRATION]);
		await setOrigins(db, tableId, child);
		const after = { catalog: await catalog(db), data: await data(db) };

		await sql`DELETE FROM kysely_migration WHERE name = ${MIGRATION}`.execute(
			db,
		);
		const replay = await migrator.migrateToLatest();
		expect(replay.error).toBeUndefined();
		expect(replay.results).toEqual([
			{ migrationName: MIGRATION, direction: "Up", status: "Success" },
		]);

		expect({ catalog: await catalog(db), data: await data(db) }).toEqual(after);
	});

	it("takes back every column, constraint and the index on down", async () => {
		const db = database.db;
		await seedPlainRows(db);
		const before = { catalog: await catalog(db), data: await data(db) };
		await runUp(db);
		expect(await originColumns(db)).toEqual(NINETEEN_COLUMNS);

		await db.transaction().execute((tx) => down(tx));

		expect(await originColumns(db)).toEqual([]);
		expect({ catalog: await catalog(db), data: await data(db) }).toEqual(
			before,
		);
	});

	it("gives up after five seconds behind a reader, adds nothing, and resets the timeout once it runs", {
		timeout: 30_000,
	}, async () => {
		const db = database.db;
		await seedPlainRows(db);
		const before = { catalog: await catalog(db), data: await data(db) };
		const reader = new Client({ connectionString: database.uri });
		await reader.connect();
		try {
			await reader.query("BEGIN");
			await reader.query(
				"LOCK TABLE public.app_locations IN ACCESS SHARE MODE",
			);

			const started = performance.now();
			const refused = await refusal(() => runUp(db));
			const waited = performance.now() - started;
			expect(refused?.code).toBe("55P03");
			expect(waited).toBeGreaterThanOrEqual(5_000);
			expect(waited).toBeLessThan(10_000);
			expect(await originColumns(db)).toEqual([]);
			expect({ catalog: await catalog(db), data: await data(db) }).toEqual(
				before,
			);

			await reader.query("COMMIT");
			const timeout = await db.transaction().execute(async (tx) => {
				await up(tx);
				const shown = await sql<{
					lock_timeout: string;
				}>`SHOW lock_timeout`.execute(tx);
				return shown.rows[0]?.lock_timeout;
			});
			expect(timeout).toBe("0");
			expect(await originColumns(db)).toEqual(NINETEEN_COLUMNS);
		} finally {
			await reader.end();
		}
	});
});
