import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import { convertThreadStorage } from "@/lib/case-store/migrations/20261112000000_incremental_transcripts";
import type { AppDatabase } from "@/lib/db/pg";
import { readDatabasePrivilegeRoleConfig } from "@/lib/db/privilegeConvergence";
import { scanThreadStorage } from "@/lib/db/threadStorageScan";

const MIGRATION = "20261112000000_incremental_transcripts";

/** Checks only; this command cannot disable service access or terminate work.
 * NOLOGIN plus zero sessions makes the operator's drained runtime a durable
 * fence while the migration runs. Local scratch databases need no IAM role. */
export async function assertThreadCutoverRuntimeStopped(
	db: Kysely<AppDatabase>,
	runtimeRole: string,
) {
	const result = await sql<{ can_login: boolean; sessions: number }>`
		SELECT role.rolcanlogin AS can_login,
			(SELECT count(*)::int FROM pg_stat_activity WHERE usename = role.rolname AND backend_type = 'client backend') AS sessions
		FROM pg_roles role WHERE role.rolname = ${runtimeRole}
	`.execute(db);
	const row = result.rows[0];
	if (!row || row.can_login || row.sessions !== 0) {
		throw new Error(
			"The direct transcript cutover requires the runtime database role to be NOLOGIN with no remaining sessions. Drain the service before execution.",
		);
	}
}

export async function migrateThreadStorage(
	db: Kysely<AppDatabase>,
	expectedDigest: string,
) {
	if (!/^[0-9a-f]{64}$/.test(expectedDigest))
		throw new Error("An exact transcript scan digest is required.");
	const roles = readDatabasePrivilegeRoleConfig();
	if (roles) await assertThreadCutoverRuntimeStopped(db, roles.runtimeRole);
	const migrator = new Migrator({
		db,
		provider: {
			getMigrations: async () => ({
				...caseStoreMigrations,
				[MIGRATION]: {
					up: async (transaction: Kysely<unknown>) => {
						if (roles)
							await assertThreadCutoverRuntimeStopped(
								transaction as Kysely<AppDatabase>,
								roles.runtimeRole,
							);
						await convertThreadStorage(transaction, expectedDigest);
					},
				},
			}),
		},
	});
	const applied = (await migrator.getMigrations()).some(
		(migration) =>
			migration.name === MIGRATION && migration.executedAt !== undefined,
	);
	const result = applied ? undefined : await migrator.migrateTo(MIGRATION);
	if (result?.error) throw result.error;
	const verified = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.execute(scanThreadStorage);
	if (
		verified.format !== "message-parts" ||
		verified.transcriptDigest !== expectedDigest ||
		verified.invalidThreads > 0 ||
		verified.invalidStoredRows > 0
	) {
		throw new Error(
			"The durable transcript differs from the reviewed scan. Keep maintenance active and inspect the cutover result.",
		);
	}
	return {
		applied:
			result?.results?.some(
				(item) => item.migrationName === MIGRATION && item.status === "Success",
			) ?? false,
		...verified,
	};
}
