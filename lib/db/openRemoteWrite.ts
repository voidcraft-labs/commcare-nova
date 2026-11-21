import "server-only";

import {
	type Expression,
	type ExpressionBuilder,
	type SqlBool,
	sql,
} from "kysely";
import type { AppDatabase } from "./pg";

/**
 * The one rule for whether a write in `hq_remote_writes` is open: its process
 * has not settled it, and its hold has not ended by the asking transaction's
 * clock. Every reader of an open write asks it.
 *
 * A settle is a state, never a time: a transaction that began before a settle
 * committed, and reads the row after it (a Project move waiting for the app
 * row, a birth waiting for the HQ app's lock), reads it settled. Only a hold's
 * end is a time, minutes after the write opened, so a transaction whose clock
 * started earlier reads it open for that much longer at most.
 */
export function openRemoteWrite(
	eb: ExpressionBuilder<AppDatabase, "hq_remote_writes">,
): Expression<SqlBool> {
	return eb.and([
		eb("settled_at", "is", null),
		eb("held_until", ">", sql<Date>`now()`),
	]);
}
