import "server-only";
import { createHmac } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import type { AppDatabase } from "@/lib/db/pg";
import {
	nextWebFormActivity,
	type WebFormActivity,
	type WebFormActivityNotice,
} from "./webFormActivity";

type Tx = Transaction<AppDatabase>;
export interface WebActivityScope {
	readonly projectId: string;
	readonly appId: string;
	readonly actorId: string;
	readonly workerId: string;
	readonly baseSeq: number;
}

// Only the server's entry resolver supplies these identities. Recheck the
// previous entry as well: a form with a constant key can join different cases.
export interface WebActivityEntry {
	readonly formUuid: string;
	readonly caseIds: readonly string[];
}
interface StoredActivity {
	worker_id: string;
	worker_name: string;
	title: string | null;
	kind: WebFormActivity["kind"];
	event_at: Date;
	window_seconds: number;
	entry_context: WebActivityEntry;
}

async function authorize(tx: Tx, scope: WebActivityScope) {
	const current = await resolveAppScopeInTransaction(
		tx,
		scope.appId,
		scope.actorId,
		"view",
	);
	if (
		current.projectId !== scope.projectId ||
		current.baseSeq !== scope.baseSeq
	) {
		throw new Error(
			"This app changed while the form was open. Open the form again to continue.",
		);
	}
}

function activityDigest(
	scope: WebActivityScope,
	namespace: string,
	key: string,
) {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret)
		throw new Error(
			"The server needs its signing key to open form activity notices.",
		);
	return createHmac("sha256", secret)
		.update(
			JSON.stringify([
				"preview-form-activity-v1",
				scope.projectId,
				scope.appId,
				namespace,
				key,
			]),
		)
		.digest();
}

/** The caller supplies a successful Web restore from this actor and worker.
 * Initial restore establishes the watermark once across tabs. A completed
 * manual or configured sync advances it; ordinary page opens never do. */
export async function recordWebPreviewRestore(
	tx: Tx,
	scope: WebActivityScope,
	mode: "initial" | "sync",
) {
	await authorize(tx, scope);
	await sql`DELETE FROM public.preview_web_restores
		WHERE project_id = ${scope.projectId} AND app_id = ${scope.appId}
			AND restored_at <= clock_timestamp() - interval '10 days'`.execute(tx);
	await sql`INSERT INTO public.preview_web_restores (project_id, app_id, actor_id, worker_id, restored_at)
		VALUES (${scope.projectId}, ${scope.appId}, ${scope.actorId}, ${scope.workerId}, clock_timestamp())
		ON CONFLICT (project_id, app_id, actor_id, worker_id) DO UPDATE SET restored_at =
			GREATEST(preview_web_restores.restored_at, EXCLUDED.restored_at)
		WHERE ${mode === "sync"}`.execute(tx);
}

/** Runs inside the authorized open or successful submission transaction. Key,
 * window and title come from the server's initialized, localized form. */
export async function recordWebFormActivity(
	tx: Tx,
	scope: WebActivityScope,
	input: {
		readonly entry: WebActivityEntry;
		readonly namespace: string;
		readonly key: string;
		readonly workerName: string;
		readonly title: string | null;
		readonly windowSeconds: number;
		readonly kind: WebFormActivity["kind"];
		readonly mayReadEntry: (
			tx: Tx,
			entry: WebActivityEntry,
		) => Promise<boolean>;
	},
): Promise<WebFormActivityNotice | null> {
	await authorize(tx, scope);
	if (!(await input.mayReadEntry(tx, input.entry))) {
		throw new Error(
			"This form is no longer available to the selected worker. Choose an available form and try again.",
		);
	}
	if (Buffer.byteLength(input.title ?? "") > 4096) {
		throw new Error(
			"The form activity title is too long. Choose a shorter text for the notice.",
		);
	}
	const digest = activityDigest(scope, input.namespace, input.key);
	await sql`SELECT pg_advisory_xact_lock(hashtextextended(${digest.toString("hex")}, 0))`.execute(
		tx,
	);
	const timestamp = await sql<{
		now: Date;
	}>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`.execute(tx);
	const now = timestamp.rows[0].now;
	const {
		rows: [stored],
	} =
		await sql<StoredActivity>`SELECT worker_id, worker_name, title, kind, event_at, window_seconds, entry_context
		FROM public.preview_form_activity
		WHERE project_id = ${scope.projectId} AND app_id = ${scope.appId} AND key_digest = ${digest}
			AND expires_at > ${now}`.execute(tx);
	const {
		rows: [restore],
	} = await sql<{
		restored_at: Date;
	}>`SELECT restored_at FROM public.preview_web_restores
		WHERE project_id = ${scope.projectId} AND app_id = ${scope.appId}
			AND actor_id = ${scope.actorId} AND worker_id = ${scope.workerId}
			AND restored_at > ${now}::timestamptz - interval '10 days'`.execute(tx);
	const previous = stored
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
		previous,
		{
			workerId: scope.workerId,
			workerName: input.workerName,
			title: input.title,
			windowSeconds: input.windowSeconds,
			kind: input.kind,
			at: now.getTime(),
		},
		restore?.restored_at.getTime() ?? 0,
	);
	if (write) {
		const reusesPreviousTitle =
			write.kind === "submitted" && previous?.workerId === write.workerId;
		const entry =
			reusesPreviousTitle && stored ? stored.entry_context : input.entry;
		await sql`INSERT INTO public.preview_form_activity
			(project_id, app_id, key_digest, worker_id, worker_name, title, entry_context, window_seconds, kind, event_at, expires_at)
			VALUES (${scope.projectId}, ${scope.appId}, ${digest}, ${write.workerId}, ${write.workerName}, ${write.title},
				${JSON.stringify(entry)}::jsonb, ${write.windowSeconds}, ${write.kind}, ${now},
				${new Date(now.getTime() + write.windowSeconds * 1000)})
			ON CONFLICT (project_id, app_id, key_digest) DO UPDATE SET
				(worker_id, worker_name, title, entry_context, window_seconds, kind, event_at, expires_at) =
				(EXCLUDED.worker_id, EXCLUDED.worker_name, EXCLUDED.title, EXCLUDED.entry_context,
				EXCLUDED.window_seconds, EXCLUDED.kind, EXCLUDED.event_at, EXCLUDED.expires_at)`.execute(
			tx,
		);
	}
	await sql`DELETE FROM public.preview_form_activity WHERE ctid IN (
		SELECT ctid FROM public.preview_form_activity WHERE project_id = ${scope.projectId} AND app_id = ${scope.appId}
			AND expires_at <= ${now} ORDER BY expires_at, key_digest LIMIT 32 FOR UPDATE SKIP LOCKED
	)`.execute(tx);
	return notice &&
		stored &&
		(await input.mayReadEntry(tx, stored.entry_context))
		? notice
		: null;
}
