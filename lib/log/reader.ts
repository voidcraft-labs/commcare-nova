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
import type { QueryDocumentSnapshot } from "@google-cloud/firestore";
import { collections, docs, getDb } from "@/lib/db/firestore";
import type { RunSummaryDoc } from "@/lib/db/types";
import { log } from "@/lib/logger";
import type { Event } from "./types";

/**
 * Decode a page of event docs, DROPPING any that fail schema validation
 * rather than letting one bad doc abort the whole read.
 *
 * The event stream is supplemental (the AppDoc snapshot is authoritative),
 * and a forward-version deploy can write a payload type an older reader
 * doesn't know — the strict Zod converter throws on `.data()` for such a
 * doc. Without this, a single unrecognized event makes EVERY reader (replay,
 * admin log inspection, diagnostic scripts) fail to load the entire app's
 * stream. Per-doc try/catch isolates the failure: known events still load,
 * the unknown ones are counted (caller logs), and the run stays inspectable.
 *
 * The throw is caught HERE (not surfaced) because there is no recovery a
 * caller could perform — the doc is undecodable under this build's schema,
 * and the only useful action is to skip it and report the count.
 */
export function decodeEventsLenient(
	eventDocs: QueryDocumentSnapshot<Event>[],
): {
	events: Event[];
	skipped: number;
	sample?: string;
} {
	const events: Event[] = [];
	let skipped = 0;
	let sample: string | undefined;
	for (const doc of eventDocs) {
		try {
			events.push(doc.data());
		} catch (err) {
			skipped++;
			if (sample === undefined) {
				sample = err instanceof Error ? err.message.slice(0, 200) : String(err);
			}
		}
	}
	return { events, skipped, sample };
}

/**
 * Load every event for a specific generation run, sorted by `ts` then
 * `seq`. Each doc is validated via `eventSchema` (the Firestore converter);
 * a doc that fails (schema drift / forward-version payload) is dropped and
 * counted rather than aborting the read — see `decodeEventsLenient`.
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
	const { events, skipped, sample } = decodeEventsLenient(snap.docs);
	if (skipped > 0) {
		log.warn(
			`[readEvents] dropped ${skipped} unparseable event(s) for app=${appId} run=${runId} (schema drift / forward-version payload). First: ${sample}`,
		);
	}
	return events;
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
	// Raw read (no Zod converter): `runId` is an envelope field present on
	// EVERY event regardless of payload validity, so a drifted/forward-version
	// latest event still yields the correct most-recent run. Going through the
	// converter here would throw on exactly that case and strand replay/admin
	// on "no recent run" for an app whose newest event is undecodable.
	const snap = await getDb()
		.collection("apps")
		.doc(appId)
		.collection("events")
		.orderBy("ts", "desc")
		.limit(1)
		.get();
	if (snap.empty) return null;
	const runId = (snap.docs[0].data() as { runId?: unknown }).runId;
	return typeof runId === "string" ? runId : null;
}

/**
 * Load the per-run summary doc. Returns `null` if none was written.
 *
 * The Zod converter on `docs.run` (see `lib/db/firestore.ts`) runs
 * `runSummaryDocSchema.parse()` inside `fromFirestore` and either returns
 * a valid `RunSummaryDoc` or throws — so when `snap.exists === true`,
 * `data()` cannot legitimately return `undefined`. TypeScript types it as
 * `T | undefined` only because `.exists` can't narrow through the
 * Firestore SDK's generic signature. The throw catches a hypothetical
 * future converter regression loudly instead of silently coercing to
 * `null` and masking it.
 *
 * (The writer in `lib/db/runSummary.ts` uses a raw doc ref without the
 * converter, so its "empty doc with exists=true" case is a different
 * scenario — not a converter contract violation — and is handled there
 * by treating the read as "no prev" and overwriting.)
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
