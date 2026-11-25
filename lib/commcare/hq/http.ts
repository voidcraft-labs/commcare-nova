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

import { validateHeaderValue } from "node:http";
import { log } from "@/lib/logger";
import { COMMCARE_SERVERS, type CommCareServer } from "../servers";
import { HQ_REFUSED_BODY_READ_MAX_BYTES } from "./bounds";
import { hqDeadlineReached } from "./deadline";
import { parseHqJsonText } from "./jsonText";
import {
	currentMemoryLease,
	giveBackHeld,
	type HeldAs,
	MemoryMeterFullError,
} from "./memoryMeter";
import {
	type BoundedBody,
	consumeBoundedBody,
	readBoundedBody,
} from "./readBody";

export { HQ_REFUSED_BODY_READ_MAX_BYTES } from "./bounds";

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
	 * where JSON was asked (`browser-page`, 502), it could not be read as
	 * what was asked for (`malformed`, 502, or 508 for a list whose cursor
	 * never ends), or a list changed while its pages were read, in every
	 * pass Nova made (`moved`, 503). Absent on a status CommCare HQ or its
	 * edge answered.
	 */
	cause?:
		| "network"
		| "timeout"
		| "malformed"
		| "too-large"
		| "browser-page"
		| "moved";
	/**
	 * The wait the response's `Retry-After` asked for, in milliseconds, when
	 * it was a count of seconds (`retryAfterMs`). Absent when the response
	 * sent none, sent an HTTP date, or was never read.
	 */
	retryAfterMs?: number;
	/**
	 * The first `HQ_REFUSED_BODY_MAX_CHARS` characters of a refused answer's
	 * body, present only where the read asked for it
	 * (`ReadHqJsonOptions.keepRefusedBody`) and the whole body arrived within
	 * `HQ_REFUSED_BODY_READ_MAX_BYTES`. Read only inside this module, never
	 * shown and never logged: a refusal's body can quote an app.
	 */
	refusedBody?: string;
}

/** The most characters of a refused answer's body a read keeps as `refusedBody`. */
export const HQ_REFUSED_BODY_MAX_CHARS = 2_048;

/**
 * The failure of a request whose answer Nova could not read as what was
 * asked for: a read's 2xx, or an import's acknowledgement. Frozen, so every
 * caller can return this one value.
 */
export const HQ_MALFORMED_ANSWER: CommCareApiError = Object.freeze({
	success: false,
	status: 502,
	cause: "malformed",
});

/**
 * Whether `value` is a count or a save counter as CommCare HQ writes one: a
 * whole number from zero to `Number.MAX_SAFE_INTEGER`.
 */
export function isHqCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A read no answer reached, or whose body stopped: the deadline, the
 * caller's `cancel`, or the network. A read its caller's `cancel` ended
 * answers `{ status: 503, cause: "network" }` and logs nothing, since the
 * caller that cancelled is the only reader of the answer; any other logs
 * `[commcare] <label> unavailable` with what the request or the stream threw.
 */
export function unansweredRead(
	label: string,
	signal: AbortSignal,
	error?: unknown,
	context: Readonly<Record<string, unknown>> = {},
): CommCareApiError {
	if (signal.aborted && !hqDeadlineReached(signal))
		return { success: false, status: 503, cause: "network" };
	log.warn(`[commcare] ${label} unavailable`, { ...context, error });
	return {
		success: false,
		status: 503,
		cause: signal.aborted ? "timeout" : "network",
	};
}

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
		body = parseHqJsonText(error.refusedBody);
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
	const value = `ApiKey ${creds.username}:${creds.apiKey}`;
	// Node's validator reports only the header name. Fetch's exception can
	// include the supplied value, and network exceptions reach the logs.
	validateHeaderValue("Authorization", value);
	return value;
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

/**
 * One answer of CommCare HQ, as every driver holds it: its status, its
 * headers, and its body only through `read`, whose bound is required. No
 * driver holds a `Response`, so no body is read whole by `.json()` or
 * `.text()`; `sendHq` is the one `fetch` for CommCare HQ, and a lint rule
 * keeps it so.
 */
export interface HqAnswer {
	readonly status: number;
	readonly ok: boolean;
	/** The header's value, or null where the answer sent none. */
	header(name: string): string | null;
	/**
	 * The body, at most `maxBytes` of it, a whole number from one to
	 * `bounds.ts::HQ_BODY_BOUND_CEILING` (anything else throws). A body past it
	 * is cancelled at the stream and answers `too-long`. `held` is what the
	 * caller keeps it as, which its bytes are charged as to the request's
	 * lease (`memoryMeter.ts`); a charge the lease refuses answers
	 * `unavailable`. Read at most once; after `discard` it answers
	 * `unavailable`.
	 */
	read(maxBytes: number, held: HeldAs): Promise<BoundedBody>;
	/**
	 * Stream a bounded response, each chunk handed to `consumer` and awaited
	 * before the next is read. A media digest knows its expected file size and
	 * a media stream writes each chunk on to storage; neither retains the
	 * payload, so neither is held to `HQ_BODY_BOUND_CEILING`.
	 */
	consume(
		maxBytes: number,
		consumer: (chunk: Uint8Array) => void | Promise<void>,
		mode?: "media-digest" | "media-stream",
	): Promise<"read" | "too-long" | "unavailable">;
	/** Let the body go unread. Never throws. */
	discard(): Promise<void>;
}

/** What a request to CommCare HQ carries beyond its URL and credentials. */
export interface HqRequest {
	readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** The `Accept` header, where the request names one. */
	readonly accept?: string;
	/** The `Content-Type` of a JSON body; a `FormData` body sets its own. */
	readonly contentType?: string;
	readonly body?: string | FormData | ReadableStream<Uint8Array>;
	readonly signal: AbortSignal;
	/** `no-store` on every read; a write leaves it out. */
	readonly noStore?: boolean;
}

/**
 * Send one request to CommCare HQ with the credentials' own header and no
 * redirect followed, and answer what came back. It rejects where `fetch`
 * does: no answer began, or the signal ended it first; and, sending nothing,
 * with a `MemoryMeterFullError` where the request's lease has refused a
 * charge, since nothing it reads now could be kept.
 */
export async function sendHq(
	creds: CommCareCredentials,
	url: string,
	request: HqRequest,
): Promise<HqAnswer> {
	if (currentMemoryLease()?.exhausted === true)
		throw new MemoryMeterFullError();
	const headers = {
		Authorization: authHeader(creds),
		...(request.accept !== undefined && { Accept: request.accept }),
		...(request.contentType !== undefined && {
			"Content-Type": request.contentType,
		}),
	};
	const response = await fetch(url, {
		method: request.method ?? "GET",
		headers,
		...(request.body === undefined ? {} : { body: request.body }),
		...(request.body instanceof ReadableStream && { duplex: "half" as const }),
		redirect: "manual",
		...(request.noStore === true ? { cache: "no-store" as const } : {}),
		signal: request.signal,
	});
	let body: "unread" | "read" | "discarded" = "unread";
	return {
		status: response.status,
		ok: response.ok,
		header: (name) => response.headers.get(name),
		async read(maxBytes, held) {
			if (body === "read")
				throw new Error(
					"A CommCare HQ answer's body was read twice. Each answer is read once.",
				);
			if (body === "discarded")
				return {
					kind: "unavailable",
					error: new Error("The answer's body was let go unread."),
				};
			body = "read";
			const length = response.headers.get("content-length");
			const hint =
				length !== null && /^\d+$/.test(length.trim())
					? Number(length.trim())
					: null;
			return readBoundedBody(response.body, maxBytes, hint, held);
		},
		async consume(maxBytes, consumer, mode) {
			if (body !== "unread")
				throw new Error("A CommCare HQ response was already consumed.");
			body = "read";
			return consumeBoundedBody(response.body, maxBytes, consumer, mode);
		},
		async discard() {
			if (body !== "unread") return;
			body = "discarded";
			await response.body?.cancel().catch(() => undefined);
		},
	};
}

/**
 * A refused answer's body as text, at most `HQ_REFUSED_BODY_READ_MAX_BYTES`
 * of it (its head where it is longer), and whether the whole of it arrived.
 * A body the network or the deadline cut off is `unavailable`. The bytes are
 * given back to the request's lease once decoded: a caller keeps at most
 * `HQ_REFUSED_BODY_MAX_CHARS` of the text.
 */
export async function readRefusedBody(answer: HqAnswer): Promise<
	| {
			readonly kind: "text";
			readonly text: string;
			readonly whole: boolean;
			readonly bytes: number;
	  }
	| { readonly kind: "unavailable"; readonly error: unknown }
> {
	const body = await answer.read(HQ_REFUSED_BODY_READ_MAX_BYTES, "text");
	if (body.kind === "unavailable") return body;
	const whole = body.kind === "read";
	const kept = whole ? body.bytes : body.head;
	const text = new TextDecoder().decode(kept);
	if (whole) giveBackHeld("text", kept.byteLength);
	return {
		kind: "text",
		text,
		whole,
		bytes: whole ? body.bytes.byteLength : body.bytes,
	};
}

/**
 * A 2xx body read to its bound and parsed as JSON: `json`, or `unreadable`
 * where it passed the bound, did not arrive whole, or is no JSON. An
 * acknowledgement's caller takes `unreadable` as its write's answer Nova
 * cannot read, which says the write may have landed.
 */
export async function readAnswerJson(
	answer: HqAnswer,
	maxBytes: number,
): Promise<
	| { readonly kind: "json"; readonly data: unknown }
	| {
			readonly kind: "unreadable";
			readonly why: "too-large" | "unavailable" | "not-json";
	  }
> {
	const body = await answer.read(maxBytes, "text");
	if (body.kind === "too-long") return { kind: "unreadable", why: "too-large" };
	if (body.kind === "unavailable")
		return { kind: "unreadable", why: "unavailable" };
	try {
		return {
			kind: "json",
			data: parseHqJsonText(new TextDecoder().decode(body.bytes)),
		};
	} catch {
		return { kind: "unreadable", why: "not-json" };
	}
}

/** The error a refused answer is, from its status, its `Retry-After` and its body, logging nothing. */
export function failedResponseError(
	res: HqAnswer,
	body: string,
): CommCareApiError {
	const wait = retryAfterMs(res.header("retry-after"));
	return {
		success: false,
		status: res.status,
		edgeRefusal: isEdgeRefusal(body),
		...(wait === null ? {} : { retryAfterMs: wait }),
	};
}

/** What a text CommCare HQ answered is, in one word that holds none of it. */
export type HqTextShape = "empty" | "json" | "page" | "text";

/**
 * `empty`, `json` where the text opens as a JSON object or array, `page`
 * where it opens with `<`, else `text`.
 */
export function hqTextShape(text: string): HqTextShape {
	const head = text.trimStart();
	if (head === "") return "empty";
	if (head.startsWith("{") || head.startsWith("[")) return "json";
	return head.startsWith("<") ? "page" : "text";
}

/**
 * What a log line may say of a text CommCare HQ answered (a refused body,
 * a verdict's message, an import's error): its shape and its length in
 * UTF-8 bytes, never a word of it. HQ's refusals quote an app
 * (`util/view_utils.py::json_error` answers `str(e)`, and an import's
 * `AppEditingError` names a form or a question), and a log line's context
 * reaches Cloud Logging and, at error, Sentry.
 */
export function hqTextFacts(text: string): {
	readonly shape: HqTextShape;
	readonly bytes: number;
} {
	return {
		shape: hqTextShape(text),
		bytes: new TextEncoder().encode(text).byteLength,
	};
}

/**
 * The context of the line a refused response logs: its status, whether the
 * edge refused it, and its body's shape and length, never its text.
 */
function refusedResponseContext(
	res: HqAnswer,
	body: {
		readonly text: string;
		readonly whole: boolean;
		readonly bytes: number;
	},
	error: CommCareApiError,
) {
	return {
		status: res.status,
		edgeRefusal: error.edgeRefusal === true,
		body: hqTextShape(body.text),
		bodyBytes: body.bytes,
		bodyCutOff: !body.whole,
	};
}

/** A refused answer's body, its head where it is longer than refusals are read, `""` where it did not arrive. */
async function refusedBodyOf(res: HqAnswer): Promise<{
	readonly text: string;
	readonly whole: boolean;
	readonly bytes: number;
}> {
	const body = await readRefusedBody(res);
	return body.kind === "text" ? body : { text: "", whole: false, bytes: 0 };
}

/**
 * Log a failed CommCare HQ response for server-side debugging, by its
 * status and its body's shape and length (`hqTextFacts`), its body read at
 * most `HQ_REFUSED_BODY_READ_MAX_BYTES` far. The body is never logged,
 * returned to callers or shown to users.
 */
export async function logAndReturnError(
	context: string,
	res: HqAnswer,
): Promise<CommCareApiError> {
	const body = await refusedBodyOf(res);
	const error = failedResponseError(res, body.text);
	log.error(
		`[commcare] ${context}`,
		undefined,
		refusedResponseContext(res, body, error),
	);
	return error;
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
	res: HqAnswer,
): Promise<CommCareApiError> {
	const body = await refusedBodyOf(res);
	const error = failedResponseError(res, body.text);
	log.warn(`[commcare] ${context}`, refusedResponseContext(res, body, error));
	return error;
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
