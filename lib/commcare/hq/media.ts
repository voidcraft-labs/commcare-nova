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

import { createHash } from "node:crypto";
import { log } from "@/lib/logger";
import type { HqMediaType } from "./appSource";
import { withHqRequestDeadline } from "./deadline";
import {
	type CommCareApiError,
	type CommCareCredentials,
	delay,
	failedResponseError,
	type HqAnswer,
	readRefusedBody,
	sendHq,
	unansweredRead,
} from "./http";
import { HQ_MEDIA_TYPES } from "./mediaMap";

export { HQ_MEDIA_IN_FLIGHT_MAX_BYTES } from "./bounds";

/**
 * The most of one media file Nova streams past its kind's limit
 * (`streamHqMediaFile`). It is no body bound of `bounds.ts`: no byte of it is
 * held, each chunk going on to a staged object as it arrives. The bound is the
 * time one file may take: a gibibyte at the 2 MiB/s a slow link to CommCare HQ
 * gives arrives in about eight and a half minutes, inside
 * `HQ_MEDIA_STREAM_DEADLINE_MS`.
 */
export const HQ_MEDIA_STREAM_MAX_BYTES = 1024 * 1024 * 1024;

/** Each file's own deadline, through its last byte: a file can be 50 MiB. */
export const HQ_MEDIA_FILE_DEADLINE_MS = 60_000;
/** The bytes `HQ_MEDIA_FILE_DEADLINE_MS` is fitted to: the largest per-kind cap. */
const HQ_MEDIA_FILE_DEADLINE_BYTES = 50 * 1024 * 1024;
/** A streamed file's deadline, through its last byte: `HQ_MEDIA_STREAM_MAX_BYTES` at a slow link. */
export const HQ_MEDIA_STREAM_DEADLINE_MS = 10 * 60_000;
/** The rate a known file's digest read is given time for beyond the file deadline: a slow link. */
const HQ_MEDIA_DIGEST_BYTES_PER_SECOND = 2 * 1024 * 1024;
/** How many media files Nova asks CommCare HQ for at once. */
export const HQ_MEDIA_READ_CONCURRENCY = 4;

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
 * `too-large`; a `Content-Length` within the bound only sizes the one array
 * the file is read into, and never bounds anything. A page for a browser in
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
	return readMedia(
		creds,
		mediaType,
		multimediaId,
		options.cancel,
		async (response, declaredContentType, signal): Promise<HqMediaFileRead> => {
			const body = await response.read(options.maxBytes, "bytes");
			if (body.kind === "too-long")
				return { kind: "too-large", maxBytes: options.maxBytes };
			if (body.kind === "unavailable") return unanswered(signal, body.error);
			return { kind: "read", bytes: body.bytes, declaredContentType };
		},
	);
}

/** Where a streamed file's bytes go as they arrive: a staged object being written. */
export interface HqMediaSink<Written> {
	readonly write: (chunk: Uint8Array) => Promise<void>;
	/** End the write, once every byte arrived, and answer what it made. */
	readonly finish: () => Promise<Written>;
	/** Let go of what was written: the file did not arrive whole. Never throws. */
	readonly abort: () => Promise<void>;
}

export type HqMediaStream<Written> =
	| {
			readonly kind: "streamed";
			/** What the sink's `finish` made of the bytes. */
			readonly written: Written;
			readonly sizeBytes: number;
			/** SHA-256 of the bytes as they arrived, hex. */
			readonly sha256: string;
	  }
	| { readonly kind: "missing" }
	| { readonly kind: "too-large"; readonly maxBytes: number }
	| CommCareApiError;

/**
 * Read the file HQ holds as `multimediaId` of `mediaType` into a sink, at most
 * `options.maxBytes` of it, holding none of it: each chunk is counted, hashed
 * and handed to the sink as it arrives, and the next is read once the sink
 * took it. `options.open` makes a fresh sink for each attempt (the one resend
 * a file HQ could not send gets its own), and a sink whose file did not arrive
 * whole is aborted. Otherwise as `readHqMediaFile`, under the longer
 * `HQ_MEDIA_STREAM_DEADLINE_MS`.
 */
export async function streamHqMediaFile<Written>(
	creds: CommCareCredentials,
	mediaType: HqMediaType,
	multimediaId: string,
	options: {
		readonly maxBytes: number;
		readonly open: () => HqMediaSink<Written>;
		readonly cancel?: AbortSignal;
	},
): Promise<HqMediaStream<Written>> {
	return readMedia(
		creds,
		mediaType,
		multimediaId,
		options.cancel,
		async (answer, _type, signal): Promise<HqMediaStream<Written>> => {
			const sink = options.open();
			const digest = createHash("sha256");
			let size = 0;
			let finished = false;
			/* A failure of Nova's own storage is thrown as itself, never read as
			 * CommCare HQ's. */
			let sinkFailure: { readonly error: unknown } | null = null;
			const toSink = async (step: () => Promise<void>) => {
				try {
					await step();
				} catch (error) {
					sinkFailure ??= { error };
					throw error;
				}
			};
			try {
				const result = await answer.consume(
					options.maxBytes,
					async (chunk) => {
						size += chunk.byteLength;
						digest.update(chunk);
						await toSink(() => sink.write(chunk));
					},
					"media-stream",
				);
				if (result === "too-long")
					return { kind: "too-large", maxBytes: options.maxBytes };
				if (result !== "read") return unanswered(signal);
				let written: Written | undefined;
				await toSink(async () => {
					written = await sink.finish();
				});
				finished = true;
				return {
					kind: "streamed",
					written: written as Written,
					sizeBytes: size,
					sha256: digest.digest("hex"),
				};
			} catch (error) {
				if (sinkFailure !== null) throw error;
				return unanswered(signal, error);
			} finally {
				if (!finished) await sink.abort();
			}
		},
		HQ_MEDIA_STREAM_DEADLINE_MS,
	);
}

type FileFailure = CommCareApiError | { kind: "missing" };
export type HqMediaDigest =
	| { kind: "hash"; sha256: string; size: number }
	| { kind: "too-large" }
	| FileFailure;

/** Hash the exact fixed-host file in transit. Only a current Project asset's
 * authenticated size can extend the buffered reader's legacy workspace. */
export function readHqMediaDigest(
	creds: CommCareCredentials,
	mediaType: HqMediaType,
	multimediaId: string,
	maxBytes: number,
	cancel?: AbortSignal,
): Promise<HqMediaDigest> {
	return readMedia(
		creds,
		mediaType,
		multimediaId,
		cancel,
		async (answer, _type, signal): Promise<HqMediaDigest> => {
			const digest = createHash("sha256");
			let size = 0;
			try {
				const result = await answer.consume(
					maxBytes,
					(chunk) => {
						size += chunk.byteLength;
						digest.update(chunk);
					},
					"media-digest",
				);
				if (result === "too-long") return { kind: "too-large" };
				if (result !== "read") return unanswered(signal);
				return { kind: "hash", size, sha256: digest.digest("hex") };
			} catch (error) {
				return unanswered(signal, error);
			}
		},
		/* A file brought in past its kind's cap is given the time its bytes past the
		 * file deadline's take. */
		HQ_MEDIA_FILE_DEADLINE_MS +
			Math.ceil(
				(Math.max(0, maxBytes - HQ_MEDIA_FILE_DEADLINE_BYTES) /
					HQ_MEDIA_DIGEST_BYTES_PER_SECOND) *
					1000,
			),
	);
}

async function readMedia<T>(
	creds: CommCareCredentials,
	mediaType: HqMediaType,
	multimediaId: string,
	cancel: AbortSignal | undefined,
	read: (
		response: HqAnswer,
		type: string | null,
		signal: AbortSignal,
	) => Promise<T>,
	deadlineMs: number = HQ_MEDIA_FILE_DEADLINE_MS,
): Promise<T | FileFailure> {
	// Both are path segments: the type is held to HQ's own list at run time,
	// beside the id, wherever it was read from.
	if (
		!/^[\w-]+$/.test(multimediaId) ||
		!(HQ_MEDIA_TYPES as readonly string[]).includes(mediaType)
	)
		return { success: false, status: 400 };
	const url = `/hq/multimedia/file/${mediaType}/${multimediaId}/`;
	return withHqRequestDeadline(
		async (signal) => {
			const ask = () => readOnce(creds, url, signal, read);
			const first = await ask();
			if (!resendable(first) || signal.aborted) return first;
			await delay(HQ_MEDIA_RESEND_WAIT_MS, signal);
			return signal.aborted ? unanswered(signal) : ask();
		},
		deadlineMs,
		cancel,
	);
}

/** HQ could not send the file this time: no answer, or a gateway's or HQ's 502, 503 or 504. */
function resendable(answer: unknown): boolean {
	if (
		!answer ||
		typeof answer !== "object" ||
		!("success" in answer) ||
		answer.success !== false
	)
		return false;
	const failure = answer as CommCareApiError;
	return (
		failure.cause === "network" ||
		(failure.cause === undefined &&
			(failure.status === 502 ||
				failure.status === 503 ||
				failure.status === 504))
	);
}

async function readOnce<T>(
	creds: CommCareCredentials,
	url: string,
	signal: AbortSignal,
	read: (
		response: HqAnswer,
		type: string | null,
		signal: AbortSignal,
	) => Promise<T>,
): Promise<T | FileFailure> {
	let response: HqAnswer;
	try {
		response = await sendHq(creds, url, {
			accept: "*/*",
			noStore: true,
			signal,
		});
	} catch (error) {
		return unanswered(signal, error);
	}
	if (!response.ok) {
		const body = await readRefusedBody(response);
		/* The headers came and the body did not: as unanswered as no headers. */
		if (body.kind === "unavailable") return unanswered(signal, body.error);
		const { text } = body;
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
	const declaredContentType = mediaTypeOf(response.header("content-type"));
	/* A page is not a file, and judging it as media would blame the app. */
	if (declaredContentType === "text/html") {
		await response.discard();
		return { success: false, status: 502, cause: "browser-page" };
	}
	return read(response, declaredContentType, signal);
}

/** No answer reached Nova, or its body stopped: the deadline, the caller's `cancel`, or the network. */
function unanswered(signal: AbortSignal, error?: unknown): CommCareApiError {
	return unansweredRead("media file", signal, error, { request: "media-file" });
}

function mediaTypeOf(header: string | null): string | null {
	if (header === null) return null;
	const mediaType = header.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === undefined || mediaType === "" ? null : mediaType;
}
