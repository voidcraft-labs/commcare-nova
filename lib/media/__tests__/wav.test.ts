/**
 * The WAV reader over ffmpeg's files and WAVs built here: 8- and 16-bit
 * integer PCM read as PCM, and every other encoding as the codec the
 * refusal names.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWav } from "../wav";

function fixture(name: string): Buffer {
	return readFileSync(join(import.meta.dirname, "fixtures", name));
}

/** A WAV of one `fmt ` chunk, after the chunks given, and no data. */
function wav(format: Buffer, before: Buffer[] = []): Buffer {
	const fmt = Buffer.alloc(8);
	fmt.write("fmt ", 0, "latin1");
	fmt.writeUInt32LE(format.length, 4);
	const body = Buffer.concat([...before, fmt, format]);
	const head = Buffer.alloc(12);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(4 + body.length, 4);
	head.write("WAVE", 8, "latin1");
	return Buffer.concat([head, body]);
}

function pcmFormat(tag: number, bits: number): Buffer {
	const format = Buffer.alloc(16);
	format.writeUInt16LE(tag, 0);
	format.writeUInt16LE(1, 2);
	format.writeUInt32LE(8000, 4);
	format.writeUInt16LE(bits, 14);
	return format;
}

describe("readWav", () => {
	it("reads 8- and 16-bit PCM", () => {
		expect(readWav(fixture("tone.wav"))).toEqual({ kind: "pcm", bits: 16 });
		expect(readWav(fixture("tone-8.wav"))).toEqual({ kind: "pcm", bits: 8 });
	});

	it("names 24-bit, float and mu-law files by their encoding", () => {
		expect(readWav(fixture("tone-24.wav"))).toEqual({
			kind: "codec",
			codec: "24-bit PCM",
		});
		expect(readWav(fixture("tone-float.wav"))).toEqual({
			kind: "codec",
			codec: "32-bit float",
		});
		expect(readWav(fixture("tone-mulaw.wav"))).toEqual({
			kind: "codec",
			codec: "mu-law",
		});
	});

	it("steps over a chunk of odd size and its pad byte before `fmt `", () => {
		const list = Buffer.alloc(8 + 3 + 1);
		list.write("LIST", 0, "latin1");
		list.writeUInt32LE(3, 4);
		expect(readWav(wav(pcmFormat(1, 16), [list]))).toEqual({
			kind: "pcm",
			bits: 16,
		});
	});

	it("reads a file with no format chunk as unreadable", () => {
		expect(readWav(fixture("tone.wav").subarray(0, 12))).toEqual({
			kind: "unreadable",
			detail: "no format chunk",
		});
	});
});
