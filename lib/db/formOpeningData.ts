import "server-only";
import { type QueryExecutorProvider, sql } from "kysely";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import { getAppDb } from "./pg";

/** The audience is computed by the server from the authenticated entry.
 * Neither the audience digest nor a content digest alone authorizes a read. */
export interface OpeningDataKey {
	readonly audienceDigest: string;
	readonly contentDigest: string;
	readonly app: string;
	readonly project: string;
	readonly session: string;
}

/** Bounded reclamation also runs on ordinary openings. SKIP LOCKED allows
 * independent tabs to keep moving as the maintenance job reclaims a batch. */
export async function reclaimExpiredFormOpeningData(): Promise<number> {
	const db = await getAppDb();
	const result = await sql<{
		retired: number;
	}>`SELECT public.nova_reclaim_expired_form_openings() AS retired`.execute(db);
	return result.rows[0]?.retired ?? 0;
}

export async function putFormOpeningData(
	key: OpeningDataKey,
	bytes: Buffer,
): Promise<void> {
	const db = await getAppDb();
	await reclaimExpiredFormOpeningData();
	const inserted = await sql<{ inserted: number }>`INSERT INTO form_opening_data
		(audience_sha256, content_sha256, app_id, project_id, session_id, data, expires_at)
		SELECT ${key.audienceDigest},${key.contentDigest},app.id,app.project_id,${key.session},${bytes},clock_timestamp() + interval '24 hours'
		FROM apps AS app WHERE app.id = ${key.app} AND app.project_id = ${key.project} AND app.deleted_at IS NULL
		ON CONFLICT (audience_sha256, content_sha256) DO NOTHING RETURNING 1 AS inserted`.execute(
		db,
	);
	if (inserted.rows.length === 0) {
		const existing = await sql`SELECT 1 FROM form_opening_data AS snapshot
			JOIN apps AS app ON app.id=snapshot.app_id AND app.project_id=snapshot.project_id
			WHERE snapshot.audience_sha256=${key.audienceDigest} AND snapshot.content_sha256=${key.contentDigest}
			AND snapshot.app_id=${key.app} AND snapshot.project_id=${key.project} AND snapshot.session_id=${key.session}
			AND app.deleted_at IS NULL AND snapshot.expires_at > clock_timestamp()`.execute(
			db,
		);
		if (!existing.rows.length)
			throw new CaptureSubmissionRejectedError(
				"The opening records changed. Open the form again to load them.",
			);
	}
}

export async function getFormOpeningData(
	key: OpeningDataKey,
	tx?: QueryExecutorProvider,
): Promise<Buffer | undefined> {
	const db = tx ?? (await getAppDb());
	const result = await sql<{
		data: Buffer;
	}>`SELECT snapshot.data FROM form_opening_data AS snapshot
		JOIN apps AS app ON app.id = snapshot.app_id AND app.project_id = snapshot.project_id AND app.deleted_at IS NULL
		WHERE snapshot.audience_sha256 = ${key.audienceDigest} AND snapshot.content_sha256 = ${key.contentDigest}
			AND snapshot.app_id = ${key.app} AND snapshot.project_id = ${key.project}
			AND snapshot.session_id = ${key.session} AND snapshot.expires_at > clock_timestamp()`.execute(
		db,
	);
	return result.rows[0]?.data;
}
