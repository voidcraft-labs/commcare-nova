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
	/**
	 * Why a read synthesized its status: no answer reached Nova (`network`,
	 * 503), the deadline ran out (`timeout`, 503), the body was longer than
	 * the read's bound (`too-large`, 502), the answer was a page for a browser
	 * where JSON was asked (`browser-page`, 502), or it could not be read as
	 * what was asked for (`malformed`, 502, or 508 for a list whose cursor
	 * never ends). Absent on a status CommCare HQ or its edge answered.
	 */
	cause?: "network" | "timeout" | "malformed" | "too-large" | "browser-page";
	/**
	 * The wait the response's `Retry-After` asked for, in milliseconds, when
	 * it was a count of seconds (`retryAfterMs`). Absent when the response
	 * sent none, sent an HTTP date, or was never read.
	 */
	retryAfterMs?: number;
	/**
	 * The first `HQ_REFUSED_BODY_MAX_CHARS` characters of a refused answer's
	 * body, present only where the read asked for it
	 * (`ReadHqJsonOptions.keepRefusedBody`). Read only inside this module,
	 * never shown and never logged beyond the 200 characters
	 * `warnAndReturnError` already logs.
	 */
	refusedBody?: string;
}

/** The most characters of a refused answer's body a read keeps as `refusedBody`. */
export const HQ_REFUSED_BODY_MAX_CHARS = 2_048;
/** The most bytes of a refused answer's body a read takes in before it cuts `refusedBody`. */
export const HQ_REFUSED_BODY_READ_MAX_BYTES = 64 * 1024;

/**
 * `api/resources/__init__.py::HqBaseResource.dispatch`, the plan refusal:
 * the project space's subscription has no API access. The check runs before
 * tastypie authenticates, so it answers every key, a superuser's included.
 */
export const HQ_API_ACCESS_REFUSAL =
	"Your current subscription does not have access to this feature";
/**
 * The same method's refusal while the `API_BLACKLIST` toggle is on for the
 * request's user or project space. Two spaces after "requests.".
 */
export const HQ_API_CUT_OFF_REFUSAL =
	"API access has been temporarily cut off due to too many requests.  To re-enable, please contact support.";

/**
 * `plan` or `cut-off` where a 401 CommCare HQ itself answered holds exactly
 * one of the two sentences of `HqBaseResource.dispatch` as its `error`, and
 * null for every other answer. Any other 401 is a key HQ did not accept,
 * never a guess at the plan.
 */
export function apiRefusalSentence(
	error: CommCareApiError,
): "plan" | "cut-off" | null {
	if (
		error.status !== 401 ||
		error.edgeRefusal === true ||
		error.refusedBody === undefined
	)
		return null;
	let body: unknown;
	try {
		body = JSON.parse(error.refusedBody);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return null;
	const sentence = (body as Record<string, unknown>).error;
	if (sentence === HQ_API_ACCESS_REFUSAL) return "plan";
	if (sentence === HQ_API_CUT_OFF_REFUSAL) return "cut-off";
	return null;
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
 * while accepting HQ legacy spelling. Standalone dot segments are excluded:
 * the URL parser removes them before any request reaches HQ.
 *
 * Source: corehq/apps/domain/utils.py — `legacy_domain_re`
 */
const DOMAIN_SLUG_RE = /^[\w.:-]+$/;

export function isValidDomainSlug(domain: string): boolean {
	return domain !== "." && domain !== ".." && DOMAIN_SLUG_RE.test(domain);
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
 * The wait a `Retry-After` header asks for, in milliseconds, or null when it
 * names none Nova reads.
 *
 * HQ's limiter sends a decimal count of seconds, the time left in its
 * current window (`corehq/apps/api/resources/meta.py::HQThrottle.retry_after`).
 * The header's other form, an HTTP date, HQ does not send; it names no wait
 * Nova reads, so a read or an import that meets one takes its 429 as the
 * answer rather than waiting the second an absent header gets.
 */
export function retryAfterMs(header: string | null): number | null {
	if (header === null) return null;
	const text = header.trim();
	if (!/^\d+(\.\d+)?$/.test(text)) return null;
	const ms = Math.ceil(Number(text) * 1000);
	return Number.isFinite(ms) ? ms : null;
}

/** The error a refused answer is, from its status, its `Retry-After` and its body, logging nothing. */
export function failedResponseError(
	res: Response,
	body: string,
): CommCareApiError {
	const wait = retryAfterMs(res.headers.get("retry-after"));
	return {
		success: false,
		status: res.status,
		edgeRefusal: isEdgeRefusal(body),
		...(wait === null ? {} : { retryAfterMs: wait }),
	};
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
	return failedResponseError(res, body);
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
 *
 * Handed `bodyAlreadyRead`, it logs and builds the error from that text and
 * never touches `res.body`, for a read that has consumed the body itself.
 */
export function warnAndReturnError(
	context: string,
	res: Response,
): Promise<CommCareApiError>;
export function warnAndReturnError(
	context: string,
	res: Response,
	bodyAlreadyRead: string,
): CommCareApiError;
export function warnAndReturnError(
	context: string,
	res: Response,
	bodyAlreadyRead?: string,
): Promise<CommCareApiError> | CommCareApiError {
	if (bodyAlreadyRead !== undefined)
		return warnWithBody(context, res, bodyAlreadyRead);
	return res.text().then(
		(body) => warnWithBody(context, res, body),
		() => warnWithBody(context, res, ""),
	);
}

function warnWithBody(
	context: string,
	res: Response,
	body: string,
): CommCareApiError {
	log.warn(`[commcare] ${context}`, {
		status: res.status,
		body: body.substring(0, 200),
	});
	return failedResponseError(res, body);
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

/** Promise-returning sleep for the bounded waits; it ends early when `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}
