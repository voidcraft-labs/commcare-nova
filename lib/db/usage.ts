/**
 * Usage tracking — per-user monthly ACTUAL-dollar cost aggregation.
 *
 * Reads and writes `usage/{userId}/months/{yyyy-mm}` documents (period string
 * = doc ID, so a read is a single document fetch). This is the accumulate-only
 * cost record: increments are atomic via FieldValue.increment(), and nothing
 * ever resets it — an admin credit reset/grant touches the parallel `credits/`
 * ledger, never this one. Its sole gate consumer is the invisible
 * `ACTUAL_COST_BACKSTOP_USD` ($50) runaway guard, which reads the running
 * `cost_estimate` via `getMonthlyUsage`. The user-facing quota is credits,
 * not dollars — see `./credits`.
 *
 * Fail-closed: the route wraps the pre-request `getMonthlyUsage` read in a
 * try/catch — if Firestore is down, the read fails → 503. No separate retry or
 * pending mechanism: a Firestore outage that blocks writes also blocks reads.
 */
import { FieldValue } from "@google-cloud/firestore";
import { log } from "@/lib/logger";
import { DEFAULT_PRICING, MODEL_PRICING } from "@/lib/models";
import { refundCredits } from "./credits";
import { docs } from "./firestore";
import { getCurrentPeriod } from "./period";
import { writeRunSummary } from "./runSummary";
import type { RunSummaryDoc, UsageDoc } from "./types";

// ── Read ──────────────────────────────────────────────────────────

/**
 * Load the current month's usage for a user. Returns null if no usage
 * document exists yet (first request of the month). The Zod converter
 * validates the read and fills defaults (all counters default to 0).
 *
 * This is a blocking read — used for the pre-request actual-$ backstop check.
 */
export async function getMonthlyUsage(
	userId: string,
): Promise<UsageDoc | null> {
	const snap = await docs.usage(userId, getCurrentPeriod()).get();
	return snap.exists ? (snap.data() ?? null) : null;
}

// ── Write ─────────────────────────────────────────────────────────

/** Deltas to increment on the usage document after a request completes. */
interface UsageIncrement {
	input_tokens: number;
	output_tokens: number;
	cost_estimate: number;
}

/**
 * Atomically increment the current month's usage counters for a user.
 * Single attempt, throws on failure — consistent with every other
 * Firestore write in the codebase. The pre-request backstop check (read)
 * is the fail-closed gate; if Firestore is down for writes, it's down
 * for reads too, and the route returns 503.
 *
 * Uses set({ merge: true }) with FieldValue.increment() so the document
 * is created automatically on the first request of a new month. No
 * separate create path, no read-then-write race conditions.
 */
export async function incrementUsage(
	userId: string,
	deltas: UsageIncrement,
): Promise<void> {
	await docs.usage(userId, getCurrentPeriod()).set(
		{
			input_tokens: FieldValue.increment(deltas.input_tokens),
			output_tokens: FieldValue.increment(deltas.output_tokens),
			cost_estimate: FieldValue.increment(deltas.cost_estimate),
			request_count: FieldValue.increment(1),
			updated_at: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
}

// ── Cost estimation ───────────────────────────────────────────────

/**
 * Estimate USD cost from token counts using `MODEL_PRICING`.
 *
 * Convention: `inputTokens` is the TOTAL input count for the call, INCLUDING
 * any cache-read and cache-write tokens. The uncached portion is derived
 * by subtracting both cache buckets, so callers must not pre-subtract.
 * Unknown model IDs fall back to `DEFAULT_PRICING` (Sonnet rates) — pricing
 * gaps should still produce a believable number rather than zero.
 *
 * `uncachedInput` is floored at zero: if a caller mis-reports cache tokens
 * such that the sum exceeds `inputTokens`, a negative uncached count would
 * flow into `FieldValue.increment` and corrupt the monthly actual-$ counter
 * (and misreport the run summary). Clamp here rather than trust the source.
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
	freshEdit: boolean;
	appReady: boolean;
	cacheExpired: boolean;
	moduleCount: number;
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
	freshEdit: boolean;
	appReady: boolean;
	cacheExpired: boolean;
	moduleCount: number;
}

/**
 * Per-request LLM usage accumulator. `flush()` fans out to the monthly
 * actual-$ document and the per-run summary doc (and refunds the credit
 * reservation on a no-op/failed run) — see the two methods for the
 * contracts they own.
 */
export class UsageAccumulator {
	/* `configureRun` replaces this field with a fresh object rather than
	 * mutating in place, which lets us mark it `readonly` honestly. */
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
	 * accrues its actual $ cost (the $50 backstop must see retry spam) but hands
	 * the reserved credits back — the user isn't charged for a broken result. */
	private _runFailed = false;

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
			freshEdit: this.seed.freshEdit,
			appReady: this.seed.appReady,
			cacheExpired: this.seed.cacheExpired,
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
	 *   included. The actual $ spend always accrues so the $50 backstop sees
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
		 * errors, so we don't wrap in try/catch here. */
		await writeRunSummary(this.seed.appId, this.seed.runId, summary);

		// Branch 1 — actual spend. Accrues whenever the SA ran (including a
		// failed run, so the $50 backstop counts retry spam). Independent of the
		// refund below.
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
		if (
			this.seed.didReserve &&
			this.seed.reservedAmount &&
			this.seed.chargePeriod &&
			(this._runFailed || summary.costEstimate === 0)
		) {
			try {
				await refundCredits(
					this.seed.userId,
					this.seed.chargePeriod,
					this.seed.reservedAmount,
				);
			} catch (err) {
				log.error("[UsageAccumulator] credit refund failed", err, {
					userId: this.seed.userId,
				});
			}
		}
	}
}
