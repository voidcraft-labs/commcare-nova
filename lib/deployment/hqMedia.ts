/**
 * Which CommCare HQ file Nova knows to stand at each path an app publishes
 * to one deployment, as `app_deployment_baselines.media_files` keeps it, and
 * the rule for a path a file can keep there. Pure and client-safe.
 */

import { z } from "zod";
import type { HqMediaMapItem } from "@/lib/commcare/hq/appSource";

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
