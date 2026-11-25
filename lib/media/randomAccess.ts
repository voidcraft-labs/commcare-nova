/**
 * The bytes of one file, read by position.
 *
 * The upload gate judges a file through this one shape whether its bytes are
 * in memory (an upload, a file read from CommCare HQ within its kind's cap) or
 * in a staged object read by range (a file read from CommCare HQ past that
 * cap, `lib/storage/media.ts::stagedObjectBytes`). Every reader of the gate
 * (the format sniff, the container parse, Nova's own box and chunk walkers)
 * reads through it, so a file's verdict is the same wherever its bytes are.
 */

import type { IReadChunkOptions, ITokenizerOptions } from "strtok3";
import { AbstractTokenizer, EndOfStreamError } from "strtok3";

export interface RandomAccessBytes {
	/** How many bytes the file holds. */
	readonly size: number;
	/**
	 * The bytes from `at`, at most `length` of them: fewer only where the file
	 * ends first, and none at or past its end.
	 */
	read(at: number, length: number): Promise<Uint8Array>;
}

/** Bytes in memory, read in place. */
export function bufferBytes(bytes: Uint8Array): RandomAccessBytes {
	return {
		size: bytes.byteLength,
		async read(at, length) {
			if (at >= bytes.byteLength || length <= 0) return new Uint8Array(0);
			return bytes.subarray(at, Math.min(bytes.byteLength, at + length));
		},
	};
}

/**
 * A file read by ranges, in blocks of `blockBytes`, the last `blocksKept` of
 * them kept: a reader walking a file's headers asks `range` for a few blocks,
 * and what it holds is `blockBytes * blocksKept` at most. A read spanning more
 * blocks than are kept (a whole picture) is one range of its own and keeps
 * nothing. `range` answers exactly the `length` bytes from `start`, which lie
 * inside the file.
 */
export function blockBytes(input: {
	readonly size: number;
	readonly blockBytes: number;
	readonly blocksKept: number;
	readonly range: (start: number, length: number) => Promise<Uint8Array>;
}): RandomAccessBytes {
	const { size, blockBytes: blockSize, blocksKept, range } = input;
	/* Least recently used first: a block read again moves to the end. */
	const blocks = new Map<number, Promise<Uint8Array>>();
	const block = (index: number): Promise<Uint8Array> => {
		const kept = blocks.get(index);
		if (kept !== undefined) {
			blocks.delete(index);
			blocks.set(index, kept);
			return kept;
		}
		const start = index * blockSize;
		const read = range(start, Math.min(blockSize, size - start));
		blocks.set(index, read);
		read.catch(() => {
			if (blocks.get(index) === read) blocks.delete(index);
		});
		while (blocks.size > blocksKept) {
			const oldest = blocks.keys().next().value as number;
			blocks.delete(oldest);
		}
		return read;
	};
	return {
		size,
		async read(at, length) {
			const end = Math.min(size, at + Math.max(0, length));
			if (at >= end) return new Uint8Array(0);
			const first = Math.floor(at / blockSize);
			const last = Math.floor((end - 1) / blockSize);
			if (last - first + 1 > blocksKept) return range(at, end - at);
			const out = new Uint8Array(end - at);
			for (let index = first; index <= last; index++) {
				const bytes = await block(index);
				const blockStart = index * blockSize;
				const from = Math.max(at, blockStart);
				const to = Math.min(end, blockStart + bytes.byteLength);
				out.set(bytes.subarray(from - blockStart, to - blockStart), from - at);
			}
			return out;
		},
	};
}

/**
 * A strtok3 tokenizer over `RandomAccessBytes`, as strtok3's own
 * `BufferTokenizer` is over a buffer: random access, the file's size known.
 * `file-type` and `music-metadata` take it where they take a buffer's.
 */
export class RandomAccessTokenizer extends AbstractTokenizer {
	readonly fileInfo: { size: number; mimeType?: string };

	constructor(
		private readonly source: RandomAccessBytes,
		options: ITokenizerOptions = {},
	) {
		super(options);
		this.fileInfo = { ...(options.fileInfo ?? {}), size: source.size };
	}

	async readBuffer(
		target: Uint8Array,
		options?: IReadChunkOptions,
	): Promise<number> {
		const normalized = this.normalizeOptions(target, options);
		const read = await this.peekBuffer(target, normalized);
		this.position = normalized.position + read;
		return read;
	}

	async peekBuffer(
		target: Uint8Array,
		options?: IReadChunkOptions,
	): Promise<number> {
		const normalized = this.normalizeOptions(target, options);
		const wanted = Math.max(
			0,
			Math.min(this.source.size - normalized.position, normalized.length),
		);
		if (!normalized.mayBeLess && wanted < normalized.length)
			throw new EndOfStreamError();
		let done = 0;
		while (done < wanted) {
			const chunk = await this.source.read(
				normalized.position + done,
				wanted - done,
			);
			if (chunk.byteLength === 0) throw new EndOfStreamError();
			target.set(chunk, done);
			done += chunk.byteLength;
		}
		return done;
	}

	supportsRandomAccess(): boolean {
		return true;
	}

	setPosition(position: number): void {
		this.validateLength(position, "position");
		this.position = position;
	}
}
