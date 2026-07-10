/**
 * Credit policy — the constants and the pure cost rules for the credit gate.
 *
 * This module is the single source of truth for the credit amounts. It is
 * deliberately dependency-free at runtime: every import is `import type`, so
 * nothing here pulls Kysely, `pg`, Zod, or any server code into a bundle. That
 * is load-bearing — the server credit ledger, the `/api/chat` gate, AND the
 * chat send-button cost indicator all read the amounts and rules from here, and
 * the send-button runs in the browser. Were any import a value import (dropping
 * the `type` keyword), `creditPolicy` would drag `./types` — and through it the
 * Kysely / `pg` handle in `./pg` — into the client bundle. Keep every import
 * type-only.
 *
 * The constants live with the credit gate they govern (the credit family), not
 * in the model-config module, which holds only model-keyed IDs and per-token
 * pricing. These are gate/quota policy, not model rates.
 */
import type { UIMessage } from "ai";
import type { CreditMonthDoc } from "./types";

/**
 * Penny anchor: 1 credit = $0.01. Not used by the gate itself — it converts a
 * credit count to a lightly-visible dollar hint in the admin/user surfaces.
 */
export const CREDITS_PER_DOLLAR = 100;

/** Cost of a new-app generation ($1). A build is the meaningful credit unit. */
export const CREDITS_PER_BUILD = 100;

/**
 * Cost of an edit to an existing app ($0.05). Deliberately cheap — priced on
 * perceived value so iterating feels nearly free, decoupled from the fact that
 * an edit can currently cost more in actual dollars than a build (a cache-expiry
 * artifact the actual-$ backstop and the cost ledger guard and track separately).
 */
export const CREDITS_PER_EDIT = 5;

/**
 * Monthly per-user grant — roughly 20 builds, or hundreds of edits. Resets to a
 * fresh 2000 each calendar month with no rollover and no cron: each period is
 * its own row, and the first chargeable turn of a new month seeds it.
 */
export const MONTHLY_CREDIT_ALLOWANCE = 2000;

/**
 * Invisible per-user monthly dollar runaway guard. Flat-credit pricing doesn't
 * track dollars, so this caps a worst-case runaway (and refund-farming, since
 * a failed run still accrues cost). The gate trips on the LARGER of the two
 * accumulated `usage_months` counters — the token-math `cost_estimate` and
 * the gateway-metered `actual_cost` — so a divergence in either direction
 * still stops a runaway. Never trips in normal use; the dollar figure is
 * never surfaced to the user.
 */
export const ACTUAL_COST_BACKSTOP_USD = 300;

/**
 * Spendable balance for a period: `allowance + bonus − consumed`.
 *
 * An absent row reads as a full monthly allowance. A period a user has never
 * touched has no `credit_months` row, and the gate must treat that as a fresh
 * 2000/2000 without forcing a pre-seeding write — so the gate, the dashboard,
 * and any read path share this one default by passing `undefined` here.
 *
 * Takes only the three balance quantities (not the whole `CreditMonthDoc`) so a
 * caller holding raw transaction data or partial fields can compute a balance
 * without first materializing the `updated_at` timestamp.
 */
export function creditBalance(
	doc: Pick<CreditMonthDoc, "allowance" | "consumed" | "bonus"> | undefined,
): number {
	if (!doc) return MONTHLY_CREDIT_ALLOWANCE;
	return doc.allowance + doc.bonus - doc.consumed;
}

/**
 * Credit cost of a chargeable turn, keyed off the build-vs-edit signal.
 *
 * `appReady` is the same boolean the route uses to pick the editing prompt —
 * true once a built app exists for the session. Edits are the cheap unit;
 * builds are the meaningful one. Sharing this function between the server gate
 * and the client cost indicator is why the indicator's displayed cost can never
 * disagree with the actual charge.
 */
export function chargeAmount(appReady: boolean): number {
	return appReady ? CREDITS_PER_EDIT : CREDITS_PER_BUILD;
}

/**
 * Whether a POST is a new user-initiated generation (charge) or a free
 * continuation of one already charged.
 *
 * The signal is the role of the last message: a fresh instruction always
 * appends a `user` message, while an answered-`askQuestions` auto-resend ends
 * with the SA's `assistant` message and belongs to the generation already
 * charged. An empty list (no last message) is non-chargeable.
 *
 * MUST be passed the RAW incoming messages — the array straight off the request
 * body, before the route's last-user-message-only cache-expiry transform. That
 * transform would leave a `user` message last on every POST and silently break
 * the free-continuation property, so reading the transformed array here would
 * charge for every clarification round-trip.
 */
export function isChargeableTurn(rawMessages: readonly UIMessage[]): boolean {
	const last = rawMessages.at(-1);
	return last?.role === "user";
}
