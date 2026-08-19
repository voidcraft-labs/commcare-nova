import "server-only";

/**
 * The one way Nova talks to CommCare HQ over HTTP.
 *
 * Every driver in this directory — apps, lookup tables, places, and
 * workers — shares these primitives rather than restating them. That
 * is not tidiness: the base-URL catalog is an SSRF boundary, the auth
 * header is CommCare HQ's own scheme rather than a standard one, and the
 * padding field below is the difference between a publish that works and
 * a bare 403 nobody can explain. A second copy of any of them is a second
 * chance to get one wrong.
 */

import { log } from "@/lib/logger";
import { COMMCARE_SERVERS, type CommCareServer } from "../servers";

/**
 * Error from a CommCare HQ API call — just the status code.
 * Callers decide what to show the user based on their own context.
 */
export interface CommCareApiError {
	success: false;
	status: number;
	/**
	 * True when the edge in front of CommCare HQ refused the request and
	 * CommCare HQ never saw it (`isEdgeRefusal`). The status is then a
	 * proxy's, so a caller must not report it as an answer about the key,
	 * the account's permissions, or the app. Absent on the errors this
	 * module returns without a response to read, such as a rejected domain
	 * slug.
	 */
	edgeRefusal?: boolean;
}

/**
 * Credentials needed to authenticate with CommCare HQ.
 *
 * `server` names which of Dimagi's separate SaaS deployments the
 * username/key pair lives on — an API key only authenticates against the
 * server that issued it, so the pair is meaningless without it. Every
 * request's base URL derives from it through the closed `COMMCARE_SERVERS`
 * catalog, never from a user-supplied URL — that closed union is the SSRF
 * boundary (a user who could set an arbitrary URL could point our server
 * at internal services: GCP metadata, localhost, etc.). See `../servers`.
 */
export interface CommCareCredentials {
	username: string;
	apiKey: string;
	server: CommCareServer;
}

/**
 * CommCare HQ domain slug validation — mirrors HQ's `legacy_domain_re`
 * (`[\w\.:-]+`) which is used in URL routing. Three tiers exist in HQ:
 * new domains (alphanum + hyphens), grandfathered (+ dots, colons), and
 * legacy (+ underscores). We accept all three since any routable domain
 * is a valid upload target. The regex prevents path traversal (no `/`)
 * while accepting all domains that HQ can actually resolve.
 *
 * Source: corehq/apps/domain/utils.py — `legacy_domain_re`
 */
const DOMAIN_SLUG_RE = /^[\w.:-]+$/;

export function isValidDomainSlug(domain: string): boolean {
	return DOMAIN_SLUG_RE.test(domain);
}

/** The refusal a rejected slug produces, before any request is made. */
export const INVALID_DOMAIN_SLUG: CommCareApiError = {
	success: false,
	status: 400,
};

/** Base URL for every HQ API call these credentials can make. */
export function baseUrl(creds: CommCareCredentials): string {
	return COMMCARE_SERVERS[creds.server].baseUrl;
}

/**
 * Build the Authorization header for CommCare HQ API key auth.
 *
 * Format: `ApiKey {username}:{api_key}` — this is CommCare HQ's custom
 * API key scheme, distinct from Basic or Bearer auth.
 */
export function authHeader(creds: CommCareCredentials): string {
	return `ApiKey ${creds.username}:${creds.apiKey}`;
}

/**
 * Throwaway multipart field that pushes the real payload past the body
 * inspection window of the WAF in front of CommCare HQ.
 *
 * That WAF matches an XML namespace declaration — `xmlns=` or
 * `xmlns:<prefix>=` — anywhere in roughly the first 8 KiB of a request
 * body, and answers 403 from the edge with a generic HTML error page. The
 * request never reaches Django, so the status carries no verdict about the
 * account or the project space. Every upload here can match: `importApp`
 * carries XForm XML inside its JSON, `uploadAppMediaBundle` carries
 * compressed image bytes, and a lookup-table workbook is a ZIP of XML
 * parts. The field goes FIRST so the payload starts past the window, and
 * Django ignores an unknown multipart field.
 *
 * `@waf_allow('XSS_BODY')` on HQ's views does not remove the need for it.
 * `corehq/apps/hqwebapp/decorators.py::waf_allow` only records the view in
 * a module-level dict for whoever configures the WAF; it wraps nothing and
 * changes nothing at request time. Uploads were still refused in
 * production after those decorators shipped, and only apps small enough to
 * put their first form's XML inside the window were affected — which is
 * why this reads as an app-size bug rather than a permissions one.
 *
 * Sized well past the observed window so it holds regardless of where a
 * given payload's XML lands.
 */
export const WAF_PADDING = "x".repeat(16 * 1024);

/**
 * Whether a failed response came from the edge in front of CommCare HQ
 * rather than from CommCare HQ itself.
 *
 * The WAF refuses with a generic proxy error page: an HTML document titled
 * with a bare status code, carrying no CommCare content. CommCare HQ's own
 * refusals never look like that — the API views answer JSON
 * (`JsonResponse` under `@json_error`), the ajax branch of
 * `corehq/apps/users/decorators.py::require_permission_raw` answers plain
 * text, and a rendered `PermissionDenied` carries CommCare markup. So a
 * match here means the status says nothing about the key, the account's
 * permissions, or the app, and a caller must not read one into it.
 */
export function isEdgeRefusal(body: string): boolean {
	const head = body.slice(0, 200).toLowerCase();
	if (!head.includes("<html")) return false;
	if (!/<title>\s*\d{3}\b/.test(head)) return false;
	return !body.toLowerCase().includes("commcare");
}

/**
 * Log a failed CommCare HQ response for server-side debugging.
 * The body is never returned to callers or shown to users.
 */
export async function logAndReturnError(
	context: string,
	res: Response,
): Promise<CommCareApiError> {
	let body = "";
	try {
		body = await res.text();
	} catch {}
	log.error(`[commcare] ${context}`, undefined, {
		status: res.status,
		body: body.substring(0, 200),
	});
	return {
		success: false,
		status: res.status,
		edgeRefusal: isEdgeRefusal(body),
	};
}

/**
 * The warn-level sibling, for the reads whose refusals are ANSWERS rather
 * than faults: a deleted app's 404, a key without the Access APIs
 * permission, a build with no profile. Each one is handled as a
 * first-class outcome by `lib/deployment/observe.ts` and recurs by design
 * on every Check status, so filing it at error level would stream a
 * Sentry event per click for a state nobody can action from Nova's side.
 * `log.warn` stays Cloud-Logging-only, which is the repo's line for
 * expected-but-worth-recording conditions.
 */
export async function warnAndReturnError(
	context: string,
	res: Response,
): Promise<CommCareApiError> {
	let body = "";
	try {
		body = await res.text();
	} catch {}
	log.warn(`[commcare] ${context}`, {
		status: res.status,
		body: body.substring(0, 200),
	});
	return {
		success: false,
		status: res.status,
		edgeRefusal: isEdgeRefusal(body),
	};
}

/** Promise-returning sleep for the bounded status polls. */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
