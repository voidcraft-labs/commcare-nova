import { expect, it } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	countAuthoringInput,
	countedInputReservation,
} from "../authoringInputCount";

it("counts the model input without dispatching a generation and refuses malformed counts", async () => {
	const received: Array<{ path: string | undefined; body: string }> = [];
	const responses: unknown[] = [
		{ object: "response.input_tokens", input_tokens: 200_000 },
		{ object: "response.input_tokens", input_tokens: -1 },
	];
	await withSocketHttpPeer(
		"api.openai.com",
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			request.on("end", () => {
				received.push({
					path: request.url,
					body: Buffer.concat(chunks).toString(),
				});
				response
					.writeHead(200, { "Content-Type": "application/json" })
					.end(JSON.stringify(responses.shift()));
			});
		},
		async () => {
			const input = {
				model: "gpt-5.6-sol",
				input: [{ role: "user", content: "Build an app" }],
				tools: [{ type: "tool_search" }],
				reasoning: { effort: "medium" },
				max_output_tokens: 16000,
				stream: true,
				store: false,
			};
			const args = {
				body: JSON.stringify(input),
				apiKey: "test-key",
				signal: new AbortController().signal,
			};
			const count = await countAuthoringInput(args);
			expect(count).toBe(200_000);
			expect(countedInputReservation(count, 16000)).toBe(3.845);
			await expect(countAuthoringInput(args)).rejects.toThrow();
			expect(received.map((item) => item.path)).toEqual([
				"/v1/responses/input_tokens",
				"/v1/responses/input_tokens",
			]);
			expect(JSON.parse(received[0].body)).toEqual({
				model: input.model,
				input: input.input,
				tools: input.tools,
				reasoning: input.reasoning,
			});
		},
	);
});
