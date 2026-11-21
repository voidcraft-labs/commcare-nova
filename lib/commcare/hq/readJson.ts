import "server-only";

import { log } from "@/lib/logger";
import { type HqReadDeadline, withHqRequestDeadline } from "./deadline";
import {
	type CommCareApiError,
	type CommCareCredentials,
	delay,
	failedResponseError,
	HQ_REFUSED_BODY_MAX_CHARS,
	type HqAnswer,
	hqTextShape,
	readRefusedBody,
	retryAfterMs,
	sendHq,
	unansweredRead,
} from "./http";
import { parseHqJsonText } from "./jsonText";
import { giveBackHeld } from "./memoryMeter";
import { HQ_READ_SENDS, readRetryWaitMs } from "./throttle";

export type ReadHqJsonOptions = {
	/**
	 * The most bytes of body Nova reads, a constant of `bounds.ts`. Required: no
	 * read of CommCare HQ is without one. A longer body is refused whole and
	 * never cut short and parsed: the bound guards the server's memory against
	 * a body of any length, and the caller decides what a refusal means.
	 */
	readonly maxBytes: number;
	/** Return a bounded prefix of a refused body as `refusedBody`. */
	readonly keepRefusedBody?: boolean;
	/**
	 * `quiet` where a body past the bound is an answer the caller reads (a
	 * list's page past what remains of its bound), so the read logs nothing
	 * of it; otherwise it logs `[commcare] <label> is longer than Nova reads`.
	 */
	readonly pastBound?: "log" | "quiet";
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
 * deadline. A read no answer began for, its connection closed or never
 * opened, is sent once more at once: fetch sends nothing again by itself, and
 * a kept-alive connection the server closes as a read goes out on it is
 * otherwise a failed read. A read the deadline or the network cut off, before its headers
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
	options: ReadHqJsonOptions,
): Promise<HqJsonRead | CommCareApiError> {
	if (options.signal !== undefined)
		return readWithin(creds, url, label, options, options);
	return withHqRequestDeadline(
		(signal, deadline) =>
			readWithin(creds, url, label, options, { signal, deadline }),
		options.deadlineMs,
		options.cancel,
	);
}

/** A 2xx JSON answer: what it parsed to, and how many bytes its body was. */
export interface HqJsonRead {
	readonly data: unknown;
	readonly bytes: number;
}

async function readWithin(
	creds: CommCareCredentials,
	url: string,
	label: string,
	options: ReadHqJsonOptions,
	within: HqReadDeadline,
): Promise<HqJsonRead | CommCareApiError> {
	const { signal, deadline } = within;
	let resentUnanswered = false;
	for (let sent = 1; ; ) {
		let response: HqAnswer;
		try {
			response = await sendHq(creds, url, {
				accept: "application/json",
				noStore: true,
				signal,
			});
		} catch (error) {
			/* No answer began: the connection closed or never opened. A kept-alive
			 * connection CommCare HQ closed as this read went out on it is the
			 * common case, and fetch sends nothing again by itself, so a read is
			 * sent once more on a fresh connection. A read is a GET, which may be
			 * sent again. */
			if (signal.aborted || resentUnanswered)
				return unansweredRead(label, signal, error);
			resentUnanswered = true;
			log.warn(`[commcare] ${label} not answered, sending again`, {
				domain: domainOf(url),
				request: label,
				error,
			});
			continue;
		}
		if (response.ok) return readAnswer(response, label, options, signal);
		const wait =
			response.status === 429 && sent < HQ_READ_SENDS
				? resendWaitMs(response.header("retry-after"))
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
		await response.discard();
		log.warn(`[commcare] ${label} rate limited, sending again`, {
			domain: domainOf(url),
			request: label,
			waitMs: wait,
			sent,
		});
		await delay(wait, signal);
		if (signal.aborted) return unansweredRead(label, signal);
		sent += 1;
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
	response: HqAnswer,
	label: string,
	url: string,
	keepRefusedBody: boolean,
	signal: AbortSignal,
): Promise<CommCareApiError> {
	const body = await readRefusedBody(response);
	if (body.kind === "unavailable")
		return unansweredRead(label, signal, body.error);
	const { text, whole } = body;
	const error = failedResponseError(response, text);
	log.warn(`[commcare] ${label} refused`, {
		domain: domainOf(url),
		status: response.status,
		edgeRefusal: error.edgeRefusal === true,
		body: hqTextShape(text),
		bodyBytes: body.bytes,
		bodyCutOff: !whole,
	});
	return keepRefusedBody && whole
		? { ...error, refusedBody: text.slice(0, HQ_REFUSED_BODY_MAX_CHARS) }
		: error;
}

async function readAnswer(
	response: HqAnswer,
	label: string,
	options: ReadHqJsonOptions,
	signal: AbortSignal,
): Promise<HqJsonRead | CommCareApiError> {
	const { maxBytes } = options;
	const body = await response.read(maxBytes, "text");
	/* The headers came and the body did not: as unanswered as no headers. */
	if (body.kind === "unavailable")
		return unansweredRead(label, signal, body.error);
	if (body.kind === "too-long") {
		/* A page is a page at any length; only data is too long. */
		if (hqTextShape(new TextDecoder().decode(body.head)) === "page")
			return { success: false, status: 502, cause: "browser-page" };
		if (options.pastBound !== "quiet")
			log.error(`[commcare] ${label} is longer than Nova reads`, undefined, {
				bytes: body.bytes,
				maxBytes,
			});
		return { success: false, status: 502, cause: "too-large" };
	}
	let text: string;
	try {
		text = new TextDecoder().decode(body.bytes);
	} catch (error) {
		/* A body within the bound always decodes; a fault here is the
		 * runtime's, and the read is no answer rather than a thrown 500. */
		giveBackHeld("text", body.bytes.byteLength);
		return unansweredRead(label, signal, error);
	}
	try {
		/* What was parsed stays charged to the request's lease, as the data
		 * its caller keeps. */
		return { data: parseHqJsonText(text), bytes: body.bytes.byteLength };
	} catch {
		/* HQ answers its sign-in page, its plan page and an inactive project
		 * space's page as HTML where JSON was asked. Nothing of it is kept. */
		giveBackHeld("text", body.bytes.byteLength);
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
