import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

/** Whether an initial reviewed build has materialized this app but still lacks
 * an authoritative terminal event. The contract freeze survives its run lease:
 * a failed or reaped build remains non-editable and non-moveable until the exact
 * plan finishes (or the whole design is explicitly discarded). */
export async function hasUnfinishedMaterializedDesignInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<boolean> {
	const result = await sql<{ id: string }>`
		SELECT session.id
		FROM design_sessions AS session
		WHERE session.mode = 'build'
			AND session.state = 'materialized'
			AND session.app_id = ${appId}
			AND COALESCE((
				SELECT event.kind
				FROM design_orchestration_events AS event
				WHERE event.design_session_id = session.id
				ORDER BY event.revision DESC
				LIMIT 1
			), '') NOT IN ('finished', 'accepted-partial')
		LIMIT 1
	`.execute(tx);
	return result.rows.length > 0;
}
