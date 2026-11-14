/**
 * What Settings says when CommCare HQ did not answer a key's check.
 *
 * The sentence is chosen by the failure's kind. Two kinds cut across
 * statuses, an edge's refusal and a page for a browser, and those are worded
 * by their status, so each answer prints the sentence it always has.
 */

import type { HqFailure } from "@/lib/commcare/hq/failure";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";

const RATE_LIMITED =
	"Rate limited by CommCare HQ. Wait a moment and try again.";
const UNAVAILABLE = "CommCare HQ is unavailable. Try again later.";
const REVOKED =
	"CommCare HQ no longer accepts your stored API key, it may have been revoked or expired. Disconnect and reconnect with a new key.";

/**
 * A key CommCare HQ did not accept, by when it was tried. A key just typed
 * names the server it was tried against: the US, India and EU servers are
 * separate installations with separate accounts, and a key carries no hint
 * of which one issued it, so a rejected key very often means a valid key on
 * the wrong server. A stored key has worked before, so its rejection means
 * it stopped being accepted.
 */
function keySentence(context: SettingsFailureContext): string {
	if (context.moment === "refresh") return REVOKED;
	const { label, host } = COMMCARE_SERVERS[context.server];
	return `CommCare HQ (${label}: ${host}) rejected this API key. Check that you copied it correctly, and that ${label} is the server where your account lives, a key only works on the server that issued it.`;
}

/**
 * When the key was tried: `verify` for a key just typed, against `server`;
 * `refresh` for the stored one, whose sentences name no server.
 */
export type SettingsFailureContext =
	| { readonly moment: "verify"; readonly server: CommCareServer }
	| { readonly moment: "refresh" };

export function settingsFailureMessage(
	failure: HqFailure,
	context: SettingsFailureContext,
): string {
	switch (failure.kind) {
		case "key-not-accepted":
		case "plan-lacks-api-access":
		case "api-cut-off":
			return keySentence(context);
		case "rate-limited":
			return RATE_LIMITED;
		case "hq-unavailable":
		case "timed-out":
		case "too-large":
		case "answer-unreadable":
			return UNAVAILABLE;
		case "gateway-refused":
		case "browser-only":
			if (failure.status === 401) return keySentence(context);
			if (failure.status === 429) return RATE_LIMITED;
			if (failure.status >= 500) return UNAVAILABLE;
			return statusSentence(failure.status);
		case "not-a-member":
		case "permission":
		case "not-found":
		case "refused":
			return statusSentence(failure.status);
	}
}

function statusSentence(status: number): string {
	return `CommCare HQ returned an error (HTTP ${status}).`;
}
