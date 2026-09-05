import { randomUUID } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import {
	APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY,
	APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY_DEFINITION,
	APP_CHANGES_FROM_PROJECT_FOREIGN_KEY,
	APP_CHANGES_FROM_PROJECT_FOREIGN_KEY_DEFINITION,
	APP_CHANGES_TO_PROJECT_FOREIGN_KEY,
	APP_CHANGES_TO_PROJECT_FOREIGN_KEY_DEFINITION,
	APPS_PROJECT_FOREIGN_KEY,
	APPS_PROJECT_FOREIGN_KEY_DEFINITION,
	down,
	up as installAppsProjectTenancy,
} from "@/lib/auth/migrations/20260728010000_apps_project_tenancy";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";

// All cases vary the exact cutover's input, not the preceding migration history.
// Build that history once, then retain real DDL/commit isolation for each case.
const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "apps_project_tenancy_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db, pool) => {
		await runCaseStoreMigrations(db);
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
		await runAuthAppMigrations(db);
	},
});

const AUTH_PROJECT_FOREIGN_KEYS = [
	{
		relation: "app_change_fold_baselines",
		name: APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY,
		definition: APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY_DEFINITION,
	},
	{
		relation: "app_changes",
		name: APP_CHANGES_FROM_PROJECT_FOREIGN_KEY,
		definition: APP_CHANGES_FROM_PROJECT_FOREIGN_KEY_DEFINITION,
	},
	{
		relation: "app_changes",
		name: APP_CHANGES_TO_PROJECT_FOREIGN_KEY,
		definition: APP_CHANGES_TO_PROJECT_FOREIGN_KEY_DEFINITION,
	},
	{
		relation: "apps",
		name: APPS_PROJECT_FOREIGN_KEY,
		definition: APPS_PROJECT_FOREIGN_KEY_DEFINITION,
	},
] as const;
const APPS_PROJECT_FOREIGN_KEY_SPEC = AUTH_PROJECT_FOREIGN_KEYS[3];

async function dropProjectForeignKey(
	foreignKey: (typeof AUTH_PROJECT_FOREIGN_KEYS)[number],
): Promise<void> {
	await sql`
		ALTER TABLE public.${sql.id(foreignKey.relation)}
		DROP CONSTRAINT ${sql.id(foreignKey.name)}
	`.execute(dbHandle.db);
}

async function dropAllProjectForeignKeys(): Promise<void> {
	for (const foreignKey of AUTH_PROJECT_FOREIGN_KEYS) {
		await dropProjectForeignKey(foreignKey);
	}
}

interface ConstraintDefinition {
	readonly oid: string;
	readonly name: string;
	readonly relation: string;
	readonly definition: string;
	readonly validated: boolean;
	readonly deferrable: boolean;
	readonly initially_deferred: boolean;
	readonly update_action: string;
	readonly delete_action: string;
}

async function constraintDefinitions(): Promise<
	readonly ConstraintDefinition[]
> {
	const result = await sql<ConstraintDefinition>`
		SELECT
			constraint_row.oid::text AS oid,
			constraint_row.conname AS name,
			relation.relname AS relation,
			pg_get_constraintdef(constraint_row.oid, true) AS definition,
			constraint_row.convalidated AS validated,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.confupdtype::text AS update_action,
			constraint_row.confdeltype::text AS delete_action
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		  AND constraint_row.conname IN (
				${sql.join(AUTH_PROJECT_FOREIGN_KEYS.map((entry) => entry.name))}
			)
		ORDER BY convert_to(constraint_row.conname, 'UTF8')
	`.execute(dbHandle.db);
	return result.rows;
}

describe("Project-reference auth-app exact cutover", () => {
	it("installs all four exact validated final FKs from the exact pristine state", async () => {
		await dropAllProjectForeignKeys();

		await installAppsProjectTenancy(dbHandle.db);

		expect(
			(await constraintDefinitions()).map(({ oid: _oid, ...row }) => row),
		).toEqual(
			AUTH_PROJECT_FOREIGN_KEYS.map((foreignKey) => ({
				name: foreignKey.name,
				relation: foreignKey.relation,
				definition: foreignKey.definition,
				validated: true,
				deferrable: false,
				initially_deferred: false,
				update_action: "r",
				delete_action: "r",
			})),
		);
	});

	it("audits an exact applied rerun without replacing any constraint", async () => {
		const before = await constraintDefinitions();

		await installAppsProjectTenancy(dbHandle.db);

		expect(await constraintDefinitions()).toEqual(before);
	});

	it("rejects a three-of-four subset without replacing or adding constraints", async () => {
		await dropProjectForeignKey(AUTH_PROJECT_FOREIGN_KEYS[1]);
		const before = await constraintDefinitions();

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);

		expect(await constraintDefinitions()).toEqual(before);
	});

	it("accepts the exact already-converged production ownership and ACL profile", async () => {
		const identity = await sql<{ current_user: string }>`
			SELECT current_user
		`.execute(dbHandle.db);
		const migrationRole = identity.rows[0]?.current_user;
		if (migrationRole === undefined)
			throw new Error("Expected database identity.");
		const roleEnv = {
			NOVA_MIGRATION_DB_USER: migrationRole,
			NOVA_RUNTIME_DB_USER: "pg_monitor",
			NOVA_CAPTURE_CLEANUP_DB_USER: "pg_signal_backend",
			NOVA_AUDIT_DB_USER: "pg_read_all_settings",
		} as const;
		const previous = Object.fromEntries(
			Object.keys(roleEnv).map((key) => [key, process.env[key]]),
		);
		Object.assign(process.env, roleEnv);
		await sql`
			GRANT SELECT, INSERT, UPDATE, DELETE
			ON TABLE public.apps, public.auth_organization
			TO pg_monitor
		`.execute(dbHandle.db);
		await sql`
			GRANT SELECT, INSERT
			ON TABLE public.app_changes
			TO pg_monitor
		`.execute(dbHandle.db);
		await sql`
			GRANT SELECT
			ON TABLE public.app_change_fold_baselines
			TO pg_monitor
		`.execute(dbHandle.db);
		await sql`
			GRANT SELECT
			ON TABLE
				public.app_change_fold_baselines,
				public.app_changes,
				public.apps,
				public.auth_organization
			TO pg_read_all_settings
		`.execute(dbHandle.db);

		try {
			const before = await constraintDefinitions();
			await installAppsProjectTenancy(dbHandle.db);
			expect(await constraintDefinitions()).toEqual(before);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	});

	it("rejects null, missing, and deleted Projects after installation", async () => {
		await expect(
			sql`
				INSERT INTO public.apps
					(id, owner, project_id, app_name, app_name_lower)
				VALUES
					('app-null', 'owner-a', NULL, 'Null Project', 'null project')
			`.execute(dbHandle.db),
		).rejects.toMatchObject({ code: "23502" });
		await sql`
			INSERT INTO public.auth_organization
				(id, name, slug, "createdAt")
			VALUES
				('project-a', 'Project A', 'project-a', now())
		`.execute(dbHandle.db);
		await sql`
			INSERT INTO public.apps
				(id, owner, project_id, app_name, app_name_lower)
			VALUES
				('app-a', 'owner-a', 'project-a', 'App A', 'app a')
		`.execute(dbHandle.db);

		await expect(
			sql`
				INSERT INTO public.apps
					(id, owner, project_id, app_name, app_name_lower)
				VALUES
					('app-missing', 'owner-a', 'project-missing', 'Missing', 'missing')
			`.execute(dbHandle.db),
		).rejects.toMatchObject({ code: "23503" });
		await sql`
			ALTER TABLE public.app_changes
			DISABLE TRIGGER app_changes_admit_insert
		`.execute(dbHandle.db);
		try {
			await expect(
				sql`
					INSERT INTO public.app_changes (
						app_id,
						seq,
						batch_id,
						actor_id,
						kind,
						mutations,
						from_project_id,
						to_project_id
					)
					VALUES (
						'app-a',
						1,
						'batch-missing-from',
						'owner-a',
						'project-move',
						'[]'::jsonb,
						'project-missing',
						'project-a'
					)
				`.execute(dbHandle.db),
			).rejects.toMatchObject({ code: "23503" });
		} finally {
			await sql`
				ALTER TABLE public.app_changes
				ENABLE TRIGGER app_changes_admit_insert
			`.execute(dbHandle.db);
		}
		await expect(
			sql`
				INSERT INTO public.app_changes (
					app_id,
					seq,
					batch_id,
					actor_id,
					kind,
					mutations,
					from_project_id,
					to_project_id
				)
				VALUES (
					'app-a',
					1,
					'batch-missing-to',
					'owner-a',
					'project-move',
					'[]'::jsonb,
					'project-a',
					'project-missing'
				)
			`.execute(dbHandle.db),
		).rejects.toMatchObject({ code: "23503" });
		await expect(
			sql`
				DELETE FROM public.auth_organization
				WHERE id = 'project-a'
			`.execute(dbHandle.db),
		).rejects.toMatchObject({ code: "23001" });
	});

	it("blocks an orphan app in the pristine state before adding the FK", async () => {
		await dropAllProjectForeignKeys();
		await sql`
			INSERT INTO public.apps
				(id, owner, project_id, app_name, app_name_lower)
			VALUES
				('app-orphan', 'owner-a', 'missing-project', 'Orphan', 'orphan')
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);

		const desired = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM pg_constraint
			WHERE conrelid = 'public.apps'::regclass
			  AND conname = ${APPS_PROJECT_FOREIGN_KEY}
		`.execute(dbHandle.db);
		expect(desired.rows).toEqual([{ count: "0" }]);
	});

	it("blocks orphan Project-move endpoints in the all-four-absent pristine state", async () => {
		await dropAllProjectForeignKeys();
		await sql`
			INSERT INTO public.auth_organization
				(id, name, slug, "createdAt")
			VALUES
				('project-destination', 'Destination', 'destination', now())
		`.execute(dbHandle.db);
		await sql`
			INSERT INTO public.apps
				(id, owner, project_id, app_name, app_name_lower)
			VALUES
				(
					'app-project-move',
					'owner-a',
					'project-destination',
					'Project move',
					'project move'
				)
		`.execute(dbHandle.db);
		await sql`
			ALTER TABLE public.app_changes
			DISABLE TRIGGER app_changes_admit_insert
		`.execute(dbHandle.db);
		await sql`
			ALTER TABLE public.app_changes
			DISABLE TRIGGER app_changes_fold_baseline_required
		`.execute(dbHandle.db);
		await sql`
			ALTER TABLE public.app_changes
			DISABLE TRIGGER app_changes_project_move_final_required
		`.execute(dbHandle.db);
		try {
			await sql`
				INSERT INTO public.app_changes (
					app_id,
					seq,
					batch_id,
					run_id,
					actor_id,
					kind,
					mutations,
					from_project_id,
					to_project_id
				)
				VALUES (
					'app-project-move',
					1,
					'batch-project-move',
					NULL,
					'owner-a',
					'project-move',
					'[]'::jsonb,
					'missing-project',
					'project-destination'
				)
			`.execute(dbHandle.db);
		} finally {
			await sql`
				ALTER TABLE public.app_changes
				ENABLE TRIGGER app_changes_admit_insert
			`.execute(dbHandle.db);
			await sql`
				ALTER TABLE public.app_changes
				ENABLE TRIGGER app_changes_fold_baseline_required
			`.execute(dbHandle.db);
			await sql`
				ALTER TABLE public.app_changes
				ENABLE TRIGGER app_changes_project_move_final_required
			`.execute(dbHandle.db);
		}

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);

		expect(await constraintDefinitions()).toEqual([]);
	});

	it("blocks an orphan fold-baseline Project in the all-four-absent pristine state", async () => {
		const userId = randomUUID();
		const projectId = randomUUID();
		await sql`
			INSERT INTO public.auth_user (
				id, name, email, "emailVerified", "createdAt", "updatedAt"
			)
			VALUES (
				${userId},
				'Fold baseline owner',
				${`${userId}@dimagi.com`},
				true,
				now(),
				now()
			)
		`.execute(dbHandle.db);
		await sql`
			INSERT INTO public.auth_organization
				(id, name, slug, "createdAt")
			VALUES
				(${projectId}, 'Fold baseline Project', ${projectId}, now())
		`.execute(dbHandle.db);
		await sql`
			INSERT INTO public.auth_member
				(id, "userId", "organizationId", role, "createdAt")
			VALUES
				(${randomUUID()}, ${userId}, ${projectId}, 'editor', now())
		`.execute(dbHandle.db);

		__setAppDbForTests(dbHandle.db as Kysely<AppDatabase>);
		let appId: string;
		try {
			const receipt = await createExplicitBlankApp(
				userId,
				projectId,
				randomUUID(),
				{
					status: "complete",
					name: "Fold baseline orphan probe",
				},
			);
			appId = receipt.appId;
		} finally {
			__setAppDbForTests(null);
		}

		await dropAllProjectForeignKeys();
		await sql`
			ALTER TABLE public.app_change_fold_baselines
			DISABLE TRIGGER app_change_fold_baselines_immutable
		`.execute(dbHandle.db);
		try {
			await sql`
				UPDATE public.app_change_fold_baselines
				SET project_id = 'missing-project'
				WHERE app_id = ${appId}
			`.execute(dbHandle.db);
		} finally {
			await sql`
				ALTER TABLE public.app_change_fold_baselines
				ENABLE TRIGGER app_change_fold_baselines_immutable
			`.execute(dbHandle.db);
		}

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);

		expect(await constraintDefinitions()).toEqual([]);
	});

	it("blocks an exact alternate-name FK instead of adopting it or adding a duplicate", async () => {
		await dropProjectForeignKey(APPS_PROJECT_FOREIGN_KEY_SPEC);
		await sql`
			ALTER TABLE public.apps
			ADD CONSTRAINT apps_project_id_auth_organization_alt_fk
			FOREIGN KEY (project_id)
			REFERENCES public.auth_organization (id)
			ON UPDATE RESTRICT
			ON DELETE RESTRICT
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks a desired-name app-change FK with the wrong target key", async () => {
		await dropProjectForeignKey(AUTH_PROJECT_FOREIGN_KEYS[1]);
		await sql`
			ALTER TABLE public.app_changes
			ADD CONSTRAINT ${sql.id(APP_CHANGES_FROM_PROJECT_FOREIGN_KEY)}
			FOREIGN KEY (from_project_id)
			REFERENCES public.apps (id)
			ON UPDATE RESTRICT
			ON DELETE RESTRICT
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks an alternate-name duplicate beside the exact FK", async () => {
		await sql`
			ALTER TABLE public.apps
			ADD CONSTRAINT apps_project_id_auth_organization_duplicate_fk
			FOREIGN KEY (project_id)
			REFERENCES public.auth_organization (id)
			ON UPDATE RESTRICT
			ON DELETE RESTRICT
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks alternate referential actions", async () => {
		await dropProjectForeignKey(APPS_PROJECT_FOREIGN_KEY_SPEC);
		await sql`
			ALTER TABLE public.apps
			ADD CONSTRAINT ${sql.id(APPS_PROJECT_FOREIGN_KEY)}
			FOREIGN KEY (project_id)
			REFERENCES public.auth_organization (id)
			ON UPDATE CASCADE
			ON DELETE CASCADE
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks a NOT VALID desired FK", async () => {
		await dropProjectForeignKey(APPS_PROJECT_FOREIGN_KEY_SPEC);
		await sql`
			ALTER TABLE public.apps
			ADD CONSTRAINT ${sql.id(APPS_PROJECT_FOREIGN_KEY)}
			FOREIGN KEY (project_id)
			REFERENCES public.auth_organization (id)
			ON UPDATE RESTRICT
			ON DELETE RESTRICT
			NOT VALID
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks alternate deferrability", async () => {
		await dropProjectForeignKey(APPS_PROJECT_FOREIGN_KEY_SPEC);
		await sql`
			ALTER TABLE public.apps
			ADD CONSTRAINT ${sql.id(APPS_PROJECT_FOREIGN_KEY)}
			FOREIGN KEY (project_id)
			REFERENCES public.auth_organization (id)
			ON UPDATE RESTRICT
			ON DELETE RESTRICT
			DEFERRABLE INITIALLY DEFERRED
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks a wrong apps.project_id default", async () => {
		await sql`
			ALTER TABLE public.apps
			ALTER COLUMN project_id SET DEFAULT 'unexpected-project'
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks a wrong app_changes Project-column type", async () => {
		await dropAllProjectForeignKeys();
		await sql`
			ALTER TABLE public.app_changes
			ALTER COLUMN from_project_id TYPE varchar(255)
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);

		expect(await constraintDefinitions()).toEqual([]);
	});

	it("blocks wrong fold-baseline Project nullability", async () => {
		await dropAllProjectForeignKeys();
		await sql`
			ALTER TABLE public.app_change_fold_baselines
			ALTER COLUMN project_id DROP NOT NULL
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);

		expect(await constraintDefinitions()).toEqual([]);
	});

	it("blocks a wrong project-scoped index definition", async () => {
		await sql`DROP INDEX public.apps_project_live_name`.execute(dbHandle.db);
		await sql`
			CREATE INDEX apps_project_live_name
			ON public.apps (project_id, id, app_name_lower)
			WHERE deleted_at IS NULL
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks an extra expression index that depends on apps.project_id", async () => {
		await sql`
			CREATE INDEX apps_project_id_lower_extra
			ON public.apps (lower(project_id))
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks an extra index that depends on app_changes.from_project_id", async () => {
		await sql`
			CREATE INDEX app_changes_from_project_id_extra
			ON public.app_changes (from_project_id)
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks an extra auth Project id index", async () => {
		await sql`
			CREATE INDEX auth_organization_id_extra
			ON public.auth_organization (id)
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("blocks an unexpected relation ACL instead of accepting or healing it", async () => {
		await sql`
			GRANT SELECT ON TABLE public.apps TO pg_monitor
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);

		const retained = await sql<{ granted: boolean }>`
			SELECT has_table_privilege(
				'pg_monitor',
				'public.apps',
				'SELECT'
			) AS granted
		`.execute(dbHandle.db);
		expect(retained.rows).toEqual([{ granted: true }]);
	});

	it("blocks an unexpected fold-baseline ACL instead of accepting or healing it", async () => {
		await sql`
			GRANT INSERT ON TABLE public.app_change_fold_baselines TO pg_monitor
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);

		const retained = await sql<{ granted: boolean }>`
			SELECT has_table_privilege(
				'pg_monitor',
				'public.app_change_fold_baselines',
				'INSERT'
			) AS granted
		`.execute(dbHandle.db);
		expect(retained.rows).toEqual([{ granted: true }]);
	});

	it("blocks wrong relation and backing-index ownership instead of healing it", async () => {
		const wrongOwner = `apps_project_wrong_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
		const current = await sql<{ current_user: string }>`
			SELECT current_user
		`.execute(dbHandle.db);
		const currentUser = current.rows[0]?.current_user;
		if (currentUser === undefined)
			throw new Error("Expected database identity.");
		await sql`CREATE ROLE ${sql.id(wrongOwner)} NOLOGIN`.execute(dbHandle.db);

		try {
			await sql`
				ALTER TABLE public.auth_organization
				OWNER TO ${sql.id(wrongOwner)}
			`.execute(dbHandle.db);

			await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
				/partial or drifted/,
			);

			const retained = await sql<{
				relation_owner: string;
				index_owner: string;
			}>`
				SELECT
					pg_get_userbyid(table_relation.relowner) AS relation_owner,
					pg_get_userbyid(index_relation.relowner) AS index_owner
				FROM pg_class AS table_relation
				JOIN pg_index AS index_row
				  ON index_row.indrelid = table_relation.oid
				 AND index_row.indisprimary
				JOIN pg_class AS index_relation
				  ON index_relation.oid = index_row.indexrelid
				WHERE table_relation.oid =
					'public.auth_organization'::regclass
			`.execute(dbHandle.db);
			expect(retained.rows).toEqual([
				{ relation_owner: wrongOwner, index_owner: wrongOwner },
			]);
		} finally {
			await sql`
				ALTER TABLE public.auth_organization
				OWNER TO ${sql.id(currentUser)}
			`.execute(dbHandle.db);
			await sql`DROP ROLE ${sql.id(wrongOwner)}`.execute(dbHandle.db);
		}
	});

	it("blocks any extra constraint touching apps.project_id", async () => {
		await sql`
			ALTER TABLE public.apps
			ADD CONSTRAINT apps_project_id_duplicate_nonblank_check
			CHECK (btrim(project_id) <> '')
		`.execute(dbHandle.db);

		await expect(installAppsProjectTenancy(dbHandle.db)).rejects.toThrow(
			/partial or drifted/,
		);
	});

	it("is forward-only", async () => {
		await expect(down()).rejects.toThrow(/forward-only/);
	});
});
