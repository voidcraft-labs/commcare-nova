/**
 * The ids a bulk media upload's status report names for the files HQ
 * matched, read by the client, which a publish records as the file standing
 * at each path it sent.
 *
 * The status answers are written whole in the shape
 * `app_import_api.py::_handle_multimedia_status` serves:
 * `hqmedia/cache.py::BulkMultimediaStatusCache.get_response` with
 * `success` set, each
 * matched entry as `hqmedia/models.py::CommCareImage.get_media_info` (and
 * `CommCareMultimedia.get_media_info` for audio) builds it, with `path` the
 * app's own spelling of the path that `tasks.py::process_bulk_upload_zip`
 * maps the document to.
 *
 * It would catch: an id read from the wrong key, so the record names a file
 * HQ never mapped there; a class of media left out of the record; and a
 * report Nova cannot read for ids turned into a failed upload, or into a
 * record of ids it does not hold.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MockAgent } from "undici";
import { expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { log } from "@/lib/logger";
import { uploadAppMediaBundle } from "../client";
import { buildMediaBulkUploadZip } from "../multimedia/bulkUploadZip";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const POST = "/a/clinic/apps/api/working-app/multimedia/";
const STATUS = `${POST}status/proc-1/`;
const png = readFileSync("public/nova-icons/household.png");
const hash = createHash("sha256").update(png).digest("hex");
const IMAGE_PATH = `jr://file/commcare/${hash}.png`;
const AUDIO_PATH = "jr://file/commcare/audio/greeting.mp3";

const zip = buildMediaBulkUploadZip(
	new Map([
		[
			testMediaAssetId("status-image"),
			{
				assetId: testMediaAssetId("status-image"),
				wirePath: `commcare/${hash}.png`,
				kind: "image",
				mimeType: "image/png",
				contentHash: hash,
				extension: ".png",
				bytes: png,
			},
		],
	]),
);

/** One matched entry as `get_media_info` builds it. */
function mediaInfo(path: string, id: string, image: boolean) {
	return {
		path,
		uid: "5f3c0c5d7e2b4a1f9c8d6e4b3a2f1e0d",
		m_id: id,
		url: `/hq/multimedia/file/${image ? "CommCareImage" : "CommCareAudio"}/${id}/`,
		updated: true,
		original_path: path.slice("jr://file/".length),
		icon_class: image ? "fa-regular fa-image" : "fa fa-volume-up",
		media_type: image ? "Image" : "Audio",
		humanized_content_length: "1.2 KB",
		...(image && { image_size: "64 x 64 px" }),
	};
}

/** A completed status in the whole shape the status view serves. */
function completedStatus(matchedFiles: unknown) {
	const classes =
		typeof matchedFiles === "object" && matchedFiles !== null
			? (matchedFiles as Record<string, unknown[]>)
			: {};
	const count = (name: string) => classes[name]?.length ?? 0;
	return {
		type: "zip",
		in_celery: true,
		is_ready: true,
		complete: true,
		progress: { percent: 100, current: 2, total: 2 },
		errors: [],
		processing_id: "proc-1",
		unmatched_files: [],
		unmatched_count: 0,
		...(matchedFiles !== undefined && { matched_files: matchedFiles }),
		matched_count: count("CommCareImage") + count("CommCareAudio"),
		total_files: 2,
		processed_files: 2,
		skipped_files: [],
		image_count: count("CommCareImage"),
		audio_count: count("CommCareAudio"),
		video_count: 0,
		success: true,
	};
}

function serve(peer: MockAgent, status: object) {
	peer
		.get(HOST)
		.intercept({ path: POST, method: "POST" })
		.reply(200, { success: true, processing_id: "proc-1" });
	peer.get(HOST).intercept({ path: STATUS, method: "GET" }).reply(200, status);
}

const upload = () => uploadAppMediaBundle(CREDS, "clinic", "working-app", zip);

it("holds each matched file's path and id, across every class of media", async () => {
	await withHttpPeer(async (peer) => {
		serve(
			peer,
			completedStatus({
				CommCareAudio: [mediaInfo(AUDIO_PATH, "audio-doc-2", false)],
				CommCareImage: [mediaInfo(IMAGE_PATH, "image-doc-1", true)],
				CommCareVideo: [],
			}),
		);
		expect(await upload()).toEqual({
			matched: 2,
			unmatched: 0,
			unmatchedFiles: [],
			matchedFiles: [
				{ path: AUDIO_PATH, multimediaId: "audio-doc-2" },
				{ path: IMAGE_PATH, multimediaId: "image-doc-1" },
			],
			errors: [],
			timedOut: false,
		});
	});
});

it("reads no ids from a status with no matched files, or an entry with no id, and keeps the counts", async () => {
	const warn = vi.spyOn(log, "warn");
	try {
		const { m_id: _, ...withoutId } = mediaInfo(IMAGE_PATH, "x", true);
		for (const matchedFiles of [
			undefined,
			{ CommCareImage: [withoutId], CommCareAudio: [], CommCareVideo: [] },
			{
				CommCareImage: [mediaInfo(IMAGE_PATH, "not an id", true)],
				CommCareAudio: [],
				CommCareVideo: [],
			},
			["not", "a", "map"],
		]) {
			warn.mockClear();
			await withHttpPeer(async (peer) => {
				serve(peer, {
					...completedStatus(matchedFiles),
					matched_count: 1,
					image_count: 1,
				});
				expect(await upload(), JSON.stringify(matchedFiles)).toEqual({
					matched: 1,
					unmatched: 0,
					unmatchedFiles: [],
					matchedFiles: null,
					errors: [],
					timedOut: false,
				});
			});
			expect(warn).toHaveBeenCalledWith(
				"[commcare] media bundle report names no matched ids",
				{ processingId: "proc-1" },
			);
		}
	} finally {
		warn.mockRestore();
	}
});
