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

/** Rebuild the query string the page was opened with. */
export function consentQuery(searchParams: ConsentSearchParams): string {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(searchParams)) {
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			query.append(key, item);
		}
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
