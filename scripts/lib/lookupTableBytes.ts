/**
 * Shared core for the lookup table byte-total scan-then-migrate pair.
 *
 * An inline table's `data_bytes` is the stored bytes of its rows: each row's
 * generated `value_bytes` plus the bytes of any large cell value it keeps
 * outside the row (`external_bytes`). A table with an active generation takes
 * its total from that generation's payload, so neither function reads it.
 */
import { type Kysely, sql } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

export interface LookupTableBytesReport {
	readonly inlineTables: number;
	readonly mismatched: number;
}

const measuredBytes = sql<string>`(SELECT coalesce(sum(r.value_bytes + r.external_bytes), 0)
	FROM lookup_rows r WHERE r.project_id = t.project_id AND r.table_id = t.id)`;

/** Read-only census of inline tables whose total differs from their rows. */
export async function scanLookupTableBytes(
	db: Kysely<AppDatabase>,
): Promise<LookupTableBytesReport> {
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const result = await sql<{ inline_tables: number; mismatched: number }>`
				SELECT count(*)::integer AS inline_tables,
					count(*) FILTER (WHERE t.data_bytes <> ${measuredBytes})::integer AS mismatched
				FROM lookup_tables t WHERE t.active_generation_id IS NULL`.execute(tx);
			const row = result.rows[0];
			return {
				inlineTables: row?.inline_tables ?? 0,
				mismatched: row?.mismatched ?? 0,
			};
		});
}

/** Repair each mismatched inline table in its own transaction. The table row
 * is locked first, as every row writer locks it, and the total is measured
 * after the lock, so it is the one the rows hold when the repair commits. */
export async function repairLookupTableBytes(
	db: Kysely<AppDatabase>,
): Promise<number> {
	const candidates = await sql<{ project_id: string; id: string }>`
		SELECT t.project_id, t.id FROM lookup_tables t
		WHERE t.active_generation_id IS NULL AND t.data_bytes <> ${measuredBytes}
		ORDER BY t.project_id, t.id`.execute(db);
	let repaired = 0;
	for (const table of candidates.rows) {
		const changed = await db.transaction().execute(async (tx) => {
			const locked = await sql`SELECT 1 FROM lookup_tables
				WHERE project_id = ${table.project_id} AND id = ${table.id}::uuid
					AND active_generation_id IS NULL
				FOR UPDATE`.execute(tx);
			if (locked.rows.length === 0) return false;
			const updated =
				await sql`UPDATE lookup_tables t SET data_bytes = ${measuredBytes}
				WHERE t.project_id = ${table.project_id} AND t.id = ${table.id}::uuid
					AND t.data_bytes <> ${measuredBytes}`.execute(tx);
			return (updated.numAffectedRows ?? BigInt(0)) > BigInt(0);
		});
		if (changed) repaired++;
	}
	return repaired;
}
