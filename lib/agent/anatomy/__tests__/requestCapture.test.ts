import { createHash } from "node:crypto";
import { streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	respondWithObject,
	withResponsesPeer,
} from "../../__tests__/responsesPeer";
import { createNovaOpenAI } from "../../openaiProvider";
import {
	type CapturedModelRequest,
	captureModelRequests,
} from "../requestCapture";

describe("model request capture", () => {
	it("records the provider's exact transmitted input without authentication headers", async () => {
		let received = "";
		let captured: CapturedModelRequest | undefined;
		await withResponsesPeer(
			(request, response) => {
				request.setEncoding("utf8");
				request.on("data", (chunk) => {
					received += chunk;
				});
				request.on("end", () => respondWithObject(response, "Ready"));
			},
			async (_provider, transport) => {
				const provider = createNovaOpenAI(
					"synthetic-capture-secret",
					captureModelRequests(transport, async (request) => {
						captured = request;
					}),
				);
				const result = streamText({
					model: provider("gpt-5.6-luna"),
					system: "Build a useful CommCare app.",
					prompt: "Keep the client's visit history.",
					tools: {
						inspect: tool({
							description: "Read the selected record.",
							inputSchema: z.object({ id: z.string() }),
							strict: false,
						}),
					},
					providerOptions: { openai: { store: false } },
					maxRetries: 0,
				});
				expect(await result.text).toBe("Ready");
			},
		);
		expect(captured).toEqual({
			body: received,
			sha256: createHash("sha256").update(received).digest("hex"),
		});
		expect(JSON.stringify(captured)).not.toContain("synthetic-capture-secret");
		expect(JSON.parse(received)).toMatchObject({
			model: "gpt-5.6-luna",
			store: false,
			tools: [
				{
					type: "function",
					name: "inspect",
					strict: false,
					parameters: { properties: { id: { type: "string" } } },
				},
			],
		});
	});

	it("does not send a paid request when its evidence cannot be saved", async () => {
		let sent = false;
		const fetch = captureModelRequests(
			async () => {
				sent = true;
				return new Response();
			},
			async () => {
				throw new Error("Storage unavailable");
			},
		);
		await expect(
			fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				body: "{}",
			}),
		).rejects.toThrow("Storage unavailable");
		expect(sent).toBe(false);
	});

	it("honors cancellation while the capture is being saved", async () => {
		const controller = new AbortController();
		let sent = false;
		const fetch = captureModelRequests(
			async () => {
				sent = true;
				return new Response();
			},
			async () => controller.abort(),
		);
		await expect(
			fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				body: "{}",
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(sent).toBe(false);
	});
});
