import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	collectThreadAttachmentAssetIds,
	remapThreadAttachmentAssetIds,
} from "../threadAttachments";

describe("thread attachment identity", () => {
	const imageSource = testMediaAssetId("image-source");
	const documentSource = testMediaAssetId("document-source");
	const imageDestination = testMediaAssetId("image-destination");
	const documentDestination = testMediaAssetId("document-destination");
	const messages = [
		{
			id: "user-1",
			role: "user",
			parts: [{ type: "text", text: "Read these" }],
			metadata: {
				attachments: [
					{
						assetId: imageSource,
						kind: "image",
						filename: "map.png",
						mimeType: "image/png",
					},
					{
						assetId: documentSource,
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

	it("walks only the strict canonical metadata attachment path", () => {
		expect(
			collectThreadAttachmentAssetIds([
				...messages,
				{ attachments: [{ assetId: "legacy-wrong-path" }] },
			]),
		).toEqual([imageSource, documentSource]);
		expect(() =>
			collectThreadAttachmentAssetIds([
				...messages,
				{ metadata: { attachments: [{ filename: "missing id" }] } },
			]),
		).toThrow();
		expect(() =>
			collectThreadAttachmentAssetIds([
				{
					metadata: {
						attachments: [
							{
								assetId: imageSource,
								kind: "audio",
								filename: "recording.mp3",
								mimeType: "audio/mpeg",
							},
						],
					},
				},
			]),
		).toThrow();
	});

	it("fails closed on malformed transcript carrier containers", () => {
		expect(() => collectThreadAttachmentAssetIds({ messages: [] })).toThrow(
			"messages are not an array",
		);
		expect(() => collectThreadAttachmentAssetIds([null])).toThrow(
			"message 0 is not an object",
		);
		expect(() => collectThreadAttachmentAssetIds([{ metadata: null }])).toThrow(
			"message 0 metadata is not an object",
		);
		expect(() =>
			collectThreadAttachmentAssetIds([
				{ metadata: { attachments: { assetId: imageSource } } },
			]),
		).toThrow("message 0 attachments are not an array");
	});

	it("rewrites only assetId while preserving the transcript payload", () => {
		const remapped = remapThreadAttachmentAssetIds(
			messages,
			new Map([
				[imageSource, imageDestination],
				[documentSource, documentDestination],
			]),
		);

		expect(remapped).toEqual([
			{
				...messages[0],
				metadata: {
					attachments: [
						{
							...messages[0].metadata.attachments[0],
							assetId: imageDestination,
						},
						{
							...messages[0].metadata.attachments[1],
							assetId: documentDestination,
						},
					],
				},
			},
		]);
	});
});
