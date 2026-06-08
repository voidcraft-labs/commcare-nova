/**
 * Period leaf — the calendar-month identity shared by both Firestore ledgers.
 *
 * This module is a deliberate leaf: it imports nothing from `usage` or
 * `credits`. Both of those ledgers key their per-month documents by the same
 * `yyyy-mm` period string, and `credits.ts` needs the period while `usage.ts`
 * imports the refund from `credits.ts`. Were `getCurrentPeriod` left in
 * `usage.ts`, that pairing would form a runtime `usage ↔ credits` import cycle;
 * hoisting the one shared function into this leaf breaks it cleanly so the
 * dependency runs one-directional (`usage → credits → period`).
 */

/**
 * The current calendar month as a `yyyy-mm` string (e.g. "2026-06"), used as
 * the Firestore document id for both the usage and credit monthly rollups.
 *
 * UTC-based via the local `Date` getters as Cloud Run runs in UTC, so every
 * instance agrees on the period boundary and no two instances can disagree
 * about which month a charge lands in.
 */
export function getCurrentPeriod(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
