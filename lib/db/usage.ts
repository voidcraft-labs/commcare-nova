/**
 * Usage tracking — per-user monthly spend aggregation.
 *
 * Reads and writes to `users/{userId}/usage/{yyyy-mm}` documents.
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
import { docs } from "./firestore";
import type { UsageDoc } from "./types";

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
