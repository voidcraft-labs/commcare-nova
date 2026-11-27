import "server-only";
import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { LookupError } from "../errors";

export function lookupCapacityError() {
	return new LookupError(
		"storage_limit",
		"This Project needs more storage for this change. You can free space or keep the source reference.",
	);
}

export function lookupStorageRefusal(error: unknown) {
	return typeof error === "object" &&
		error !== null &&
		"constraint" in error &&
		error.constraint === "lookup_storage_capacity"
		? lookupCapacityError()
		: null;
}

export async function lockLookupBudget(
	tx: Transaction<AppDatabase>,
	projectId: string,
) {
	await sql`INSERT INTO lookup_storage_budgets(project_id) VALUES (${projectId}) ON CONFLICT DO NOTHING`.execute(
		tx,
	);
	const result = await sql<{
		bulk_slots: number;
		capacity_bytes: string;
		used_bytes: string;
	}>`
		SELECT bulk_slots, capacity_bytes, used_bytes FROM lookup_storage_budgets WHERE project_id=${projectId} FOR UPDATE`.execute(
		tx,
	);
	return result.rows[0];
}

/** The SQL triggers settle ordinary data and generation chunks including
 * metadata. Other physically stored payloads use this same counter only while
 * holding the lock and in the transaction that journals their object ID. */
export async function settleLookupSqlBytes(
	tx: Transaction<AppDatabase>,
	projectId: string,
	deltaBytes: number | bigint,
) {
	const delta = BigInt(deltaBytes).toString();
	const settled =
		await sql`UPDATE lookup_storage_budgets SET used_bytes=used_bytes+${delta}::bigint
		WHERE project_id=${projectId} AND (${delta}::bigint<=0 OR used_bytes+${delta}::bigint <=
			capacity_bytes-CASE WHEN current_setting('nova.lookup_rewrite_project',true)=project_id THEN 0 ELSE least(capacity_bytes/32,67108864) END) RETURNING project_id`.execute(
			tx,
		);
	if (!settled.rows.length) throw lookupCapacityError();
}

export interface BulkObject {
	projectId: string;
	id: string;
	actorId: string;
	binding: string;
	kind: "cell" | "media" | "export" | "import" | "download";
}

/** A work slot is held only by a job that is running: a staging generation
 * whose runner holds its lease, an export whose artifact holds its build
 * lease, and any other working reservation until it lapses. A failed,
 * abandoned or cancelled job therefore stops holding its slot when its lease
 * ends, whatever its retained bytes' lifetime. */
export async function availableBulkSlot(
	tx: Transaction<AppDatabase>,
	projectId: string,
	slots: number,
) {
	const jobs = await sql<{
		count: number;
	}>`SELECT ((SELECT count(*) FROM lookup_generations WHERE project_id=${projectId}
		AND state='staging' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp())+
		(SELECT count(*) FROM lookup_bulk_reservations r WHERE r.project_id=${projectId} AND r.state='working'
			AND r.expires_at>clock_timestamp()
			AND (r.kind<>'export' OR EXISTS (SELECT 1 FROM export_artifacts a
				WHERE a.project_id=r.project_id AND a.id=r.object_id AND a.state='building'
					AND a.lease_until>clock_timestamp()))))::integer AS count`.execute(
		tx,
	);
	if (jobs.rows[0].count >= slots)
		throw new LookupError(
			"storage_limit",
			"This Project already has bulk work in progress. You can retry after a job finishes.",
		);
}

/** Hold or renew a work slot for a job that stores no bytes outside SQL, such
 * as a large-value edit, until `leaseUntil`. Each step of the job renews it;
 * a job whose lease lapsed takes a free slot again before it continues. */
export async function holdBulkWork(
	tx: Transaction<AppDatabase>,
	object: BulkObject,
	leaseUntil: Date,
) {
	const { projectId, id, actorId, binding, kind } = object;
	const budget = await lockLookupBudget(tx, projectId);
	const previous = await sql<{
		actor_id: string;
		binding: string;
		kind: string;
		bytes: string;
		state: string;
		active: boolean;
	}>`
		SELECT actor_id,binding,kind,bytes,state,expires_at>clock_timestamp() AS active FROM lookup_bulk_reservations WHERE project_id=${projectId} AND object_id=${id} FOR UPDATE`.execute(
		tx,
	);
	const row = previous.rows[0];
	if (
		row &&
		(row.actor_id !== actorId ||
			row.binding !== binding ||
			row.kind !== kind ||
			row.state !== "working" ||
			Number(row.bytes) !== 0)
	)
		throw new LookupError(
			"conflict",
			"This storage reservation changed. You can restart the operation.",
		);
	if (!row?.active) await availableBulkSlot(tx, projectId, budget.bulk_slots);
	await sql`INSERT INTO lookup_bulk_reservations(project_id,object_id,actor_id,binding,kind,state,bytes,expires_at)
		VALUES(${projectId},${id},${actorId},${binding},${kind},'working',0,${leaseUntil})
		ON CONFLICT(project_id,object_id) DO UPDATE SET expires_at=excluded.expires_at`.execute(
		tx,
	);
}

/** External bytes are admitted before upload/copy and retained through confirmed
 * physical deletion. SQL-backed jobs pass zero because their triggers charge
 * every stored chunk. A resumed object reuses its exact reservation. */
export async function reserveBulkObject(
	tx: Transaction<AppDatabase>,
	object: BulkObject,
	bytes: number,
	expiresAt: Date,
) {
	const { projectId, id, actorId, binding, kind } = object;
	if (
		!Number.isSafeInteger(bytes) ||
		bytes < 0 ||
		expiresAt.getTime() <= Date.now()
	)
		throw lookupCapacityError();
	const budget = await lockLookupBudget(tx, projectId);
	const previous = await sql<{
		actor_id: string;
		binding: string;
		kind: string;
		bytes: string;
		state: string;
		active: boolean;
	}>`
		SELECT actor_id,binding,kind,bytes,state,expires_at>clock_timestamp() AS active FROM lookup_bulk_reservations WHERE project_id=${projectId} AND object_id=${id} FOR UPDATE`.execute(
		tx,
	);
	const row = previous.rows[0];
	if (row) {
		if (
			!row.active ||
			row.actor_id !== actorId ||
			row.binding !== binding ||
			row.kind !== kind ||
			row.state !== "working" ||
			Number(row.bytes) > bytes
		)
			throw new LookupError(
				"conflict",
				"This storage reservation changed. You can restart the operation.",
			);
		if (Number(row.bytes) === bytes) return;
	} else await availableBulkSlot(tx, projectId, budget.bulk_slots);
	await settleLookupSqlBytes(tx, projectId, bytes - Number(row?.bytes ?? 0));
	await sql`INSERT INTO lookup_bulk_reservations(project_id,object_id,actor_id,binding,kind,state,bytes,expires_at)
		VALUES(${projectId},${id},${actorId},${binding},${kind},'working',${bytes},${expiresAt})
		ON CONFLICT(project_id,object_id) DO UPDATE SET bytes=excluded.bytes`.execute(
		tx,
	);
}

export async function confirmBulkObject(
	tx: Transaction<AppDatabase>,
	object: BulkObject,
	actualBytes: number,
	retainUntil: Date,
) {
	await lockLookupBudget(tx, object.projectId);
	const held = await sql<{
		bytes: string;
		state: string;
	}>`SELECT bytes,state FROM lookup_bulk_reservations WHERE project_id=${object.projectId}
		AND object_id=${object.id} AND actor_id=${object.actorId} AND binding=${object.binding} AND kind=${object.kind} FOR UPDATE`.execute(
		tx,
	);
	const row = held.rows[0];
	if (
		!row ||
		actualBytes < 0 ||
		!Number.isSafeInteger(actualBytes) ||
		Number(row.bytes) < actualBytes ||
		row.state === "deleting"
	)
		throw lookupCapacityError();
	if (row.state === "stored") {
		if (Number(row.bytes) !== actualBytes) throw lookupCapacityError();
		return;
	}
	await settleLookupSqlBytes(
		tx,
		object.projectId,
		actualBytes - Number(row.bytes),
	);
	await sql`UPDATE lookup_bulk_reservations SET bytes=${actualBytes},state='stored',expires_at=${retainUntil}
		WHERE project_id=${object.projectId} AND object_id=${object.id}`.execute(
		tx,
	);
}

export async function markBulkObjectDeleting(
	tx: Transaction<AppDatabase>,
	object: BulkObject,
) {
	await sql`UPDATE lookup_bulk_reservations SET state='deleting' WHERE project_id=${object.projectId} AND object_id=${object.id}
		AND actor_id=${object.actorId} AND binding=${object.binding} AND kind=${object.kind}`.execute(
		tx,
	);
}

/** An object-store owner calls only after that exact object is absent. SQL-only
 * jobs have no external payload and release the work reservation at completion. */
export async function refundDeletedBulkObject(
	tx: Transaction<AppDatabase>,
	object: BulkObject,
) {
	await lockLookupBudget(tx, object.projectId);
	const result = await sql<{
		bytes: string;
	}>`DELETE FROM lookup_bulk_reservations WHERE project_id=${object.projectId} AND object_id=${object.id}
		AND actor_id=${object.actorId} AND binding=${object.binding} AND kind=${object.kind} AND (state='deleting' OR (kind='cell' AND bytes=0))
		RETURNING bytes`.execute(tx);
	if (result.rows[0])
		await settleLookupSqlBytes(
			tx,
			object.projectId,
			-BigInt(result.rows[0].bytes),
		);
}
