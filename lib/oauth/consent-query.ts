/**
 * The signed authorization query the consent page is opened with.
 *
 * The `oauth-provider` plugin's authorize handler redirects to `/consent`
 * with the original authorization request plus an `exp` timestamp and a `sig`
 * HMAC over the whole query. The page checks that signature before it reads
 * anything about the client, so a hand-typed or forged link shows the
 * invalid-request screen and never reaches a client lookup.
 */

import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";

/** A page's `searchParams`: a repeated key arrives as an array. */
export type ConsentSearchParams = Record<string, string | string[] | undefined>;

/** The parameter the authorize handler lists every signed name under. */
const SIGNED_NAMES = "ba_param";

const values = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * Rebuild the signed part of the query the page was opened with: `sig`, the
 * list of signed names, and the parameters that list names. This is the same
 * selection the plugin's client posts with the decision, so a parameter the
 * link picked up on the way (a tracking tag, say) doesn't turn a request the
 * decision would accept into an invalid one. A query that lists no names is
 * passed whole and fails verification.
 */
export function consentQuery(searchParams: ConsentSearchParams): string {
	const signed = new Set(values(searchParams[SIGNED_NAMES]));
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(searchParams)) {
		const kept =
			signed.size === 0 ||
			key === "sig" ||
			key === SIGNED_NAMES ||
			signed.has(key);
		if (!kept) continue;
		for (const item of values(value)) query.append(key, item);
	}
	return query.toString();
}

/**
 * Whether the plugin's authorize handler issued this query and it has not
 * expired. `secret` is the auth instance's own (`auth.$context`).
 */
export function isSignedConsentRequest(
	searchParams: ConsentSearchParams,
	secret: string,
): Promise<boolean> {
	return verifyOAuthQueryParams(consentQuery(searchParams), secret);
}
