import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { MockAgent } from "undici";
import { vi } from "vitest";
import {
	type RetainedPublishRead,
	replyRetained,
	retainedBodyJson,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import type { HqMediaType } from "@/lib/commcare/hq/mediaType";
import { getStoredObjectMetadata, streamAsset } from "@/lib/storage/media";

/** The GCS boundary serves only the selected Project files and their pinned generations. */
export function storeProjectImages(project: string, images: readonly Buffer[]) {
	const files = new Map(
		images.map((bytes) => [
			`projects/${project}/${createHash("sha256").update(bytes).digest("hex")}.png`,
			bytes,
		]),
	);
	vi.mocked(getStoredObjectMetadata).mockImplementation(async (key) => {
		const bytes = files.get(key);
		return bytes
			? {
					size: bytes.length,
					generation: "7",
					checksum: "fixture-crc32c",
					contentType: "image/png",
				}
			: null;
	});
	vi.mocked(streamAsset).mockImplementation((key, generation) => {
		const bytes = files.get(key);
		if (!bytes || generation !== "7")
			throw new Error("Unexpected Project or generation for image.");
		return Readable.from([bytes]);
	});
}

/** A successful bulk job is followed by independent reads of HQ's app map
 * and its authenticated file. Serve the exact destination and original bytes. */
export function servePublishedImage(
	peer: MockAgent,
	input: {
		source: string;
		read: RetainedPublishRead;
		wirePath: string;
		bytes?: Buffer;
		mediaType?: HqMediaType;
		id: string;
	},
) {
	const server = peer.get("https://india.commcarehq.org");
	const headers = { authorization: "ApiKey account:fixture-key" };
	const retained = retainedPublishRead(input.read);
	const source = retainedBodyJson(retained);
	source.multimedia_map = {
		[`jr://file/${input.wirePath}`]: {
			multimedia_id: input.id,
			media_type: input.mediaType ?? "CommCareImage",
			version: null,
			unique_id: createHash("md5")
				.update(input.wirePath + input.id)
				.digest("hex"),
			upstream_media_id: null,
			doc_type: "HQMediaMapItem",
		},
	};
	replyRetained(
		server.intercept({ method: "GET", path: input.source, headers }),
		{ ...retained, body: JSON.stringify(source) },
	);
	const path = `/hq/multimedia/file/${input.mediaType ?? "CommCareImage"}/${input.id}/`;
	if (!input.bytes) return path;
	server
		.intercept({ method: "GET", path, headers })
		.reply(200, input.bytes, { headers: { "content-type": "image/png" } });
	return path;
}
