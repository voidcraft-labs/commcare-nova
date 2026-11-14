import "server-only";

export type BoundedBody =
	| { readonly kind: "read"; readonly bytes: Uint8Array }
	/** The body passed `maxBytes`; `bytes` is how many had arrived when the read was cancelled. */
	| { readonly kind: "too-long"; readonly bytes: number }
	/** The stream failed or the deadline's signal aborted it. */
	| { readonly kind: "unavailable" };

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
			total += value.byteLength;
			if (maxBytes !== undefined && total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { kind: "too-long", bytes: total };
			}
			chunks.push(value);
		}
	} catch {
		return { kind: "unavailable" };
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { kind: "read", bytes };
}
