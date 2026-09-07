import { createHash } from "node:crypto";
import {
	attachmentRefSchema,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { asMediaAssetId, EXTRACTOR_VERSION } from "@/lib/domain/multimedia";

export const SOURCE_SESSION = "00000000-0000-4000-8000-000000000800";
export const SOURCE_THREAD = "00000000-0000-4000-8000-000000000801";
export const SOURCE_DOCUMENT = asMediaAssetId(
	"00000000-0000-4000-8000-000000000810",
);
export const SOURCE_IMAGE = asMediaAssetId(
	"00000000-0000-4000-8000-000000000811",
);
export const SOURCE_PROJECT = "source-project";
export const SOURCE_TEXT = "Register patients and record visits.";
export const SOURCE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNQDmz5DwADiwH4gz7gMgAAAABJRU5ErkJggg==",
	"base64",
);
export const OTHER_SOURCE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPY62ryHwAFLwI2bRgkkQAAAABJRU5ErkJggg==",
	"base64",
);
export const sourceDigest = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

export function sourceAsset(
	id: string,
	kind: "image" | "text" = id === SOURCE_IMAGE ? "image" : "text",
): MediaAssetRecord {
	const bytes = kind === "image" ? SOURCE_PNG : Buffer.from(SOURCE_TEXT);
	const contentHash = sourceDigest(bytes);
	const extension = kind === "image" ? ".png" : ".txt";
	return {
		id: asMediaAssetId(id),
		project_id: SOURCE_PROJECT,
		owner: "source-user",
		contentHash,
		kind,
		mimeType: kind === "image" ? "image/png" : "text/plain",
		extension,
		sizeBytes: bytes.length,
		status: "ready",
		gcsObjectKey: `projects/${SOURCE_PROJECT}/${contentHash}${extension}`,
		originalFilename: kind === "image" ? "mockup.png" : "requirements.txt",
		created_at: new Date("2026-01-01T00:00:00Z"),
		...(kind === "image"
			? { dimensions: { width: 1, height: 1 } }
			: {
					extract: {
						status: "ready",
						version: EXTRACTOR_VERSION,
						model: "offline-fixture",
						truncated: false,
						charCount: SOURCE_TEXT.length,
						extractedAt: 1,
						title: "Program requirements",
						summary: "Patient visits.",
					},
				}),
	};
}

export function sourceRef(
	id: string,
	kind: "image" | "text" = id === SOURCE_IMAGE ? "image" : "text",
) {
	const asset = sourceAsset(id, kind);
	return attachmentRefSchema.parse({
		assetId: asset.id,
		filename: asset.originalFilename,
		mimeType: asset.mimeType,
		kind,
	});
}

export function sourceMessage(
	id: string,
	text: string,
	attachments: ReturnType<typeof sourceRef>[] = [],
): NovaUIMessage {
	return {
		id,
		role: "user",
		parts: [{ type: "text", text }],
		metadata: { attachments },
	};
}
