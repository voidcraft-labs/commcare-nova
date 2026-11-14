/**
 * The lookup name migration, over the production chain before it. The
 * plausible failures: a check the migration missed or doubled, so the
 * database refuses a hyphenated name the schema admits or keeps admitting a
 * name HQ refuses; a new App Test namespace left with the old check; a lock
 * request that waits with no bound behind a reader of the serving revision;
 * and a lock timeout left set for the next migration of the batch.
 */

import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { down, up } from "../20261113000000_hq_round_trip_lookup_names";

const MIGRATION = "20261113000000_hq_round_trip_lookup_names";

const database = setupPerTestDatabase({
	databaseNamePrefix: "lookup_names_migration_",
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

const PROJECT = "lookup-names-project";

const ADMITTED_TAGS = ["health-facility-v2", "XMLcodes", "a-b_c"];
const ADMITTED_WIRE_NAMES = ["geo-lat", "XMLcode"];
const REFUSED_NAMES = [
	"health-facility.v2",
	"geo.lat",
	"xmlcodes",
	"1a",
	"-a",
	"a b",
	"ñ",
];

/** The SQLSTATE a statement fails with, or `undefined` when it succeeds. */
async function sqlState(
	run: () => Promise<unknown>,
): Promise<string | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code !== "string") throw error;
		return code;
	}
}

function insertTable(db: Kysely<unknown>, tag: string, schema = "public") {
	return sql`
		INSERT INTO ${sql.id(schema, "lookup_tables")}
			(project_id, name, tag, definition_revision, rows_revision,
			 column_count, created_by, updated_by)
		VALUES (${PROJECT}, 'Facilities', ${tag}, 1, 1, 1, 'tester', 'tester')
		RETURNING id
	`.execute(db);
}

async function seedTable(db: Kysely<unknown>): Promise<string> {
	const inserted = await insertTable(db, "facilities");
	const id = (inserted.rows[0] as { id?: string } | undefined)?.id;
	if (id === undefined)
		throw new Error("The lookup table insert returned no id.");
	return id;
}

function insertColumn(db: Kysely<unknown>, tableId: string, wireName: string) {
	return sql`
		INSERT INTO public.lookup_columns
			(project_id, table_id, wire_name, label, data_type, order_key)
		VALUES (${PROJECT}, ${tableId}::uuid, ${wireName}, 'Name', 'text', 'V')
	`.execute(db);
}

async function tagStates(db: Kysely<unknown>, tags: readonly string[]) {
	const states: Record<string, string | undefined> = {};
	for (const tag of tags)
		states[tag] = await sqlState(() => insertTable(db, tag));
	return states;
}

async function wireNameStates(
	db: Kysely<unknown>,
	tableId: string,
	names: readonly string[],
) {
	const states: Record<string, string | undefined> = {};
	for (const name of names) {
		states[name] = await sqlState(() => insertColumn(db, tableId, name));
	}
	return states;
}

const each = (names: readonly string[], state: string | undefined) =>
	Object.fromEntries(names.map((name) => [name, state]));

/** Each check on the column, by name and definition. */
async function columnChecks(
	db: Kysely<unknown>,
	table: "lookup_tables" | "lookup_columns",
	column: "tag" | "wire_name",
) {
	const rows = await sql<{ name: string; definition: string }>`
		SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition
		FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.conrelid = ${`public.${table}`}::regclass
			AND c.contype = 'c'
			AND a.attname = ${column}
		ORDER BY c.conname
	`.execute(db);
	return rows.rows;
}

async function bothChecks(db: Kysely<unknown>) {
	return {
		tag: await columnChecks(db, "lookup_tables", "tag"),
		wireName: await columnChecks(db, "lookup_columns", "wire_name"),
	};
}

async function runUp(db: Kysely<unknown>) {
	await db.transaction().execute((tx) => up(tx));
}

describe(MIGRATION, () => {
	it("admits hyphens and a capital XML start, and refuses everything else the earlier checks refused", async () => {
		const db = database.db;
		await runUp(db);
		const tableId = await seedTable(db);

		expect(await tagStates(db, ADMITTED_TAGS)).toEqual(
			each(ADMITTED_TAGS, undefined),
		);
		const refusedTags = [...REFUSED_NAMES, "t".repeat(33)];
		expect(await tagStates(db, refusedTags)).toEqual(
			each(refusedTags, "23514"),
		);

		expect(await wireNameStates(db, tableId, ADMITTED_WIRE_NAMES)).toEqual(
			each(ADMITTED_WIRE_NAMES, undefined),
		);
		const refusedWireNames = [...REFUSED_NAMES, "w".repeat(256)];
		expect(await wireNameStates(db, tableId, refusedWireNames)).toEqual(
			each(refusedWireNames, "23514"),
		);
	});

	it("leaves exactly one named check on each column, and writes it again when run again", async () => {
		const db = database.db;
		const before = await bothChecks(db);
		expect(before.tag).toHaveLength(1);
		expect(before.wireName).toHaveLength(1);

		await runUp(db);
		const after = await bothChecks(db);
		expect(after.tag.map((check) => check.name)).toEqual([
			"lookup_tables_tag_check",
		]);
		expect(after.wireName.map((check) => check.name)).toEqual([
			"lookup_columns_wire_name_check",
		]);
		expect(after.tag[0]?.definition).toContain("A-Za-z0-9_-");
		expect(after.wireName[0]?.definition).toContain("A-Za-z0-9_-");

		// The adoption replay runs the chain again over the same schema.
		await runUp(db);
		expect(await bothChecks(db)).toEqual(after);
	});

	it("puts the earlier refusals back on down, and refuses to while a stored name needs the wider grammar", async () => {
		const db = database.db;
		const before = await bothChecks(db);
		await runUp(db);
		await insertTable(db, "health-facility-v2");
		const tableId = await seedTable(db);
		await insertColumn(db, tableId, "XMLcode");

		await expect(db.transaction().execute((tx) => down(tx))).rejects.toThrow(
			"Nova can't put the earlier lookup name checks back: 1 table tags and 1 column names hold a hyphen or start with XML in capitals, which the earlier checks refuse. Renaming them first lets the rollback run.",
		);
		expect((await bothChecks(db)).tag[0]?.definition).toContain("A-Za-z0-9_-");

		await sql`DELETE FROM public.lookup_tables WHERE tag = 'health-facility-v2'`.execute(
			db,
		);
		await sql`DELETE FROM public.lookup_columns WHERE wire_name = 'XMLcode'`.execute(
			db,
		);
		await db.transaction().execute((tx) => down(tx));

		const restored = await bothChecks(db);
		expect(restored.tag.map((check) => check.definition)).toEqual(
			before.tag.map((check) => check.definition),
		);
		expect(restored.wireName.map((check) => check.definition)).toEqual(
			before.wireName.map((check) => check.definition),
		);
		expect(await tagStates(db, ["health-facility-v2", "XMLcodes"])).toEqual({
			"health-facility-v2": "23514",
			XMLcodes: "23514",
		});
		expect(await wireNameStates(db, tableId, ["geo-lat", "XMLcode"])).toEqual({
			"geo-lat": "23514",
			XMLcode: "23514",
		});
	});

	it("gives an App Test namespace made after it the wider tag check", async () => {
		const db = database.db;
		await runUp(db);
		const created = await sql<{
			namespace: string;
		}>`SELECT public.nova_create_app_test_namespace(${randomUUID()}::uuid) AS namespace`.execute(
			db,
		);
		const namespace = created.rows[0]?.namespace;
		if (namespace === undefined)
			throw new Error("No App Test namespace was made.");
		expect(
			await sqlState(() => insertTable(db, "health-facility-v2", namespace)),
		).toBeUndefined();
		expect(await sqlState(() => insertTable(db, "geo.lat", namespace))).toBe(
			"23514",
		);
	});

	it("gives up after five seconds behind a reader, changes nothing, and resets the timeout once it runs", {
		timeout: 30_000,
	}, async () => {
		const db = database.db;
		const before = await bothChecks(db);
		const reader = new Client({ connectionString: database.uri });
		await reader.connect();
		try {
			await reader.query("BEGIN");
			await reader.query(
				"LOCK TABLE public.lookup_columns IN ACCESS SHARE MODE",
			);

			const started = performance.now();
			const refused = await sqlState(() => runUp(db));
			const waited = performance.now() - started;
			expect(refused).toBe("55P03");
			expect(waited).toBeGreaterThanOrEqual(5_000);
			expect(waited).toBeLessThan(10_000);
			expect(await bothChecks(db)).toEqual(before);

			await reader.query("COMMIT");
			const timeout = await db.transaction().execute(async (tx) => {
				await up(tx);
				const shown = await sql<{
					lock_timeout: string;
				}>`SHOW lock_timeout`.execute(tx);
				return shown.rows[0]?.lock_timeout;
			});
			expect(timeout).toBe("0");
			expect((await bothChecks(db)).tag[0]?.definition).toContain(
				"A-Za-z0-9_-",
			);
		} finally {
			await reader.end();
		}
	});
});
