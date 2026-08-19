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

/**
 * The statuses CommCare HQ produces BEFORE the view that would do the
 * work ever runs.
 *
 * Each one is read in source rather than assumed. Tastypie's
 * `resources.py::dispatch` runs `method_check` (405), then
 * `is_authenticated` (401/403), then `throttle_check` (429), and only
 * then calls the method — and answers 501 when the resource declares no
 * handler at all. `api/decorators.py::api_throttle`, which the fixapi
 * view carries, returns its own 429 without calling the view. 413 never
 * reaches application code. And 400 is where every API view raises its
 * own complaint up front: `v0_5.py::CommCareUserResource.obj_create`
 * raises all of its before `CommCareUser.create`, `::obj_update` raises
 * its gathered errors before `bundle.obj.save()`.
 *
 * 400 carries one residual, kept deliberately. `Meta.always_return_data`
 * makes `post_list` dehydrate AFTER the commit, and a `fields.ApiFieldError`
 * raised there also becomes a 400. Treating every 400 as unknown was the
 * alternative, and it would put a "this may exist, here is its password"
 * warning on the ordinary refusals — a taken username, a weak password —
 * where it is wrong nearly every time, which is how a warning stops being
 * read. So 400 settles it, and the rare shape it cannot see is named here
 * rather than papered over.
 */
const SETTLED_BEFORE_THE_VIEW: ReadonlySet<number> = new Set([
	400, 401, 403, 405, 413, 429, 501,
]);

/**
 * Whether a refused write may have taken effect on CommCare HQ anyway.
 *
 * One definition for every driver that writes, because it is the most
 * safety-critical judgement any of them makes and two spellings of it
 * would drift. Answering "nothing landed" wrongly is the expensive
 * direction: the caller records no mapping and discards whatever the
 * write produced, and for a mobile worker that is a live account whose
 * generated password existed only in the answer being thrown away.
 *
 * `edgeRefusal` is consulted rather than ignored, and its two halves
 * point opposite ways. An edge answering a 4xx REFUSED the request, so
 * CommCare HQ never saw it and nothing landed. An edge answering 502 or
 * 504 did the opposite: it forwarded the request and then gave up
 * waiting, so CommCare HQ most likely received it and ran it. Reading a
 * gateway timeout as "never arrived" is what discards a credential in
 * precisely the case this exists for.
 *
 * Everything the set does not name counts as landed. That includes a
 * 404, because `always_return_data` makes `resources.py::post_list`
 * dehydrate after the commit and
 * `::get_response_class_for_exception` turns an `ObjectDoesNotExist`
 * raised there into a 404 over a resource that already exists, and a
 * 406, which `create_response` raises later still.
 */
export function writeMayHaveLanded(
	status: number,
	edgeRefusal?: boolean,
): boolean {
	if (edgeRefusal === true) return status >= 500;
	return !SETTLED_BEFORE_THE_VIEW.has(status);
}

/** Promise-returning sleep for the bounded status polls. */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
