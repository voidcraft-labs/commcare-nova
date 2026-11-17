/**
 * The record a bring-in's birth writes of which CommCare HQ file stands at
 * each path the app keeps there.
 *
 * It would catch: a kept path recorded under another entry's id, so the first
 * publish's drift check sees a file replaced that nobody touched; a path the
 * app does not keep recorded beside the ones it does; and a kept path with no
 * entry passed over silently instead of naming the caller's mistake.
 */

import { describe, expect, it } from "vitest";
import type { HqMediaMapItem } from "@/lib/commcare/hq/appSource";
import { hqMediaRecordFromSource, hqMediaRecordSchema } from "../hqMedia";

const MAP: readonly HqMediaMapItem[] = [
	{
		path: "jr://file/commcare/image/logo.png",
		multimediaId: "a1b2c3",
		mediaType: "CommCareImage",
		unreadable: false,
	},
	{
		path: "jr://file/commcare/image/logo-copy.png",
		multimediaId: "a1b2c3",
		mediaType: "CommCareImage",
		unreadable: false,
	},
	{
		path: "jr://file/commcare/audio/hello.mp3",
		multimediaId: "d4e5f6",
		mediaType: "CommCareAudio",
		unreadable: false,
	},
	{
		path: "jr://file/commcare/image/empty.png",
		multimediaId: null,
		mediaType: null,
		unreadable: false,
	},
];

describe("hqMediaRecordFromSource", () => {
	it("records each kept path under the id of the map entry at that path, and nothing else", () => {
		const record = hqMediaRecordFromSource(
			["commcare/audio/hello.mp3", "commcare/image/logo.png"],
			MAP,
		);
		expect(record).toEqual({
			"commcare/audio/hello.mp3": "d4e5f6",
			"commcare/image/logo.png": "a1b2c3",
		});
		expect(hqMediaRecordSchema.parse(record)).toEqual(record);
	});

	it("records nothing for an app that keeps no path", () => {
		expect(hqMediaRecordFromSource([], MAP)).toEqual({});
	});

	it("refuses a kept path the map names no file at, without naming the path", () => {
		for (const path of ["commcare/image/empty.png", "commcare/image/gone.png"])
			expect(() => hqMediaRecordFromSource([path], MAP)).toThrow(
				/media map names no file there/,
			);
		expect(() =>
			hqMediaRecordFromSource(["commcare/image/gone.png"], MAP),
		).not.toThrow(/gone/);
	});
});
