/**
 * The capture's peer holds an app's pictures and sounds as CommCare HQ holds
 * them, so a capture over a replaced file reads what Nova's publish reads.
 *
 * Contract (`../targetPeer.ts`): Nova's bulk upload is processed as
 * `hqmedia/tasks.py::process_bulk_upload_zip` processes it, each file found
 * or made as a media document of its content and its path mapped to that
 * document (`Application.create_mapping`); the upload's status names, for
 * every path it matched, the document the map now names there
 * (`matched_files`), which Nova records; a person's replacement on HQ's
 * media page maps the path to the document of the new bytes and deletes
 * nothing (`ProcessImageFileUploadView`); and the file view serves a
 * document's bytes by its class and id (`ViewMultimediaFile`), which Nova
 * reads to settle a path by content. A map entry is held to one CommCare HQ
 * wrote after Nova's own upload (`proof/hq-reads/case-list-inline/app-source-after-media.json`).
 *
 * The plausible failures: an entry in another shape or with another
 * `unique_id` than HQ writes (a review would read a map HQ never serves); a
 * report naming another document than the map (Nova would record a file the
 * path does not hold); a replacement that changes the old document or keeps
 * the path on it (a review would find nothing replaced); and an upload of
 * Nova's bytes after a replacement that makes another document rather than
 * finding Nova's (the publish-over branch would read a map HQ never holds).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { jrFileRef } from "@/lib/commcare/multimedia/assetWirePath";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import { MEDIA_PROCESSING_ID, mediaMapItem, TargetPeer } from "../targetPeer";

const DOMAIN = "nova-proof";
const APP = "app";
const UPLOAD = `/a/${DOMAIN}/apps/api/${APP}/multimedia/`;

function peerWithApp(): TargetPeer {
	const peer = new TargetPeer({
		credentials: {
			username: "account",
			apiKey: "fixture-key",
			server: "production",
		},
		domain: DOMAIN,
		flags: new Set(),
		caseSearchEnabled: false,
		appId: APP,
		commcareVersion: "2.57.0",
		cloudcareGranted: false,
	});
	peer.restore({
		source: { doc_type: "Application", multimedia_map: {} },
		version: 2,
		media: [],
		mediaReport: undefined,
		tables: [],
		minted: 0,
	});
	return peer;
}

const manifest = mediaManifest();
function asset(id: typeof mediaIds.label) {
	const held = manifest.get(id);
	if (held?.bytes === undefined) throw new Error(`No bytes for ${id}.`);
	return held;
}

async function upload(
	peer: TargetPeer,
	ids: readonly (typeof mediaIds.label)[],
) {
	const form = new FormData();
	const zip = buildMediaBulkUploadZip(
		new Map(ids.map((id) => [id, asset(id)])),
	);
	form.set("bulk_upload_file", new Blob([new Uint8Array(zip)]), "media.zip");
	const request = new Request("http://peer.invalid", {
		method: "POST",
		body: form,
	});
	const answer = await peer.answer({
		method: "POST",
		path: UPLOAD,
		contentType: request.headers.get("content-type") ?? undefined,
		body: Buffer.from(await request.arrayBuffer()),
	});
	expect(answer.status).toBe(200);
	const status = await peer.answer({
		method: "GET",
		path: `${UPLOAD}status/${MEDIA_PROCESSING_ID}/`,
		contentType: undefined,
		body: Buffer.alloc(0),
	});
	return JSON.parse(String(status.body)) as {
		readonly matched_files: Record<
			string,
			readonly { readonly path: string; readonly m_id: string }[]
		>;
	};
}

function mapOf(peer: TargetPeer) {
	return (peer.snapshot().source?.multimedia_map ?? {}) as Record<
		string,
		{ readonly multimedia_id: string; readonly media_type: string }
	>;
}

async function file(peer: TargetPeer, mediaClass: string, id: string) {
	return peer.answer({
		method: "GET",
		path: `/hq/multimedia/file/${mediaClass}/${id}/`,
		contentType: undefined,
		body: Buffer.alloc(0),
	});
}

const labelPath = jrFileRef(asset(mediaIds.label).wirePath);

describe("the media an app holds on the capture's peer", () => {
	it("writes a map entry in the shape and with the unique id CommCare HQ wrote after Nova's upload", () => {
		const retained = JSON.parse(
			readFileSync(
				"proof/hq-reads/case-list-inline/app-source-after-media.json",
				"utf8",
			),
		) as { readonly body: string | Record<string, unknown> };
		const body =
			typeof retained.body === "string"
				? (JSON.parse(retained.body) as Record<string, unknown>)
				: retained.body;
		const map = body.multimedia_map as Record<
			string,
			{ readonly multimedia_id: string }
		>;
		const [[path, entry]] = Object.entries(map) as [
			[string, { readonly multimedia_id: string }],
		];
		const written = mediaMapItem(path, {
			id: entry.multimedia_id,
			mediaClass: "CommCareImage",
		});
		expect(written).toEqual(entry);
		expect(Object.keys(written)).toEqual(Object.keys(entry));
	});

	it("maps each uploaded file at its path to a document of its bytes, and reports the document the map names", async () => {
		const peer = peerWithApp();
		const report = await upload(peer, [mediaIds.label, mediaIds.audio]);
		const map = mapOf(peer);
		const matched = Object.values(report.matched_files).flat();
		expect(matched.map((entry) => entry.path).sort()).toEqual(
			Object.keys(map).sort(),
		);
		for (const entry of matched)
			expect(map[entry.path]?.multimedia_id).toBe(entry.m_id);
		expect(report.matched_files.CommCareImage).toHaveLength(1);
		expect(report.matched_files.CommCareAudio).toHaveLength(1);
		const image = map[labelPath];
		if (image === undefined) throw new Error("The picture is not mapped.");
		const served = await file(peer, "CommCareImage", image.multimedia_id);
		expect(served.status).toBe(200);
		expect(Buffer.from(served.body as Uint8Array)).toEqual(
			Buffer.from(asset(mediaIds.label).bytes as Buffer),
		);
		/* A file is served only under its own class. */
		expect(
			(await file(peer, "CommCareAudio", image.multimedia_id)).status,
		).toBe(404);
	});

	it("maps a replaced picture's path to the document of the new bytes, keeps the old one, and finds Nova's again on its next upload", async () => {
		const peer = peerWithApp();
		await upload(peer, [mediaIds.label]);
		const nova = mapOf(peer)[labelPath]?.multimedia_id;
		const theirs = asset(mediaIds.option);
		peer.replaceMedia({
			path: labelPath,
			mimeType: theirs.mimeType,
			base64: Buffer.from(theirs.bytes as Buffer).toString("base64"),
		});
		const replaced = mapOf(peer)[labelPath]?.multimedia_id;
		expect(replaced).toBeDefined();
		expect(replaced).not.toBe(nova);
		const served = await file(peer, "CommCareImage", replaced ?? "");
		expect(Buffer.from(served.body as Uint8Array)).toEqual(
			Buffer.from(theirs.bytes as Buffer),
		);
		expect((await file(peer, "CommCareImage", nova ?? "")).status).toBe(200);

		const report = await upload(peer, [mediaIds.label]);
		expect(mapOf(peer)[labelPath]?.multimedia_id).toBe(nova);
		expect(report.matched_files.CommCareImage?.[0]?.m_id).toBe(nova);
	});

	it("refuses a replacement HQ's image upload refuses", () => {
		const peer = peerWithApp();
		expect(() =>
			peer.replaceMedia({
				path: labelPath,
				mimeType: "audio/wav",
				base64: Buffer.from(asset(mediaIds.audio).bytes as Buffer).toString(
					"base64",
				),
			}),
		).toThrow(/image upload refuses/);
	});
});
