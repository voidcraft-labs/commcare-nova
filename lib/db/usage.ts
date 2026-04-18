/**
 * Usage tracking — per-user monthly spend aggregation.
 *
 * Reads and writes to `usage/{userId}/months/{yyyy-mm}` documents.
 * Spend cap checks are a single document read (period string = doc ID).
 * Increments are atomic via FieldValue.increment() — safe for concurrent
 * requests from the same user.
 *
 * Fail-closed: the pre-request getMonthlyUsage() read is wrapped in a
 * try/catch by the route — if Firestore is down, the read fails → 503,
 * which blocks the user from continuing. No separate retry or pending
 * mechanism needed — a Firestore outage that blocks writes also blocks reads.
 */
import { FieldValue } from "@google-cloud/firestore";
import { log } from "@/lib/logger";
import { DEFAULT_PRICING, MODEL_PRICING } from "@/lib/models";
import { docs } from "./firestore";
import { writeRunSummary } from "./runSummary";
import type { RunSummaryDoc, UsageDoc } from "./types";

// ── Configuration ─────────────────────────────────────────────────

/**
 * Monthly per-user spend cap in USD. Authenticated users whose cumulative
 * monthly cost reaches this threshold are blocked from further requests
 * until the next calendar month.
 *
 * Set via MONTHLY_SPEND_CAP_USD env var. Default $15 — enough for
 * real work (~7-30 full builds/month), tight enough to prevent
 * runaway costs on the shared Anthropic key.
 */
export const MONTHLY_SPEND_CAP_USD =
	Number(process.env.MONTHLY_SPEND_CAP_USD) || 15;

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Current calendar month as a `yyyy-mm` string (e.g. "2026-04").
 * Used as the Firestore document ID for usage aggregation.
 * UTC-based — consistent across Cloud Run instances.
 */
export function getCurrentPeriod(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Load the current month's usage for a user. Returns null if no usage
 * document exists yet (first request of the month). The Zod converter
 * validates the read and fills defaults (all counters default to 0).
 *
 * This is a blocking read — used for the pre-request spend cap check.
 */
export async function getMonthlyUsage(
	userId: string,
): Promise<UsageDoc | null> {
	const snap = await docs.usage(userId, getCurrentPeriod()).get();
	return snap.exists ? (snap.data() ?? null) : null;
}

// ── Write ─────────────────────────────────────────────────────────

/** Deltas to increment on the usage document after a request completes. */
export interface UsageIncrement {
	input_tokens: number;
	output_tokens: number;
	cost_estimate: number;
}

/**
 * Atomically increment the current month's usage counters for a user.
 * Single attempt, throws on failure — consistent with every other
 * Firestore write in the codebase. The pre-request cap check (read)
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
 * flow into `FieldValue.increment` and corrupt the monthly spend counter
 * (and misreport the run summary). Clamp here rather than trust the source.
 *
 * Exported so admin inspect scripts (Task 18) can recompute costs from
 * stored run summaries without depending on the accumulator class.
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
export interface LLMCallUsage {
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
}

/** Fields that can be updated mid-request via `configureRun`. */
export interface AccumulatorRunConfig {
	promptMode: "build" | "edit";
	freshEdit: boolean;
	appReady: boolean;
	cacheExpired: boolean;
	moduleCount: number;
}

/**
 * Accumulates per-request LLM usage for two write targets:
 *
 * 1. **Monthly spend cap** — `incrementUsage(userId, …)` at request end.
 *    This path is fail-closed via the pre-request `getMonthlyUsage` read
 *    (see route handler); an error here logs but does not re-throw —
 *    observability writes must never break the response.
 * 2. **Per-run summary doc** — `writeRunSummary(appId, runId, …)` with
 *    full token + cost breakdown for admin inspect tools. The event log
 *    itself does NOT carry token usage (spec §5), so this is the only
 *    persistence surface for per-run cost observability.
 *
 * `track({…}, {step: true})` marks an outer agent step (vs. a sub-gen
 * inside a tool). `stepCount` goes onto the run summary for admin use.
 * Sub-gen usage still accumulates into the totals — just not step count.
 *
 * `flush()` is idempotent via a `_finalized` guard so the route can call
 * it from multiple places (finally block, onFinish, abort handler)
 * without double-writing. `configureRun` is a separate no-op after
 * finalization — late config mutations from a completing request must
 * not appear in the summary under a new `finishedAt`.
 */
export class UsageAccumulator {
	// Non-readonly because configureRun mutates fields in place — keeping the
	// declaration honest avoids the reader pausing on `readonly` + Object.assign.
	// `private` still prevents call sites from bypassing the finalized guard.
	private seed: AccumulatorSeed;
	private readonly startedAt: string;
	private inputTokens = 0;
	private outputTokens = 0;
	private cacheReadTokens = 0;
	private cacheWriteTokens = 0;
	private stepCount = 0;
	private toolCallCount = 0;
	private _finalized = false;

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
	 * - Run summary is always written (fire-and-forget), even on zero-cost
	 *   edit replays, so inspect tools have a row to display.
	 * - Monthly increment is skipped for zero-cost runs — `incrementUsage`
	 *   would otherwise bump `request_count` without matching spend.
	 */
	async flush(): Promise<void> {
		if (this._finalized) return;
		this._finalized = true;

		const snap = this.snapshot();
		const summary: RunSummaryDoc = {
			...snap,
			finishedAt: new Date().toISOString(),
		};

		writeRunSummary(this.seed.appId, this.seed.runId, summary);

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
	}
}
