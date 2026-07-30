import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import { replayCanonicalMutationSuffix } from "@/lib/db/canonicalMutationFold";
import { proseText } from "@/lib/domain/prose";
import {
	type FrozenMigrationFailureStage,
	runFrozenCanonicalIdentityMigration,
} from "../20260728000000_canonical_identity_foundation/frozenDatabaseMigration";
import {
	captureFrozenStorageSnapshot,
	dispatchFrozenStorageOccurrences,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
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
	await adminPool.query(`DROP DATABASE "${scratch.name}"`);
}

async function seedLegacyApp(
	db: Kysely<unknown>,
	fixture: LegacyFixture = PRIMARY_FIXTURE,
	optionUuid: string = `${fixture.fieldUuid}-opt-0`,
): Promise<void> {
	const { appId, moduleUuid, formUuid, fieldUuid } = fixture;
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
	await sql`
		INSERT INTO presence
			(app_id, user_id, session_id, name, email, color, location, expire_at)
		VALUES
			(${appId}, 'fixture-user', ${`fixture-session-${appId}`}, 'Fixture', '',
			 '#000000',
			 ${JSON.stringify({
					kind: "module",
					moduleUuid,
				})}::jsonb,
			 now() + interval '1 hour')
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
			const baselines = await sql<{
				app_id: string;
				seq: string;
				snapshot: Record<string, unknown>;
				snapshot_digest: string;
			}>`
				SELECT app_id, seq::text, snapshot, snapshot_digest
				FROM mutation_fold_baselines
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
				sql`UPDATE mutation_fold_baselines SET snapshot = snapshot`.execute(
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
			await runCaseStoreMigrations(scratch.db);
			const direct = await scratch.db
				.transaction()
				.execute((tx) => runFrozenCanonicalIdentityMigration(tx));
			expect(direct.alreadyApplied).toBe(true);
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
						WHERE batch_id = 'migration:canonical-identity-foundation'
					) AS horizons,
					(SELECT count(*)::text FROM chat_stream_chunks) AS chunks,
					(SELECT count(*)::text FROM presence) AS presence,
					pg_catalog.to_regclass(
						'public.mutation_fold_baselines'
					)::text AS baseline_table
			`.execute(scratch.db);
			expect(after.rows[0]).toEqual({
				...before.rows[0],
				identity_type: "text",
				migration_rows: "0",
				horizons: "0",
				chunks: "2",
				presence: "2",
				baseline_table: null,
			});
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test.each<FrozenMigrationFailureStage>(["carriers", "horizon", "ddl"])(
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
			await runCaseStoreMigrations(scratch.db);
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

	test("rejects a mixed per-app applied state and a malformed horizon marker", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await seedLegacyApp(scratch.db, SECOND_FIXTURE);
			await runCaseStoreMigrations(scratch.db);

			await sql`
				DROP TRIGGER mutation_fold_baselines_immutable
				ON mutation_fold_baselines
			`.execute(scratch.db);
			await sql`
				DELETE FROM mutation_fold_baselines
				WHERE app_id = ${SECOND_APP_ID}
			`.execute(scratch.db);
			await expect(
				scratch.db
					.transaction()
					.execute((tx) => runFrozenCanonicalIdentityMigration(tx)),
			).rejects.toThrow(/exact one-baseline-per-app applied state is absent/);

			await sql`
				INSERT INTO mutation_fold_baselines
					(app_id, seq, snapshot, snapshot_digest)
				SELECT
					${SECOND_APP_ID},
					seq,
					(
						SELECT snapshot
						FROM mutation_fold_baselines
						WHERE app_id = ${APP_ID}
					),
					(
						SELECT snapshot_digest
						FROM mutation_fold_baselines
						WHERE app_id = ${APP_ID}
					)
				FROM accepted_mutations
				WHERE app_id = ${SECOND_APP_ID}
				  AND batch_id = 'migration:canonical-identity-foundation'
			`.execute(scratch.db);
			await sql`
				UPDATE accepted_mutations
				SET actor_id = 'wrong-actor'
				WHERE app_id = ${SECOND_APP_ID}
				  AND batch_id = 'migration:canonical-identity-foundation'
			`.execute(scratch.db);
			await expect(
				scratch.db
					.transaction()
					.execute((tx) => runFrozenCanonicalIdentityMigration(tx)),
			).rejects.toThrow(/malformed fold marker/);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);

	test("direct applied-state audit strictly replays the post-baseline suffix", async () => {
		let scratch: ScratchDatabase | undefined;
		try {
			scratch = await createScratchDatabase();
			await seedLegacyApp(scratch.db);
			await runCaseStoreMigrations(scratch.db);
			await sql`
				INSERT INTO accepted_mutations
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

			const applied = await scratch.db.transaction().execute((tx) =>
				runFrozenCanonicalIdentityMigration(tx, {
					replayAppliedSuffix: replayCanonicalMutationSuffix,
				}),
			);
			expect(applied.alreadyApplied).toBe(true);

			await sql`
				UPDATE accepted_mutations
				SET mutations = '[{"kind":"setAppName","name":"Wrong replay"}]'::jsonb
				WHERE app_id = ${APP_ID} AND seq = 3
			`.execute(scratch.db);
			await expect(
				scratch.db.transaction().execute((tx) =>
					runFrozenCanonicalIdentityMigration(tx, {
						replayAppliedSuffix: replayCanonicalMutationSuffix,
					}),
				),
			).rejects.toThrow(/post-baseline replay does not equal current state/);
		} finally {
			await destroyScratchDatabase(scratch);
		}
	}, 120_000);
});
