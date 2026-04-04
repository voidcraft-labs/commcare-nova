/**
 * Log event CRUD helpers — thin wrappers over Firestore collection helpers.
 *
 * Each StoredEvent writes as-is to a Firestore document. No sparse stripping,
 * no defaults map — each event variant only contains its own fields so there's
 * nothing to strip. Reads go through the Zod converter which validates the
 * discriminated union on read.
 */

import { log } from "@/lib/log";
import { collections } from "./firestore";
import type { StoredEvent } from "./types";

// ── Write ──────────────────────────────────────────────────────────

/**
 * Write a single StoredEvent to Firestore. Fire-and-forget — callers should
 * not await this. Errors are caught and logged to the console so a Firestore
 * outage never blocks generation.
 *
 * Uses deterministic document IDs (`{runId}_{sequence}`) so writes are
 * idempotent if retried by the Firestore SDK on transient network errors.
 * `undefined` values in event data (e.g. from `stripEmpty()` converting
 * sentinel strings back) are silently dropped by the Firestore SDK via
 * `ignoreUndefinedProperties: true` on the client instance.
 */
export function writeLogEvent(
	email: string,
	projectId: string,
	event: StoredEvent,
): void {
	const docId = `${event.run_id}_${String(event.sequence).padStart(6, "0")}`;
	collections
		.logs(email, projectId)
		.doc(docId)
		.set(event)
		.catch((err) => log.error("[writeLogEvent] Firestore write failed", err));
}

// ── Read ───────────────────────────────────────────────────────────

/**
 * Load all events for a specific generation run, ordered by sequence.
 *
 * Returns the full StoredEvent (Zod-validated by the converter).
 * Used by the replay system and the logs API endpoint.
 */
export async function loadRunEvents(
	email: string,
	projectId: string,
	runId: string,
): Promise<StoredEvent[]> {
	const snap = await collections
		.logs(email, projectId)
		.where("run_id", "==", runId)
		.orderBy("sequence")
		.get();
	return snap.docs.map((doc) => doc.data());
}

/**
 * Get the most recent run_id for a project.
 *
 * Queries the single highest-sequence event and returns its run_id.
 * Returns null if no log events exist for the project.
 */
export async function loadLatestRunId(
	email: string,
	projectId: string,
): Promise<string | null> {
	/* Order by timestamp (not sequence) because sequence is per-run and resets
	 * to 0 for each EventLogger instance. Timestamp is globally monotonic. */
	const snap = await collections
		.logs(email, projectId)
		.orderBy("timestamp", "desc")
		.limit(1)
		.get();
	if (snap.empty) return null;
	return snap.docs[0].data().run_id;
}
