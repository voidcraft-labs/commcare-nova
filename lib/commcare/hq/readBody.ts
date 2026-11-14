import "server-only";

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
	/** The stream failed or the deadline's signal aborted it; `error` is what the stream threw. */
	| { readonly kind: "unavailable"; readonly error: unknown };

/** The whole body, read as a stream so a bound stops the read rather than
 * following it. */
export async function readBoundedBody(
	response: Response,
	maxBytes: number | undefined,
): Promise<BoundedBody> {
	const stream = response.body;
	if (stream === null) return { kind: "read", bytes: new Uint8Array() };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (maxBytes !== undefined && total + value.byteLength > maxBytes) {
				const head = joined(
					[...chunks, value],
					Math.min(maxBytes, BOUNDED_BODY_HEAD_MAX_BYTES),
				);
				total += value.byteLength;
				await reader.cancel().catch(() => undefined);
				return { kind: "too-long", bytes: total, head };
			}
			total += value.byteLength;
			chunks.push(value);
		}
	} catch (error) {
		return { kind: "unavailable", error };
	}
	return { kind: "read", bytes: joined(chunks, total) };
}

/** The first `length` bytes of `chunks`, in one array. */
function joined(chunks: readonly Uint8Array[], length: number): Uint8Array {
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
