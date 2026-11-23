/**
 * CommCare HQ's media map as Nova reads it, kept apart from the source reader
 * so a pure module (the reading's acceptance) can read one without the
 * reader's logger. Client-safe: it reads JSON alone.
 */

import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import type { HqAppSourceParseNote } from "./appSource";

/** The four document kinds `hqmedia/models.py::CommCareMultimedia.get_doc_class` names. */
export const HQ_MEDIA_TYPES = [
	"CommCareImage",
	"CommCareAudio",
	"CommCareVideo",
	"CommCareMultimedia",
] as const;
export type HqMediaType = (typeof HQ_MEDIA_TYPES)[number];

/** One entry of `multimedia_map`. */
export interface HqMediaMapItem {
	/** The map's key: the path the app's content names, `jr://file/...`. */
	readonly path: string;
	/** HQ's id of the file, or null where the entry names none Nova can ask for. */
	readonly multimediaId: string | null;
	readonly mediaType: HqMediaType | null;
	/** True where the entry names a file by an id or a type Nova cannot read. Both are then null. */
	readonly unreadable: boolean;
}

const MEDIA_TYPES: ReadonlySet<string> = new Set(HQ_MEDIA_TYPES);

/** The most positions of unreadable media map entries one note names. */
export const UNREADABLE_MEDIA_ENTRY_POSITIONS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An unreadable entry has no typed id. Preserve changes to the actual file
 * or its type without treating an unrelated save or a new entry UUID as a new file. */
export function unreadableMediaIdentity(source: unknown, path: string): string {
	const map = isRecord(source) ? source.multimedia_map : null;
	const entry = isRecord(map) ? map[path] : null;
	return canonicalJsonText(
		isRecord(entry)
			? [entry.multimedia_id ?? null, entry.media_type ?? null]
			: (entry ?? null),
	);
}

/**
 * `multimedia_map`, `hqmedia/models.py::ApplicationMediaMixin.multimedia_map`:
 * path to `HQMediaMapItem`. An entry with no id names no file
 * (`HQMediaMapItem.url` is empty for it); an entry whose id or type Nova
 * cannot ask for is kept as unreadable, so one entry never refuses the read.
 */
export function readMultimediaMap(
	value: unknown,
	onNote?: (note: HqAppSourceParseNote) => void,
): readonly HqMediaMapItem[] | null {
	if (value === undefined) return null;
	if (!isRecord(value)) {
		onNote?.({ kind: "media-map-malformed" });
		return null;
	}
	const items: HqMediaMapItem[] = [];
	/* One note for the map, after the loop: the map is an app author's, and
	 * its length is bounded only by the source's. */
	let unreadable = 0;
	const firstIndexes: number[] = [];
	for (const [index, [path, entry]] of Object.entries(value).entries()) {
		if (isRecord(entry)) {
			const id = entry.multimedia_id;
			if (id === undefined || id === null || id === "") {
				items.push({
					path,
					multimediaId: null,
					mediaType: null,
					unreadable: false,
				});
				continue;
			}
			const type = entry.media_type;
			if (
				typeof id === "string" &&
				/^[\w-]+$/.test(id) &&
				typeof type === "string" &&
				MEDIA_TYPES.has(type)
			) {
				items.push({
					path,
					multimediaId: id,
					mediaType: type as HqMediaType,
					unreadable: false,
				});
				continue;
			}
		}
		unreadable += 1;
		if (firstIndexes.length < UNREADABLE_MEDIA_ENTRY_POSITIONS)
			firstIndexes.push(index);
		items.push({ path, multimediaId: null, mediaType: null, unreadable: true });
	}
	if (unreadable > 0)
		onNote?.({
			kind: "media-entries-unreadable",
			count: unreadable,
			firstIndexes,
		});
	return items;
}
