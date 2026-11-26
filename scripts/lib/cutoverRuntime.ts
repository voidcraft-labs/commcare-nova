import { type Kysely, sql } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

/** Checks only; this command cannot disable service access or terminate work.
 * NOLOGIN plus zero sessions makes the operator's drained runtime a durable
 * fence while the migration runs. Count by role even when PostgreSQL hides the
 * backend type from a migration user outside that role. */
export async function assertCutoverRuntimeStopped(
	db: Kysely<AppDatabase>,
	writerRole: string,
) {
	const result = await sql<{ can_login: boolean; sessions: number }>`
		SELECT role.rolcanlogin AS can_login,
			(SELECT count(*)::int FROM pg_stat_activity WHERE usename = role.rolname) AS sessions
		FROM pg_roles role WHERE role.rolname = ${writerRole}
	`.execute(db);
	const row = result.rows[0];
	if (!row || row.can_login || row.sessions !== 0) {
		throw new Error(
			`The direct cutover requires ${writerRole} to be NOLOGIN with no remaining sessions. Drain its writers before execution.`,
		);
	}
}
