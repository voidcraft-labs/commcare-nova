import "server-only";

/**
 * Read one media file an app on CommCare HQ names.
 *
 * The URL is the one HQ gives each entry of an app's media map
 * (`hqmedia/models.py::HQMediaMapItem.url`, a `reverse` of the route
 * `hqmedia_download`), the one HQ's own app pages fetch the file from:
 * `<base>/hq/multimedia/file/<mediaType>/<multimediaId>/`. It is read with
 * the stored credential, as the app source is.
 *
 * The reader holds a status and bytes and nothing else of HQ's answer. It
 * never says what a file is: the declared type is returned as a hint, and
 * `lib/media` judges the bytes.
 *
 * The address names no project space, so its log lines carry the request
 * kind and the status, and no body.
 */

import { log } from "@/lib/logger";
import type { HqMediaType } from "./appSource";
import { hqDeadlineReached, withHqRequestDeadline } from "./deadline";
import {
	authHeader,
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	delay,
	failedResponseError,
	HQ_REFUSED_BODY_READ_MAX_BYTES,
} from "./http";
import { readBoundedBody } from "./readBody";

/** Each file's own deadline, through its last byte: a file can be 50 MiB. */
export const HQ_MEDIA_FILE_DEADLINE_MS = 60_000;
/** How many media files Nova asks CommCare HQ for at once. */
export const HQ_MEDIA_READ_CONCURRENCY = 4;
/** The most the files in flight may sum to, each counted at its kind's limit. */
export const HQ_MEDIA_IN_FLIGHT_MAX_BYTES = 64 * 1024 * 1024;

/** The wait before the one resend of a file HQ could not send. */
const HQ_MEDIA_RESEND_WAIT_MS = 1_000;

export type HqMediaFileRead =
	| {
			readonly kind: "read";
			readonly bytes: Uint8Array;
			/** The response's `Content-Type` media type, lowercased, or null. A hint, never trusted. */
			readonly declaredContentType: string | null;
	  }
	/** A 404 that is not the edge's: CommCare HQ holds no file there. */
	| { readonly kind: "missing" }
	/** The file is longer than `maxBytes`; nothing of it is kept. */
	| { readonly kind: "too-large"; readonly maxBytes: number }
	| CommCareApiError;

/**
 * Read the file HQ holds as `multimediaId` of `mediaType`, at most
 * `options.maxBytes` of it.
 *
 * An id outside `^[\w-]+$` is a request Nova will not send: it answers 400
 * with no request made. A body past `maxBytes` is cancelled and answers
 * `too-large`, and no `Content-Length` is trusted. A page for a browser in
 * place of a file is `browser-page`. Where no answer came, or HQ or its edge
 * answered 502, 503 or 504, the file is asked for once more after one
 * second, inside the same deadline. `options.cancel` stops the read early;
 * it then answers `{ status: 503, cause: "network" }` and logs nothing.
 */
export async function readHqMediaFile(
	creds: CommCareCredentials,
	mediaType: HqMediaType,
	multimediaId: string,
	options: { readonly maxBytes: number; readonly cancel?: AbortSignal },
): Promise<HqMediaFileRead> {
	if (!/^[\w-]+$/.test(multimediaId)) return { success: false, status: 400 };
	const url = `${baseUrl(creds)}/hq/multimedia/file/${mediaType}/${multimediaId}/`;
	return withHqRequestDeadline(
		async (signal) => {
			const first = await readOnce(creds, url, options.maxBytes, signal);
			if (!resendable(first) || signal.aborted) return first;
			await delay(HQ_MEDIA_RESEND_WAIT_MS, signal);
			if (signal.aborted) return unanswered(signal);
			return readOnce(creds, url, options.maxBytes, signal);
		},
		HQ_MEDIA_FILE_DEADLINE_MS,
		options.cancel,
	);
}

/** HQ could not send the file this time: no answer, or a gateway's or HQ's 502, 503 or 504. */
function resendable(answer: HqMediaFileRead): boolean {
	if (!("success" in answer)) return false;
	return (
		answer.cause === "network" ||
		(answer.cause === undefined &&
			(answer.status === 502 || answer.status === 503 || answer.status === 504))
	);
}

async function readOnce(
	creds: CommCareCredentials,
	url: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<HqMediaFileRead> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: authHeader(creds), Accept: "*/*" },
			redirect: "manual",
			cache: "no-store",
			signal,
		});
	} catch (error) {
		return unanswered(signal, error);
	}
	if (!response.ok) {
		const body = await readBoundedBody(
			response,
			HQ_REFUSED_BODY_READ_MAX_BYTES,
		);
		const text =
			body.kind === "read" ? new TextDecoder().decode(body.bytes) : "";
		/* The body is read only to tell the edge's refusal from HQ's, and is
		 * never logged. */
		log.warn("[commcare] media file refused", {
			request: "media-file",
			status: response.status,
		});
		const error = failedResponseError(response, text);
		return error.status === 404 && error.edgeRefusal !== true
			? { kind: "missing" }
			: error;
	}
	const declaredContentType = mediaTypeOf(response.headers.get("content-type"));
	/* A page is not a file, and judging it as media would blame the app. */
	if (declaredContentType === "text/html") {
		await response.body?.cancel().catch(() => undefined);
		return { success: false, status: 502, cause: "browser-page" };
	}
	const body = await readBoundedBody(response, maxBytes);
	if (body.kind === "too-long") return { kind: "too-large", maxBytes };
	if (body.kind === "unavailable") return unanswered(signal);
	return { kind: "read", bytes: body.bytes, declaredContentType };
}

/** No answer reached Nova: the deadline, the caller's `cancel`, or the network. */
function unanswered(signal: AbortSignal, error?: unknown): CommCareApiError {
	if (signal.aborted && !hqDeadlineReached(signal))
		return { success: false, status: 503, cause: "network" };
	log.warn("[commcare] media file unavailable", {
		request: "media-file",
		error,
	});
	return {
		success: false,
		status: 503,
		cause: signal.aborted ? "timeout" : "network",
	};
}

function mediaTypeOf(header: string | null): string | null {
	if (header === null) return null;
	const mediaType = header.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === undefined || mediaType === "" ? null : mediaType;
}
