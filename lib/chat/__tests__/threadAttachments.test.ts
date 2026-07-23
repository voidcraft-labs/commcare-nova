import { describe, expect, it } from "vitest";
import {
	collectThreadAttachmentAssetIds,
	remapThreadAttachmentAssetIds,
} from "../threadAttachments";

describe("thread attachment identity", () => {
	const messages = [
		{
			id: "user-1",
			role: "user",
			parts: [{ type: "text", text: "Read these" }],
			metadata: {
				attachments: [
					{
						assetId: "image-source",
						kind: "image",
						filename: "map.png",
						mimeType: "image/png",
					},
					{
						assetId: "document-source",
						kind: "pdf",
						filename: "brief.pdf",
						mimeType: "application/pdf",
						title: "Brief",
						summary: "The current requirements.",
					},
				],
			},
		},
	];

	it("walks only the canonical metadata attachment path", () => {
		expect(
			collectThreadAttachmentAssetIds([
				...messages,
				{ metadata: { attachments: [{ filename: "missing id" }] } },
				{ attachments: [{ assetId: "legacy-wrong-path" }] },
			]),
		).toEqual(["image-source", "document-source"]);
	});

	it("rewrites only assetId while preserving the transcript payload", () => {
		const remapped = remapThreadAttachmentAssetIds(
			messages,
			new Map([
				["image-source", "image-destination"],
				["document-source", "document-destination"],
			]),
		);

		expect(remapped).toEqual([
			{
				...messages[0],
				metadata: {
					attachments: [
						{
							...messages[0].metadata.attachments[0],
							assetId: "image-destination",
						},
						{
							...messages[0].metadata.attachments[1],
							assetId: "document-destination",
						},
					],
				},
			},
		]);
	});
});
