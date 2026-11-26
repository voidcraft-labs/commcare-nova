import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

export async function exportTargetRevision(
	tx: Transaction<AppDatabase>,
	projectId: string,
	appId: string,
): Promise<string> {
	const found = await sql<{
		revision: string;
	}>`SELECT revision::text AS revision FROM export_target_versions WHERE project_id=${projectId} AND app_id=${appId}`.execute(
		tx,
	);
	return found.rows[0]?.revision ?? "0";
}
