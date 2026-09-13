import { type Expression, sql } from "kysely";

/** Retired artifacts remain sealed history, outside the current typed model. */
export function nonRetiredDesignSession(sessionId: Expression<unknown>) {
	return sql<boolean>`exists (
		select 1 from design_sessions
		where design_sessions.id = ${sessionId}
		and design_sessions.state <> 'retired'
	)`;
}
