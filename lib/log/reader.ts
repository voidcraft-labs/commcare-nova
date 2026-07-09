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
import { log } from "@/lib/logger";
import { type Event, eventSchema } from "./types";

/**
 * Decode a page of stored event payloads, DROPPING any that fail schema
 * validation rather than letting one bad row abort the whole read.
 *
 * The event stream is supplemental (the AppDoc snapshot is authoritative),
 * and a forward-version deploy can write a payload type an older reader
 * doesn't know — `eventSchema.parse` would throw on such a row. Without
 * this, a single unrecognized event makes EVERY reader (admin log
 * inspection, diagnostic scripts) fail to load the entire app's stream.
 * Per-row `safeParse` isolates the failure: known events still load, the
 * unknown ones are counted (caller logs), and the run stays inspectable.
 *
 * Input is the raw `event` jsonb values as Postgres returns them (already
 * parsed to plain objects by the pg driver); each is re-validated against
 * `eventSchema` so a drifted row is skipped, not surfaced — there is no
 * recovery a caller could perform, so the only useful action is to skip it
 * and report the count.
 */
export function decodeEventsLenient(rawEvents: readonly unknown[]): {
	events: Event[];
	skipped: number;
	sample?: string;
} {
	const events: Event[] = [];
	let skipped = 0;
	let sample: string | undefined;
	for (const raw of rawEvents) {
		const parsed = eventSchema.safeParse(raw);
		if (parsed.success) {
			events.push(parsed.data);
			continue;
		}
		skipped++;
		if (sample === undefined) {
			sample = (parsed.error.issues[0]?.message ?? "unparseable event").slice(
				0,
				200,
			);
		}
	}
	return { events, skipped, sample };
}

/**
 * Load every event for a specific generation run, sorted by `ts` then `seq`,
 * alongside a `skipped` count of rows dropped for failing `eventSchema`
 * (schema drift / forward-version payload — see `decodeEventsLenient`).
 *
 * `skipped` is part of the return, not just a server log, ON PURPOSE: a
 * dropped event makes the returned stream PARTIAL, and a consumer that
 * reconstructs from it (applying mutations in order — a missing mutation
 * can land a state that never existed) must be able to tell the stream is
 * incomplete. Forcing callers to read `{ events, skipped }` keeps that
 * partiality impossible to ignore. `skipped` is normally 0; it goes
 * positive only when the reading code's schema is older than what wrote the
 * events (a transient cross-version-read window).
 */
export async function readEvents(
	appId: string,
	runId: string,
): Promise<{ events: Event[]; skipped: number }> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("events")
		.select("event")
		.where("app_id", "=", appId)
		.where("run_id", "=", runId)
		.orderBy("ts")
		.orderBy("seq")
		.execute();
	const { events, skipped, sample } = decodeEventsLenient(
		rows.map((row) => row.event),
	);
	if (skipped > 0) {
		log.warn(
			`[readEvents] dropped ${skipped} unparseable event(s) for app=${appId} run=${runId} (schema drift / forward-version payload). First: ${sample}`,
		);
	}
	return { events, skipped };
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
	return loadRunSummary(appId, runId);
}
