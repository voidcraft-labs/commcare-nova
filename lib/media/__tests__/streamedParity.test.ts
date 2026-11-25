/**
 * The gate over a file read by position gives the verdict it gives the same
 * bytes in memory: `validateSniffedMediaBody` against
 * `validateSniffedMediaBytes`, over every committed fixture (accepted and
 * refused alike), each read through `blockBytes` in blocks far smaller than
 * the structures the readers walk, so every read that crosses a block, every
 * block evicted and read again, and every read past the end is exercised.
 *
 * Then the reason the path exists: a video past its kind's cap, which the
 * in-memory gate refuses for its size, is judged from a few blocks of it.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSET_SIZE_CAPS_BYTES } from "@/lib/domain/multimedia";
import { blockBytes, bufferBytes } from "../randomAccess";
import {
	type MediaBody,
	validateSniffedMediaBody,
	validateSniffedMediaBytes,
} from "../validate";

const FIXTURES = join(import.meta.dirname, "fixtures");

/** `bytes` read by ranges in blocks of `block`, counting what the ranges asked for. */
function rangedBody(
	bytes: Buffer,
	block: number,
): { readonly body: MediaBody; readonly asked: { bytes: number } } {
	const asked = { bytes: 0 };
	const memory = bufferBytes(bytes);
	const body: MediaBody = {
		source: blockBytes({
			size: bytes.byteLength,
			blockBytes: block,
			blocksKept: 3,
			async range(start, length) {
				asked.bytes += length;
				expect(start + length).toBeLessThanOrEqual(bytes.byteLength);
				/* A copy: nothing the readers hold aliases the file. */
				return (await memory.read(start, length)).slice();
			},
		}),
		withWhole: (use) => use(bytes),
		parseTimeoutMs: 10_000,
	};
	return { body, asked };
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("the gate over a file read by position", () => {
	const files = readdirSync(FIXTURES).sort();

	it.each(files)("judges %s as it judges the bytes in memory", async (name) => {
		const bytes = readFileSync(join(FIXTURES, name));
		const inMemory = await validateSniffedMediaBytes(bytes);
		for (const block of [7, 61, 4096]) {
			const { body } = rangedBody(bytes, block);
			expect(
				await validateSniffedMediaBody({ body, contentHash: sha256(bytes) }),
			).toEqual(inMemory);
		}
	});

	it("judges a file of one byte and of none as it judges them in memory", async () => {
		for (const bytes of [Buffer.alloc(0), Buffer.from([0x89])]) {
			const { body } = rangedBody(bytes, 7);
			expect(
				await validateSniffedMediaBody({ body, contentHash: sha256(bytes) }),
			).toEqual(await validateSniffedMediaBytes(bytes));
		}
	});

	it("holds a video past its kind's cap, read from a few blocks of it", async () => {
		const video = readFileSync(join(FIXTURES, "pattern-h264-main-aac.mp4"));
		/* A `free` box after the movie takes the file past the video cap. */
		const padding = ASSET_SIZE_CAPS_BYTES.video + 1;
		const free = Buffer.alloc(8 + padding);
		free.writeUInt32BE(8 + padding, 0);
		free.write("free", 4, "latin1");
		const large = Buffer.concat([video, free]);

		const inMemory = await validateSniffedMediaBytes(large);
		expect(inMemory).toMatchObject({
			ok: false,
			reason: "size-cap-exceeded",
		});

		const { body, asked } = rangedBody(large, 64 * 1024);
		const judged = await validateSniffedMediaBody({
			body,
			contentHash: sha256(large),
		});
		const small = await validateSniffedMediaBytes(video);
		if (!small.ok) throw new Error("the fixture is not a video the gate holds");
		expect(judged).toEqual({
			ok: true,
			validated: {
				...small.validated,
				contentHash: sha256(large),
				sizeBytes: large.byteLength,
			},
		});
		/* The free box is never read: what the ranges asked for is a few blocks. */
		expect(asked.bytes).toBeLessThan(1024 * 1024);
	});

	it("refuses a picture larger than the body holds whole, by its size", async () => {
		const picture = readFileSync(join(FIXTURES, "pattern.png"));
		const { body } = rangedBody(picture, 61);
		const judged = await validateSniffedMediaBody({
			body: { ...body, withWhole: async () => null },
			contentHash: sha256(picture),
		});
		expect(judged).toMatchObject({
			ok: false,
			reason: "size-cap-exceeded",
			sniffedMime: "image/png",
		});
	});
});
