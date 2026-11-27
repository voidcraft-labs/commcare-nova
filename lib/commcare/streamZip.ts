import { type PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ZipFile } from "yazl";
import { checkArchivePaths } from "./zipMembers";

export interface StreamMember {
	path: string;
	size?: number;
	open: () => AsyncIterable<Uint8Array>;
}

export function textMember(path: string, text: string): StreamMember {
	return {
		path,
		size: Buffer.byteLength(text),
		async *open() {
			// Preserve surrogate pairs at UTF-8 chunk boundaries.
			for (let start = 0; start < text.length; ) {
				let end = Math.min(start + 16384, text.length);
				const c = text.charCodeAt(end - 1);
				if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
				yield Buffer.from(text.slice(start, end));
				start = end;
			}
		},
	};
}
export function bytesMember(path: string, bytes: Uint8Array): StreamMember {
	return {
		path,
		size: bytes.length,
		async *open() {
			for (let i = 0; i < bytes.length; i += 65536)
				yield bytes.subarray(i, i + 65536);
		},
	};
}

/** One entry stream is open at a time. The consumer's backpressure travels all the
 * way through deflate to object storage. The central directory consists of names
 * and fixed-size member descriptors, so bound its memory separately from payloads. */
export async function* streamZip(
	members: readonly StreamMember[],
): AsyncGenerator<Uint8Array> {
	checkArchivePaths(members, "streamZip", 16 * 1024 * 1024);
	const zip = new ZipFile();
	const output = zip.outputStream as PassThrough;
	let input: Readable | undefined;
	let closed = false;
	zip.on("error", (error: Error) => output.destroy(error));
	try {
		for (const m of members) {
			zip.addReadStreamLazy(
				m.path,
				{
					mtime: new Date(2000, 0, 1),
					forceDosTimestamp: true,
					compressionLevel: 6,
					...(m.size !== undefined && { size: m.size }),
				},
				(ready) => {
					if (closed) return;
					input = Readable.from(m.open(), {
						objectMode: false,
						highWaterMark: 65536,
					});
					input.on("error", (error) => output.destroy(error));
					ready(null, input);
				},
			);
		}
		zip.end();
		for await (const bytes of output) yield bytes;
	} finally {
		closed = true;
		output.destroy();
		if (input) {
			input.destroy();
			await finished(input, { cleanup: true }).catch(() => undefined);
		}
	}
}
