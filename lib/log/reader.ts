/**
 * Event log reader.
 *
 * Three capabilities:
 *   - `readEvents(appId, runId)` — every event for one run, sorted
 *     chronologically by (ts, seq).
 *   - `readLatestRunId(appId)` — the runId of the single most recent
 *     event (by ts). Used when admin tooling needs the "most recent
 *     run" without the user specifying it.
 *   - `readRunSummary(appId, runId)` — the per-run cost/behavior summary
 *     written by `UsageAccumulator.flush`.
 *
 * All reads hit Postgres directly; no caching. Callers either live in
 * admin surfaces (one-time loads) or diagnostic scripts (manual
 * invocation), so cache complexity isn't justified.
 */
import { getAppDb } from "@/lib/db/pg";
import { loadRunSummary } from "@/lib/db/runSummary";
import type { RunSummaryDoc } from "@/lib/db/types";
import { type Event, eventSchema } from "./types";

/**
 * Decode one complete ordered page of stored event payloads.
 *
 * Event history is an ordered forensic record. Returning the valid rows around
 * a malformed event would manufacture a sequence that never existed, so the
 * page is one strict unit: every row parses through the sole current schema or
 * the read fails. Pre-cutover mutation bytes have one explicit representation,
 * `archived-mutation`; no unknown or forward-version event is silently dropped.
 */
export function decodeEvents(rawEvents: readonly unknown[]): Event[] {
	return eventSchema.array().parse(rawEvents);
}

/**
 * Load and strictly decode every event for a run, sorted by `ts` then `seq`.
 * One malformed row fails the whole read; no caller receives partial history.
 */
export async function readEvents(
	appId: string,
	runId: string,
): Promise<Event[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("events")
		.select("event")
		.where("app_id", "=", appId)
		.where("run_id", "=", runId)
		.orderBy("ts")
		.orderBy("seq")
		.execute();
	return decodeEvents(rows.map((row) => row.event));
}

/**
 * Resolve the most recent runId for an app. Returns `null` when no events
 * exist.
 *
 * Ordering is on `ts` (globally monotonic across runs) rather than `seq`
 * (per-run; resets to 0 per new run). A single top-1 query replaces the
 * full-table scan.
 *
 * Reads the `run_id` COLUMN directly (never the `event` jsonb): it is
 * present on every row regardless of payload validity, so a
 * drifted/forward-version latest event still yields the correct
 * most-recent run — parsing the payload here would strand admin/inspect on
 * "no recent run" for an app whose newest event is undecodable.
 */
export async function readLatestRunId(appId: string): Promise<string | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("events")
		.select("run_id")
		.where("app_id", "=", appId)
		.orderBy("ts", "desc")
		.limit(1)
		.executeTakeFirst();
	return row?.run_id ?? null;
}

/**
 * Load the per-run summary doc. Returns `null` if none was written.
 *
 * Delegates to `loadRunSummary` (`lib/db/runSummary.ts`), which owns the
 * `run_summaries` table read; this reader keeps the export co-located with
 * `readEvents` / `readLatestRunId` so a log consumer reaches the whole
 * run-forensics surface through one module.
 */
export async function readRunSummary(
	appId: string,
	runId: string,
): Promise<RunSummaryDoc | null> {
	return loadRunSummary({ kind: "app", appId }, runId);
}
