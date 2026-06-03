import type { UIMessage } from "ai";
import { chargeAmount, isChargeableTurn } from "@/lib/db/creditPolicy";

/**
 * The credit-gate decision for one `/api/chat` POST: whether this request is a
 * chargeable new generation and, if so, how many credits it costs.
 *
 * Pure on purpose — it lifts the two policy reads (`isChargeableTurn` +
 * `chargeAmount`) out of the route so they can be unit-tested without standing
 * up the whole handler, and so the route reads as a single destructure at the
 * top of the gate.
 *
 * CRITICAL — `rawMessages` must be the array straight off `body.messages`,
 * BEFORE the route's message-strategy transform (the `editing && cacheExpired`
 * last-user-message-only path). That transform leaves a `user` message last on
 * every POST, so reading the transformed array here would mark every
 * clarification round-trip chargeable and silently break the free-continuation
 * property. The amount keys off `appReady` (from the raw request body), so it is
 * unaffected by the transform — but the charge-or-not signal is, hence the
 * raw-array requirement.
 */
export function creditGateDecision(input: {
	rawMessages: readonly UIMessage[];
	appReady: boolean;
}): { chargeable: boolean; cost: number } {
	const chargeable = isChargeableTurn(input.rawMessages);
	// A non-chargeable continuation costs nothing: no reservation, no debit. The
	// amount is only meaningful when `chargeable` is true.
	return { chargeable, cost: chargeable ? chargeAmount(input.appReady) : 0 };
}
