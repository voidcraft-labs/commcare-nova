import "server-only";

import { log } from "@/lib/logger";
import { type HqReadDeadline, withHqRequestDeadline } from "./deadline";
import {
	authHeader,
	type CommCareApiError,
	type CommCareCredentials,
	delay,
	failedResponseError,
	HQ_REFUSED_BODY_MAX_CHARS,
	HQ_REFUSED_BODY_READ_MAX_BYTES,
	hqTextShape,
	retryAfterMs,
	unansweredRead,
} from "./http";
import { readBoundedBody } from "./readBody";
import { HQ_READ_SENDS, readRetryWaitMs } from "./throttle";

export type ReadHqJsonOptions = {
	/**
	 * The most bytes of body Nova reads. A longer body is refused whole and
	 * never cut short and parsed: the bound guards the server's memory against
	 * a body of any length, and the caller decides what a refusal means.
	 */
	readonly maxBytes?: number;
	/** Return a bounded prefix of a refused body as `refusedBody`. */
	readonly keepRefusedBody?: boolean;
} & (
	| /** One page of a list read: the list's own deadline. */
	HqReadDeadline
	/** Any other read: it owns a deadline of `deadlineMs`, 30 seconds unless given. */
	| {
			readonly signal?: undefined;
			readonly deadline?: undefined;
			readonly deadlineMs?: number;
			/** The caller's way to stop the read early. Never a deadline. */
			readonly cancel?: AbortSignal;
	  }
);

/**
 * A response from the exact selected endpoint, never from a redirect target.
 * Validation of the returned JSON belongs to its wire consumer.
 *
 * A failed answer is one of five a read synthesizes (`network`, `timeout`,
 * `too-large`, `browser-page`, `malformed`) or the status CommCare HQ or its
 * edge gave. A 429 is sent again by `throttle.ts::readRetryWaitMs`, at most
 * `HQ_READ_SENDS` times, and no wait is begun that would outlast the
 * deadline. A read the deadline or the network cut off, before its headers
 * or while its body streamed, a refused answer's body included, logs
 * `[commcare] <label> unavailable`. A read its caller's `cancel` ended
 * answers `{ status: 503, cause: "network" }` and logs nothing.
 *
 * Every refused body is read at most `HQ_REFUSED_BODY_READ_MAX_BYTES` far,
 * whatever `maxBytes` says, and its first bytes alone tell the edge's
 * refusal from HQ's. The line `[commcare] <label> refused` names the status
 * and the body's shape and length, never its text: CommCare HQ's refusals
 * quote an app's words (`util/view_utils.py::json_error` answers `str(e)`).
 */
export async function readHqJson(
	creds: CommCareCredentials,
	url: string,
	label: string,
	options: ReadHqJsonOptions = {},
): Promise<{ readonly data: unknown } | CommCareApiError> {
	if (options.signal !== undefined)
		return readWithin(creds, url, label, options, options);
	return withHqRequestDeadline(
		(signal, deadline) =>
			readWithin(creds, url, label, options, { signal, deadline }),
		options.deadlineMs,
		options.cancel,
	);
}

async function readWithin(
	creds: CommCareCredentials,
	url: string,
	label: string,
	options: ReadHqJsonOptions,
	within: HqReadDeadline,
): Promise<{ readonly data: unknown } | CommCareApiError> {
	const { signal, deadline } = within;
	for (let sent = 1; ; sent++) {
		let response: Response;
		try {
			response = await fetch(url, {
				headers: {
					Authorization: authHeader(creds),
					Accept: "application/json",
				},
				redirect: "manual",
				cache: "no-store",
				signal,
			});
		} catch (error) {
			return unansweredRead(label, signal, error);
		}
		if (response.ok) return readAnswer(response, label, options, signal);
		const wait =
			response.status === 429 && sent < HQ_READ_SENDS
				? resendWaitMs(response.headers.get("retry-after"))
				: null;
		/* A resend the deadline would cut off is no resend: the 429 is the answer. */
		if (wait === null || Date.now() + wait >= deadline)
			return refused(
				response,
				label,
				url,
				options.keepRefusedBody === true,
				signal,
			);
		await response.body?.cancel().catch(() => undefined);
		log.warn(`[commcare] ${label} rate limited, sending again`, {
			domain: domainOf(url),
			request: label,
			waitMs: wait,
			sent,
		});
		await delay(wait, signal);
		if (signal.aborted) return unansweredRead(label, signal);
	}
}

/**
 * The wait before a throttled read is sent again, or null when its 429 is the
 * answer. A 429 with no `Retry-After` waits `readRetryWaitMs`'s second; one
 * whose `Retry-After` Nova cannot read as seconds, such as an HTTP date,
 * names a wait Nova cannot take and is the answer.
 */
function resendWaitMs(retryAfter: string | null): number | null {
	if (retryAfter === null) return readRetryWaitMs(undefined);
	const named = retryAfterMs(retryAfter);
	return named === null ? null : readRetryWaitMs(named);
}

/**
 * A refused answer's error, from its status, its `Retry-After` and at most
 * the first `HQ_REFUSED_BODY_READ_MAX_BYTES` of its body. A body past that
 * bound tells the edge apart by those bytes and keeps no `refusedBody`;
 * one the deadline, the network or `cancel` cut off is no answer.
 */
async function refused(
	response: Response,
	label: string,
	url: string,
	keepRefusedBody: boolean,
	signal: AbortSignal,
): Promise<CommCareApiError> {
	const body = await readBoundedBody(response, HQ_REFUSED_BODY_READ_MAX_BYTES);
	if (body.kind === "unavailable")
		return unansweredRead(label, signal, body.error);
	const whole = body.kind === "read";
	const bytes = whole ? body.bytes : body.head;
	const text = new TextDecoder().decode(bytes);
	const error = failedResponseError(response, text);
	log.warn(`[commcare] ${label} refused`, {
		domain: domainOf(url),
		status: response.status,
		edgeRefusal: error.edgeRefusal === true,
		body: hqTextShape(text),
		bodyBytes: whole ? body.bytes.byteLength : body.bytes,
		bodyCutOff: !whole,
	});
	return keepRefusedBody && whole
		? { ...error, refusedBody: text.slice(0, HQ_REFUSED_BODY_MAX_CHARS) }
		: error;
}

async function readAnswer(
	response: Response,
	label: string,
	options: ReadHqJsonOptions,
	signal: AbortSignal,
): Promise<{ readonly data: unknown } | CommCareApiError> {
	const { maxBytes } = options;
	const body = await readBoundedBody(response, maxBytes);
	/* The headers came and the body did not: as unanswered as no headers. */
	if (body.kind === "unavailable")
		return unansweredRead(label, signal, body.error);
	if (body.kind === "too-long") {
		/* A page is a page at any length; only data is too long. */
		if (hqTextShape(new TextDecoder().decode(body.head)) === "page")
			return { success: false, status: 502, cause: "browser-page" };
		log.error(`[commcare] ${label} is longer than Nova reads`, undefined, {
			bytes: body.bytes,
			maxBytes: maxBytes ?? null,
		});
		return { success: false, status: 502, cause: "too-large" };
	}
	const text = new TextDecoder().decode(body.bytes);
	try {
		return { data: JSON.parse(text) };
	} catch {
		/* HQ answers its sign-in page, its plan page and an inactive project
		 * space's page as HTML where JSON was asked. */
		return {
			success: false,
			status: 502,
			cause: hqTextShape(text) === "page" ? "browser-page" : "malformed",
		};
	}
}

/** The project space a `/a/<domain>/…` URL names, for a log line; null for any other path. */
function domainOf(url: string): string | null {
	const segments = new URL(url).pathname.split("/");
	return segments[1] === "a" && segments[2] ? segments[2] : null;
}
