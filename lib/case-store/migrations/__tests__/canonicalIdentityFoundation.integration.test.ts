import { getMigrations } from "better-auth/db/migration";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import { proseText } from "@/lib/domain/prose";
import {
	APPS_PROJECT_NONBLANK_CHECK,
	CASES_PROJECT_APP_TENANT_FOREIGN_KEY,
	CASES_PROJECT_APP_TENANT_FOREIGN_KEY_DEFINITION,
	CASES_PROJECT_NONBLANK_CHECK,
	type FrozenMigrationFailureStage,
	runFrozenCanonicalIdentityMigration,
} from "../20260728000000_canonical_identity_foundation/frozenDatabaseMigration";
import {
	captureFrozenStorageSnapshot,
	dispatchFrozenStorageOccurrences,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import { scanFrozenCanonicalIdentityFoundation } from "../20260728000000_canonical_identity_foundation/frozenScanner";
import {
	CANONICAL_IDENTITY_MIGRATION_VERSION,
	canonicalIdentityDigest,
	legacyOptionUuidV5,
} from "../20260728000000_canonical_identity_foundation/frozenTransform";

const MODULE_UUID = "10000000-0000-4000-8000-000000000001";
const FORM_UUID = "20000000-0000-4000-8000-000000000002";
const FIELD_UUID = "30000000-0000-4000-8000-000000000003";
const APP_ID = "canonical-migration-fixture";
const MIGRATION_NAME = "20260728000000_canonical_identity_foundation";
const SECOND_MODULE_UUID = "10000000-0000-4000-8000-000000000011";
const SECOND_FORM_UUID = "20000000-0000-4000-8000-000000000012";
const SECOND_FIELD_UUID = "30000000-0000-4000-8000-000000000013";
const SECOND_APP_ID = "canonical-migration-second-fixture";
const WRONG_KIND_MEDIA_ID = "40000000-0000-4000-8000-000000000004";

interface LegacyFixture {
	readonly appId: string;
	readonly moduleUuid: string;
	readonly formUuid: string;
	readonly fieldUuid: string;
}

const PRIMARY_FIXTURE: LegacyFixture = {
	appId: APP_ID,
	moduleUuid: MODULE_UUID,
	formUuid: FORM_UUID,
	fieldUuid: FIELD_UUID,
};

const SECOND_FIXTURE: LegacyFixture = {
	appId: SECOND_APP_ID,
	moduleUuid: SECOND_MODULE_UUID,
	formUuid: SECOND_FORM_UUID,
	fieldUuid: SECOND_FIELD_UUID,
};

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
					([migrationName]) => migrationName < MIGRATION_NAME,
				),
			),
	};
	const result = await new Migrator({ db, provider }).migrateToLatest();
	if (result.error !== undefined) throw result.error;
	const { runMigrations } = await getMigrations(authMigrateOptions(pool));
	await runMigrations();
	return { name, db, pool };
}

/**
 * This is a timestamp-frozen migration rehearsal. Later migrations may add
 * deliberate dependencies to `apps` or widen Blueprint storage, and replaying
 * those future objects before a direct idempotency audit changes the historical
 * catalog the cutover is specifically meant to prove. Keep the harness on the
 * exact prefix through this migration; current-schema replay has its own
 * migration suites.
 */
async function runFrozenCaseStoreMigrations(
	db: Kysely<unknown>,
): Promise<void> {
	const provider = {
		getMigrations: async () =>
			Object.fromEntries(
				Object.entries(caseStoreMigrations).filter(
					([migrationName]) => migrationName <= MIGRATION_NAME,
				),
			),
	};
	const result = await new Migrator({ db, provider }).migrateToLatest();
	if (result.error !== undefined) throw result.error;
}

async function destroyScratchDatabase(
	scratch: ScratchDatabase | undefined,
): Promise<void> {
	if (scratch === undefined) return;
	await scratch.db.destroy();
	await adminPool.query(`DROP DATABASE "${scratch.name}"`);
}

async function seedLegacyApp(
	db: Kysely<unknown>,
	fixture: LegacyFixture = PRIMARY_FIXTURE,
	optionUuid: string = `${fixture.fieldUuid}-opt-0`,
): Promise<void> {
	const { appId, moduleUuid, formUuid, fieldUuid } = fixture;
	// A data-bearing production database has Better Auth's complete seven-table
	// topology. `createScratchDatabase` installs that exact external schema
	// before this fixture writes a Project; a one-table stand-in would exercise
	// a partial topology that the cutover correctly rejects.
	await sql`
		INSERT INTO auth_organization (id, name, slug, "createdAt")
		VALUES (
			'fixture-project',
			'Fixture Project',
			'fixture-project',
			now()
		)
		ON CONFLICT (id) DO NOTHING
	`.execute(db);
	await sql`
		INSERT INTO apps
			(id, owner, project_id, app_name, app_name_lower, connect_type,
			 case_types, mutation_seq, status)
		VALUES
			(${appId}, 'fixture-user', 'fixture-project', 'Fixture', 'fixture',
			 NULL, '[]'::jsonb, 1, 'complete')
	`.execute(db);
	await sql`
		INSERT INTO blueprint_entities
			(app_id, uuid, kind, parent_uuid, ordinal, data)
		VALUES
			(
				${appId}, ${moduleUuid}, 'module', NULL, 0,
				${JSON.stringify({
					uuid: moduleUuid,
					id: "module",
					name: "Module",
				})}::jsonb
			),
			(
				${appId}, ${formUuid}, 'form', ${moduleUuid}, 0,
				${JSON.stringify({
					uuid: formUuid,
					id: "form",
					name: "Form",
					type: "survey",
				})}::jsonb
			),
			(
				${appId}, ${fieldUuid}, 'field', ${formUuid}, 0,
				${JSON.stringify({
					uuid: fieldUuid,
					id: "choice",
					kind: "single_select",
					label: proseText("Choice"),
					options: [
						{ uuid: optionUuid, value: "a", label: "A" },
						{
							uuid: `${fieldUuid}-opt-1`,
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
			(${appId}, 1, 'fixture:before', NULL, 'fixture-user', 'user',
			 '[{"kind":"setAppName","name":"Fixture"}]'::jsonb)
	`.execute(db);
	await sql`
		INSERT INTO events
			(app_id, run_id, ts, seq, source, kind, event)
		VALUES
			(
				${appId}, ${`fixture-run-${appId}`}, 1234, 0, 'chat', 'mutation',
				${JSON.stringify({
					kind: "mutation",
					runId: `fixture-run-${appId}`,
					ts: 1234,
					seq: 0,
					source: "chat",
					actor: "user",
					mutation: { kind: "setAppName", name: "Fixture" },
				})}::jsonb)
	`.execute(db);
	await sql`
		INSERT INTO chat_stream_chunks
			(stream_id, first_index, app_id, run_id, chunks, terminal)
		VALUES (
			${`fixture-stream-${appId}`},
			0,
			${appId},
			${`fixture-run-${appId}`},
			'[]'::jsonb,
			true
		)
	`.execute(db);
	/* A pre-cutover case row carrying `external_id` BOTH in its column and as a
	 * duplicate inside `properties`, with the two disagreeing — the exact shape
	 * production holds. The column is authoritative, so the cutover must keep it
	 * and drop the document copy; leaving the copy makes the row unreadable,
	 * because the persisted-schema decoder refuses a standard scalar found as a
	 * JSON property. */
	await sql`
		INSERT INTO cases
			(app_id, project_id, case_type, case_name, external_id, properties)
		VALUES (
			${appId},
			'fixture-project',
			'patient',
			'Patient',
			'COLUMN01',
			'{"external_id":"DOCUMENT1","village":"Riverside"}'::jsonb
		)
	`.execute(db);
}

async function seedGenesisRoot(
	db: Kysely<unknown>,
	appId: string,
	runId: string,
): Promise<void> {
	await sql`
		INSERT INTO apps
			(id, owner, project_id, app_name, app_name_lower, connect_type,
			 case_types, mutation_seq, status, run_id)
		VALUES (
			${appId},
			'fixture-user',
			'fixture-project',
			${appId},
			${appId.toLowerCase()},
			NULL,
			NULL,
			1,
			'complete',
			${runId}
		)
	`.execute(db);
	await sql`
		INSERT INTO app_changes
			(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
		VALUES (
			${appId},
			1,
			${`genesis:${appId}`},
			${runId},
			'fixture-user',
			'fold-baseline',
			'[]'::jsonb
		)
	`.execute(db);
}

async function seedWrongKindAppLogo(db: Kysely<unknown>): Promise<void> {
	await sql`
		UPDATE apps
		SET logo = ${WRONG_KIND_MEDIA_ID}
		WHERE id = ${APP_ID}
	`.execute(db);
	await sql`
		INSERT INTO media_assets (
			id, project_id, owner, content_hash, mime_type, extension,
			size_bytes, kind, gcs_object_key, original_filename, status
		) VALUES (
			${WRONG_KIND_MEDIA_ID},
			'fixture-project',
			'fixture-user',
			${"4".repeat(64)},
			'audio/mpeg',
			'.mp3',
			10,
			'audio',
			'projects/fixture-project/wrong-kind.mp3',
			'wrong-kind.mp3',
			'ready'
		)
	`.execute(db);
	await sql`
		INSERT INTO media_asset_refs (asset_id, app_id)
		VALUES (${WRONG_KIND_MEDIA_ID}, ${APP_ID})
	`.execute(db);
}

async function captureDatabaseProof(db: Kysely<unknown>): Promise<string> {
	const storage = await captureFrozenStorageSnapshot(db);
	const columns = await sql<Record<string, unknown>>`
		SELECT table_name, column_name, ordinal_position, data_type, udt_name,
		       is_nullable, column_default
		FROM information_schema.columns
		WHERE table_schema = 'public'
		ORDER BY table_name, ordinal_position
	`.execute(db);
	const constraints = await sql<Record<string, unknown>>`
		SELECT namespace.nspname AS schema_name,
		       relation.relname AS table_name,
		       constraint_row.conname AS constraint_name,
		       constraint_row.contype AS constraint_type,
		       constraint_row.condeferrable AS deferrable,
		       constraint_row.condeferred AS initially_deferred,
		       constraint_row.convalidated AS validated,
		       pg_get_constraintdef(constraint_row.oid, true) AS definition
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		ORDER BY table_name, constraint_name
	`.execute(db);
	const indexes = await sql<Record<string, unknown>>`
		SELECT namespace.nspname AS schema_name,
		       relation.relname AS table_name,
		       index_relation.relname AS index_name,
		       pg_get_indexdef(index_row.indexrelid) AS definition
		FROM pg_index AS index_row
		JOIN pg_class AS relation ON relation.oid = index_row.indrelid
		JOIN pg_class AS index_relation
		  ON index_relation.oid = index_row.indexrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		ORDER BY table_name, index_name
	`.execute(db);
	const triggers = await sql<Record<string, unknown>>`
		SELECT namespace.nspname AS schema_name,
		       relation.relname AS table_name,
		       trigger_row.tgname AS trigger_name,
		       pg_get_triggerdef(trigger_row.oid, true) AS definition
		FROM pg_trigger AS trigger_row
		JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		  AND NOT trigger_row.tgisinternal
		ORDER BY table_name, trigger_name
	`.execute(db);
	const routines = await sql<Record<string, unknown>>`
		SELECT namespace.nspname AS schema_name,
		       routine.proname AS routine_name,
		       pg_get_function_identity_arguments(routine.oid) AS arguments,
		       pg_get_functiondef(routine.oid) AS definition,
		       routine.proowner::regrole::text AS owner_name,
		       routine.proacl::text AS acl
		FROM pg_proc AS routine
		JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
		WHERE namespace.nspname = 'public'
		  AND routine.prokind IN ('f', 'p')
		ORDER BY routine_name, arguments
	`.execute(db);
	const relations = await sql<Record<string, unknown>>`
		SELECT namespace.nspname AS schema_name,
		       relation.relname AS relation_name,
		       relation.relkind AS relation_kind,
		       relation.relowner::regrole::text AS owner_name,
		       relation.relacl::text AS acl
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		ORDER BY relation_name, relation_kind
	`.execute(db);
	const migrationLedger = await sql<Record<string, unknown>>`
		SELECT to_jsonb(kysely_migration) AS row_value
		FROM kysely_migration
		ORDER BY name
	`.execute(db);
	return canonicalIdentityDigest({
		storage,
		columns: columns.rows,
		constraints: constraints.rows,
		indexes: indexes.rows,
		triggers: triggers.rows,
		routines: routines.rows,
		relations: relations.rows,
		migrationLedger: migrationLedger.rows,
	});
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

			await runFrozenCaseStoreMigrations(scratch.db);

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

			const appChanges = await sql<{
				seq: string;
				batch_id: string;
				kind: string;
				mutations: unknown;
				row_text: string;
			}>`
				SELECT seq::text, batch_id, kind, mutations,
				       (
						to_jsonb(app_changes)
							- 'from_project_id'
							- 'to_project_id'
					   )::text AS row_text
				FROM app_changes
				WHERE app_id = ${APP_ID}
				ORDER BY seq
			`.execute(scratch.db);
			expect(appChanges.rows).toHaveLength(2);
			expect(appChanges.rows[0]?.row_text).toBe(
				beforeAccepted.rows[0]?.row_text,
			);
			expect(appChanges.rows[1]).toMatchObject({
				seq: "2",
				batch_id: "fold-baseline:canonical-identity-foundation",
				kind: "fold-baseline",
				mutations: [],
			});
			const baselines = await sql<{
				app_id: string;
				seq: string;
				snapshot: Record<string, unknown>;
				snapshot_digest: string;
			}>`
				SELECT app_id, seq::text, snapshot, snapshot_digest
				FROM app_change_fold_baselines
			`.execute(scratch.db);
			expect(baselines.rows).toHaveLength(1);
			expect(baselines.rows[0]).toMatchObject({
				app_id: APP_ID,
				seq: "2",
			});
			expect(baselines.rows[0]?.snapshot_digest).toMatch(/^[0-9a-f]{64}$/);
			expect(baselines.rows[0]?.snapshot).toMatchObject({
				appId: APP_ID,
				moduleOrder: [MODULE_UUID],
				formOrder: { [MODULE_UUID]: [FORM_UUID] },
				fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
			});
			await expect(
				sql`UPDATE app_change_fold_baselines SET snapshot = snapshot`.execute(
					scratch.db,
				),
			).rejects.toThrow(/immutable/);

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

			// The migration ledger is idempotent, and the frozen procedure itself
			// verifies the exact already-applied baseline state when invoked again.
			await runFrozenCaseStoreMigrations(scratch.db);
			const direct = await scratch.db
				.transaction()
				.execute((tx) => runFrozenCanonicalIdentityMigration(tx));
			expect(direct.alreadyApplied).toBe(true);
			const horizons = await sql<{ count: string }>`
				SELECT count(*)::text AS count
				FROM app_changes
				WHERE app_id = ${APP_ID}
				  AND batch_id = 'fold-baseline:canonical-identity-foundation'
			`.execute(scratch.db);
			expect(horizons.rows[0]?.count).toBe("1");
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("installs exact Project tenancy constraints and admits an atomic app move", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await runFrozenCaseStoreMigrations(scratch.db);

			const columns = await sql<{
				schema_name: string;
				table_name: string;
				not_null: boolean;
			}>`
				SELECT namespace.nspname AS schema_name,
				       relation.relname AS table_name,
				       attribute.attnotnull AS not_null
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace
				  ON namespace.oid = relation.relnamespace
				JOIN pg_attribute AS attribute
				  ON attribute.attrelid = relation.oid
				 AND attribute.attname = 'project_id'
				 AND NOT attribute.attisdropped
				WHERE (namespace.nspname, relation.relname) IN (
					('public', 'apps'),
					('public', 'cases')
				)
				ORDER BY namespace.nspname, relation.relname
			`.execute(scratch.db);
			expect(columns.rows).toEqual([
				{ schema_name: "public", table_name: "apps", not_null: true },
				{ schema_name: "public", table_name: "cases", not_null: true },
			]);

			const constraints = await sql<{
				constraint_name: string;
				definition: string;
				validated: boolean;
				deferrable: boolean;
				initially_deferred: boolean;
			}>`
				SELECT
					constraint_row.conname AS constraint_name,
					pg_get_constraintdef(constraint_row.oid, true) AS definition,
					constraint_row.convalidated AS validated,
					constraint_row.condeferrable AS deferrable,
					constraint_row.condeferred AS initially_deferred
				FROM pg_constraint AS constraint_row
				WHERE constraint_row.conrelid IN (
					'public.apps'::regclass,
					'public.cases'::regclass
				)
				  AND constraint_row.conname IN (
					${APPS_PROJECT_NONBLANK_CHECK},
					${CASES_PROJECT_NONBLANK_CHECK},
					${CASES_PROJECT_APP_TENANT_FOREIGN_KEY}
				  )
				ORDER BY constraint_row.conname
			`.execute(scratch.db);
			expect(constraints.rows).toEqual([
				{
					constraint_name: APPS_PROJECT_NONBLANK_CHECK,
					definition: "CHECK (btrim(project_id) <> ''::text)",
					validated: true,
					deferrable: false,
					initially_deferred: false,
				},
				{
					constraint_name: CASES_PROJECT_APP_TENANT_FOREIGN_KEY,
					definition: CASES_PROJECT_APP_TENANT_FOREIGN_KEY_DEFINITION,
					validated: true,
					deferrable: true,
					initially_deferred: true,
				},
				{
					constraint_name: CASES_PROJECT_NONBLANK_CHECK,
					definition: "CHECK (btrim(project_id) <> ''::text)",
					validated: true,
					deferrable: false,
					initially_deferred: false,
				},
			]);

			await expect(
				sql`UPDATE apps SET project_id = NULL WHERE id = ${APP_ID}`.execute(
					scratch.db,
				),
			).rejects.toMatchObject({ code: "23502" });
			await expect(
				sql`UPDATE apps SET project_id = '' WHERE id = ${APP_ID}`.execute(
					scratch.db,
				),
			).rejects.toMatchObject({ code: "23514" });
			await expect(
				sql`
					INSERT INTO cases
						(app_id, project_id, case_type, case_name, properties)
					VALUES (${APP_ID}, 'wrong-project', 'patient', 'Patient', '{}'::jsonb)
				`.execute(scratch.db),
			).rejects.toMatchObject({ code: "23503" });
			await expect(
				sql`
					INSERT INTO cases
						(app_id, project_id, case_type, case_name, properties)
					VALUES (${APP_ID}, '', 'patient', 'Patient', '{}'::jsonb)
				`.execute(scratch.db),
			).rejects.toMatchObject({ code: "23514" });
			await expect(
				sql`
					INSERT INTO cases
						(app_id, project_id, case_type, case_name, properties)
					VALUES (${APP_ID}, NULL, 'patient', 'Patient', '{}'::jsonb)
				`.execute(scratch.db),
			).rejects.toMatchObject({ code: "23502" });

			await sql`
				INSERT INTO cases
					(app_id, project_id, case_type, case_name, properties)
				VALUES (${APP_ID}, 'fixture-project', 'patient', 'Patient', '{}'::jsonb)
			`.execute(scratch.db);
			await sql`
				INSERT INTO auth_organization (id, name, slug, "createdAt")
				VALUES (
					'fixture-project-next',
					'Fixture Project Next',
					'fixture-project-next',
					now()
				)
			`.execute(scratch.db);
			await scratch.db.transaction().execute(async (tx) => {
				await sql`
					INSERT INTO app_changes
						(app_id, seq, batch_id, run_id, actor_id, kind, mutations,
						 from_project_id, to_project_id)
					VALUES (
						${APP_ID},
						3,
						'project-move:3',
						NULL,
						'fixture-user',
						'project-move',
						'[]'::jsonb,
						'fixture-project',
						'fixture-project-next'
					)
				`.execute(tx);
				await sql`
					UPDATE apps
					SET project_id = 'fixture-project-next',
					    mutation_seq = 3
					WHERE id = ${APP_ID}
				`.execute(tx);
				await sql`
					UPDATE cases
					SET project_id = 'fixture-project-next'
					WHERE app_id = ${APP_ID}
				`.execute(tx);
			});
			const moved = await sql<{ app_project: string; case_project: string }>`
				SELECT app.project_id AS app_project,
				       case_row.project_id AS case_project
				FROM apps AS app
				JOIN cases AS case_row ON case_row.app_id = app.id
				WHERE app.id = ${APP_ID}
			`.execute(scratch.db);
			/* Every case row follows its app, however many the fixture holds —
			 * asserting a row COUNT here would just re-pin the fixture. */
			expect(moved.rows.length).toBeGreaterThan(0);
			expect(moved.rows).toEqual(
				moved.rows.map(() => ({
					app_project: "fixture-project-next",
					case_project: "fixture-project-next",
				})),
			);

			await sql`
				INSERT INTO auth_organization (id, name, slug, "createdAt")
				VALUES (
					'fixture-project-third',
					'Fixture Project Third',
					'fixture-project-third',
					now()
				)
			`.execute(scratch.db);

			await expect(
				scratch.db.transaction().execute(async (tx) => {
					await sql`
						UPDATE apps
						SET project_id = 'fixture-project-third',
						    mutation_seq = 4
						WHERE id = ${APP_ID}
					`.execute(tx);
					await sql`
						UPDATE cases
						SET project_id = 'fixture-project-third'
						WHERE app_id = ${APP_ID}
					`.execute(tx);
				}),
			).rejects.toThrow(/no exact same-sequence project-move app change/);

			await expect(
				scratch.db.transaction().execute(async (tx) => {
					await sql`
						INSERT INTO app_changes
							(app_id, seq, batch_id, run_id, actor_id, kind, mutations,
							 from_project_id, to_project_id)
						VALUES (
							${APP_ID},
							4,
							'project-move:4:event-only',
							NULL,
							'fixture-user',
							'project-move',
							'[]'::jsonb,
							'fixture-project-next',
							'fixture-project-third'
						)
					`.execute(tx);
				}),
			).rejects.toThrow(/does not equal the final app Project\/head/);

			await expect(
				scratch.db.transaction().execute(async (tx) => {
					await sql`
						UPDATE apps
						SET project_id = 'fixture-project-third',
						    mutation_seq = 4
						WHERE id = ${APP_ID}
					`.execute(tx);
					await sql`
						INSERT INTO app_changes
							(app_id, seq, batch_id, run_id, actor_id, kind, mutations,
							 from_project_id, to_project_id)
						VALUES (
							${APP_ID},
							4,
							'project-move:4:wrong-order',
							NULL,
							'fixture-user',
							'project-move',
							'[]'::jsonb,
							'fixture-project-next',
							'fixture-project-third'
						)
					`.execute(tx);
				}),
			).rejects.toThrow(/does not start at the locked app Project\/head/);

			await expect(
				sql`
					INSERT INTO app_changes
						(app_id, seq, batch_id, run_id, actor_id, kind, mutations,
						 from_project_id, to_project_id)
					VALUES (
						${APP_ID},
						4,
						'autosave:4:scoped',
						NULL,
						'fixture-user',
						'autosave',
						'[{"kind":"setAppName","name":"Scoped"}]'::jsonb,
						'fixture-project-next',
						'fixture-project-third'
					)
				`.execute(scratch.db),
			).rejects.toMatchObject({ code: "23514" });

			await expect(
				sql`
					INSERT INTO app_changes
						(app_id, seq, batch_id, run_id, actor_id, kind, mutations,
						 from_project_id, to_project_id)
					VALUES (
						${APP_ID},
						4,
						'project-move:4:blank-scope',
						NULL,
						'fixture-user',
						'project-move',
						'[]'::jsonb,
						' ',
						'fixture-project-third'
					)
				`.execute(scratch.db),
			).rejects.toThrow(/does not start at the locked app Project\/head/);

			await expect(
				sql`
					INSERT INTO app_changes
						(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
					VALUES (
						${APP_ID},
						4,
						'autosave:4:blank-run',
						' ',
						'fixture-user',
						'autosave',
						'[{"kind":"setAppName","name":"Blank run"}]'::jsonb
					)
				`.execute(scratch.db),
			).rejects.toThrow(/blank envelope identity/);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("rolls back every write and DDL change on one blocking app finding", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await seedLegacyApp(
				scratch.db,
				SECOND_FIXTURE,
				`${SECOND_FIELD_UUID}-opt-99`,
			);
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

			await expect(runFrozenCaseStoreMigrations(scratch.db)).rejects.toThrow(
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
				baseline_table: string | null;
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
						WHERE batch_id = 'fold-baseline:canonical-identity-foundation'
					) AS horizons,
					(SELECT count(*)::text FROM chat_stream_chunks) AS chunks,
					(SELECT count(*)::text FROM presence) AS presence,
					pg_catalog.to_regclass(
						'public.app_change_fold_baselines'
					)::text AS baseline_table
			`.execute(scratch.db);
			expect(after.rows[0]).toEqual({
				...before.rows[0],
				identity_type: "text",
				migration_rows: "0",
				horizons: "0",
				chunks: "2",
				presence: "0",
				baseline_table: null,
			});
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("scanner blocks and migration rolls back a ready same-Project asset of the wrong authored slot kind", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await seedWrongKindAppLogo(scratch.db);
			const before = await captureDatabaseProof(scratch.db);

			const scan = await scanFrozenCanonicalIdentityFoundation(scratch.db);
			expect(scan.complete).toBe(true);
			if (!scan.complete) throw new Error("Expected one complete frozen scan.");
			expect(
				scan.cutoverPlan.findings.some(
					(finding) =>
						finding.carrierId === "blueprint-media-reference" &&
						finding.code === "invalid-legacy-shape",
				),
			).toBe(true);
			expect(await captureDatabaseProof(scratch.db)).toBe(before);

			await expect(runFrozenCaseStoreMigrations(scratch.db)).rejects.toThrow(
				/exact authored slot kind/,
			);
			expect(await captureDatabaseProof(scratch.db)).toBe(before);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test.each<FrozenMigrationFailureStage>([
		"canonical-properties",
		"expressions",
		"final-shape",
		"date-post-submit",
		"events",
		"operational",
		"horizon",
		"ddl",
		"media-index",
	])(
		"rolls back every row, catalog object, and ledger byte after the %s stage",
		async (stage) => {
			let scratch: ScratchDatabase | undefined;
			try {
				scratch = await createScratchDatabase();
				await seedLegacyApp(scratch.db);
				await seedLegacyApp(scratch.db, SECOND_FIXTURE);
				const before = await captureDatabaseProof(scratch.db);

				await expect(
					scratch.db.transaction().execute((tx) =>
						runFrozenCanonicalIdentityMigration(tx, {
							failAfterStage: stage,
						}),
					),
				).rejects.toThrow(
					`Injected canonical identity migration failure after ${stage}.`,
				);

				expect(await captureDatabaseProof(scratch.db)).toBe(before);
			} finally {
				await destroyScratchDatabase(scratch);
			}
		},
		120_000,
	);

	test("reports the exact shared occurrence projection before and after migration", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			const sourceDigest = canonicalIdentityDigest(
				dispatchFrozenStorageOccurrences(
					await captureFrozenStorageSnapshot(scratch.db),
				),
			);

			const report = await scratch.db
				.transaction()
				.execute((tx) => runFrozenCanonicalIdentityMigration(tx));
			const resultDigest = canonicalIdentityDigest(
				dispatchFrozenStorageOccurrences(
					await captureFrozenStorageSnapshot(scratch.db),
				),
			);

			expect(report.occurrenceSourceDigest).toBe(sourceDigest);
			expect(report.occurrenceResultDigest).toBe(resultDigest);
			expect(report.occurrencePlanDigest).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("rejects a mixed SQL identity-column state", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await runFrozenCaseStoreMigrations(scratch.db);
			await sql`
				ALTER TABLE apps
				ALTER COLUMN logo TYPE text USING logo::text
			`.execute(scratch.db);

			await expect(
				scratch.db
					.transaction()
					.execute((tx) => runFrozenCanonicalIdentityMigration(tx)),
			).rejects.toThrow(/partial or unexpected schema state/);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("rejects an unexpected SQL identity dependency before the first write", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await sql`
				CREATE INDEX canonical_identity_unexpected_logo_idx
				ON apps (logo)
			`.execute(scratch.db);

			await expect(runFrozenCaseStoreMigrations(scratch.db)).rejects.toThrow(
				/text SQL identity dependency closure differs from the frozen exact catalog/,
			);

			const state = await sql<{
				data_type: string;
				migration_rows: string;
			}>`
				SELECT
					(
						SELECT data_type
						FROM information_schema.columns
						WHERE table_schema = 'public'
						  AND table_name = 'apps'
						  AND column_name = 'logo'
					) AS data_type,
					(
						SELECT count(*)::text
						FROM kysely_migration
						WHERE name = ${MIGRATION_NAME}
					) AS migration_rows
			`.execute(scratch.db);
			expect(state.rows).toEqual([{ data_type: "text", migration_rows: "0" }]);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("rejects an unexpected SQL identity dependency in applied state", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await runFrozenCaseStoreMigrations(scratch.db);
			await sql`
				CREATE INDEX canonical_identity_unexpected_entity_uuid_idx
				ON blueprint_entities (uuid)
			`.execute(scratch.db);

			await expect(
				scratch.db
					.transaction()
					.execute((tx) => runFrozenCanonicalIdentityMigration(tx)),
			).rejects.toThrow(
				/uuid SQL identity dependency closure differs from the frozen exact catalog/,
			);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("admits only the exact current same-transaction baseline bytes", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await runFrozenCaseStoreMigrations(scratch.db);

			await expect(
				scratch.db.transaction().execute(async (tx) => {
					const appId = "baseline-wrong-snapshot";
					await seedGenesisRoot(tx, appId, "run-wrong-snapshot");
					await sql`
						INSERT INTO app_change_fold_baselines
							(app_id, seq, project_id, snapshot, snapshot_digest)
						SELECT
							${appId},
							1,
							'fixture-project',
							nova_current_app_change_fold_snapshot(${appId})
								|| '{"unexpected":true}'::jsonb,
							nova_app_change_fold_snapshot_digest(
								nova_current_app_change_fold_snapshot(${appId})
									|| '{"unexpected":true}'::jsonb
							)
					`.execute(tx);
				}),
			).rejects.toThrow(/snapshot does not equal current app state/);

			await expect(
				scratch.db.transaction().execute(async (tx) => {
					const appId = "baseline-wrong-digest";
					await seedGenesisRoot(tx, appId, "run-wrong-digest");
					await sql`
						INSERT INTO app_change_fold_baselines
							(app_id, seq, project_id, snapshot, snapshot_digest)
						SELECT
							${appId},
							1,
							'fixture-project',
							nova_current_app_change_fold_snapshot(${appId}),
							repeat('0', 64)
					`.execute(tx);
				}),
			).rejects.toThrow(/digest does not match snapshot/);

			await expect(
				scratch.db.transaction().execute(async (tx) => {
					const sourceApp = "baseline-cross-source";
					const targetApp = "baseline-cross-target";
					await seedGenesisRoot(tx, sourceApp, "run-cross-source");
					await seedGenesisRoot(tx, targetApp, "run-cross-target");
					await sql`
						INSERT INTO app_change_fold_baselines
							(app_id, seq, project_id, snapshot, snapshot_digest)
						SELECT
							${targetApp},
							1,
							'fixture-project',
							nova_current_app_change_fold_snapshot(${sourceApp}),
							nova_app_change_fold_snapshot_digest(
								nova_current_app_change_fold_snapshot(${sourceApp})
							)
					`.execute(tx);
				}),
			).rejects.toThrow(/snapshot does not equal current app state/);

			await expect(
				scratch.db.transaction().execute(async (tx) => {
					const appId = "baseline-numeric-lexeme";
					const moduleUuid = "81111111-1111-4111-8111-111111111111";
					const formUuid = "82222222-2222-4222-8222-222222222222";
					const fieldUuid = "83333333-3333-4333-8333-333333333333";
					await seedGenesisRoot(tx, appId, "run-numeric-lexeme");
					await sql`
						INSERT INTO blueprint_entities
							(app_id, uuid, kind, parent_uuid, ordinal, data)
						VALUES
							(
								${appId},
								${moduleUuid}::uuid,
								'module',
								NULL,
								0,
								jsonb_build_object(
									'uuid', ${moduleUuid}::text,
									'id', 'main',
									'name', 'Main'
								)
							),
							(
								${appId},
								${formUuid}::uuid,
								'form',
								${moduleUuid}::uuid,
								0,
								jsonb_build_object(
									'uuid', ${formUuid}::text,
									'id', 'survey',
									'name', 'Survey',
									'type', 'survey'
								)
							),
							(
								${appId},
								${fieldUuid}::uuid,
								'field',
								${formUuid}::uuid,
								0,
								(
									'{"id":"amount","kind":"decimal","config":' ||
									'{"decimal":1.00}}'
								)::jsonb
									|| jsonb_build_object('uuid', ${fieldUuid}::text)
							)
					`.execute(tx);
					await sql`
						WITH submitted AS (
							SELECT jsonb_set(
								nova_current_app_change_fold_snapshot(${appId}),
								ARRAY[
									'fields'::text,
									${fieldUuid}::text,
									'config'::text,
									'decimal'::text
								],
								'1.0'::jsonb
							) AS snapshot
						)
						INSERT INTO app_change_fold_baselines
							(app_id, seq, project_id, snapshot, snapshot_digest)
						SELECT
							${appId},
							1,
							'fixture-project',
							snapshot,
							nova_app_change_fold_snapshot_digest(snapshot)
						FROM submitted
					`.execute(tx);
				}),
			).rejects.toThrow(/snapshot does not equal current app state/);

			await expect(
				scratch.db.transaction().execute(async (tx) => {
					const appId = "baseline-empty-arbitrary";
					await sql`
						INSERT INTO apps
							(id, owner, project_id, app_name, app_name_lower,
							 mutation_seq, status)
						VALUES (
							${appId},
							'fixture-user',
							'fixture-project',
							${appId},
							${appId},
							1,
							'complete'
						)
					`.execute(tx);
					await sql`
						INSERT INTO app_changes
							(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
						VALUES (
							${appId},
							1,
							'arbitrary-empty',
							NULL,
							'fixture-user',
							'autosave',
							'[]'::jsonb
						)
					`.execute(tx);
				}),
			).rejects.toThrow(
				/non-move non-baseline app changes must contain mutations/,
			);

			const delayedApp = "baseline-delayed";
			await sql`
				ALTER TABLE app_changes
				DISABLE TRIGGER app_changes_fold_baseline_required
			`.execute(scratch.db);
			await scratch.db.transaction().execute(async (tx) => {
				await seedGenesisRoot(tx, delayedApp, "run-delayed");
			});
			await sql`
				ALTER TABLE app_changes
				ENABLE TRIGGER app_changes_fold_baseline_required
			`.execute(scratch.db);
			await expect(
				sql`
					INSERT INTO app_change_fold_baselines
						(app_id, seq, project_id, snapshot, snapshot_digest)
					SELECT
						${delayedApp},
						1,
						'fixture-project',
						nova_current_app_change_fold_snapshot(${delayedApp}),
						nova_app_change_fold_snapshot_digest(
							nova_current_app_change_fold_snapshot(${delayedApp})
						)
				`.execute(scratch.db),
			).rejects.toThrow(/exact horizon or genesis marker/);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("derives the complete persisted snapshot and database-owned digest", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await runFrozenCaseStoreMigrations(scratch.db);
			const appId = "baseline-full-shape";
			const moduleUuid = "11111111-1111-4111-8111-111111111111";
			const emptyModuleUuid = "11111111-1111-4111-8111-111111111112";
			const formUuid = "22222222-2222-4222-8222-222222222221";
			const emptyFormUuid = "22222222-2222-4222-8222-222222222222";
			const groupUuid = "33333333-3333-4333-8333-333333333331";
			const repeatUuid = "33333333-3333-4333-8333-333333333332";
			const childUuid = "33333333-3333-4333-8333-333333333333";
			const userPropertyUuid = "44444444-4444-4444-8444-444444444441";
			const userTypeUuid = "55555555-5555-4555-8555-555555555551";
			const personaUuid = "66666666-6666-4666-8666-666666666661";
			const logoUuid = "77777777-7777-4777-8777-777777777771";
			const entities = [
				{
					uuid: moduleUuid,
					kind: "module",
					parentUuid: null,
					ordinal: 0,
					data: { uuid: moduleUuid, id: "main", name: "Main" },
				},
				{
					uuid: emptyModuleUuid,
					kind: "module",
					parentUuid: null,
					ordinal: 1,
					data: {
						uuid: emptyModuleUuid,
						id: "empty",
						name: "Empty",
					},
				},
				{
					uuid: formUuid,
					kind: "form",
					parentUuid: moduleUuid,
					ordinal: 0,
					data: {
						uuid: formUuid,
						id: "full",
						name: "Full",
						type: "survey",
					},
				},
				{
					uuid: emptyFormUuid,
					kind: "form",
					parentUuid: moduleUuid,
					ordinal: 1,
					data: {
						uuid: emptyFormUuid,
						id: "empty-form",
						name: "Empty form",
						type: "survey",
					},
				},
				{
					uuid: groupUuid,
					kind: "field",
					parentUuid: formUuid,
					ordinal: 0,
					data: {
						uuid: groupUuid,
						id: "group",
						kind: "group",
						label: proseText("Group"),
						config: { z: 1.25, a: 1e30 },
					},
				},
				{
					uuid: repeatUuid,
					kind: "field",
					parentUuid: formUuid,
					ordinal: 1,
					data: {
						uuid: repeatUuid,
						id: "repeat",
						kind: "repeat",
						label: proseText("Repeat"),
					},
				},
				{
					uuid: childUuid,
					kind: "field",
					parentUuid: groupUuid,
					ordinal: 0,
					data: {
						uuid: childUuid,
						id: "child",
						kind: "text",
						label: proseText("Child"),
					},
				},
				{
					uuid: userPropertyUuid,
					kind: "user_property",
					parentUuid: null,
					ordinal: 0,
					data: {
						uuid: userPropertyUuid,
						id: "region",
						name: "Region",
						dataType: "text",
					},
				},
				{
					uuid: userTypeUuid,
					kind: "user_type",
					parentUuid: null,
					ordinal: 0,
					data: {
						uuid: userTypeUuid,
						id: "worker",
						name: "Worker",
					},
				},
				{
					uuid: personaUuid,
					kind: "persona",
					parentUuid: null,
					ordinal: 0,
					data: {
						uuid: personaUuid,
						id: "nurse",
						name: "Nurse",
					},
				},
			] as const;
			await scratch.db.transaction().execute(async (tx) => {
				await seedGenesisRoot(tx, appId, "run-full-shape");
				await sql`
					UPDATE apps
					SET logo = ${logoUuid}::uuid
					WHERE id = ${appId}
				`.execute(tx);
				await sql`
					INSERT INTO blueprint_entities
						(app_id, uuid, kind, parent_uuid, ordinal, data)
					SELECT
						${appId},
						value.uuid::uuid,
						value.kind,
						value.parent_uuid::uuid,
						value.ordinal,
						value.data
					FROM jsonb_to_recordset(${JSON.stringify(
						entities.map((entity) => ({
							uuid: entity.uuid,
							kind: entity.kind,
							parent_uuid: entity.parentUuid,
							ordinal: entity.ordinal,
							data: entity.data,
						})),
					)}::jsonb)
						AS value(
							uuid text,
							kind text,
							parent_uuid text,
							ordinal integer,
							data jsonb
						)
				`.execute(tx);
				await sql`
					SELECT nova_insert_app_change_genesis_fold_baseline(${appId})
				`.execute(tx);
			});
			const baseline = await sql<{
				snapshot: Record<string, unknown>;
				snapshot_text: string;
				digest_matches: boolean;
			}>`
				SELECT
					snapshot,
					snapshot::text AS snapshot_text,
					snapshot_digest =
						encode(
							sha256(convert_to(snapshot::text, 'UTF8')),
							'hex'
						) AS digest_matches
				FROM app_change_fold_baselines
				WHERE app_id = ${appId}
			`.execute(scratch.db);
			expect(baseline.rows[0]?.digest_matches).toBe(true);
			expect(baseline.rows[0]?.snapshot).toEqual({
				appId,
				appName: appId,
				connectType: null,
				caseTypes: null,
				logo: logoUuid,
				modules: {
					[moduleUuid]: {
						uuid: moduleUuid,
						id: "main",
						name: "Main",
					},
					[emptyModuleUuid]: {
						uuid: emptyModuleUuid,
						id: "empty",
						name: "Empty",
					},
				},
				forms: {
					[formUuid]: {
						uuid: formUuid,
						id: "full",
						name: "Full",
						type: "survey",
					},
					[emptyFormUuid]: {
						uuid: emptyFormUuid,
						id: "empty-form",
						name: "Empty form",
						type: "survey",
					},
				},
				fields: {
					[groupUuid]: {
						uuid: groupUuid,
						id: "group",
						kind: "group",
						label: proseText("Group"),
						config: { z: 1.25, a: 1e30 },
					},
					[repeatUuid]: {
						uuid: repeatUuid,
						id: "repeat",
						kind: "repeat",
						label: proseText("Repeat"),
					},
					[childUuid]: {
						uuid: childUuid,
						id: "child",
						kind: "text",
						label: proseText("Child"),
					},
				},
				moduleOrder: [moduleUuid, emptyModuleUuid],
				formOrder: {
					[moduleUuid]: [formUuid, emptyFormUuid],
					[emptyModuleUuid]: [],
				},
				fieldOrder: {
					[formUuid]: [groupUuid, repeatUuid],
					[emptyFormUuid]: [],
					[groupUuid]: [childUuid],
					[repeatUuid]: [],
				},
				userProperties: {
					[userPropertyUuid]: {
						uuid: userPropertyUuid,
						id: "region",
						name: "Region",
						dataType: "text",
					},
				},
				userPropertyOrder: [userPropertyUuid],
				userTypes: {
					[userTypeUuid]: {
						uuid: userTypeUuid,
						id: "worker",
						name: "Worker",
					},
				},
				userTypeOrder: [userTypeUuid],
				personas: {
					[personaUuid]: {
						uuid: personaUuid,
						id: "nurse",
						name: "Nurse",
					},
				},
				personaOrder: [personaUuid],
			});
			expect(baseline.rows[0]?.snapshot_text).toContain(
				'"config": {"a": 1000000000000000000000000000000, "z": 1.25}',
			);

			const noLogoApp = "baseline-no-logo";
			await scratch.db.transaction().execute(async (tx) => {
				await seedGenesisRoot(tx, noLogoApp, "run-no-logo");
				await sql`
					SELECT nova_insert_app_change_genesis_fold_baseline(${noLogoApp})
				`.execute(tx);
			});
			const noLogo = await sql<{ snapshot: Record<string, unknown> }>`
				SELECT snapshot
				FROM app_change_fold_baselines
				WHERE app_id = ${noLogoApp}
			`.execute(scratch.db);
			expect(noLogo.rows[0]?.snapshot).not.toHaveProperty("logo");
			expect(noLogo.rows[0]?.snapshot).toEqual({
				appId: noLogoApp,
				appName: noLogoApp,
				connectType: null,
				caseTypes: null,
				modules: {},
				forms: {},
				fields: {},
				moduleOrder: [],
				formOrder: {},
				fieldOrder: {},
			});
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("rejects a mixed per-app applied state and a malformed horizon marker", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await seedLegacyApp(scratch.db, SECOND_FIXTURE);
			await runFrozenCaseStoreMigrations(scratch.db);
			const secondBaseline = await sql<{
				seq: string;
				project_id: string;
				snapshot: Record<string, unknown>;
				snapshot_digest: string;
			}>`
				SELECT seq::text, project_id, snapshot, snapshot_digest
				FROM app_change_fold_baselines
				WHERE app_id = ${SECOND_APP_ID}
			`.execute(scratch.db);
			const saved = secondBaseline.rows[0];
			if (saved === undefined) throw new Error("second baseline disappeared");

			await sql`
				ALTER TABLE app_change_fold_baselines
					DISABLE TRIGGER app_change_fold_baselines_immutable
			`.execute(scratch.db);
			await sql`
				DELETE FROM app_change_fold_baselines
				WHERE app_id = ${SECOND_APP_ID}
			`.execute(scratch.db);
			await sql`
				ALTER TABLE app_change_fold_baselines
					ENABLE TRIGGER app_change_fold_baselines_immutable
			`.execute(scratch.db);
			await expect(
				scratch.db
					.transaction()
					.execute((tx) => runFrozenCanonicalIdentityMigration(tx)),
			).rejects.toThrow(/cutover is in a mixed or drifted state/);

			await sql`
				ALTER TABLE app_change_fold_baselines
					DISABLE TRIGGER app_change_fold_baselines_admit_insert;
				ALTER TABLE app_changes
					DISABLE TRIGGER app_changes_fold_baseline_required
			`.execute(scratch.db);
			await sql`
				INSERT INTO app_change_fold_baselines
					(app_id, seq, project_id, snapshot, snapshot_digest)
				VALUES (
					${SECOND_APP_ID},
					${saved.seq}::bigint,
					${saved.project_id},
					${JSON.stringify(saved.snapshot)}::jsonb,
					${saved.snapshot_digest}
				)
			`.execute(scratch.db);
			await sql`
				UPDATE app_changes
				SET actor_id = 'wrong-actor'
				WHERE app_id = ${SECOND_APP_ID}
				  AND batch_id = 'fold-baseline:canonical-identity-foundation'
			`.execute(scratch.db);
			await sql`
				ALTER TABLE app_change_fold_baselines
					ENABLE TRIGGER app_change_fold_baselines_admit_insert;
				ALTER TABLE app_changes
					ENABLE TRIGGER app_changes_fold_baseline_required
			`.execute(scratch.db);
			await expect(
				scratch.db
					.transaction()
					.execute((tx) => runFrozenCanonicalIdentityMigration(tx)),
			).rejects.toThrow(/has a malformed marker/);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("direct applied-state audit strictly replays the app-change suffix", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await runFrozenCaseStoreMigrations(scratch.db);
			await sql`
				INSERT INTO app_changes
					(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
				VALUES
					(
						${APP_ID},
						3,
						'fixture:after-horizon',
						NULL,
						'fixture-user',
						'autosave',
						'[{"kind":"setAppName","name":"Renamed fixture"}]'::jsonb
					)
			`.execute(scratch.db);
			await sql`
				UPDATE apps
				SET app_name = 'Renamed fixture',
				    app_name_lower = 'renamed fixture',
				    mutation_seq = 3
				WHERE id = ${APP_ID}
			`.execute(scratch.db);

			const applied = await scratch.db
				.transaction()
				.execute((tx) => runFrozenCanonicalIdentityMigration(tx));
			expect(applied.alreadyApplied).toBe(true);

			await sql`
				UPDATE app_changes
				SET mutations = '[{"kind":"setAppName","name":"Wrong replay"}]'::jsonb
				WHERE app_id = ${APP_ID} AND seq = 3
			`.execute(scratch.db);
			await expect(
				scratch.db
					.transaction()
					.execute((tx) => runFrozenCanonicalIdentityMigration(tx)),
			).rejects.toThrow(
				/app-change suffix replay does not equal current state/,
			);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);
});
