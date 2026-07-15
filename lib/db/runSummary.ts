/**
 * Per-run cost/behavior summary writer. One row per generation run in
 * `run_summaries`, keyed `(app_id, run_id)`. Awaited from the usage
 * accumulator's flush path so Cloud Run cold-kills can't drop the write;
 * errors log but never bubble, so a storage outage degrades observability
 * without blocking the response.
 */
import { log } from "@/lib/logger";
import { getAppDb, withAppTx } from "./pg";
import type { RunSummaryDoc } from "./types";

/**
 * What `writeRunSummary` did to the stored row — surfaced so the per-run
 * finalize log can show whether a flush *accumulated* onto the run's running
 * totals or *replaced* them:
 *
 * - `"created"` — first write of this run; no prior row existed.
 * - `"incremented"` — a prior row existed and this turn's deltas were added to
 *   it (the healthy multi-turn path).
 * - `"overwritten"` — a legacy diagnostic for a prior row that failed to parse
 *   and was clobbered. Unreachable on typed columns (every column comes back
 *   typed, there is nothing to fail parsing), so it is never returned; the
 *   variant is retained only so a reader that switches on the action stays
 *   exhaustive.
 * - `"failed"` — the transaction threw; nothing was written.
 */
export type RunSummaryWriteAction =
	| "created"
	| "incremented"
	| "overwritten"
	| "failed";

/**
 * Persist the run summary for one request inside a chat thread.
 *
 * A `runId` spans every request in the same thread — initial build plus
 * every follow-up edit turn — so `summary` is this request's contribution,
 * not the run's lifetime totals. The writer merges this turn's deltas
 * onto the existing row inside a transaction.
 *
 * ## Field-accumulation policy
 *
 * Each summary field falls into one of three buckets based on what an
 * admin reader wants to see about the whole run:
 *
 * **Pinned (first write wins, never overwritten afterwards):**
 * - `run_id` — immutable by construction.
 * - `started_at` — wall-clock of the first turn's finalize.
 * - `prompt_mode` — a thread that starts as "build" stays a build thread
 *   in the summary, even after the follow-up edits switch prompts.
 * - `app_ready` — same logic: was the app ready when the thread opened?
 * - `model` — pinned at the thread's first turn, so a build thread keeps
 *   `SA_BUILD_MODEL` even after follow-up edits switch to `SA_EDIT_MODEL`.
 *   Cost is unaffected: each turn's accumulator prices its own tokens at
 *   that turn's model.
 *
 * **Scalar overwrite (latest turn wins):**
 * - `finished_at` — last turn's finalize time. Note this means
 *   `finished_at − started_at` is the span of the thread's activity,
 *   including any idle gaps between turns. Not the agent's wall-clock
 *   runtime.
 * - `module_count` — reflects the blueprint as of the latest turn, so
 *   "apps with N modules" filters in admin tools match reality. Pinning
 *   at turn-1 would permanently mark every successful build→edit thread
 *   as a zero-module app.
 *
 * **Accumulated (cumulative numeric deltas):**
 * - `step_count`, `tool_call_count`, `input_tokens`, `output_tokens`,
 *   `cache_read_tokens`, `cache_write_tokens`, `cost_estimate`,
 *   `actual_cost`. The `bigint`
 *   token columns come back from pg as strings, so each is `Number(...)`-ed
 *   before adding this turn's delta.
 *
 * ## Why the transaction
 *
 * The live TOCTOU is a client abort followed by an immediate retry.
 * Request #1's `finally` awaits `usage.flush()`, but the route's
 * abort-handler also fires `void usage.flush()` on disconnect — the
 * abort path is fire-and-forget, which makes it *possible* (on Cloud
 * Run in particular) for the abort-triggered write to overlap
 * request #2's synchronous flush. Both flushes target the same
 * `(app_id, run_id)` row with non-overlapping deltas; a plain
 * read-modify-write would drop whichever delta lost the commit race.
 * The `SELECT … FOR UPDATE` here serializes the two against the row, and
 * `withAppTx` retries a serialization/deadlock failure until it commits.
 *
 * The FIRST write has no row to lock, so two overlapping first-turn flushes
 * can both take the insert path — the loser's 23505 unique violation is
 * caught here and the write re-runs ONCE, now finding the winner's row and
 * accumulating onto it, so neither turn's deltas are dropped.
 */
export async function writeRunSummary(
	appId: string,
	runId: string,
	summary: RunSummaryDoc,
): Promise<RunSummaryWriteAction> {
	const attempt = () =>
		withAppTx(async (tx): Promise<RunSummaryWriteAction> => {
			const existing = await tx
				.selectFrom("run_summaries")
				.selectAll()
				.where("app_id", "=", appId)
				.where("run_id", "=", runId)
				.forUpdate()
				.executeTakeFirst();

			if (!existing) {
				await tx
					.insertInto("run_summaries")
					.values({
						app_id: appId,
						run_id: runId,
						started_at: summary.startedAt,
						finished_at: summary.finishedAt,
						prompt_mode: summary.promptMode,
						app_ready: summary.appReady,
						module_count: summary.moduleCount,
						step_count: summary.stepCount,
						model: summary.model,
						input_tokens: summary.inputTokens,
						output_tokens: summary.outputTokens,
						cache_read_tokens: summary.cacheReadTokens,
						cache_write_tokens: summary.cacheWriteTokens,
						cost_estimate: summary.costEstimate,
						actual_cost: summary.actualCost,
						tool_call_count: summary.toolCallCount,
					})
					.execute();
				return "created";
			}

			/* Pinned fields (started_at / prompt_mode / app_ready / model) are
			 * omitted from the SET, so the first write's values stand. */
			await tx
				.updateTable("run_summaries")
				.set({
					finished_at: summary.finishedAt,
					module_count: summary.moduleCount,
					step_count: existing.step_count + summary.stepCount,
					tool_call_count: existing.tool_call_count + summary.toolCallCount,
					input_tokens: Number(existing.input_tokens) + summary.inputTokens,
					output_tokens: Number(existing.output_tokens) + summary.outputTokens,
					cache_read_tokens:
						Number(existing.cache_read_tokens) + summary.cacheReadTokens,
					cache_write_tokens:
						Number(existing.cache_write_tokens) + summary.cacheWriteTokens,
					cost_estimate: existing.cost_estimate + summary.costEstimate,
					actual_cost: existing.actual_cost + summary.actualCost,
				})
				.where("app_id", "=", appId)
				.where("run_id", "=", runId)
				.execute();
			return "incremented";
		});
	try {
		try {
			return await attempt();
		} catch (err) {
			if ((err as { code?: unknown })?.code !== "23505") throw err;
			// Lost the concurrent first-insert race — the row exists now.
			return await attempt();
		}
	} catch (err) {
		log.error("[writeRunSummary] Postgres write failed", err, {
			appId,
			runId,
		});
		return "failed";
	}
}

/**
 * Load the per-run summary. Returns `null` when none was written. Maps the
 * snake_case columns to the `RunSummaryDoc` camelCase shape and `Number(...)`s
 * the `bigint` token columns (pg returns them as strings). The SELECT-based
 * building block the event-log reader (`lib/log/reader.ts`) surfaces as
 * `readRunSummary`.
 */
export async function loadRunSummary(
	appId: string,
	runId: string,
): Promise<RunSummaryDoc | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("run_summaries")
		.selectAll()
		.where("app_id", "=", appId)
		.where("run_id", "=", runId)
		.executeTakeFirst();
	if (!row) return null;
	return {
		runId: row.run_id,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		promptMode: row.prompt_mode as RunSummaryDoc["promptMode"],
		appReady: row.app_ready,
		moduleCount: row.module_count,
		stepCount: row.step_count,
		model: row.model,
		inputTokens: Number(row.input_tokens),
		outputTokens: Number(row.output_tokens),
		cacheReadTokens: Number(row.cache_read_tokens),
		cacheWriteTokens: Number(row.cache_write_tokens),
		costEstimate: row.cost_estimate,
		actualCost: row.actual_cost,
		toolCallCount: row.tool_call_count,
	};
}
