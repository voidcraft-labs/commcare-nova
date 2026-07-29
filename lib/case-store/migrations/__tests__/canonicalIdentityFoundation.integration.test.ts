import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import { proseText } from "@/lib/domain/prose";
import {
	CANONICAL_IDENTITY_MIGRATION_VERSION,
	legacyOptionUuidV5,
} from "../20260728000000_canonical_identity_foundation/frozenTransform";

const MODULE_UUID = "10000000-0000-4000-8000-000000000001";
const FORM_UUID = "20000000-0000-4000-8000-000000000002";
const FIELD_UUID = "30000000-0000-4000-8000-000000000003";
const APP_ID = "canonical-migration-fixture";
const MIGRATION_NAME = "20260728000000_canonical_identity_foundation";

const adminUrl = inject("postgresTestUrl");
const adminPool = new Pool({ connectionString: adminUrl, max: 2 });
let databaseCounter = 0;

interface ScratchDatabase {
	readonly name: string;
	readonly db: Kysely<unknown>;
	readonly pool: Pool;
}

function databaseUrl(name: string): string {
	const value = new URL(adminUrl);
	value.pathname = `/${name}`;
	return value.toString();
}

async function createScratchDatabase(): Promise<ScratchDatabase> {
	databaseCounter++;
	const name = `canonical_identity_${process.pid}_${databaseCounter}`;
	await adminPool.query(`CREATE DATABASE "${name}"`);
	const pool = new Pool({ connectionString: databaseUrl(name), max: 3 });
	await pool.query('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
	await pool.query('CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch"');
	await pool.query('CREATE EXTENSION IF NOT EXISTS "postgis"');
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({ pool }),
	});
	const provider = {
		getMigrations: async () =>
			Object.fromEntries(
				Object.entries(caseStoreMigrations).filter(
					([migrationName]) => migrationName !== MIGRATION_NAME,
				),
			),
	};
	const result = await new Migrator({ db, provider }).migrateToLatest();
	if (result.error !== undefined) throw result.error;
	return { name, db, pool };
}

async function destroyScratchDatabase(
	scratch: ScratchDatabase | undefined,
): Promise<void> {
	if (scratch === undefined) return;
	await scratch.db.destroy();
	await adminPool.query(`DROP DATABASE "${scratch.name}" WITH (FORCE)`);
}

async function seedLegacyApp(
	db: Kysely<unknown>,
	optionUuid: string = `${FIELD_UUID}-opt-0`,
): Promise<void> {
	await sql`
		INSERT INTO apps
			(id, owner, project_id, app_name, app_name_lower, connect_type,
			 case_types, mutation_seq, status)
		VALUES
			(${APP_ID}, 'fixture-user', 'fixture-project', 'Fixture', 'fixture',
			 NULL, '[]'::jsonb, 1, 'complete')
	`.execute(db);
	await sql`
		INSERT INTO blueprint_entities
			(app_id, uuid, kind, parent_uuid, ordinal, data)
		VALUES
			(
				${APP_ID}, ${MODULE_UUID}, 'module', NULL, 0,
				${JSON.stringify({
					uuid: MODULE_UUID,
					name: "Module",
				})}::jsonb
			),
			(
				${APP_ID}, ${FORM_UUID}, 'form', ${MODULE_UUID}, 0,
				${JSON.stringify({
					uuid: FORM_UUID,
					name: "Form",
				})}::jsonb
			),
			(
				${APP_ID}, ${FIELD_UUID}, 'field', ${FORM_UUID}, 0,
				${JSON.stringify({
					uuid: FIELD_UUID,
					id: "choice",
					kind: "single_select",
					label: proseText("Choice"),
					options: [
						{ uuid: optionUuid, value: "a", label: "A" },
						{
							uuid: `${FIELD_UUID}-opt-1`,
							value: "b",
							label: "B",
						},
					],
				})}::jsonb
			)
	`.execute(db);
	await sql`
		INSERT INTO accepted_mutations
			(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
		VALUES
			(${APP_ID}, 1, 'fixture:before', NULL, 'fixture-user', 'user',
			 '[{"kind":"setAppName","name":"Fixture"}]'::jsonb)
	`.execute(db);
	await sql`
		INSERT INTO events
			(app_id, run_id, ts, seq, source, kind, event)
		VALUES
			(
				${APP_ID}, 'fixture-run', 1234, 0, 'chat', 'mutation',
				'{
					"kind":"mutation",
					"runId":"fixture-run",
					"ts":1234,
					"seq":0,
					"source":"chat",
					"actor":"user",
					"mutation":{"kind":"setAppName","name":"Fixture"}
				}'::jsonb)
	`.execute(db);
	await sql`
		INSERT INTO chat_stream_chunks
			(stream_id, first_index, app_id, run_id, chunks, terminal)
		VALUES ('fixture-stream', 0, ${APP_ID}, 'fixture-run', '[]'::jsonb, false)
	`.execute(db);
	await sql`
		INSERT INTO presence
			(app_id, user_id, session_id, name, email, color, location, expire_at)
		VALUES
			(${APP_ID}, 'fixture-user', 'fixture-session', 'Fixture', '',
			 '#000000',
			 ${JSON.stringify({
					kind: "module",
					moduleUuid: MODULE_UUID,
				})}::jsonb,
			 now() + interval '1 hour')
	`.execute(db);
}

beforeAll(() => {
	expect(CANONICAL_IDENTITY_MIGRATION_VERSION).toBe(
		"20260728000000-canonical-identity-v1",
	);
});

afterAll(async () => {
	await adminPool.end();
});

describe.sequential("canonical identity database migration", () => {
	test("atomically rewrites, archives, horizons, clears, and converts the frozen fixture", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			const beforeEvent = await sql<{ event_text: string }>`
				SELECT event::text AS event_text FROM events
			`.execute(scratch.db);
			const beforeAccepted = await sql<{ row_text: string }>`
				SELECT to_jsonb(accepted_mutations)::text AS row_text
				FROM accepted_mutations
				WHERE app_id = ${APP_ID} AND seq = 1
			`.execute(scratch.db);

			await runCaseStoreMigrations(scratch.db);

			const field = await sql<{ data: Record<string, unknown> }>`
				SELECT data FROM blueprint_entities WHERE uuid = ${FIELD_UUID}::uuid
			`.execute(scratch.db);
			const source = field.rows[0]?.data.optionsSource as
				| { kind: string; options: Array<{ uuid: string }> }
				| undefined;
			expect(source?.kind).toBe("inline");
			expect(source?.options.map((option) => option.uuid)).toEqual([
				legacyOptionUuidV5(`${FIELD_UUID}-opt-0`),
				legacyOptionUuidV5(`${FIELD_UUID}-opt-1`),
			]);
			expect(field.rows[0]?.data).not.toHaveProperty("options");

			const event = await sql<{
				kind: string;
				archived_text: string;
			}>`
				SELECT kind, (event -> 'archived')::text AS archived_text
				FROM events
			`.execute(scratch.db);
			expect(event.rows[0]).toEqual({
				kind: "archived-mutation",
				archived_text: beforeEvent.rows[0]?.event_text,
			});

			const accepted = await sql<{
				seq: string;
				batch_id: string;
				kind: string;
				mutations: unknown;
				row_text: string;
			}>`
				SELECT seq::text, batch_id, kind, mutations,
				       to_jsonb(accepted_mutations)::text AS row_text
				FROM accepted_mutations
				WHERE app_id = ${APP_ID}
				ORDER BY seq
			`.execute(scratch.db);
			expect(accepted.rows).toHaveLength(2);
			expect(accepted.rows[0]?.row_text).toBe(beforeAccepted.rows[0]?.row_text);
			expect(accepted.rows[1]).toMatchObject({
				seq: "2",
				batch_id: "migration:canonical-identity-foundation",
				kind: "migration",
				mutations: [],
			});

			const operational = await sql<{
				chunks: string;
				presence: string;
			}>`
				SELECT
					(SELECT count(*)::text FROM chat_stream_chunks) AS chunks,
					(SELECT count(*)::text FROM presence) AS presence
			`.execute(scratch.db);
			expect(operational.rows[0]).toEqual({ chunks: "0", presence: "0" });

			const types = await sql<{
				table_name: string;
				column_name: string;
				data_type: string;
			}>`
				SELECT table_name, column_name, data_type
				FROM information_schema.columns
				WHERE table_schema = 'public'
				  AND (
					(table_name = 'apps' AND column_name = 'logo')
					OR
					(table_name = 'blueprint_entities'
					 AND column_name IN ('uuid', 'parent_uuid'))
					OR
					(table_name = 'media_assets' AND column_name = 'id')
					OR
					(table_name = 'media_upload_aliases'
					 AND column_name IN ('attempt_asset_id', 'canonical_asset_id'))
					OR
					(table_name = 'media_asset_refs' AND column_name = 'asset_id')
					OR
					(table_name = 'form_submission_intents'
					 AND column_name = 'form_uuid')
					OR
					(table_name = 'form_attachments' AND column_name = 'field_uuid')
				  )
			`.execute(scratch.db);
			expect(types.rows).toHaveLength(9);
			expect(new Set(types.rows.map((row) => row.data_type))).toEqual(
				new Set(["uuid"]),
			);

			// A direct replay through the frozen runner's ledger path is a no-op.
			await runCaseStoreMigrations(scratch.db);
			const horizons = await sql<{ count: string }>`
				SELECT count(*)::text AS count
				FROM accepted_mutations
				WHERE app_id = ${APP_ID}
				  AND batch_id = 'migration:canonical-identity-foundation'
			`.execute(scratch.db);
			expect(horizons.rows[0]?.count).toBe("1");
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("rolls back every write and DDL change on one blocking app finding", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db, `${FIELD_UUID}-opt-99`);
			const before = await sql<{
				event_text: string;
				field_text: string;
			}>`
				SELECT
					(SELECT event::text FROM events LIMIT 1) AS event_text,
					(
						SELECT data::text
						FROM blueprint_entities
						WHERE uuid = ${FIELD_UUID}
					) AS field_text
			`.execute(scratch.db);

			await expect(runCaseStoreMigrations(scratch.db)).rejects.toThrow(
				/blocking frozen-scan finding/,
			);

			const after = await sql<{
				event_text: string;
				field_text: string;
				identity_type: string;
				migration_rows: string;
				horizons: string;
				chunks: string;
				presence: string;
			}>`
				SELECT
					(SELECT event::text FROM events LIMIT 1) AS event_text,
					(
						SELECT data::text
						FROM blueprint_entities
						WHERE uuid = ${FIELD_UUID}
					) AS field_text,
					(
						SELECT data_type
						FROM information_schema.columns
						WHERE table_schema = 'public'
						  AND table_name = 'blueprint_entities'
						  AND column_name = 'uuid'
					) AS identity_type,
					(
						SELECT count(*)::text
						FROM kysely_migration
						WHERE name = ${MIGRATION_NAME}
					) AS migration_rows,
					(
						SELECT count(*)::text
						FROM accepted_mutations
						WHERE batch_id = 'migration:canonical-identity-foundation'
					) AS horizons,
					(SELECT count(*)::text FROM chat_stream_chunks) AS chunks,
					(SELECT count(*)::text FROM presence) AS presence
			`.execute(scratch.db);
			expect(after.rows[0]).toEqual({
				...before.rows[0],
				identity_type: "text",
				migration_rows: "0",
				horizons: "0",
				chunks: "1",
				presence: "1",
			});
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);
});
