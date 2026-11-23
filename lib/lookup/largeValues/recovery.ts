import { sql } from "kysely";
import { refundDeletedBulkObject } from "../generations/budget";
import type { ValueTx } from "./value";

/** One reclamation transaction erases bounded physical data. Immutable value
 * locks held by a reader prevent reclaiming its segments. A ref installed in
 * a concurrent transaction is also protected by the foreign key. */
export async function reclaimCellStorageBatch(tx: ValueTx, projectId: string) {
	await sql`SELECT 1 FROM lookup_project_state WHERE project_id=${projectId} FOR UPDATE`.execute(
		tx,
	);
	const orphan = await sql<{
		id: string;
	}>`SELECT v.id FROM lookup_cell_values v WHERE project_id=${projectId}
		AND NOT EXISTS(SELECT 1 FROM lookup_cell_value_refs r WHERE (r.project_id,r.value_id)=(v.project_id,v.id))
		ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(tx);
	if (orphan.rows.length) {
		const valueId = orphan.rows[0].id;
		const removed =
			await sql`DELETE FROM lookup_cell_segments WHERE ctid IN (SELECT ctid FROM lookup_cell_segments
			WHERE project_id=${projectId} AND value_id=${valueId} LIMIT 128)`.execute(
				tx,
			);
		if (!removed.numAffectedRows)
			await sql`DELETE FROM lookup_cell_values WHERE project_id=${projectId} AND id=${valueId}`.execute(
				tx,
			);
		return true;
	}
	const blobs =
		await sql`DELETE FROM lookup_cell_blobs WHERE ctid IN (SELECT b.ctid FROM lookup_cell_blobs b WHERE b.project_id=${projectId}
		AND NOT EXISTS(SELECT 1 FROM lookup_cell_segments s WHERE (s.project_id,s.blob_id)=(b.project_id,b.id))
		LIMIT 128 FOR UPDATE OF b SKIP LOCKED)`.execute(tx);
	if (blobs.numAffectedRows) return true;
	const expired = await sql<{
		id: string;
		actor_id: string;
		binding: string;
	}>`SELECT id,actor_id,binding FROM lookup_cell_edits
		WHERE project_id=${projectId} AND state='staging' AND expires_at<=clock_timestamp() LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(
		tx,
	);
	if (expired.rows.length) {
		const edit = expired.rows[0];
		await sql`UPDATE lookup_cell_edits SET state='cancelled' WHERE project_id=${projectId} AND id=${edit.id}`.execute(
			tx,
		);
		await refundDeletedBulkObject(tx, {
			projectId,
			id: edit.id,
			actorId: edit.actor_id,
			binding: edit.binding,
			kind: "cell",
		});
		return true;
	}
	const inputs =
		await sql`DELETE FROM lookup_cell_inputs WHERE ctid IN (SELECT i.ctid FROM lookup_cell_inputs i
		JOIN lookup_cell_edits e ON e.project_id=i.project_id AND e.id=i.operation_id
		WHERE i.project_id=${projectId} AND e.state<>'staging' LIMIT 128)`.execute(
			tx,
		);
	if (inputs.numAffectedRows) return true;
	const stale =
		await sql`DELETE FROM lookup_bulk_reservations WHERE ctid IN(SELECT r.ctid FROM lookup_bulk_reservations r
		WHERE r.project_id=${projectId} AND r.kind='cell' AND r.bytes=0 AND NOT EXISTS
			(SELECT 1 FROM lookup_cell_edits e WHERE e.project_id=r.project_id AND e.id=r.object_id AND e.state='staging') LIMIT 128)`.execute(
			tx,
		);
	return Boolean(stale.numAffectedRows);
}
