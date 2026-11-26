/**
 * Which CommCare HQ file Nova knows to stand at each path an app publishes:
 * the record a bring-in's birth writes, the standing of each published file
 * against a source read, the record after each write, and the comparison's
 * one `media` part.
 *
 * It would catch: a kept path recorded under another entry's id, so the first
 * publish's drift check sees a file replaced that nobody touched; a path the
 * app does not keep recorded beside the ones it does; a kept path with no
 * entry passed over silently instead of naming the caller's mistake; a file
 * replaced in CommCare HQ read as this app's because only its path was
 * compared; a path with no record read as unchanged, so a publish writes over
 * it unseen; a report's id losing to an older record; an id whose file
 * CommCare HQ no longer serves kept, so every Refresh reads a moved file a
 * review finds unchanged; a file Nova's own upload mapped between a
 * publish's two reads read as a person's, unsettled; and a moved file that
 * never reaches the drift verdict.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { HqMediaMapItem } from "@/lib/commcare/hq/appSource";
import {
	type HqMediaPath,
	hqMediaRecordFromSource,
	hqMediaRecordMoves,
	hqMediaRecordSchema,
	hqMediaStandings,
	mediaMovedBetween,
	movedRecordedPaths,
	nextHqMediaRecord,
	type PublishedMediaFile,
} from "../hqMedia";
import { diffHqAppSource, normalizeHqAppSource } from "../hqSourceBaseline";
import type { AppOwnership } from "../types";

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

/** A published image at `wirePath`. */
function published(wirePath: string): PublishedMediaFile {
	return {
		wirePath,
		assetId: testMediaAssetId(wirePath),
		contentHash: "a".repeat(64),
		kind: "image",
	};
}

/** A map entry naming a file, at `jr://file/<wirePath>`. */
function entry(wirePath: string, multimediaId: string): HqMediaMapItem {
	return {
		path: `jr://file/${wirePath}`,
		multimediaId,
		mediaType: "CommCareImage",
		unreadable: false,
	};
}

describe("hqMediaStandings", () => {
	const paths = {
		absent: "commcare/absent.png",
		noId: "commcare/no-id.png",
		unreadable: "commcare/unreadable.png",
		recorded: "commcare/recorded.png",
		moved: "commcare/moved.png",
		unrecorded: "commcare/unrecorded.png",
	};
	const now: readonly HqMediaMapItem[] = [
		{
			path: `jr://file/${paths.noId}`,
			multimediaId: null,
			mediaType: null,
			unreadable: false,
		},
		{
			path: `jr://file/${paths.unreadable}`,
			multimediaId: null,
			mediaType: null,
			unreadable: true,
		},
		entry(paths.recorded, "doc-recorded"),
		entry(paths.moved, "doc-new"),
		entry(paths.unrecorded, "doc-unrecorded"),
	];
	const record = {
		[paths.recorded]: "doc-recorded",
		[paths.moved]: "doc-old",
		[paths.absent]: "doc-gone",
		[paths.noId]: "doc-emptied",
		[paths.unreadable]: "doc-before",
	};

	it("holds a mapped picture under the wrong class even when its recorded id is unchanged", () => {
		const file = published(paths.recorded);
		const image = entry(file.wirePath, record[paths.recorded]);
		const audio: HqMediaMapItem = { ...image, mediaType: "CommCareAudio" };
		expect(
			hqMediaStandings({ published: [file], record, now: [audio] }),
		).toMatchObject([{ standing: "replaced" }]);
		expect(mediaMovedBetween([image], [audio], [file])).toMatchObject([
			{ standing: "replaced" },
		]);
	});

	it("judges every combination of a record and an entry", () => {
		const standings = hqMediaStandings({
			published: Object.values(paths).map(published),
			record,
			now,
		});
		expect(
			standings.map(({ wirePath, standing, hq }) => ({
				wirePath,
				standing,
				hq,
			})),
		).toEqual([
			{ wirePath: paths.absent, standing: "absent", hq: null },
			{ wirePath: paths.noId, standing: "absent", hq: null },
			{ wirePath: paths.unreadable, standing: "replaced", hq: null },
			{
				wirePath: paths.recorded,
				standing: "recorded",
				hq: { mediaType: "CommCareImage", multimediaId: "doc-recorded" },
			},
			{
				wirePath: paths.moved,
				standing: "moved",
				hq: { mediaType: "CommCareImage", multimediaId: "doc-new" },
			},
			{
				wirePath: paths.unrecorded,
				standing: "unrecorded",
				hq: { mediaType: "CommCareImage", multimediaId: "doc-unrecorded" },
			},
		]);
	});

	it("reads every file an entry names as unrecorded where Nova holds no record", () => {
		expect(
			hqMediaStandings({
				published: Object.values(paths).map(published),
				record: null,
				now,
			}).map((path) => path.standing),
		).toEqual([
			"absent",
			"absent",
			"replaced",
			"unrecorded",
			"unrecorded",
			"unrecorded",
		]);
	});

	it("keeps each published file's own facts beside its standing", () => {
		const file = published(paths.recorded);
		const [standing] = hqMediaStandings({
			published: [file],
			record,
			now,
		});
		expect(standing).toMatchObject(file);
	});
});

describe("nextHqMediaRecord", () => {
	const files = [
		"commcare/a.png",
		"commcare/b.png",
		"commcare/c.png",
		"commcare/d.png",
	];

	it("takes the reported id, else the learned one, else the previous record's", () => {
		expect(
			nextHqMediaRecord({
				published: files.map(published),
				previous: {
					"commcare/a.png": "previous-a",
					"commcare/b.png": "previous-b",
					"commcare/c.png": "previous-c",
				},
				learned: {
					"commcare/a.png": "learned-a",
					"commcare/b.png": "learned-b",
				},
				reported: { "commcare/a.png": "reported-a" },
			}),
		).toEqual({
			"commcare/a.png": "reported-a",
			"commcare/b.png": "learned-b",
			"commcare/c.png": "previous-c",
		});
	});

	it("leaves out a path the app no longer publishes, and one CommCare HQ reported for no published file", () => {
		expect(
			nextHqMediaRecord({
				published: [published("commcare/a.png")],
				previous: {
					"commcare/a.png": "previous-a",
					"commcare/old.png": "previous-old",
				},
				learned: { "commcare/gone.png": "learned-gone" },
				reported: { "commcare/other.png": "reported-other" },
			}),
		).toEqual({ "commcare/a.png": "previous-a" });
	});

	it("keeps no previous id for a path whose entry names a file CommCare HQ no longer serves", () => {
		const gone: HqMediaPath = {
			...published("commcare/a.png"),
			hq: { mediaType: "CommCareImage", multimediaId: "doc-dead" },
			standing: "absent",
		};
		const emptied: HqMediaPath = {
			...published("commcare/b.png"),
			hq: null,
			standing: "absent",
		};
		const previous = {
			"commcare/a.png": "previous-a",
			"commcare/b.png": "previous-b",
		};
		expect(
			nextHqMediaRecord({
				published: [gone, emptied],
				previous,
				learned: {},
				reported: {},
				settled: [gone, emptied],
			}),
		).toEqual({ "commcare/b.png": "previous-b" });
		expect(
			nextHqMediaRecord({
				published: [gone, emptied],
				previous,
				learned: {},
				reported: { "commcare/a.png": "reported-a" },
				settled: [gone, emptied],
			}),
		).toEqual({
			"commcare/a.png": "reported-a",
			"commcare/b.png": "previous-b",
		});
	});

	it("writes an empty record for an app that publishes no file", () => {
		expect(
			nextHqMediaRecord({
				published: [],
				previous: { "commcare/a.png": "previous-a" },
				learned: {},
				reported: {},
			}),
		).toEqual({});
	});
});

describe("mediaMovedBetween", () => {
	const at = "commcare/a.png";
	const standingsOf = (
		first: readonly HqMediaMapItem[],
		second: readonly HqMediaMapItem[],
	) =>
		mediaMovedBetween(first, second, [published(at)]).map(
			({ wirePath, standing, hq }) => ({ wirePath, standing, hq }),
		);

	it("lists no path that holds the same entry in both reads", () => {
		const map = [entry(at, "doc-1"), entry("commcare/other.png", "doc-2")];
		expect(
			mediaMovedBetween(
				map,
				[entry(at, "doc-1"), entry("commcare/other.png", "doc-3")],
				[published(at)],
			),
		).toEqual([]);
		expect(mediaMovedBetween([], [], [published(at)])).toEqual([]);
	});

	it("lists a file the second read names under another id, or names where the first named none, to be settled by its content", () => {
		const settle = {
			wirePath: at,
			standing: "unrecorded",
			hq: { mediaType: "CommCareImage", multimediaId: "doc-2" },
		};
		expect(standingsOf([entry(at, "doc-1")], [entry(at, "doc-2")])).toEqual([
			settle,
		]);
		/* Nova's own earlier upload, whose processing outlived its poll, can
		 * map its file between the two reads: its content says so. */
		expect(standingsOf([], [entry(at, "doc-2")])).toEqual([settle]);
	});

	it("lists an entry Nova cannot read as replaced, and a file gone as absent", () => {
		expect(
			standingsOf(
				[entry(at, "doc-1")],
				[
					{
						path: `jr://file/${at}`,
						multimediaId: null,
						mediaType: null,
						unreadable: true,
					},
				],
			),
		).toEqual([{ wirePath: at, standing: "replaced", hq: null }]);
		expect(standingsOf([entry(at, "doc-1")], [])).toEqual([
			{ wirePath: at, standing: "absent", hq: null },
		]);
	});
});

describe("hqMediaRecordMoves", () => {
	it("is true only where the next record learns, forgets or changes an id", () => {
		const record = { "commcare/a.png": "doc-a" };
		expect(hqMediaRecordMoves(record, { "commcare/a.png": "doc-a" })).toBe(
			false,
		);
		expect(hqMediaRecordMoves(null, {})).toBe(false);
		expect(hqMediaRecordMoves({}, {})).toBe(false);
		expect(hqMediaRecordMoves(record, {})).toBe(true);
		expect(hqMediaRecordMoves(record, { "commcare/a.png": "doc-b" })).toBe(
			true,
		);
		expect(
			hqMediaRecordMoves(record, {
				"commcare/a.png": "doc-a",
				"commcare/b.png": "doc-b",
			}),
		).toBe(true);
		expect(hqMediaRecordMoves(null, { "commcare/a.png": "doc-a" })).toBe(true);
	});
});

describe("movedRecordedPaths", () => {
	it("counts a recorded path whose id moved, and no path without a record", () => {
		const now = [
			entry("commcare/same.png", "doc-same"),
			entry("commcare/moved.png", "doc-new"),
			entry("commcare/unrecorded.png", "doc-any"),
			{
				path: "jr://file/commcare/unreadable.png",
				multimediaId: null,
				mediaType: null,
				unreadable: true,
			},
		];
		const record = {
			"commcare/same.png": "doc-same",
			"commcare/moved.png": "doc-old",
			"commcare/unreadable.png": "doc-before",
			"commcare/gone.png": "doc-gone",
		};
		expect(movedRecordedPaths(record, now)).toBe(2);
		expect(movedRecordedPaths(null, now)).toBe(0);
		expect(movedRecordedPaths({}, now)).toBe(0);
	});
});

describe("diffHqAppSource's media part", () => {
	const READS = path.join(process.cwd(), "proof/hq-reads");
	const source = JSON.parse(
		JSON.parse(
			readFileSync(path.join(READS, "navigation-base/app-source.json"), "utf8"),
		).body,
	) as unknown;
	const ownership = JSON.parse(
		readFileSync(path.join(READS, "navigation-base/ownership.json"), "utf8"),
	) as AppOwnership;
	const normalized = normalizeHqAppSource(source);
	if ("malformed" in normalized)
		throw new Error("The retained read did not normalize.");
	const diff = (options: { shell: boolean; mediaChanged?: number }) =>
		diffHqAppSource({
			baseline: normalized.normalized,
			current: normalized.normalized,
			ownership,
			shell: options.shell,
			languageNames: "nova",
			...(options.mediaChanged !== undefined && {
				mediaChanged: options.mediaChanged,
			}),
		});

	it("gives one media part for a count above zero", () => {
		expect(diff({ shell: false, mediaChanged: 1 })).toEqual([
			{ kind: "media", count: 1 },
		]);
		expect(diff({ shell: false, mediaChanged: 3 })).toEqual([
			{ kind: "media", count: 3 },
		]);
	});

	it("gives none for zero or for no count, on a shell as on any app", () => {
		expect(diff({ shell: false, mediaChanged: 0 })).toEqual([]);
		expect(diff({ shell: false })).toEqual([]);
		expect(diff({ shell: true, mediaChanged: 0 })).toEqual([]);
	});

	it("gives a shell's media part too: the empty app HQ made can hold a file at a path this app publishes", () => {
		expect(diff({ shell: true, mediaChanged: 2 })).toEqual([
			{ kind: "media", count: 2 },
		]);
	});
});
