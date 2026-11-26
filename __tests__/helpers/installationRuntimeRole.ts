import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, type PostgresPool, sql } from "kysely";
import { Pool } from "pg";
import { CASE_RUNTIME_SCHEMA } from "@/lib/case-store/postgres/connection";
import type { AppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";
import {
	PUBLIC_TABLE_POLICIES,
	RUNTIME_TABLES_WITHOUT_DELETE,
	RUNTIME_TABLES_WITHOUT_INSERT,
	RUNTIME_TABLES_WITHOUT_UPDATE,
} from "@/lib/db/privilegeConvergence";

/** Exercise publishing through real restricted PostgreSQL connections.
 * The fixture owner keeps its separate connection for synthetic HQ actions. */
export async function withInstallationRuntimeRole<T>(
	fixture: AppStateTestDb,
	run: () => Promise<T>,
): Promise<T> {
	const owner = fixture.db(),
		role = `installation_runtime_${randomUUID().replaceAll("-", "")}`;
	await sql`CREATE ROLE ${sql.id(role)} NOLOGIN`.execute(owner);
	const runtime = new Kysely<AppDatabase>({
		dialect: new PostgresDialect({
			pool: new Pool({
				connectionString: fixture.uri(),
				options: `-c role=${role} -c search_path=public,${CASE_RUNTIME_SCHEMA}`,
				max: 4,
			}) as unknown as PostgresPool,
		}),
	});
	try {
		const existing = new Set(
			(
				await sql<{
					name: string;
				}>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`.execute(
					owner,
				)
			).rows.map((t) => t.name),
		);
		const accessible = PUBLIC_TABLE_POLICIES.filter(
			(t) => existing.has(t.name) && t.runtimeCapability !== "none",
		).map((t) => t.name);
		await owner.transaction().execute(async (tx) => {
			await sql`GRANT USAGE ON SCHEMA public TO ${sql.id(role)}`.execute(tx);
			for (const [verb, excluded] of [
				["SELECT", []],
				["INSERT", RUNTIME_TABLES_WITHOUT_INSERT],
				["DELETE", RUNTIME_TABLES_WITHOUT_DELETE],
				["UPDATE", RUNTIME_TABLES_WITHOUT_UPDATE],
			] as const) {
				const restricted = new Set<string>(excluded),
					tables = accessible.filter((name) => !restricted.has(name));
				if (tables.length)
					await sql`GRANT ${sql.raw(verb)} ON TABLE ${sql.join(tables.map((t) => sql.id("public", t)))} TO ${sql.id(role)}`.execute(
						tx,
					);
			}
			const sequences = await sql<{
				name: string;
				parent: string;
			}>`SELECT s.relname AS name,t.relname AS parent FROM pg_depend d JOIN pg_class s ON s.oid=d.objid AND s.relkind='S' JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND d.deptype IN ('a','i')`.execute(
				tx,
			);
			const insertable = new Set(
				accessible.filter((t) => !RUNTIME_TABLES_WITHOUT_INSERT.includes(t)),
			);
			for (const s of sequences.rows)
				if (insertable.has(s.parent))
					await sql`GRANT USAGE,SELECT ON SEQUENCE ${sql.id("public", s.name)} TO ${sql.id(role)}`.execute(
						tx,
					);
		});
		const permissions = (
			await sql<{
				role: string;
				can_update: boolean;
				can_replace: boolean;
			}>`SELECT current_user AS role,has_table_privilege('app_deployment_installation_reviews','UPDATE') AS can_update,
    has_table_privilege('app_deployment_installation_reviews','DELETE') AND has_table_privilege('app_deployment_installation_reviews','INSERT') AS can_replace`.execute(
				runtime,
			)
		).rows[0];
		if (
			permissions.role !== role ||
			permissions.can_update ||
			!permissions.can_replace
		)
			throw new Error(
				"The publishing role must replace installation checkpoints under its serving grants.",
			);
		__setAppDbForTests(runtime);
		return await run();
	} finally {
		__setAppDbForTests(owner);
		await runtime.destroy();
		await sql`DROP OWNED BY ${sql.id(role)}`.execute(owner);
		await sql`DROP ROLE ${sql.id(role)}`.execute(owner);
	}
}
