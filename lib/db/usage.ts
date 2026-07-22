/**
 * Usage tracking — per-user monthly dollar cost aggregation.
 *
 * Reads and writes the `usage_months` row keyed `(user_id, period)`, so a read
 * is a single primary-key fetch. This is the accumulate-only cost record:
 * increments add to the stored counters in one UPSERT, and nothing ever resets
 * it — an admin credit reset/grant touches the parallel `credit_months` ledger,
 * never this one. The dollar counter is `cost_estimate` — token math over
 * `MODEL_PRICING`, which with a direct OpenAI key is the deterministic bill,
 * not a forecast. Its sole gate consumer is the invisible `COST_BACKSTOP_USD`
 * runaway guard, read via `getMonthlyUsage`. The user-facing quota is
 * credits, not dollars — see `./credits`.
 *
 * Fail-closed: the route wraps the pre-request `getMonthlyUsage` read in a
 * try/catch — if Postgres is down, the read fails → 503. No separate retry or
 * pending mechanism: an outage that blocks writes also blocks reads.
 */
import { sql } from "kysely";
import { log } from "@/lib/logger";
import { DEFAULT_PRICING, MODEL_PRICING } from "@/lib/models";
import { refundReservation } from "./credits";
import { getCurrentPeriod } from "./period";
import { getAppDb } from "./pg";
import { writeRunSummary } from "./runSummary";
import type { RunSummaryDoc, UsageDoc } from "./types";

// ── Read ──────────────────────────────────────────────────────────

/**
 * Load the current month's usage for a user. Returns null if no usage row
 * exists yet (first request of the month). The `bigint` token columns come
 * back from pg as strings, so each is `Number(...)`-ed here.
 *
 * This is a blocking read — used for the pre-request dollar-backstop check.
 */
export async function getMonthlyUsage(
	userId: string,
): Promise<UsageDoc | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("usage_months")
		.select([
			"input_tokens",
			"output_tokens",
			"cost_estimate",
			"request_count",
			"updated_at",
		])
		.where("user_id", "=", userId)
		.where("period", "=", getCurrentPeriod())
		.executeTakeFirst();
	if (!row) return null;
	return {
		input_tokens: Number(row.input_tokens),
		output_tokens: Number(row.output_tokens),
		cost_estimate: row.cost_estimate,
		request_count: row.request_count,
		updated_at: row.updated_at,
	};
}

// ── Write ─────────────────────────────────────────────────────────

/** Deltas to add to the usage row after a request completes. */
interface UsageIncrement {
	input_tokens: number;
	output_tokens: number;
	cost_estimate: number;
}

/**
 * Accumulate the current month's usage counters for a user. Single attempt,
 * throws on failure — consistent with every other write here. The pre-request
 * backstop check (read) is the fail-closed gate; if Postgres is down for
 * writes, it's down for reads too, and the route returns 503.
 *
 * One `INSERT ... ON CONFLICT (user_id, period) DO UPDATE` seeds the row on the
 * first request of a new month and otherwise adds this request's deltas
 * (`request_count + 1`) to the stored totals in the same statement — so there
 * is no separate create path and no read-then-write race.
 */
export async function incrementUsage(
	userId: string,
	deltas: UsageIncrement,
): Promise<void> {
	const db = await getAppDb();
	await db
		.insertInto("usage_months")
		.values({
			user_id: userId,
			period: getCurrentPeriod(),
			input_tokens: deltas.input_tokens,
			output_tokens: deltas.output_tokens,
			cost_estimate: deltas.cost_estimate,
			request_count: 1,
			updated_at: new Date(),
		})
		.onConflict((oc) =>
			oc.columns(["user_id", "period"]).doUpdateSet({
				input_tokens: sql<number>`usage_months.input_tokens + excluded.input_tokens`,
				output_tokens: sql<number>`usage_months.output_tokens + excluded.output_tokens`,
				cost_estimate: sql<number>`usage_months.cost_estimate + excluded.cost_estimate`,
				request_count: sql<number>`usage_months.request_count + 1`,
				updated_at: new Date(),
			}),
		)
		.execute();
}

// ── Cost estimation ───────────────────────────────────────────────

/**
 * Compute USD cost from token counts using `MODEL_PRICING`. With a direct
 * OpenAI key this token math IS the bill — there is no separate meter.
 *
 * Convention: `inputTokens` is the TOTAL input count for the call, INCLUDING
 * any cache-read and cache-write tokens. The uncached portion is derived
 * by subtracting both cache buckets, so callers must not pre-subtract.
 * Unknown model IDs fall back to `DEFAULT_PRICING` (a conservative
 * mid-family rate) — pricing gaps should still produce a believable number
 * rather than zero.
 *
 * `uncachedInput` is floored at zero: if a caller mis-reports cache tokens
 * such that the sum exceeds `inputTokens`, a negative uncached count would
 * flow into the monthly `incrementUsage` accumulation and corrupt the
 * dollar counter (and misreport the run summary). Clamp here rather than
 * trust the source.
 *
 * Exported so admin inspect scripts can recompute costs from stored run
 * summaries without depending on the accumulator class.
 */
export function estimateCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
): number {
	const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
	const uncachedInput = Math.max(
		0,
		inputTokens - cacheReadTokens - cacheWriteTokens,
	);
	return (
		(uncachedInput * pricing.input +
			cacheReadTokens * pricing.cacheRead +
			cacheWriteTokens * pricing.cacheWrite +
			outputTokens * pricing.output) /
		1_000_000
	);
}

// ── Per-request accumulator ───────────────────────────────────────

/** Per-LLM-call token usage accepted by the accumulator. */
interface LLMCallUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/**
 * Seed metadata captured at request start. `startedAt` is optional so the
 * accumulator can default it to "now" at construction — tests pin it for
 * deterministic assertions, the route leaves it implicit.
 */
export interface AccumulatorSeed {
	appId: string;
	userId: string;
	runId: string;
	model: string;
	promptMode: "build" | "edit";
	appReady: boolean;
	moduleCount: number;
	/**
	 * Input-context composition for the per-run finalize log (observability
	 * only — NOT persisted to the run summary). The system prompt is roughly
	 * constant (the CORE prompt plus a one-line-per-field blueprint summary),
	 * so the variable input cost is the conversation history actually sent to
	 * the model this request — captured here as the message count and their
	 * serialized byte size, after the cache-expiry last-message-only trim.
	 * Set via `configureRun` once the route has assembled the effective
	 * messages; absent on a run that finalized before that point.
	 */
	sentMessageCount?: number;
	sentMessageChars?: number;
	/** ISO timestamp. Defaults to "now" at construction. */
	startedAt?: string;
	/**
	 * Credit-reservation context, threaded from the chat route when a run booked
	 * a charge at request start. All three are present together (a chargeable
	 * turn) or all absent (a free assistant-tail continuation). They drive the
	 * refund branch in `flush()`: a run that failed or did no billable work hands
	 * the reservation back.
	 */
	/** Whether the route reserved credits for this run. The refund branch is gated on it. */
	didReserve?: boolean;
	/** Credits reserved (a build's 100 or an edit's 5). Refunded verbatim on a no-op. */
	reservedAmount?: number;
	/**
	 * The period the charge was booked against. The refund targets THIS period,
	 * not `getCurrentPeriod()` at flush time — a flush that crosses midnight into
	 * a new month must still un-book the month that was actually debited.
	 */
	chargePeriod?: string;
}

/** Fields that can be updated mid-request via `configureRun`. */
interface AccumulatorRunConfig {
	promptMode: "build" | "edit";
	appReady: boolean;
	moduleCount: number;
	/** Input-context composition for the finalize log — see `AccumulatorSeed`. */
	sentMessageCount: number;
	sentMessageChars: number;
	/**
	 * Credit-reservation context — see `AccumulatorSeed`. Seed-only except on
	 * the serialize-with-wait path, where a conflicting run reserves INSIDE the
	 * stream (the poll-wait winning `claimAndReserveRun`), so the accumulator — built
	 * before the stream with no reservation context on that path — must be told
	 * the reservation once it lands, or the flush-time refund/settle targets the
	 * wrong period (or misfires entirely). All three travel together.
	 */
	didReserve: boolean;
	reservedAmount: number;
	chargePeriod: string;
}

/**
 * Per-request LLM usage accumulator. `flush()` fans out to the monthly
 * dollar document and the per-run summary doc (and refunds the credit
 * reservation on a no-op/failed run) — see the two methods for the
 * contracts they own.
 */
export class UsageAccumulator {
	/* `readonly` marks the seed REFERENCE as never reassigned — it does NOT
	 * freeze the contents. `configureRun` backfills individual fields in place
	 * via `Object.assign(this.seed, ...)` (which `readonly` does not prevent)
	 * once the route resolves the prompt-mode / cache / message-composition
	 * signals that aren't known at construction time. */
	private readonly seed: AccumulatorSeed;
	private readonly startedAt: string;
	private inputTokens = 0;
	private outputTokens = 0;
	private cacheReadTokens = 0;
	private cacheWriteTokens = 0;
	private stepCount = 0;
	private toolCallCount = 0;
	private _finalized = false;
	/* Flipped by `markRunFailed` when the run broke the app. A failed run still
	 * accrues its dollar cost (the backstop must see retry spam) but hands
	 * the reserved credits back — the user isn't charged for a broken result. */
	private _runFailed = false;
	/* Set true iff a credit refund was owed this run AND its (cross-document)
	 * transaction did NOT commit. The route reads this after `flush()` to decide
	 * whether it's safe to flip a failed build to `error`: a stranded refund must
	 * leave the row reapable so the reaper retries it, never flip it to a status
	 * the reaper skips. Also keeps the `[run-finalize]` log's `refunded` honest
	 * (the outcome, not just the intent). */
	private _refundFailed = false;

	constructor(seed: AccumulatorSeed) {
		this.seed = { ...seed };
		this.startedAt = seed.startedAt ?? new Date().toISOString();
	}

	/** Run id the route uses when constructing Event envelopes. */
	get runId(): string {
		return this.seed.runId;
	}

	/**
	 * Record one LLM call's usage. `step: true` counts it as an outer
	 * agent step; sub-gen calls omit the option. Sub-gen token totals
	 * still flow into the summary — only `stepCount` is gated.
	 */
	track(usage: LLMCallUsage, opts: { step?: boolean } = {}): void {
		this.inputTokens += usage.inputTokens;
		this.outputTokens += usage.outputTokens;
		this.cacheReadTokens += usage.cacheReadTokens ?? 0;
		this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		if (opts.step) this.stepCount++;
	}

	/** Record a tool call — feeds the `toolCallCount` run-summary field. */
	noteToolCall(): void {
		this.toolCallCount++;
	}

	/**
	 * Mark the run as failed so `flush()` refunds the credit reservation. The
	 * chat route's single error funnel calls this before flush. Safe to call any
	 * time, including after `flush()` (the refund already happened; this only
	 * sets a flag the finalized flush no longer reads).
	 */
	markRunFailed(): void {
		this._runFailed = true;
	}

	/**
	 * Update seed fields mid-request. The chat route constructs the
	 * accumulator before it has finished resolving the prompt-mode /
	 * editing flags (those depend on an app-existence check that follows
	 * the accumulator creation). No-op after `flush()` so a late caller
	 * cannot silently rewrite a finalized summary.
	 *
	 * Accepts a `Partial` so callers can update individual fields without
	 * rebuilding the whole config — and so the signature stays robust if
	 * future fields are added to `AccumulatorRunConfig`.
	 */
	configureRun(fields: Partial<AccumulatorRunConfig>): void {
		if (this._finalized) return;
		Object.assign(this.seed, fields);
	}

	/** Current snapshot — used by the run summary writer + tests. */
	snapshot(): Omit<RunSummaryDoc, "finishedAt"> {
		return {
			runId: this.seed.runId,
			startedAt: this.startedAt,
			promptMode: this.seed.promptMode,
			appReady: this.seed.appReady,
			moduleCount: this.seed.moduleCount,
			stepCount: this.stepCount,
			model: this.seed.model,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			cacheReadTokens: this.cacheReadTokens,
			cacheWriteTokens: this.cacheWriteTokens,
			costEstimate: estimateCost(
				this.seed.model,
				this.inputTokens,
				this.outputTokens,
				this.cacheReadTokens,
				this.cacheWriteTokens,
			),
			toolCallCount: this.toolCallCount,
		};
	}

	/**
	 * Flush both write targets. Idempotent. Safe to call from the execute
	 * finally block, onFinish, AND the abort handler — the first call does
	 * the work; subsequent calls no-op.
	 *
	 * Write ordering:
	 * - Run summary is always written (awaited, transactional), even on
	 *   zero-cost edit replays, so inspect tools have a row to display
	 *   and multi-turn threads accumulate correctly.
	 * - Monthly increment fires whenever there was real cost — failed runs
	 *   included. The dollar spend always accrues so the backstop sees
	 *   retry spam from a user hammering a broken app. (Zero-cost runs skip it:
	 *   `incrementUsage` would bump `request_count` without matching spend.)
	 * - Credit refund fires when a reservation was booked AND the run did no
	 *   billable work — it FAILED (broke the app) or produced zero cost. These
	 *   two are INDEPENDENT decisions: a failed run with real cost both accrues
	 *   the cost (above) and refunds the reservation (below). The refund targets
	 *   the period CAPTURED at reservation (`chargePeriod`), not the period at
	 *   flush time, so a flush that crosses midnight un-books the right month.
	 *
	 * All three writes swallow their own errors (fire-and-forget semantics from
	 * the caller's perspective) so finalization never blocks on observability
	 * failures.
	 */
	async flush(): Promise<void> {
		if (this._finalized) return;
		this._finalized = true;

		const snap = this.snapshot();
		const summary: RunSummaryDoc = {
			...snap,
			finishedAt: new Date().toISOString(),
		};

		/* Awaited so Cloud Run's cold-kill after response resolution can't
		 * truncate the summary write. `writeRunSummary` catches its own
		 * errors, so we don't wrap in try/catch here. The returned action
		 * (created / incremented / overwritten / failed) feeds the finalize
		 * log below — an `overwritten` is a silent clobber worth seeing. */
		const summaryAction = await writeRunSummary(
			this.seed.appId,
			this.seed.runId,
			summary,
		);

		// Branch 1 — dollar spend. Accrues whenever the SA ran (including a
		// failed run, so the dollar backstop counts retry spam). Independent
		// of the refund below.
		if (summary.costEstimate > 0) {
			try {
				await incrementUsage(this.seed.userId, {
					input_tokens: summary.inputTokens,
					output_tokens: summary.outputTokens,
					cost_estimate: summary.costEstimate,
				});
			} catch (err) {
				log.error("[UsageAccumulator] monthly increment failed", err, {
					userId: this.seed.userId,
				});
			}
		}

		// Branch 2 — credit refund. Only when a reservation was booked
		// (`didReserve`, with its amount + period) AND the run earned nothing
		// chargeable — it failed or produced zero cost. The `didReserve` gate
		// stops a free continuation (which never reserved) from phantom-refunding.
		// `refundReason` is computed (not just a boolean) so the finalize log can
		// distinguish a legitimate failed-run refund from a `zero-cost` refund,
		// which on a run that actually did work is the wrong-refund symptom of a
		// flush that captured an empty accumulator.
		const reservationBooked =
			this.seed.didReserve &&
			!!this.seed.reservedAmount &&
			!!this.seed.chargePeriod;
		const refundReason: "run-failed" | "zero-cost" | null = !reservationBooked
			? null
			: this._runFailed
				? "run-failed"
				: summary.costEstimate === 0
					? "zero-cost"
					: null;
		if (
			refundReason !== null &&
			this.seed.chargePeriod &&
			this.seed.reservedAmount
		) {
			try {
				// The marker (period + amount) lives on the app doc, co-committed with
				// the debit at reserve time, so the refund reads it from there — and
				// settles it atomically, so the reaper can never double-refund a hold
				// this live flush already returned. Passing `runId` ownership-gates it:
				// a run that was reaped mid-flight + its app re-claimed must not claw the
				// new run's live marker (its `reserveCredits` overwrote `runId`).
				await refundReservation(
					this.seed.appId,
					this.seed.runId,
					this.seed.promptMode,
				);
			} catch (err) {
				/* The refund was owed but its transaction did not commit. Record it so
				 * the route leaves the row reapable (rather than flipping to a status the
				 * reaper skips) and the finalize log reports the true outcome. */
				this._refundFailed = true;
				log.error("[UsageAccumulator] credit refund failed", err, {
					userId: this.seed.userId,
				});
			}
		}

		/* One structured line per request finalization — the single place to
		 * read, per POST of a thread, what this flush recorded versus dropped.
		 * It makes three otherwise-invisible failures self-evident from one log
		 * search: an all-zero `stepCount`/`toolCallCount` on a run that did real
		 * work, a `summaryAction: "overwritten"` clobber, and a
		 * `refundReason: "zero-cost"` that handed a build's credits back because
		 * the flush saw no cost. Info level — it fires once per finalize and the
		 * payload is numeric counters + identifiers, no user content. */
		log.info("[run-finalize]", {
			appId: this.seed.appId,
			runId: this.seed.runId,
			userId: this.seed.userId,
			promptMode: this.seed.promptMode,
			stepCount: summary.stepCount,
			toolCallCount: summary.toolCallCount,
			inputTokens: summary.inputTokens,
			outputTokens: summary.outputTokens,
			cacheReadTokens: summary.cacheReadTokens,
			cacheWriteTokens: summary.cacheWriteTokens,
			costEstimate: summary.costEstimate,
			summaryAction,
			didReserve: this.seed.didReserve ?? false,
			reservedAmount: this.seed.reservedAmount ?? 0,
			/* `refunded` is the OUTCOME (the refund actually committed), not the
			 * intent — a refund that was owed (`refundReason`) but whose transaction
			 * threw logs `refunded: false` + `refundFailed: true`, so the cost
			 * investigation can't be misled into thinking credits were handed back. (Scope: this is FLUSH's
			 * this-POST refund; a multi-POST hold refunded by the route's post-flush
			 * `refundReservation` — e.g. a free continuation failing — settles on the
			 * marker + the credit doc and is not reflected in this line.) */
			refunded: refundReason !== null && !this._refundFailed,
			refundReason,
			refundFailed: this._refundFailed,
			accruedCost: summary.costEstimate > 0,
			sentMessageCount: this.seed.sentMessageCount,
			sentMessageChars: this.seed.sentMessageChars,
		});
	}
}
