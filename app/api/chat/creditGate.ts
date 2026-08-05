import type { UIMessage } from "ai";
import {
	CREDITS_PER_BUILD,
	CREDITS_PER_EDIT,
	isChargeableTurn,
} from "@/lib/db/creditPolicy";

/**
 * The credit-gate decision for one `/api/chat` POST: whether this request is a
 * chargeable new generation and, if so, the amount its ADVISORY pre-flight
 * balance read should require.
 *
 * Pure on purpose: it lifts the charge-signal read (`isChargeableTurn`) and
 * the floor selection out of the route so they can be unit-tested without
 * standing up the whole handler, and so the route reads as a single
 * destructure at the top of the gate.
 *
 * `preflightCost` is deliberately NOT the authoritative charge. The real
 * amount depends on the app row's status, which isn't loaded yet at the
 * gate; the claim/reservation transaction re-checks affordability against the
 * authoritative amount and rolls back cleanly on a shortfall. So this figure
 * only needs two properties: on a NEW build (`existingApp: false`) it is the
 * exact build rate, checked before `createApp` so an unaffordable first turn
 * can't mint an orphan app; on an EXISTING app it is the CHEAPEST chargeable
 * amount (the edit rate), a floor that can never falsely reject an affordable
 * turn whatever mode the app row turns out to be in. Feeding a client-claimed
 * mode in here instead would let a stale tab's guess 429 a user who can
 * afford their edit. (There is deliberately no follow-up read at the derived
 * rate once the row is loaded: the claim transaction rejects an unaffordable
 * direct-path turn pre-stream anyway, and a queued turn's final rate is only
 * decided at the winning poll, where a build-derived turn usually adopts the
 * edit rate, so a derived-rate reject would break this floor property.)
 *
 * CRITICAL: `rawMessages` must be the array straight off `body.messages`.
 * The last message's ROLE is the charge signal (a fresh instruction ends with
 * `user`; an answered-askQuestions auto-resend ends with `assistant` and
 * rides free), so any transform of the history the SA receives, the
 * tool-part sanitizer today, anything else tomorrow: must never feed back
 * into this read: a transform that leaves a `user` message last would mark
 * every clarification round-trip chargeable and silently break the
 * free-continuation property.
 */
export function creditGateDecision(input: {
	rawMessages: readonly UIMessage[];
	existingApp: boolean;
}): { chargeable: boolean; preflightCost: number } {
	const chargeable = isChargeableTurn(input.rawMessages);
	// A non-chargeable continuation costs nothing: no reservation, no debit. The
	// amount is only meaningful when `chargeable` is true. Spelled with the rate
	// constants directly, NOT `chargeAmount(...)`: its parameter is `appReady`,
	// and "existing app" is a different fact that merely happens to want the
	// same two numbers today — the floor must not silently follow a future
	// change to the charge rule.
	const floor = input.existingApp ? CREDITS_PER_EDIT : CREDITS_PER_BUILD;
	return {
		chargeable,
		preflightCost: chargeable ? floor : 0,
	};
}
