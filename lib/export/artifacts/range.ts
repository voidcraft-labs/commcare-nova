/** Responses allow one inclusive byte range (RFC 9110). Multiple ranges
 * would require a multipart body, so Nova declines them before opening storage. */
export interface ByteRange {
	start: number;
	end: number;
}

export const EXPORT_INLINE_BYTES = 1024 * 1024;
export const EXPORT_PART_BYTES = 1024 * 1024;
export const EXPORT_RESOURCE_BYTES = 192 * 1024;

export function readByteRange(
	header: string | null,
	length: number,
): ByteRange | null {
	if (header === null) return { start: 0, end: length - 1 };
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2]) || length < 1) return null;
	const left = Number(match[1]);
	const right = Number(match[2]);
	if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
	if (!match[1])
		return right > 0
			? { start: Math.max(0, length - right), end: length - 1 }
			: null;
	const end = match[2] ? Math.min(length - 1, right) : length - 1;
	return left <= end ? { start: left, end } : null;
}

export async function* fixedExportParts(source: AsyncIterable<Uint8Array>) {
	let pending = Buffer.allocUnsafe(EXPORT_PART_BYTES);
	let used = 0;
	for await (const chunk of source) {
		let offset = 0;
		while (offset < chunk.length) {
			const length = Math.min(chunk.length - offset, pending.length - used);
			pending.set(chunk.subarray(offset, offset + length), used);
			used += length;
			offset += length;
			if (used === pending.length) {
				yield pending;
				pending = Buffer.allocUnsafe(EXPORT_PART_BYTES);
				used = 0;
			}
		}
	}
	if (used > 0) yield pending.subarray(0, used);
}
