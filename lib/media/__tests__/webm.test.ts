/**
 * The VP9 profile reader over the committed WebM fixtures (the ffmpeg
 * commands at the top of `validate.test.ts`): the profile of each VP9 file,
 * and an unreadable answer for every file that holds no VP9 frame.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bufferBytes } from "../randomAccess";
import { readVp9Profile as readVp9ProfileAt } from "../webm";

/** The reader over bytes in memory. */
const readVp9Profile = (bytes: Uint8Array) =>
	readVp9ProfileAt(bufferBytes(bytes));

function fixture(name: string): Uint8Array {
	return readFileSync(join(import.meta.dirname, "fixtures", name));
}

describe("readVp9Profile", () => {
	it.each([
		["pattern-vp9.webm", 0],
		["pattern-vp9-opus.webm", 0],
		["pattern-vp9-profile1.webm", 1],
		["pattern-vp9-profile2.webm", 2],
	] as const)("reads %s as profile %i", async (file, profile) => {
		expect(await readVp9Profile(fixture(file))).toEqual({
			kind: "profile",
			profile,
		});
	});

	it.each([
		"pattern-vp8.webm",
		"pattern-vp8-vorbis.webm",
		"pattern-av1.webm",
		"tone.webm",
	])("finds no VP9 frame in %s", async (file) => {
		expect((await readVp9Profile(fixture(file))).kind).toBe("unreadable");
	});

	it("answers unreadable for a file cut before its first frame", async () => {
		const bytes = fixture("pattern-vp9.webm");
		const cut = bytes.subarray(0, 200);
		expect((await readVp9Profile(cut)).kind).toBe("unreadable");
	});

	it("answers unreadable for bytes that are no WebM", async () => {
		expect((await readVp9Profile(new Uint8Array([0, 1, 2, 3]))).kind).toBe(
			"unreadable",
		);
		expect((await readVp9Profile(new Uint8Array(0))).kind).toBe("unreadable");
	});
});
