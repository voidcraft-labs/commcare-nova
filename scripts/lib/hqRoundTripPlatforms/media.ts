/**
 * The media backfill's classification (part 09 §7): every ready image, audio
 * and video row's format, from its stored MIME where that settles it and from
 * its stored bytes otherwise.
 *
 * A ready row's `mime_type` is the sniff its upload made, and the body check
 * that upload ran is the one `classifyStoredMediaBytes` would run, so a MIME
 * with exactly one variant gives that variant without a byte read
 * (`FORMAT_OF_STORED_MIME`, built from the registry, so a MIME that later
 * gains a second variant leaves the map without an edit). `audio/wav` is left
 * out: its check is new, and a stored WAV may be 24-bit or float. Every other
 * row's object is read once per key, four at a time, through an injected
 * reader the classification never calls when no row needs bytes.
 *
 * The size decision is made from the reader's `size` before any download,
 * never from a thrown error's message: a missing object is `missing`, one past
 * its kind's cap `too-large`, and any error from either call stops the run
 * with nothing written.
 */

import {
	ASSET_SIZE_CAPS_BYTES,
	type AssetKind,
	type AssetMimeType,
	MEDIA_FORMATS,
	type MediaFormatKey,
	UNPLAYABLE_MEDIA_FORMAT,
} from "@/lib/domain/multimedia";
import { classifyStoredMediaBytes } from "@/lib/media/validate";
import { downloadAssetBytes, getStoredObjectSize } from "@/lib/storage/media";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { compareText, type MediaPlan } from "./types";

/** One ready image, audio or video row, as the fleet read selects it. */
export interface MediaRow {
	readonly id: string;
	readonly project_id: string;
	readonly status: string;
	readonly kind: string;
	readonly mime_type: string;
	readonly extension: string;
	readonly content_hash: string;
	readonly gcs_object_key: string;
}

/** The kinds the backfill classifies; documents stay without a format. */
export const CLASSIFIED_KINDS = ["image", "audio", "video"] as const;

/** Objects read at once: at most 200 MB of video in memory. */
export const MEDIA_READ_CONCURRENCY = 4;

/**
 * Each stored MIME that has exactly one variant in `MEDIA_FORMATS`, less
 * `audio/wav`, to that variant.
 */
export const FORMAT_OF_STORED_MIME: ReadonlyMap<string, MediaFormatKey> =
	(() => {
		const byMime = new Map<string, MediaFormatKey[]>();
		for (const format of MEDIA_FORMATS) {
			byMime.set(format.mime, [...(byMime.get(format.mime) ?? []), format.key]);
		}
		return new Map(
			[...byMime]
				.filter(([mime, keys]) => keys.length === 1 && mime !== "audio/wav")
				.map(([mime, keys]) => [mime, keys[0] as MediaFormatKey]),
		);
	})();

/** Whether the row's format comes only from its stored bytes. */
export function needsBytes(row: Pick<MediaRow, "mime_type">): boolean {
	return !FORMAT_OF_STORED_MIME.has(row.mime_type);
}

/** The digest of what a row's format is decided from, which the writer holds still. */
export function mediaRowDigest(row: MediaRow): string {
	return canonicalJsonDigest({
		status: row.status,
		kind: row.kind,
		mime_type: row.mime_type,
		extension: row.extension,
		content_hash: row.content_hash,
		gcs_object_key: row.gcs_object_key,
	});
}

/** The storage boundary the classification reads through. */
export interface MediaObjectReader {
	/** The object's byte size, or null where it does not exist. */
	size(key: string): Promise<number | null>;
	/** The object's bytes, refused past `cap` as they stream. */
	bytes(key: string, cap: number): Promise<Buffer>;
}

/** The production arm: the media bucket through `lib/storage/media.ts`. */
export const storageMediaReader: MediaObjectReader = {
	size: (key) => getStoredObjectSize(key),
	bytes: (key, cap) => downloadAssetBytes(key, cap),
};

/** A read of a stored object failed: the run stopped with nothing written. */
export class MediaReadError extends Error {
	readonly name = "MediaReadError";

	constructor(
		readonly assetId: string,
		readonly failureClass: string,
		options?: ErrorOptions,
	) {
		super(
			`Reading the stored file of media asset ${assetId} failed with an error of class ${failureClass}, so this run stopped before writing anything. Run --prove-media-read to check the Job can read the media bucket, then run again.`,
			options,
		);
	}
}

/** What the classification did, for the report's `media` line. */
export interface MediaClassificationStats {
	readonly objectsRead: number;
	readonly bytesRead: number;
	readonly milliseconds: number;
}

function classOf(error: unknown): string {
	return error instanceof Error ? error.constructor.name : typeof error;
}

/** The kind's cap, by the row's stored kind. */
function capOf(kind: string): number {
	return ASSET_SIZE_CAPS_BYTES[kind as AssetKind];
}

/**
 * Every row's plan, in asset-id order: its MIME's one variant where it has
 * one, otherwise what its object's size and bytes give. One read per object
 * key, however many rows share it.
 */
export async function classifyFleetMedia(
	rows: readonly MediaRow[],
	reader: MediaObjectReader,
): Promise<{
	readonly plans: readonly MediaPlan[];
	readonly stats: MediaClassificationStats;
}> {
	const started = performance.now();
	const sorted = [...rows].sort((a, b) => compareText(a.id, b.id));
	const byKey = new Map<string, MediaRow[]>();
	for (const row of sorted) {
		if (!needsBytes(row)) continue;
		byKey.set(row.gcs_object_key, [
			...(byKey.get(row.gcs_object_key) ?? []),
			row,
		]);
	}
	const verdicts = new Map<string, Pick<MediaPlan, "format" | "cause">>();
	let objectsRead = 0;
	let bytesRead = 0;
	const keys = [...byKey.keys()].sort(compareText);
	let next = 0;
	/* The first read that failed: every worker stops taking keys once one has,
	 * and the run throws it only after each worker has finished, so no read
	 * outlives the run. */
	let failed: MediaReadError | undefined;
	const worker = async (): Promise<void> => {
		while (next < keys.length && failed === undefined) {
			const key = keys[next] as string;
			next += 1;
			const keyRows = byKey.get(key) ?? [];
			const first = keyRows[0] as MediaRow;
			let size: number | null;
			try {
				size = await reader.size(key);
			} catch (error) {
				throw new MediaReadError(first.id, classOf(error), { cause: error });
			}
			for (const row of keyRows) {
				const cap = capOf(row.kind);
				if (size === null) {
					verdicts.set(row.id, {
						format: UNPLAYABLE_MEDIA_FORMAT,
						cause: "missing",
					});
					continue;
				}
				if (size > cap) {
					verdicts.set(row.id, {
						format: UNPLAYABLE_MEDIA_FORMAT,
						cause: "too-large",
					});
				}
			}
			const toRead = keyRows.filter((row) => !verdicts.has(row.id));
			if (toRead.length === 0) continue;
			const cap = Math.max(...toRead.map((row) => capOf(row.kind)));
			let bytes: Buffer;
			try {
				bytes = await reader.bytes(key, cap);
			} catch (error) {
				throw new MediaReadError(first.id, classOf(error), { cause: error });
			}
			objectsRead += 1;
			bytesRead += bytes.length;
			for (const row of toRead) {
				const format = await classifyStoredMediaBytes(bytes, {
					mimeType: row.mime_type as AssetMimeType,
					extension: row.extension,
				});
				verdicts.set(row.id, {
					format,
					cause:
						format === UNPLAYABLE_MEDIA_FORMAT ? "no-variant" : "classified",
				});
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(MEDIA_READ_CONCURRENCY, keys.length) },
			async () => {
				try {
					await worker();
				} catch (error) {
					failed ??=
						error instanceof MediaReadError
							? error
							: new MediaReadError("unknown", classOf(error), { cause: error });
				}
			},
		),
	);
	if (failed !== undefined) throw failed;
	const plans = sorted.map((row): MediaPlan => {
		const byMime = FORMAT_OF_STORED_MIME.get(row.mime_type);
		const verdict =
			byMime !== undefined
				? { format: byMime, cause: "mime" as const }
				: verdicts.get(row.id);
		if (verdict === undefined) {
			throw new Error(
				`Media asset ${row.id} was left without a format by the classification, which reads every row that needs its bytes. This is a defect of the cutover; nothing was written.`,
			);
		}
		return {
			assetId: row.id,
			projectId: row.project_id,
			rowDigest: mediaRowDigest(row),
			mimeType: row.mime_type,
			...verdict,
		};
	});
	return {
		plans,
		stats: {
			objectsRead,
			bytesRead,
			milliseconds: Math.round(performance.now() - started),
		},
	};
}

/** What `--prove-media-read` prints. */
export type MediaReadProof = "ok" | "no-media" | "failed";

/** How `--prove-media-read` waits between refusals, injectable for tests. */
export interface ProveMediaReadTiming {
	readonly retryMilliseconds: number;
	readonly limitMilliseconds: number;
	readonly sleep: (milliseconds: number) => Promise<void>;
}

/** Retry a refusal every 15 seconds for up to ten minutes. */
export const PROVE_MEDIA_READ_TIMING: ProveMediaReadTiming = {
	retryMilliseconds: 15_000,
	limitMilliseconds: 600_000,
	sleep: (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Read the metadata of one stored object of a ready row that needs its bytes
 * read, the lowest such asset id: `ok` once a read is answered (a missing
 * object answers too, which proves the grant), `no-media` where no ready row
 * needs its bytes read, `failed` where every read in the time allowed was
 * refused. A grant takes a while to reach the bucket, hence the retries.
 */
export async function proveMediaRead(
	rows: readonly MediaRow[],
	reader: Pick<MediaObjectReader, "size">,
	timing: ProveMediaReadTiming = PROVE_MEDIA_READ_TIMING,
): Promise<MediaReadProof> {
	const [first] = rows
		.filter((row) => needsBytes(row))
		.sort((a, b) => compareText(a.id, b.id));
	if (first === undefined) return "no-media";
	for (let waited = 0; ; waited += timing.retryMilliseconds) {
		try {
			await reader.size(first.gcs_object_key);
			return "ok";
		} catch {
			if (waited + timing.retryMilliseconds > timing.limitMilliseconds)
				return "failed";
			await timing.sleep(timing.retryMilliseconds);
		}
	}
}
