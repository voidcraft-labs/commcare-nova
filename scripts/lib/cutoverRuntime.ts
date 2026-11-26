import { type Kysely, sql } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

/** Checks only; this command cannot disable service access or terminate work.
 * NOLOGIN plus zero sessions makes the operator's drained runtime a durable
 * fence while the migration runs. Local scratch databases need no IAM role. */
export async function assertCutoverRuntimeStopped(
	db: Kysely<AppDatabase>,
	writerRole: string,
) {
	const result = await sql<{ can_login: boolean; sessions: number }>`
		SELECT role.rolcanlogin AS can_login,
			(SELECT count(*)::int FROM pg_stat_activity WHERE usename = role.rolname AND backend_type = 'client backend') AS sessions
		FROM pg_roles role WHERE role.rolname = ${writerRole}
	`.execute(db);
	const row = result.rows[0];
	if (!row || row.can_login || row.sessions !== 0) {
		throw new Error(
			`The direct cutover requires ${writerRole} to be NOLOGIN with no remaining sessions. Drain its writers before execution.`,
		);
	}
}
