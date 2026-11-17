/**
 * Settling a published path whose file CommCare HQ's id alone cannot vouch
 * for, by the file's content: the one place a publish, or a review of
 * changes made in CommCare HQ, asks CommCare HQ for a file this app sends.
 */

import "server-only";
import { createHash } from "node:crypto";
import type { HqMediaType } from "@/lib/commcare/hq/appSource";
import type {
	CommCareApiError,
	CommCareCredentials,
} from "@/lib/commcare/hq/http";
import {
	HQ_MEDIA_IN_FLIGHT_MAX_BYTES,
	HQ_MEDIA_READ_CONCURRENCY,
	type HqMediaFileRead,
	readHqMediaFile,
} from "@/lib/commcare/hq/media";
import { ASSET_SIZE_CAPS_BYTES } from "@/lib/domain";
import type { HqMediaPath, HqMediaRecord, HqMediaStanding } from "./hqMedia";

/**
 * What CommCare HQ answered for one file, kept for a later step of the same
 * request that reads the same file: its whole bytes, or that it serves none.
 */
export type SettledHqMediaRead =
	| { readonly kind: "read"; readonly bytes: Uint8Array }
	| { readonly kind: "missing" };

export type SettledHqMedia =
	| {
			readonly kind: "settled";
			/** Every path, with no `moved` and no `unrecorded` among those asked for. */
			readonly paths: readonly HqMediaPath[];
			/** Candidates found to hold this app's bytes: path to the id that holds them. */
			readonly learned: HqMediaRecord;
			/**
			 * Where the caller asked to `retain` them: the answers by id, each
			 * file read whole while the bytes kept stay within
			 * `HQ_MEDIA_IN_FLIGHT_MAX_BYTES`, and each file HQ serves none of.
			 * Empty otherwise.
			 */
			readonly reads: ReadonlyMap<string, SettledHqMediaRead>;
	  }
	| { readonly kind: "failed"; readonly failure: CommCareApiError };

/** What one file's answer says, once it is hashed and its bytes dropped. */
type FileVerdict =
	| { readonly kind: "hash"; readonly sha256: string }
	| { readonly kind: "too-large" }
	| { readonly kind: "missing" };

/** One file to ask for: every candidate path that names its id. */
interface FileRequest {
	readonly multimediaId: string;
	readonly mediaType: HqMediaType;
	/** The largest limit among the kinds of the paths that name it. */
	readonly maxBytes: number;
}

/**
 * Asks CommCare HQ for the file of each `moved` and each `unrecorded` path,
 * once per id, and hashes its bytes with SHA-256:
 *
 * - bytes of the path's own `contentHash`: `recorded`, and `learned` gains
 *   the path under that id;
 * - bytes of another hash, or a file over Nova's limit for the kind:
 *   `replaced`, since no file of this app's is either;
 * - CommCare HQ serving no file there: `absent`, and an upload puts the
 *   file back.
 *
 * A file starts only where fewer than `HQ_MEDIA_READ_CONCURRENCY` are in
 * flight and their limits plus its own stay within
 * `HQ_MEDIA_IN_FLIGHT_MAX_BYTES`. A file CommCare HQ could not send after
 * the reader's one resend ends the call: the reads in flight are aborted and
 * the answer is `failed`, which is never "nothing changed". A fetched file is
 * hashed and dropped, unless the caller asks to `retain` what it read for a
 * later step that reads the same files (a review of changes made in CommCare
 * HQ, whose readings judge the files the sources name): then each file read
 * whole is kept while the bytes kept stay within
 * `HQ_MEDIA_IN_FLIGHT_MAX_BYTES`, and each file HQ serves none of is noted,
 * so that step asks CommCare HQ for none of them again.
 */
export async function settleHqMedia(
	creds: CommCareCredentials,
	paths: readonly HqMediaPath[],
	options: { readonly cancel?: AbortSignal; readonly retain?: boolean },
): Promise<SettledHqMedia> {
	const requests = new Map<string, FileRequest>();
	for (const path of paths) {
		if (!isCandidate(path.standing) || path.hq === null) continue;
		const cap = ASSET_SIZE_CAPS_BYTES[path.kind];
		const held = requests.get(path.hq.multimediaId);
		requests.set(path.hq.multimediaId, {
			multimediaId: path.hq.multimediaId,
			mediaType: held?.mediaType ?? path.hq.mediaType,
			maxBytes: Math.max(held?.maxBytes ?? 0, cap),
		});
	}

	const stop = new AbortController();
	const signal =
		options.cancel === undefined
			? stop.signal
			: AbortSignal.any([options.cancel, stop.signal]);
	const verdicts = new Map<string, FileVerdict>();
	const reads = new Map<string, SettledHqMediaRead>();
	let retainedBytes = 0;
	let failure: CommCareApiError | null = null;
	let thrown: { readonly error: unknown } | null = null;

	const ask = async (request: FileRequest): Promise<void> => {
		const read: HqMediaFileRead = await readHqMediaFile(
			creds,
			request.mediaType,
			request.multimediaId,
			{ maxBytes: request.maxBytes, cancel: signal },
		);
		if ("success" in read) {
			failure ??= read;
			stop.abort();
			return;
		}
		if (options.retain === true) {
			if (read.kind === "missing")
				reads.set(request.multimediaId, { kind: "missing" });
			else if (
				read.kind === "read" &&
				retainedBytes + read.bytes.byteLength <= HQ_MEDIA_IN_FLIGHT_MAX_BYTES
			) {
				retainedBytes += read.bytes.byteLength;
				reads.set(request.multimediaId, { kind: "read", bytes: read.bytes });
			}
		}
		verdicts.set(
			request.multimediaId,
			read.kind === "read"
				? {
						kind: "hash",
						sha256: createHash("sha256").update(read.bytes).digest("hex"),
					}
				: { kind: read.kind },
		);
	};

	const queue = [...requests.values()];
	const inFlight = new Set<Promise<void>>();
	let inFlightBytes = 0;
	let next = 0;
	const fits = (request: FileRequest) =>
		inFlight.size < HQ_MEDIA_READ_CONCURRENCY &&
		inFlightBytes + request.maxBytes <= HQ_MEDIA_IN_FLIGHT_MAX_BYTES;
	const mayStart = () => failure === null && thrown === null && !signal.aborted;
	for (;;) {
		while (
			next < queue.length &&
			mayStart() &&
			fits(queue[next] as FileRequest)
		) {
			const request = queue[next] as FileRequest;
			next += 1;
			inFlightBytes += request.maxBytes;
			const task: Promise<void> = ask(request)
				.catch((error: unknown) => {
					thrown ??= { error };
					stop.abort();
				})
				.finally(() => {
					inFlight.delete(task);
					inFlightBytes -= request.maxBytes;
				});
			inFlight.add(task);
		}
		if (inFlight.size === 0) break;
		await Promise.race(inFlight);
	}

	if (thrown !== null) throw (thrown as { readonly error: unknown }).error;
	if (failure !== null) return { kind: "failed", failure };
	if (options.cancel?.aborted === true)
		return {
			kind: "failed",
			failure: { success: false, status: 503, cause: "network" },
		};

	const learned: Record<string, string> = {};
	const settled = paths.map((path): HqMediaPath => {
		if (!isCandidate(path.standing) || path.hq === null) return path;
		const verdict = verdicts.get(path.hq.multimediaId);
		if (verdict === undefined)
			throw new Error(
				"Nova settled a media path it never asked CommCare HQ about. Every candidate's id is asked for once, so look at how settleHqMedia queues its reads.",
			);
		if (verdict.kind === "missing") return { ...path, standing: "absent" };
		if (verdict.kind === "hash" && verdict.sha256 === path.contentHash) {
			learned[path.wirePath] = path.hq.multimediaId;
			return { ...path, standing: "recorded" };
		}
		return { ...path, standing: "replaced" };
	});
	return { kind: "settled", paths: settled, learned, reads };
}

/** A standing an id alone cannot settle. */
function isCandidate(standing: HqMediaStanding): boolean {
	return standing === "moved" || standing === "unrecorded";
}
