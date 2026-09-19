import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { type SourceMaterial, sourceAttachmentsMessage } from "../sources";
import { respondWithObject, withResponsesPeer } from "./responsesPeer";

const PNG_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const material: SourceMaterial = {
	digest: "digest",
	requests: [],
	documents: [],
	images: [
		{
			id: "asset-1",
			name: "intake-form.png",
			mediaType: "image/png",
			dataUrl: PNG_DATA_URL,
			bytesDigest: "bytes",
		},
	],
};

describe("an attached image", () => {
	it("reaches OpenAI as an image the model sees, not as a file to read", async () => {
		const message = sourceAttachmentsMessage(material);
		if (!message) throw new Error("Expected an attachments message");
		let received = "";
		// The shared setup fails this test on any provider warning, which is how
		// a part shape the SDK has deprecated would show.
		await withResponsesPeer(
			(request, response) => {
				request.setEncoding("utf8");
				request.on("data", (chunk) => {
					received += chunk;
				});
				request.on("end", () => respondWithObject(response, "Ready"));
			},
			async (provider) => {
				const result = streamText({
					model: provider("gpt-5.6-sol"),
					messages: [message],
					providerOptions: { openai: { store: false } },
					maxRetries: 0,
				});
				await result.text;
			},
		);

		const sent = JSON.parse(received) as {
			input: {
				role: string;
				content: { type: string; image_url?: string }[];
			}[];
		};
		const parts = sent.input.flatMap((item) => item.content);
		expect(parts.filter((part) => part.type !== "input_text")).toEqual([
			{ type: "input_image", image_url: PNG_DATA_URL },
		]);
	});
});
