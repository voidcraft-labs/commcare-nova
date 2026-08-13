import { sql, type Transaction } from "kysely";
import { APP_RELEASING_ORCHESTRATION_KINDS } from "@/lib/agent/build/orchestrationKinds";
import type { AppDatabase } from "@/lib/db/pg";

/** Whether an initial reviewed build has materialized this app but still lacks
 * an authoritative terminal event. The contract freeze survives its run lease:
 * a failed or reaped build remains non-editable and non-moveable until the exact
 * plan finishes (or the whole design is explicitly discarded). The allow list
 * derives from the shared kind classification (a deliberate data→agent leaf
 * import, like `designInProgress.ts`'s fold) so a new terminal kind cannot
 * freeze apps by drifting past this string. */
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
			), '') NOT IN (${sql.join(APP_RELEASING_ORCHESTRATION_KINDS)})
		LIMIT 1
	`.execute(tx);
	return result.rows.length > 0;
}
