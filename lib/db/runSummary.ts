/**
 * Per-run cost/behavior summary writer. One document per generation run
 * at `apps/{appId}/runs/{runId}`. Awaited from the usage accumulator's
 * flush path so Cloud Run cold-kills can't drop the write; errors log
 * but never bubble, so a Firestore outage degrades observability
 * without blocking the response.
 */
import { FieldValue } from "@google-cloud/firestore";
import { log } from "@/lib/logger";
import { getDb } from "./firestore";
import { type RunSummaryDoc, runSummaryDocSchema } from "./types";

/**
 * Persist the run summary for one request inside a chat thread.
 *
 * A `runId` spans every request in the same thread — initial build plus
 * every follow-up edit turn — so `summary` is this request's contribution,
 * not the run's lifetime totals. The writer merges this turn's deltas
 * onto the existing doc via a Firestore transaction.
 *
 * ## Field-accumulation policy
 *
 * Each summary field falls into one of three buckets based on what an
 * admin reader wants to see about the whole run:
 *
 * **Pinned (first write wins, never overwritten afterwards):**
 * - `runId` — immutable by construction.
 * - `startedAt` — wall-clock of the first turn's finalize.
 * - `promptMode` — a thread that starts as "build" stays a build thread
 *   in the summary, even after the follow-up edits switch prompts.
 * - `appReady` — same logic: was the app ready when the thread opened?
 * - `model` — would require a different field if we ever mix SA models
 *   inside a single thread, but `SA_MODEL` is a code constant today.
 *
 * **Scalar overwrite (latest turn wins):**
 * - `finishedAt` — last turn's finalize time. Note this means
 *   `finishedAt − startedAt` is the span of the thread's activity,
 *   including any idle gaps between turns. Not the agent's wall-clock
 *   runtime.
 * - `moduleCount` — reflects the blueprint as of the latest turn, so
 *   "apps with N modules" filters in admin tools match reality. Pinning
 *   at turn-1 would permanently mark every successful build→edit thread
 *   as a zero-module app.
 *
 * **Union (boolean OR across turns):**
 * - `freshEdit`, `cacheExpired` — cost-relevant signals. An admin needs
 *   "did any turn hit a cold cache / run a fresh edit?" rather than
 *   "was turn 1 cold." OR-ing via `prev || delta` captures that.
 *
 * **Accumulated via `FieldValue.increment` (cumulative numeric deltas):**
 * - `stepCount`, `toolCallCount`, `inputTokens`, `outputTokens`,
 *   `cacheReadTokens`, `cacheWriteTokens`, `costEstimate`.
 *
 * ## Why the transaction
 *
 * The live TOCTOU is a client abort followed by an immediate retry.
 * Request #1's `finally` awaits `usage.flush()`, but the route's
 * abort-handler also fires `void usage.flush()` on disconnect — the
 * abort path is fire-and-forget, which makes it *possible* (on Cloud
 * Run in particular) for the abort-triggered write to overlap
 * request #2's synchronous flush. Both flushes target the same
 * `runs/{runId}` doc with non-overlapping deltas; a plain read-
 * modify-write would drop whichever delta lost the commit race.
 * `db.runTransaction` forces a re-read on contention; Firestore
 * retries the closure automatically until commit succeeds.
 *
 * `FieldValue.increment` composes correctly with transaction retries:
 * the sentinel is a server-side instruction that only fires on the
 * winning commit, not once per closure invocation.
 *
 * ## Schema-drift safety
 *
 * A Zod parse failure on the existing on-disk doc falls through to the
 * "no prev" branch — the current turn's summary overwrites it. We log
 * the full prior doc (RunSummaryDoc carries no user content — just
 * counters, timestamps, model/runId, flags) so an operator can
 * reconstruct what was lost. Overwriting corrupt data with fresh data
 * is strictly safer than dropping the current turn's contribution
 * just to preserve garbage.
 */
export async function writeRunSummary(
	appId: string,
	runId: string,
	summary: RunSummaryDoc,
): Promise<void> {
	try {
		const db = getDb();
		/* Raw doc ref (no converter) — transactions read and write
		 * Zod-free DocumentData so we control the parse boundary
		 * ourselves. The converter on `docs.run` would throw on malformed
		 * docs, aborting the transaction before we can fall through to a
		 * safe overwrite. */
		const ref = db.collection("apps").doc(appId).collection("runs").doc(runId);

		await db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const raw = snap.exists ? (snap.data() ?? null) : null;
			const prev = raw ? parseExistingSummary(raw) : null;

			if (!prev) {
				tx.set(ref, summary);
				return;
			}

			/* Merge payload. Fields not included here retain their on-disk
			 * values via Firestore's `{ merge: true }` semantics — that's
			 * how the "pinned" bucket stays immutable across turns. */
			tx.set(
				ref,
				{
					finishedAt: summary.finishedAt,
					moduleCount: summary.moduleCount,
					freshEdit: prev.freshEdit || summary.freshEdit,
					cacheExpired: prev.cacheExpired || summary.cacheExpired,
					stepCount: FieldValue.increment(summary.stepCount),
					toolCallCount: FieldValue.increment(summary.toolCallCount),
					inputTokens: FieldValue.increment(summary.inputTokens),
					outputTokens: FieldValue.increment(summary.outputTokens),
					cacheReadTokens: FieldValue.increment(summary.cacheReadTokens),
					cacheWriteTokens: FieldValue.increment(summary.cacheWriteTokens),
					costEstimate: FieldValue.increment(summary.costEstimate),
				},
				{ merge: true },
			);
		});
	} catch (err) {
		log.error("[writeRunSummary] Firestore write failed", err, {
			appId,
			runId,
		});
	}
}

/**
 * Parse an on-disk summary without throwing. Returns the parsed doc on
 * success, or `null` when the stored shape fails schema validation —
 * the caller then overwrites with the current turn's summary.
 *
 * The prior doc is logged in full on parse failure so an operator can
 * reconstruct what was lost (e.g. if the failure turns out to be a
 * schema-drift false positive, not genuine corruption). Safe to log:
 * `RunSummaryDoc` carries no user content — just numeric counters,
 * timestamps, model/runId identifiers, and booleans.
 */
function parseExistingSummary(raw: unknown): RunSummaryDoc | null {
	const parsed = runSummaryDocSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	log.warn("[writeRunSummary] existing doc failed schema parse; overwriting", {
		issues: JSON.stringify(parsed.error.issues),
		priorDoc: JSON.stringify(raw),
	});
	return null;
}
