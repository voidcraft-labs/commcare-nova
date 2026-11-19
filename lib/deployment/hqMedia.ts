/**
 * Which CommCare HQ file Nova knows to stand at each path an app publishes
 * to one deployment, as `app_deployment_baselines.media_files` keeps it, and
 * the rule for a path a file can keep there. Pure and client-safe.
 */

import { z } from "zod";
import type { HqMediaMapItem, HqMediaType } from "@/lib/commcare/hq/appSource";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import type { AssetKind, IconRef } from "@/lib/domain";

/** The most code points a held path has, the width of HQ's own path columns. */
const MAX_WIRE_PATH_CODE_POINTS = 255;

/** Any control character: unsafe in a zip entry and in a media suite location. */
const CONTROL = /\p{Cc}/u;

/**
 * A character Python's `str.strip()` removes at either end, less the
 * controls, which `CONTROL` already refuses anywhere. `str.isspace()` holds
 * for exactly `\p{Zs}`, U+2028 (`\p{Zl}`), U+2029 (`\p{Zp}`) and ten
 * controls.
 */
const STRIPPED_AT_AN_END = /^[\p{Zs}\p{Zl}\p{Zp}]|[\p{Zs}\p{Zl}\p{Zp}]$/u;

/**
 * Whether a file can keep this path (HQ's path without `jr://file/`) on a
 * deployment: a directory and a name, no empty, `.` or `..` segment, no
 * backslash and no control character, at most 255 code points, no character
 * at either end that CommCare HQ's bulk upload strips from every zip entry
 * (`CommCareMultimedia.get_form_path`), and text a UTF-8 zip entry can name.
 */
export function isHoldableWirePath(path: string): boolean {
	if (!path.isWellFormed()) return false;
	if ([...path].length > MAX_WIRE_PATH_CODE_POINTS) return false;
	if (path.includes("\\") || CONTROL.test(path)) return false;
	if (STRIPPED_AT_AN_END.test(path)) return false;
	const segments = path.split("/");
	return (
		segments.length >= 2 &&
		segments.every(
			(segment) => segment !== "" && segment !== "." && segment !== "..",
		)
	);
}

/** Wire path (CommCare HQ's path without `jr://file/`) to CommCare HQ's id of the file there. */
export type HqMediaRecord = Readonly<Record<string, string>>;

/** Keys pass `isHoldableWirePath`; values are CommCare HQ document ids (`^[\w-]+$`). */
export const hqMediaRecordSchema: z.ZodType<HqMediaRecord> = z
	.record(
		z.string().refine(isHoldableWirePath, {
			message:
				"A media path Nova keeps is one CommCare HQ's upload can address.",
		}),
		z.string().regex(/^[\w-]+$/),
	)
	.readonly();

const JR_FILE = "jr://file/";

/**
 * Each kept path's id in the source a bring-in read its files from: the
 * `multimedia_map` entry at that path names the file the bring-in fetched
 * and kept there. A kept path is always one of the map's own, so a path the
 * map holds no readable entry for is a defect of the caller's, and throws.
 */
export function hqMediaRecordFromSource(
	wirePaths: readonly string[],
	map: readonly HqMediaMapItem[],
): HqMediaRecord {
	const byPath = new Map(map.map((item) => [item.path, item]));
	const record: Record<string, string> = {};
	for (const wirePath of wirePaths) {
		const id = byPath.get(`${JR_FILE}${wirePath}`)?.multimediaId ?? null;
		if (id === null) {
			throw new Error(
				"Nova kept a media path for an app it brought in, and CommCare HQ's media map names no file there. " +
					"A kept path is one the bring-in fetched a file by, so look at what built the media path rows the birth writes.",
			);
		}
		record[wirePath] = id;
	}
	return record;
}

/** One file this app publishes to a deployment. */
export interface PublishedMediaFile {
	/** The path the publish sends the file under: HQ's path without `jr://file/`. */
	readonly wirePath: string;
	/** An asset of the Project's library, or one of Nova's own icons. */
	readonly assetId: IconRef;
	/** The SHA-256 of the file's bytes, as `media_assets.content_hash` holds it. */
	readonly contentHash: string;
	readonly kind: AssetKind;
}

/**
 * The files a publish sends, from the assets its bulk upload carries
 * (`hqJsonExportArchive.ts::bulkUploadAssets`), each at the wire path the
 * resolved manifest gives it.
 */
export function publishedMediaFiles(
	assets: AssetManifest,
): readonly PublishedMediaFile[] {
	return [...assets.values()].map((asset) => ({
		wirePath: asset.wirePath,
		assetId: asset.assetId,
		contentHash: asset.contentHash,
		kind: asset.kind,
	}));
}

export type HqMediaStanding =
	/** CommCare HQ maps no file at the path, or maps an entry with no id. */
	| "absent"
	/** The id there is the one the record holds: this app's file. */
	| "recorded"
	/** The record holds another id for the path. A candidate. */
	| "moved"
	/** Nova holds no record for the path. A candidate. */
	| "unrecorded"
	/** Settled by content: the file there is not this app's. */
	| "replaced";

export interface HqMediaPath extends PublishedMediaFile {
	/** CommCare HQ's entry at the path now, where it names a file Nova can ask for. */
	readonly hq: {
		readonly mediaType: HqMediaType;
		readonly multimediaId: string;
	} | null;
	readonly standing: HqMediaStanding;
}

/** The map's entries by wire path. A key outside `jr://file/` is no path an app publishes to. */
function entriesByWirePath(
	map: readonly HqMediaMapItem[],
): ReadonlyMap<string, HqMediaMapItem> {
	const byPath = new Map<string, HqMediaMapItem>();
	for (const item of map) {
		if (item.path.startsWith(JR_FILE))
			byPath.set(item.path.slice(JR_FILE.length), item);
	}
	return byPath;
}

/**
 * How many paths of `record` hold another id in `now`: an entry that names
 * another file, or one Nova cannot read, which its own upload never writes.
 * A path whose entry is gone or names no file is none: a publish puts the
 * file back. Pure, and needs no document, so Refresh and the check when the
 * builder opens can count it from a source read alone.
 */
export function movedRecordedPaths(
	record: HqMediaRecord | null,
	now: readonly HqMediaMapItem[],
): number {
	if (record === null) return 0;
	const byPath = entriesByWirePath(now);
	let moved = 0;
	for (const [wirePath, id] of Object.entries(record)) {
		const item = byPath.get(wirePath);
		if (item === undefined) continue;
		if (
			item.unreadable ||
			(item.multimediaId !== null && item.multimediaId !== id)
		)
			moved += 1;
	}
	return moved;
}

/**
 * The published files whose entry the second of two maps holds differently
 * from the first: the reads a publish makes before and after it pushes the
 * Project's data. Each is judged as `hqMediaStandings` judges a path Nova
 * holds no record for: a file the second read names is `unrecorded`, to be
 * settled by its content, since Nova's own earlier upload can still be
 * mapping its file while the data goes; an entry Nova cannot read is
 * `replaced`; and a path whose file is gone, or whose entry names none, is
 * `absent`, which the upload puts back. A path that reads the same in both
 * is not listed: the person decided over it as the first read showed it.
 */
export function mediaMovedBetween(
	first: readonly HqMediaMapItem[],
	second: readonly HqMediaMapItem[],
	published: readonly PublishedMediaFile[],
): readonly HqMediaPath[] {
	const before = entriesByWirePath(first);
	const after = entriesByWirePath(second);
	const moved = published.filter((file) => {
		const earlier = before.get(file.wirePath);
		const later = after.get(file.wirePath);
		if (earlier === undefined || later === undefined) return earlier !== later;
		return (
			earlier.unreadable !== later.unreadable ||
			earlier.multimediaId !== later.multimediaId
		);
	});
	return hqMediaStandings({ published: moved, record: null, now: second });
}

/**
 * The standing of every published file against one source read. Pure: no
 * fetch. An entry Nova cannot read at a published path is `replaced` at
 * once, since Nova's own upload never writes one.
 */
export function hqMediaStandings(input: {
	readonly published: readonly PublishedMediaFile[];
	readonly record: HqMediaRecord | null;
	/** `HqAppSource.multimediaMap` of the read being judged. */
	readonly now: readonly HqMediaMapItem[];
}): readonly HqMediaPath[] {
	const byPath = entriesByWirePath(input.now);
	return input.published.map((file): HqMediaPath => {
		const item = byPath.get(file.wirePath);
		if (item === undefined) return { ...file, hq: null, standing: "absent" };
		if (item.unreadable) return { ...file, hq: null, standing: "replaced" };
		if (item.multimediaId === null || item.mediaType === null)
			return { ...file, hq: null, standing: "absent" };
		const hq = { mediaType: item.mediaType, multimediaId: item.multimediaId };
		const recorded = input.record?.[file.wirePath];
		return {
			...file,
			hq,
			standing:
				recorded === undefined
					? "unrecorded"
					: recorded === item.multimediaId
						? "recorded"
						: "moved",
		};
	});
}

/**
 * For each published path: the id CommCare HQ reported, else one learned by
 * content, else the previous record's. A path with none of the three has no
 * entry, and a path the app no longer publishes leaves the record.
 *
 * `settled` is the standings of the read this write follows, once settled.
 * A path whose entry there names a file CommCare HQ no longer serves keeps no
 * previous id: another id stands at the path, and no file of this app's is
 * behind it, so the old id would read as a moved file on every Refresh while
 * a review, which asks for the file, finds nothing changed.
 */
export function nextHqMediaRecord(input: {
	readonly published: readonly PublishedMediaFile[];
	readonly previous: HqMediaRecord | null;
	readonly learned: HqMediaRecord;
	readonly reported: HqMediaRecord;
	readonly settled?: readonly HqMediaPath[];
}): HqMediaRecord {
	const gone = new Set(
		(input.settled ?? [])
			.filter((path) => path.standing === "absent" && path.hq !== null)
			.map((path) => path.wirePath),
	);
	const record: Record<string, string> = {};
	for (const { wirePath } of input.published) {
		const id =
			input.reported[wirePath] ??
			input.learned[wirePath] ??
			(gone.has(wirePath) ? undefined : input.previous?.[wirePath]);
		if (id !== undefined) record[wirePath] = id;
	}
	return record;
}

/**
 * Whether a write of `next` would change what `previous` holds, reading no
 * record as an empty one: a review that settled its paths writes the record
 * only where it learned or forgot something.
 */
export function hqMediaRecordMoves(
	previous: HqMediaRecord | null,
	next: HqMediaRecord,
): boolean {
	const before = previous ?? {};
	const paths = Object.keys(next);
	return (
		paths.length !== Object.keys(before).length ||
		paths.some((path) => before[path] !== next[path])
	);
}
