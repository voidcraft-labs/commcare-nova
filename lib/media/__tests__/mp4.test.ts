/**
 * The MP4 reader over real bytes: each profile ffmpeg wrote reads as itself,
 * and each file no platform plays reads as the reason the upload gate names.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readMp4 } from "../mp4";
import { severalEncodingsMp4, twoVideoMp4 } from "./editedFixtures";

function fixture(name: string): Buffer {
	return readFileSync(join(import.meta.dirname, "fixtures", name));
}

describe("readMp4", () => {
	it.each([
		["pattern-h264-baseline.mp4", "mp4-h264-baseline"],
		["pattern-h264-main-aac.mp4", "mp4-h264-main"],
		["tiny-video.mp4", "mp4-h264-high"],
		["pattern-hevc.mp4", "mp4-hevc"],
		["pattern-mpeg4.mp4", "mp4-mpeg4-part2"],
	])("reads %s as %s", (file, key) => {
		expect(readMp4(fixture(file))).toEqual({ kind: "variant", key });
	});

	it.each([
		["pattern-h264-high10.mp4", "H.264 High 10", "MP4 with H.264 Main video"],
		["pattern-hevc-main10.mp4", "HEVC Main 10", "MP4 with H.264 Main video"],
		[
			"pattern-mpeg4-asp.mp4",
			"MPEG-4 Part 2 Advanced Simple",
			"MP4 with H.264 Main video",
		],
		["pattern-av1.mp4", "AV1", "MP4 with H.264 Main video"],
		["pattern-h264-mp3.mp4", "MP3", "MP4 with AAC audio, or with none"],
	])("names %s's codec as %s", (file, codec, accepted) => {
		expect(readMp4(fixture(file))).toEqual({ kind: "codec", codec, accepted });
	});

	it("reads a sound-only file, two video tracks and a subtitle track as their own refusals", () => {
		expect(readMp4(fixture("tone-audio-only.mp4"))).toEqual({
			kind: "no-video",
		});
		expect(readMp4(twoVideoMp4())).toEqual({ kind: "several-videos" });
		expect(readMp4(fixture("pattern-h264-subtitles.mp4"))).toEqual({
			kind: "other-track",
			handler: "sbtl",
		});
	});

	it("names a track of several encodings against its own kind's advice", () => {
		expect(
			readMp4(severalEncodingsMp4("pattern-h264-main-aac.mp4", "soun")),
		).toEqual({
			kind: "codec",
			codec: "several encodings in one track",
			accepted: "MP4 with AAC audio, or with none",
		});
		expect(
			readMp4(severalEncodingsMp4("pattern-h264-main-aac.mp4", "vide")),
		).toEqual({
			kind: "codec",
			codec: "several encodings in one track",
			accepted: "MP4 with H.264 Main video",
		});
		expect(readMp4(severalEncodingsMp4("tone-audio-only.mp4", "soun"))).toEqual(
			{ kind: "no-video" },
		);
	});

	it("reads a cut header and a file with no movie as unreadable", () => {
		expect(
			readMp4(fixture("pattern-h264-main-aac.mp4").subarray(0, 200)),
		).toEqual({
			kind: "unreadable",
			detail: "a box runs past the end of the file",
		});
		expect(readMp4(new Uint8Array(12))).toEqual({
			kind: "unreadable",
			detail: "no movie header",
		});
	});
});
