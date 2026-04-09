/**
 * Chat thread CRUD helpers — Firestore persistence for conversation history.
 *
 * Threads live at `apps/{appId}/threads/{threadId}` where threadId = runId
 * (the generation session UUID). Each thread captures one conversation
 * session — the initial build or a subsequent edit.
 *
 * Writes are fire-and-forget (same pattern as event logging). Reads return
 * Zod-validated ThreadDoc arrays ordered chronologically.
 */

import { log } from "@/lib/log";
import { collections } from "./firestore";
import type { ThreadDoc } from "./types";

// ── Write ──────────────────────────────────────────────────────────

/**
 * Save a thread document to Firestore. Fire-and-forget — callers should
 * not await this. Uses the runId as the document ID so writes are
 * idempotent (each status=ready transition overwrites with the latest
 * snapshot of the same thread).
 */
export function saveThread(appId: string, thread: ThreadDoc): void {
	collections
		.threads(appId)
		.doc(thread.run_id)
		.set(thread)
		.catch((err) =>
			log.error("[saveThread] Firestore write failed", err, { appId }),
		);
}

// ── Read ───────────────────────────────────────────────────────────

/**
 * Load all threads for an app, ordered chronologically (oldest first).
 *
 * Returns the full ThreadDoc array (Zod-validated by the converter).
 * No composite index needed — single-field `created_at` is auto-indexed.
 */
export async function loadThreads(appId: string): Promise<ThreadDoc[]> {
	const snap = await collections
		.threads(appId)
		.orderBy("created_at", "asc")
		.get();
	return snap.docs.map((doc) => doc.data());
}
