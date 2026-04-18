/**
 * Event log reader.
 *
 * Three capabilities:
 *   - `readEvents(appId, runId)` — every event for one run, sorted
 *     chronologically by (ts, seq).
 *   - `readLatestRunId(appId)` — the runId of the single most recent
 *     event (by ts). Used when replay / admin tooling needs the "most
 *     recent run" without the user specifying it.
 *   - `readRunSummary(appId, runId)` — the per-run cost/behavior summary
 *     written by `UsageAccumulator.flush`.
 *
 * All reads hit Firestore directly; no caching. Callers either live in
 * admin/replay surfaces (one-time loads) or diagnostic scripts (manual
 * invocation), so cache complexity isn't justified.
 */
import { collections, docs } from "@/lib/db/firestore";
import type { RunSummaryDoc } from "@/lib/db/types";
import type { Event } from "./types";

/**
 * Load every event for a specific generation run, sorted by `ts` then
 * `seq`. The Firestore converter validates each doc via `eventSchema`;
 * malformed entries surface as a parse error at this boundary.
 */
export async function readEvents(
	appId: string,
	runId: string,
): Promise<Event[]> {
	const snap = await collections
		.events(appId)
		.where("runId", "==", runId)
		.orderBy("ts")
		.orderBy("seq")
		.get();
	return snap.docs.map((doc) => doc.data());
}

/**
 * Resolve the most recent runId for an app. Returns `null` when no events
 * exist.
 *
 * Ordering is on `ts` (globally monotonic across runs) rather than `seq`
 * (per-run; resets to 0 per new run). A single top-1 query replaces the
 * full-collection scan.
 */
export async function readLatestRunId(appId: string): Promise<string | null> {
	const snap = await collections
		.events(appId)
		.orderBy("ts", "desc")
		.limit(1)
		.get();
	if (snap.empty) return null;
	return snap.docs[0].data().runId;
}

/**
 * Load the per-run summary doc. Returns `null` if none was written.
 *
 * When `snap.exists` is `true`, the Firestore converter has already run
 * `runSummaryDocSchema.parse()` and produced a valid `RunSummaryDoc` — or
 * thrown. `data()` cannot resolve to `undefined` in that branch. The static
 * type is `T | undefined` only because TS can't narrow through `.exists`;
 * we throw on the impossible case so a future converter regression surfaces
 * loudly instead of being silently coerced to `null`.
 */
export async function readRunSummary(
	appId: string,
	runId: string,
): Promise<RunSummaryDoc | null> {
	const snap = await docs.run(appId, runId).get();
	if (!snap.exists) return null;
	const data = snap.data();
	if (!data) {
		throw new Error(
			`Run summary doc at apps/${appId}/runs/${runId} reported exists=true but returned undefined from data() — converter contract violated.`,
		);
	}
	return data;
}
