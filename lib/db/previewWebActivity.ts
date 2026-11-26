import "server-only";

import { type QueryExecutorProvider, sql } from "kysely";
import {
	nextWebFormActivity,
	type WebFormActivity,
	type WebFormActivityEntry,
} from "@/lib/domain/webFormActivity";

interface ActivityScope {
	readonly appId: string;
	readonly projectId: string;
	readonly workerId: string;
	readonly actorId: string;
}

interface StoredActivity {
	readonly entry_key: string;
	readonly worker_id: string;
	readonly worker_name: string;
	readonly title: string | null;
	readonly case_ids: string[];
	readonly kind: WebFormActivity["kind"];
	readonly event_at: Date;
	readonly window_seconds: number;
}

/** Runs under app placement and Project membership locks. Read and write
 * one key in order, preserving an earlier submission's original expiry. */
export async function recordWebFormActivity(
	tx: QueryExecutorProvider,
	scope: ActivityScope,
	entryKey: string,
	entry: WebFormActivityEntry,
	kind: WebFormActivity["kind"],
) {
	await sql`SELECT pg_advisory_xact_lock(hashtextextended(${entry.digest}, 0))`.execute(
		tx,
	);
	const {
		rows: [clock],
	} = await sql<{
		now: Date;
	}>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`.execute(tx);
	const now = clock.now;
	const {
		rows: [stored],
	} = await sql<StoredActivity>`
		SELECT entry_key, worker_id, worker_name, title, case_ids, kind, event_at, window_seconds
		FROM public.preview_form_activity
		WHERE project_id = ${scope.projectId} AND app_id = ${scope.appId} AND key_digest = ${entry.digest}
			AND expires_at > ${now}`.execute(tx);

	let lastRestore = 0;
	if (kind === "opened") {
		const {
			rows: [restore],
		} = await sql<{ restored_at: Date }>`
			SELECT restored_at FROM public.preview_web_restores
			WHERE app_id = ${scope.appId} AND project_id = ${scope.projectId}
				AND actor_id = ${scope.actorId} AND worker_id = ${scope.workerId}
				AND restored_at > ${now}::timestamptz - interval '10 days'`.execute(tx);
		lastRestore = restore?.restored_at.getTime() ?? 0;
	}
	const prior = stored
		? {
				workerId: stored.worker_id,
				workerName: stored.worker_name,
				title: stored.title,
				windowSeconds: stored.window_seconds,
				kind: stored.kind,
				at: stored.event_at.getTime(),
			}
		: null;
	const { write, notice } = nextWebFormActivity(
		prior,
		{
			workerId: scope.workerId,
			workerName: entry.workerName,
			title: entry.title,
			windowSeconds: entry.windowSeconds,
			kind,
			at: now.getTime(),
		},
		lastRestore,
	);
	if (write && !(stored?.entry_key === entryKey && stored.kind === kind)) {
		const caseIds =
			kind === "submitted" && stored?.worker_id === scope.workerId
				? stored.case_ids
				: entry.caseIds;
		await sql`INSERT INTO public.preview_form_activity
			(app_id, project_id, key_digest, entry_key, worker_id, worker_name, title, case_ids, window_seconds, kind, event_at, expires_at)
			VALUES (${scope.appId}, ${scope.projectId}, ${entry.digest}, ${entryKey}, ${scope.workerId},
				${write.workerName}, ${write.title}, ${caseIds}, ${write.windowSeconds}, ${kind},
				${now}, ${new Date(now.getTime() + write.windowSeconds * 1000)})
			ON CONFLICT (app_id, project_id, key_digest) DO UPDATE SET
				(entry_key, worker_id, worker_name, title, case_ids, window_seconds, kind, event_at, expires_at) =
				(EXCLUDED.entry_key, EXCLUDED.worker_id, EXCLUDED.worker_name, EXCLUDED.title, EXCLUDED.case_ids,
				EXCLUDED.window_seconds, EXCLUDED.kind, EXCLUDED.event_at, EXCLUDED.expires_at)`.execute(
			tx,
		);
	}
	return notice !== null && stored
		? { notice, caseIds: stored.case_ids }
		: undefined;
}

/** The first successful restore starts a Web Apps worker's watermark.
 * Preview's ordinary later form openings do not represent a worker sync. */
export async function initializeWebActivityRestore(
	tx: QueryExecutorProvider,
	scope: ActivityScope,
) {
	await sql`DELETE FROM public.preview_form_activity WHERE ctid IN (
		SELECT ctid FROM public.preview_form_activity WHERE expires_at <= clock_timestamp()
		ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED
	)`.execute(tx);
	await sql`DELETE FROM public.preview_web_restores WHERE ctid IN (
		SELECT ctid FROM public.preview_web_restores WHERE restored_at <= clock_timestamp() - interval '10 days'
		ORDER BY restored_at LIMIT 32 FOR UPDATE SKIP LOCKED
	)`.execute(tx);
	await sql`INSERT INTO public.preview_web_restores (app_id, project_id, actor_id, worker_id, restored_at)
		VALUES (${scope.appId}, ${scope.projectId}, ${scope.actorId}, ${scope.workerId}, clock_timestamp())
		ON CONFLICT (app_id, project_id, actor_id, worker_id) DO NOTHING`.execute(
		tx,
	);
}
