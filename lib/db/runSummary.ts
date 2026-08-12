/**
 * Per-run cost/behavior summary writer. One row per generation run in
 * `run_summaries`, keyed by one `GenerationTarget` plus `run_id`. Awaited from
 * the usage accumulator's flush path so Cloud Run cold-kills can't drop the
 * write; errors log but never bubble, so a storage outage degrades
 * observability without blocking the response.
 */
import { type Kysely, sql } from "kysely";
import { log } from "@/lib/logger";
import {
	type GenerationTarget,
	generationTargetColumns,
} from "./generationTargets";
import { type AppDatabase, getAppDb, withAppTx } from "./pg";
import type { RunSummaryDoc } from "./types";

/** The scope a run summary is keyed under — the closed target union
 * (`run_summaries_app_run` / `run_summaries_design_session_run` partial
 * unique indexes). */
export type RunSummaryTarget = GenerationTarget;

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

export interface DurableRunSummaryContribution {
	readonly contextId: string;
	readonly stepKey: string;
	readonly stepCount: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly costEstimate: number;
}

export interface DurableRunSummaryWriteResult {
	readonly action: RunSummaryWriteAction;
	/** Only identities inserted by this transaction. */
	readonly admittedContributions: readonly DurableRunSummaryContribution[];
	/** True only when this transaction also advanced the monthly dollar ledger. */
	readonly monthlyUsageAccrued: boolean;
	/** Authoritative cumulative cost for this run after the transaction. Null
	 * means accounting failed, so callers must not infer a zero-cost run. */
	readonly runCostEstimate: number | null;
}

export interface RunSummaryBillingTarget {
	readonly userId: string;
	readonly period: string;
}

function withContributions(
	summary: RunSummaryDoc,
	contributions: readonly DurableRunSummaryContribution[],
): RunSummaryDoc {
	const total = { ...summary };
	for (const contribution of contributions) {
		total.stepCount += contribution.stepCount;
		total.inputTokens += contribution.inputTokens;
		total.outputTokens += contribution.outputTokens;
		total.cacheReadTokens += contribution.cacheReadTokens;
		total.cacheWriteTokens += contribution.cacheWriteTokens;
		total.costEstimate += contribution.costEstimate;
	}
	return total;
}

async function writeRunSummaryInternal(
	target: RunSummaryTarget,
	runId: string,
	summary: RunSummaryDoc,
	contributions: readonly DurableRunSummaryContribution[],
	billing?: RunSummaryBillingTarget,
): Promise<DurableRunSummaryWriteResult> {
	const attempt = () =>
		withAppTx(async (tx): Promise<DurableRunSummaryWriteResult> => {
			/* Inline `selectFrom` + row lock (not the shared target-query
			 * helper): the row-lock privilege scanner must statically prove
			 * the locked table. */
			const existingQuery = tx
				.selectFrom("run_summaries")
				.selectAll()
				.where("run_id", "=", runId)
				.forUpdate();
			const existing = await (target.kind === "app"
				? existingQuery.where("app_id", "=", target.appId)
				: existingQuery.where("design_session_id", "=", target.designSessionId)
			).executeTakeFirst();

			const insertedAccounts =
				contributions.length === 0
					? []
					: await tx
							.insertInto("design_model_step_usage_accounts")
							.values(
								contributions.map((contribution) => ({
									context_id: contribution.contextId,
									step_key: contribution.stepKey,
									event_kind: "completed",
									run_id: runId,
								})),
							)
							.onConflict((conflict) => conflict.doNothing())
							.returning(["context_id", "step_key"])
							.execute();
			const insertedKeys = new Set(
				insertedAccounts.map(
					(account) => `${account.context_id}\u0000${account.step_key}`,
				),
			);
			const admittedContributions = contributions.filter((contribution) =>
				insertedKeys.has(
					`${contribution.contextId}\u0000${contribution.stepKey}`,
				),
			);
			const admittedSummary = withContributions(summary, admittedContributions);
			const monthlyUsageAccrued =
				billing !== undefined && admittedSummary.costEstimate > 0;
			if (monthlyUsageAccrued) {
				await tx
					.insertInto("usage_months")
					.values({
						user_id: billing.userId,
						period: billing.period,
						input_tokens: admittedSummary.inputTokens,
						output_tokens: admittedSummary.outputTokens,
						cost_estimate: admittedSummary.costEstimate,
						request_count: 1,
						updated_at: new Date(),
					})
					.onConflict((conflict) =>
						conflict.columns(["user_id", "period"]).doUpdateSet({
							input_tokens: sql<number>`usage_months.input_tokens + excluded.input_tokens`,
							output_tokens: sql<number>`usage_months.output_tokens + excluded.output_tokens`,
							cost_estimate: sql<number>`usage_months.cost_estimate + excluded.cost_estimate`,
							request_count: sql<number>`usage_months.request_count + 1`,
							updated_at: new Date(),
						}),
					)
					.execute();
			}

			if (!existing) {
				await tx
					.insertInto("run_summaries")
					.values({
						...generationTargetColumns(target),
						run_id: runId,
						started_at: admittedSummary.startedAt,
						finished_at: admittedSummary.finishedAt,
						prompt_mode: admittedSummary.promptMode,
						app_ready: admittedSummary.appReady,
						module_count: admittedSummary.moduleCount,
						step_count: admittedSummary.stepCount,
						model: admittedSummary.model,
						input_tokens: admittedSummary.inputTokens,
						output_tokens: admittedSummary.outputTokens,
						cache_read_tokens: admittedSummary.cacheReadTokens,
						cache_write_tokens: admittedSummary.cacheWriteTokens,
						cost_estimate: admittedSummary.costEstimate,
						tool_call_count: admittedSummary.toolCallCount,
					})
					.execute();
				return {
					action: "created",
					admittedContributions,
					monthlyUsageAccrued,
					runCostEstimate: admittedSummary.costEstimate,
				};
			}

			/* Pinned fields (started_at / prompt_mode / app_ready / model) are
			 * omitted from the SET, so the first write's values stand. Keep the
			 * latest-finish projection monotonic when overlapping POSTs finalize out
			 * of order. */
			const incomingIsLatest =
				existing.finished_at <= admittedSummary.finishedAt;
			let update = tx
				.updateTable("run_summaries")
				.set({
					finished_at: incomingIsLatest
						? admittedSummary.finishedAt
						: existing.finished_at,
					module_count: incomingIsLatest
						? admittedSummary.moduleCount
						: existing.module_count,
					step_count: existing.step_count + admittedSummary.stepCount,
					tool_call_count:
						existing.tool_call_count + admittedSummary.toolCallCount,
					input_tokens:
						Number(existing.input_tokens) + admittedSummary.inputTokens,
					output_tokens:
						Number(existing.output_tokens) + admittedSummary.outputTokens,
					cache_read_tokens:
						Number(existing.cache_read_tokens) +
						admittedSummary.cacheReadTokens,
					cache_write_tokens:
						Number(existing.cache_write_tokens) +
						admittedSummary.cacheWriteTokens,
					cost_estimate: existing.cost_estimate + admittedSummary.costEstimate,
				})
				.where("run_id", "=", runId);
			update =
				target.kind === "app"
					? update.where("app_id", "=", target.appId)
					: update.where("design_session_id", "=", target.designSessionId);
			await update.execute();
			return {
				action: "incremented",
				admittedContributions,
				monthlyUsageAccrued,
				runCostEstimate: existing.cost_estimate + admittedSummary.costEstimate,
			};
		});
	try {
		try {
			return await attempt();
		} catch (err) {
			if ((err as { code?: unknown })?.code !== "23505") throw err;
			// Lost the concurrent first-insert race — its account inserts rolled
			// back with the transaction, so the retry can derive the exact subset.
			return await attempt();
		}
	} catch (err) {
		log.error("[writeRunSummary] Postgres write failed", err, {
			target,
			runId,
		});
		return {
			action: "failed",
			admittedContributions: [],
			monthlyUsageAccrued: false,
			runCostEstimate: null,
		};
	}
}

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
 * **Latest projection (greatest finish timestamp wins):**
 * - `finished_at` — last turn's finalize time. Note this means
 *   `finished_at − started_at` is the span of the thread's activity,
 *   including any idle gaps between turns. Not the agent's wall-clock
 *   runtime.
 * - `module_count` — travels with that latest finish, so an older overlapping
 *   flush cannot regress it. It reflects the blueprint as of the latest turn, so
 *   "apps with N modules" filters in admin tools match reality. Pinning
 *   at turn-1 would permanently mark every successful build→edit thread
 *   as a zero-module app.
 *
 * **Accumulated (cumulative numeric deltas):**
 * - `step_count`, `tool_call_count`, `input_tokens`, `output_tokens`,
 *   `cache_read_tokens`, `cache_write_tokens`, `cost_estimate`. The `bigint`
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
	target: RunSummaryTarget,
	runId: string,
	summary: RunSummaryDoc,
): Promise<RunSummaryWriteAction> {
	return (await writeRunSummaryInternal(target, runId, summary, [])).action;
}

export async function writeRunSummaryWithDurableContributions(
	target: RunSummaryTarget,
	runId: string,
	summary: RunSummaryDoc,
	contributions: readonly DurableRunSummaryContribution[],
	billing: RunSummaryBillingTarget,
): Promise<DurableRunSummaryWriteResult> {
	return writeRunSummaryInternal(
		target,
		runId,
		summary,
		contributions,
		billing,
	);
}

/** A SELECT pre-guarded by run id + exact target columns. */
function runSummaryTargetQuery(
	db: Pick<Kysely<AppDatabase>, "selectFrom">,
	target: RunSummaryTarget,
	runId: string,
) {
	const base = db.selectFrom("run_summaries").where("run_id", "=", runId);
	return target.kind === "app"
		? base.where("app_id", "=", target.appId)
		: base.where("design_session_id", "=", target.designSessionId);
}

/**
 * Load the per-run summary. Returns `null` when none was written. Maps the
 * snake_case columns to the `RunSummaryDoc` camelCase shape and `Number(...)`s
 * the `bigint` token columns (pg returns them as strings). The SELECT-based
 * building block the event-log reader (`lib/log/reader.ts`) surfaces as
 * `readRunSummary`.
 */
export async function loadRunSummary(
	target: RunSummaryTarget,
	runId: string,
): Promise<RunSummaryDoc | null> {
	const db = await getAppDb();
	const row = await runSummaryTargetQuery(db, target, runId)
		.selectAll()
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
		toolCallCount: row.tool_call_count,
	};
}
