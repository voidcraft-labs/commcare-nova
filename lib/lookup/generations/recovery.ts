import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

/** Small restartable cleanup transactions. PostgreSQL rolls back both a
 * deletion and its byte refund together. Check the pointer again under the
 * generation lock; a range currently reading a generation holds it FOR SHARE. */
export async function reclaimLookupStorageBatch(
	tx: Transaction<AppDatabase>,
	projectId: string,
) {
	await sql`SELECT 1 FROM lookup_project_state WHERE project_id=${projectId} FOR UPDATE`.execute(
		tx,
	);
	const candidate = await sql<{
		id: string;
		table_id: string;
	}>`SELECT g.id,g.table_id FROM lookup_generations g
		WHERE g.project_id=${projectId} AND (g.state='retired' OR (g.state IN ('staging','paused') AND g.expires_at<=clock_timestamp()))
		AND NOT EXISTS (SELECT 1 FROM lookup_tables t WHERE t.project_id=g.project_id AND t.id=g.table_id AND t.active_generation_id=g.id)
		ORDER BY g.expires_at,g.id LIMIT 1 FOR UPDATE OF g SKIP LOCKED`.execute(tx);
	const gen = candidate.rows[0];
	if (!gen) {
		const blobs =
			await sql`DELETE FROM lookup_generation_blobs WHERE ctid IN(SELECT b.ctid FROM lookup_generation_blobs b WHERE b.project_id=${projectId}
			AND NOT EXISTS(SELECT 1 FROM lookup_generation_chunks c WHERE (c.project_id,c.blob_id)=(b.project_id,b.id)) LIMIT 128 FOR UPDATE SKIP LOCKED)`.execute(
				tx,
			);
		return Boolean(blobs.numAffectedRows);
	}
	await sql`UPDATE lookup_generations SET state='retired' WHERE project_id=${projectId} AND table_id=${gen.table_id} AND id=${gen.id}`.execute(
		tx,
	);
	for (const name of [
		"lookup_generation_chunks",
		"lookup_generation_rows",
		"lookup_generation_pages",
	] as const) {
		const removed = await sql`DELETE FROM ${sql.table(name)} WHERE ctid IN (
			SELECT ctid FROM ${sql.table(name)} WHERE project_id=${projectId} AND table_id=${gen.table_id} AND generation_id=${gen.id} LIMIT 128)
			RETURNING 1`.execute(tx);
		if (removed.rows.length) return true;
	}
	await sql`DELETE FROM lookup_generations WHERE project_id=${projectId} AND table_id=${gen.table_id} AND id=${gen.id}`.execute(
		tx,
	);
	return true;
}
