/**
 * Chat thread persistence — Postgres read/write for conversation history.
 *
 * Marked `"use server"` so the server-only data layer never enters the client
 * bundle. Client components import `saveThread` as a server action reference;
 * the actual write runs server-side.
 *
 * Threads live in the `threads` table keyed `(app_id, thread_id)` where
 * thread_id = runId (the generation session UUID). Each row captures one
 * conversation session — the initial build or a subsequent edit — with the
 * display-relevant messages embedded as a jsonb array.
 */
"use server";

import { log } from "@/lib/logger";
import { getAppDb } from "./pg";
import { type ThreadDoc, threadDocSchema } from "./types";

// ── Write ──────────────────────────────────────────────────────────

/**
 * Save a thread to Postgres. Fire-and-forget — callers should not await this.
 * Keyed on `(app_id, thread_id = run_id)` with an idempotent overwrite, so each
 * status=ready transition replaces the row with the latest snapshot of the same
 * thread (`messages` serialized to jsonb).
 */
export async function saveThread(
	appId: string,
	thread: ThreadDoc,
): Promise<void> {
	try {
		const db = await getAppDb();
		await db
			.insertInto("threads")
			.values({
				app_id: appId,
				thread_id: thread.run_id,
				created_at: thread.created_at,
				thread_type: thread.thread_type,
				summary: thread.summary,
				run_id: thread.run_id,
				messages: JSON.stringify(thread.messages),
			})
			.onConflict((oc) =>
				oc.columns(["app_id", "thread_id"]).doUpdateSet({
					created_at: thread.created_at,
					thread_type: thread.thread_type,
					summary: thread.summary,
					run_id: thread.run_id,
					messages: JSON.stringify(thread.messages),
				}),
			)
			.execute();
	} catch (err) {
		log.error("[saveThread] Postgres write failed", err, { appId });
	}
}

// ── Read ───────────────────────────────────────────────────────────

/**
 * Load all threads for an app, ordered chronologically (oldest first).
 *
 * `created_at` is an ISO-8601 string, so a text `ORDER BY` sorts chronologically.
 * Each row is validated through `threadDocSchema` (the `messages` jsonb comes
 * back as an array; the candidate object is assembled then parsed).
 */
export async function loadThreads(appId: string): Promise<ThreadDoc[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("threads")
		.select(["created_at", "thread_type", "summary", "run_id", "messages"])
		.where("app_id", "=", appId)
		.orderBy("created_at", "asc")
		.execute();
	return rows.map((row) =>
		threadDocSchema.parse({
			created_at: row.created_at,
			thread_type: row.thread_type,
			summary: row.summary,
			run_id: row.run_id,
			messages: row.messages,
		}),
	);
}
