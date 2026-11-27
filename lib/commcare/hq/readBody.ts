import "server-only";

import { HQ_BODY_BOUND_CEILING } from "./bounds";
import {
	currentMemoryLease,
	type HeldAs,
	MemoryMeterFullError,
} from "./memoryMeter";

/** The most bytes of a body past its bound that `too-long` keeps as its `head`. */
export const BOUNDED_BODY_HEAD_MAX_BYTES = 64 * 1024;

export type BoundedBody =
	| { readonly kind: "read"; readonly bytes: Uint8Array }
	/**
	 * The body passed `maxBytes`; `bytes` is how many had arrived when the read
	 * was cancelled, and `head` the first of them, at most `maxBytes` and at
	 * most `BOUNDED_BODY_HEAD_MAX_BYTES`: enough to say what the body is, never
	 * the body.
	 */
	| {
			readonly kind: "too-long";
			readonly bytes: number;
			readonly head: Uint8Array;
	  }
	/**
	 * The stream failed, the deadline's signal aborted it, or the request's
	 * lease refused to hold more (`error` a `MemoryMeterFullError`); `error`
	 * is what stopped it.
	 */
	| { readonly kind: "unavailable"; readonly error: unknown };

/**
 * Whether `maxBytes` is a bound a read may take: a whole number of bytes from
 * one to `HQ_BODY_BOUND_CEILING`. Anything else is a programmer's error, and
 * the reader throws on it rather than read without a bound.
 */
export function assertBodyBound(maxBytes: number): void {
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > HQ_BODY_BOUND_CEILING
	)
		throw new Error(
			`A read of CommCare HQ asked for a bound of ${String(maxBytes)} bytes. Every read takes a whole number of bytes from 1 to ${HQ_BODY_BOUND_CEILING}, named in lib/commcare/hq/bounds.ts.`,
		);
}

/**
 * The whole body, read as a stream so a bound stops the read rather than
 * following it. Only `http.ts` calls it, through `HqAnswer.read`.
 *
 * `sizeHint` is the answer's `Content-Length` where it named one within the
 * bound: the body is then written into one array of that length as it
 * arrives, so a file is held once rather than as chunks and then their join.
 * The hint never bounds anything: a body longer than it carries on as chunks,
 * and only `maxBytes`, counted on the stream, stops a read.
 *
 * Every byte is charged, as `held`, to the lease the request runs under
 * (`memoryMeter.ts`) before it is kept, the array a hint sizes when it is
 * made. A charge the lease refuses cancels the stream and answers
 * `unavailable` with a `MemoryMeterFullError`. What the read lets go is given
 * back before it answers: everything, where it answers `unavailable` or
 * `too-long` (whose head, at most `BOUNDED_BODY_HEAD_MAX_BYTES`, every caller
 * drops once it has read what the body is); all but the array it answers,
 * where that is shorter than what was charged. The caller keeps a body it
 * read charged until it lets it go (`giveBackHeld`) or the lease ends.
 */
export async function readBoundedBody(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	sizeHint: number | null,
	held: HeldAs,
): Promise<BoundedBody> {
	assertBodyBound(maxBytes);
	if (stream === null) return { kind: "read", bytes: new Uint8Array() };
	const lease = currentMemoryLease();
	let charged = 0;
	const charge = (bytes: number): boolean => {
		if (lease === undefined) return true;
		if (!lease.charge(held, bytes)) return false;
		charged += bytes;
		return true;
	};
	/** What the answer keeps of what was charged; the rest goes back. */
	const keeping = (bytes: number) => {
		if (lease !== undefined && charged > bytes)
			lease.giveBack(held, charged - bytes);
	};
	const reader = stream.getReader();
	const hinted =
		sizeHint !== null &&
		Number.isSafeInteger(sizeHint) &&
		sizeHint > 0 &&
		sizeHint <= maxBytes;
	if (hinted && !charge(sizeHint)) {
		await reader.cancel().catch(() => undefined);
		return { kind: "unavailable", error: new MemoryMeterFullError() };
	}
	const sized = hinted ? new Uint8Array(sizeHint) : null;
	/* While `chunks` is null the body is written into `sized`; once a chunk
	 * would pass it, what was written becomes the first chunk. */
	let chunks: Uint8Array[] | null = sized === null ? [] : null;
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.byteLength > maxBytes) {
				const written =
					chunks ?? (sized === null ? [] : [sized.subarray(0, total)]);
				const head = joined(
					[...written, value],
					Math.min(maxBytes, BOUNDED_BODY_HEAD_MAX_BYTES),
				);
				total += value.byteLength;
				chunks = null;
				await reader.cancel().catch(() => undefined);
				keeping(0);
				return { kind: "too-long", bytes: total, head };
			}
			if (chunks === null && sized !== null) {
				if (total + value.byteLength <= sized.byteLength) {
					sized.set(value, total);
					total += value.byteLength;
					continue;
				}
				chunks = [sized.subarray(0, total)];
			}
			if (!charge(value.byteLength)) {
				await reader.cancel().catch(() => undefined);
				keeping(0);
				return { kind: "unavailable", error: new MemoryMeterFullError() };
			}
			(chunks as Uint8Array[]).push(value);
			total += value.byteLength;
		}
	} catch (error) {
		keeping(0);
		return { kind: "unavailable", error };
	}
	if (chunks === null && sized !== null) {
		const bytes = total === sized.byteLength ? sized : sized.slice(0, total);
		keeping(bytes.byteLength);
		return { kind: "read", bytes };
	}
	const bytes = joined(chunks ?? [], total);
	keeping(bytes.byteLength);
	return { kind: "read", bytes };
}

/** The first `length` bytes of `chunks`, in one array. */
function joined(chunks: readonly Uint8Array[], length: number): Uint8Array {
	if (chunks.length === 1 && chunks[0]?.byteLength === length) return chunks[0];
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= length) break;
		const part = chunk.subarray(0, length - offset);
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return bytes;
}

/** Decode a selected part of a response without retaining other case or worker
 * data. The consumer may keep its own bounded projection only. */
export async function consumeBoundedBody(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	consume: (chunk: Uint8Array) => void,
	mode?: "media-digest",
): Promise<"read" | "too-long" | "unavailable"> {
	if (mode === "media-digest") {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
			throw new Error(
				"A streamed media digest needs the expected file length.",
			);
	} else assertBodyBound(maxBytes);
	if (stream === null) return "read";
	const reader = stream.getReader();
	const lease = currentMemoryLease();
	let total = 0;
	let complete = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				complete = true;
				return "read";
			}
			total += value.byteLength;
			if (total > maxBytes) return "too-long";
			if (lease && !lease.charge("text", value.byteLength))
				return "unavailable";
			try {
				consume(value);
			} finally {
				lease?.giveBack("text", value.byteLength);
			}
		}
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
