import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { runCaseStoreMigrations } from "../../migrate";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { down, up } from "../20260728010000_case_schema_index_convergence";

const database = setupPerTestDatabase({
	databaseNamePrefix: "case_index_convergence_migration_",
});

beforeEach(async () => {
	await runCaseStoreMigrations(database.db);
});

async function recreateExactLegacyCatalog(): Promise<void> {
	await sql`DROP TABLE public.case_schema_index_deletions`.execute(database.db);
	await sql`DROP TABLE public.case_type_schemas`.execute(database.db);
	await sql`
		CREATE TABLE public.case_type_schemas (
			app_id text NOT NULL,
			case_type text NOT NULL,
			schema jsonb NOT NULL,
			synced_seq bigint NOT NULL DEFAULT 0,
			PRIMARY KEY (app_id, case_type)
		)
	`.execute(database.db);
}

async function seedApp(): Promise<void> {
	await sql`
		INSERT INTO public.apps
			(id, owner, project_id, app_name, app_name_lower)
		VALUES
			('migration-app', 'migration-owner', 'migration-project',
			 'Migration', 'migration')
	`.execute(database.db);
}

async function readConvergenceRows(): Promise<
	readonly {
		readonly app_id: string;
		readonly case_type: string;
		readonly synced_seq: string;
		readonly index_pending_seq: string | null;
		readonly index_synced_seq: string;
		readonly row_version: string;
	}[]
> {
	const result = await sql<{
		app_id: string;
		case_type: string;
		synced_seq: string;
		index_pending_seq: string | null;
		index_synced_seq: string;
		row_version: string;
	}>`
		SELECT
			app_id,
			case_type,
			synced_seq::text,
			index_pending_seq::text,
			index_synced_seq::text,
			xmin::text AS row_version
		FROM public.case_type_schemas
		ORDER BY convert_to(app_id, 'UTF8'), convert_to(case_type, 'UTF8')
	`.execute(database.db);
	return result.rows;
}

describe("case-schema index convergence exact cutover", () => {
	it("converts only the exact pristine catalog and marks each row pending at its stored sequence", async () => {
		await recreateExactLegacyCatalog();
		await seedApp();
		await sql`
			INSERT INTO public.case_type_schemas
				(app_id, case_type, schema, synced_seq)
			VALUES
				('migration-app', 'patient',
				 '{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
				 17)
		`.execute(database.db);

		await up(database.db);

		const state = await sql<{
			index_pending_seq: string | null;
			index_synced_seq: string;
			deletion_table: string | null;
		}>`
			SELECT
				index_pending_seq::text,
				index_synced_seq::text,
				to_regclass('public.case_schema_index_deletions')::text
					AS deletion_table
			FROM public.case_type_schemas
			WHERE app_id = 'migration-app' AND case_type = 'patient'
		`.execute(database.db);
		expect(state.rows[0]).toEqual({
			index_pending_seq: "17",
			index_synced_seq: "0",
			deletion_table: "case_schema_index_deletions",
		});
		const ownership = await sql<{
			relation_name: string;
			owner_name: string;
			raw_acl: string;
			index_owner_name: string;
			index_raw_acl: string;
		}>`
			SELECT
				relation.relname AS relation_name,
				relation_owner.rolname AS owner_name,
				COALESCE(to_jsonb(relation.relacl)::text, 'null') AS raw_acl,
				index_owner.rolname AS index_owner_name,
				COALESCE(to_jsonb(index_relation.relacl)::text, 'null')
					AS index_raw_acl
			FROM pg_class AS relation
			JOIN pg_namespace AS namespace
			  ON namespace.oid = relation.relnamespace
			JOIN pg_roles AS relation_owner
			  ON relation_owner.oid = relation.relowner
			JOIN pg_index AS index_row
			  ON index_row.indrelid = relation.oid
			 AND index_row.indisprimary
			JOIN pg_class AS index_relation
			  ON index_relation.oid = index_row.indexrelid
			JOIN pg_roles AS index_owner
			  ON index_owner.oid = index_relation.relowner
			WHERE namespace.nspname = 'public'
			  AND relation.relname IN (
				'case_type_schemas',
				'case_schema_index_deletions'
			  )
			ORDER BY convert_to(relation.relname, 'UTF8')
		`.execute(database.db);
		const currentRole = await sql<{ name: string }>`
			SELECT current_user AS name
		`.execute(database.db);
		const ownerName = currentRole.rows[0]?.name;
		expect(ownerName).toBeDefined();
		expect(ownership.rows).toEqual([
			{
				relation_name: "case_schema_index_deletions",
				owner_name: ownerName,
				raw_acl: "null",
				index_owner_name: ownerName,
				index_raw_acl: "null",
			},
			{
				relation_name: "case_type_schemas",
				owner_name: ownerName,
				raw_acl: "null",
				index_owner_name: ownerName,
				index_raw_acl: "null",
			},
		]);
	});

	it("audits an exact applied rerun without resetting a newer pending sequence or touching rows", async () => {
		// A later migration adds lifecycle columns; remove those later-owned columns so
		// this old migration's frozen exact-final rerun oracle sees its own
		// terminal catalog, as it did when originally shipped.
		await sql`
			ALTER TABLE public.case_type_schemas DROP COLUMN is_active
		`.execute(database.db);
		await sql`
			ALTER TABLE public.case_type_schemas DROP COLUMN retired_seq
		`.execute(database.db);
		await seedApp();
		await sql`
			INSERT INTO public.case_type_schemas (
				app_id,
				case_type,
				schema,
				synced_seq,
				index_pending_seq,
				index_synced_seq
			) VALUES (
				'migration-app',
				'patient',
				'{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
				23,
				23,
				19
			)
		`.execute(database.db);
		await sql`
			INSERT INTO public.case_schema_index_deletions (app_id, case_type)
			VALUES ('other-app', 'retired')
		`.execute(database.db);
		const beforeRows = await readConvergenceRows();
		const beforeDeletion = await sql<{
			app_id: string;
			case_type: string;
			row_version: string;
		}>`
			SELECT app_id, case_type, xmin::text AS row_version
			FROM public.case_schema_index_deletions
		`.execute(database.db);

		await up(database.db);

		expect(await readConvergenceRows()).toEqual(beforeRows);
		const afterDeletion = await sql<{
			app_id: string;
			case_type: string;
			row_version: string;
		}>`
			SELECT app_id, case_type, xmin::text AS row_version
			FROM public.case_schema_index_deletions
		`.execute(database.db);
		expect(afterDeletion.rows).toEqual(beforeDeletion.rows);
	});

	it("copies the exact converged application ACL during the legacy cutover", async () => {
		await recreateExactLegacyCatalog();
		const currentRole = (
			await sql<{ name: string }>`SELECT current_user AS name`.execute(
				database.db,
			)
		).rows[0]?.name;
		expect(currentRole).toBeDefined();
		if (currentRole === undefined) return;

		const roleSuffix = `${process.pid}`;
		const runtimeRole = `case_schema_runtime_${roleSuffix}`;
		const cleanupRole = `case_schema_cleanup_${roleSuffix}`;
		const auditRole = `case_schema_audit_${roleSuffix}`;
		const roleEnv = {
			NOVA_MIGRATION_DB_USER: currentRole,
			NOVA_RUNTIME_DB_USER: runtimeRole,
			NOVA_CAPTURE_CLEANUP_DB_USER: cleanupRole,
			NOVA_AUDIT_DB_USER: auditRole,
		} as const;
		const previousRoleEnv = Object.fromEntries(
			Object.keys(roleEnv).map((key) => [key, process.env[key]]),
		);
		for (const role of [runtimeRole, cleanupRole, auditRole]) {
			await sql`CREATE ROLE ${sql.id(role)}`.execute(database.db);
		}
		try {
			Object.assign(process.env, roleEnv);
			await sql`
				GRANT SELECT, INSERT, UPDATE, DELETE
				ON TABLE public.case_type_schemas
				TO ${sql.id(runtimeRole)}
			`.execute(database.db);
			await sql`
				GRANT SELECT ON TABLE public.case_type_schemas
				TO ${sql.id(auditRole)}
			`.execute(database.db);

			await up(database.db);

			const acl = await sql<{ relation_name: string; raw_acl: string }>`
				SELECT
					relation.relname AS relation_name,
					to_jsonb(relation.relacl)::text AS raw_acl
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace
				  ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname = 'public'
				  AND relation.relname IN (
					'case_type_schemas',
					'case_schema_index_deletions'
				  )
				ORDER BY convert_to(relation.relname, 'UTF8')
			`.execute(database.db);
			expect(acl.rows).toHaveLength(2);
			expect(acl.rows[0]?.raw_acl).toBe(acl.rows[1]?.raw_acl);
		} finally {
			for (const relation of [
				"case_type_schemas",
				"case_schema_index_deletions",
			]) {
				if (
					(
						await sql<{ exists: boolean }>`
							SELECT to_regclass(${`public.${relation}`}) IS NOT NULL AS exists
						`.execute(database.db)
					).rows[0]?.exists
				) {
					await sql`
						REVOKE ALL PRIVILEGES
						ON TABLE public.${sql.id(relation)}
						FROM ${sql.id(runtimeRole)}, ${sql.id(cleanupRole)},
							${sql.id(auditRole)}
					`.execute(database.db);
				}
			}
			for (const [key, value] of Object.entries(previousRoleEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			for (const role of [runtimeRole, cleanupRole, auditRole]) {
				await sql`DROP ROLE ${sql.id(role)}`.execute(database.db);
			}
		}
	});

	it.each([
		{
			name: "partial relation set",
			mutate: async () => {
				await sql`DROP TABLE public.case_schema_index_deletions`.execute(
					database.db,
				);
			},
		},
		{
			name: "wrong pending-sequence type",
			mutate: async () => {
				await sql`
					ALTER TABLE public.case_type_schemas
					ALTER COLUMN index_pending_seq TYPE integer
					USING index_pending_seq::integer
				`.execute(database.db);
			},
		},
		{
			name: "wrong pending-sequence default",
			mutate: async () => {
				await sql`
					ALTER TABLE public.case_type_schemas
					ALTER COLUMN index_pending_seq SET DEFAULT 0
				`.execute(database.db);
			},
		},
		{
			name: "extra index",
			mutate: async () => {
				await sql`
					CREATE INDEX case_type_schemas_synced_seq_extra
					ON public.case_type_schemas (synced_seq)
				`.execute(database.db);
			},
		},
		{
			name: "extra constraint",
			mutate: async () => {
				await sql`
					ALTER TABLE public.case_type_schemas
					ADD CONSTRAINT case_type_schemas_synced_seq_extra
					CHECK (synced_seq >= 0)
				`.execute(database.db);
			},
		},
		{
			name: "alternate duplicate key constraint",
			mutate: async () => {
				await sql`
					ALTER TABLE public.case_schema_index_deletions
					ADD CONSTRAINT case_schema_index_deletions_alt_key
					UNIQUE (app_id, case_type)
				`.execute(database.db);
			},
		},
		{
			name: "case-schema relation ACL drift",
			mutate: async () => {
				await sql`
					GRANT SELECT ON TABLE public.case_type_schemas TO PUBLIC
				`.execute(database.db);
			},
		},
		{
			name: "deletion relation ACL drift",
			mutate: async () => {
				await sql`
					GRANT SELECT
					ON TABLE public.case_schema_index_deletions
					TO PUBLIC
				`.execute(database.db);
			},
		},
	])("blocks $name before any convergence write", async ({ mutate }) => {
		await mutate();
		await expect(up(database.db)).rejects.toThrow(/partial or drifted/);
	});

	it("blocks relation and primary-index ownership drift", async () => {
		const ownerRole = `case_schema_cutover_owner_${process.pid}`;
		await sql`CREATE ROLE ${sql.id(ownerRole)}`.execute(database.db);
		try {
			await sql`
				ALTER TABLE public.case_type_schemas OWNER TO ${sql.id(ownerRole)}
			`.execute(database.db);
			await expect(up(database.db)).rejects.toThrow(/partial or drifted/);
		} finally {
			await sql`
				ALTER TABLE public.case_type_schemas OWNER TO CURRENT_USER
			`.execute(database.db);
			await sql`DROP ROLE ${sql.id(ownerRole)}`.execute(database.db);
		}
	});

	it("blocks a mixed final data state instead of resetting it", async () => {
		await seedApp();
		await sql`
			INSERT INTO public.case_type_schemas (
				app_id,
				case_type,
				schema,
				synced_seq,
				index_pending_seq,
				index_synced_seq
			) VALUES (
				'migration-app',
				'patient',
				'{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
				23,
				22,
				19
			)
		`.execute(database.db);
		const before = await readConvergenceRows();

		await expect(up(database.db)).rejects.toThrow(/partial or drifted/);

		expect(await readConvergenceRows()).toEqual(before);
	});

	it("blocks invalid pristine sequence data before adding any column or table", async () => {
		await recreateExactLegacyCatalog();
		await seedApp();
		await sql`
			INSERT INTO public.case_type_schemas
				(app_id, case_type, schema, synced_seq)
			VALUES
				('migration-app', 'patient',
				 '{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
				 -1)
		`.execute(database.db);

		await expect(up(database.db)).rejects.toThrow(/partial or drifted/);

		const catalog = await sql<{
			pending_column: boolean;
			deletion_table: string | null;
		}>`
			SELECT
				EXISTS (
					SELECT 1
					FROM pg_attribute
					WHERE attrelid = 'public.case_type_schemas'::regclass
					  AND attname = 'index_pending_seq'
					  AND NOT attisdropped
				) AS pending_column,
				to_regclass('public.case_schema_index_deletions')::text
					AS deletion_table
		`.execute(database.db);
		expect(catalog.rows).toEqual([
			{ pending_column: false, deletion_table: null },
		]);
	});

	it("blocks legacy relation ACL drift before adding any final object", async () => {
		await recreateExactLegacyCatalog();
		await sql`
			GRANT SELECT ON TABLE public.case_type_schemas TO PUBLIC
		`.execute(database.db);

		await expect(up(database.db)).rejects.toThrow(/partial or drifted/);

		const catalog = await sql<{
			pending_column: boolean;
			deletion_table: string | null;
		}>`
			SELECT
				EXISTS (
					SELECT 1
					FROM pg_attribute
					WHERE attrelid = 'public.case_type_schemas'::regclass
					  AND attname = 'index_pending_seq'
					  AND NOT attisdropped
				) AS pending_column,
				to_regclass('public.case_schema_index_deletions')::text
					AS deletion_table
		`.execute(database.db);
		expect(catalog.rows).toEqual([
			{ pending_column: false, deletion_table: null },
		]);
	});

	it("is forward-only", async () => {
		await expect(down()).rejects.toThrow(/forward-only/);
	});
});
