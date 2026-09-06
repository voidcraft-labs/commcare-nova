/** Native Responses request/stream boundary; no provider or SDK replacement. */
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import { OPENAI_COMPACTION_THRESHOLD } from "@/lib/models";
import { productionExecutorStep } from "../executorLoop";

const definitions = {
	searchBlueprint: {
		description: "Find fields",
		inputSchema: {
			type: "object" as const,
			properties: {},
			additionalProperties: false,
		},
	},
	finishWorkflow: {
		description: "Finish",
		inputSchema: {
			type: "object" as const,
			properties: {},
			additionalProperties: false,
		},
	},
};
const args = () => ({
	system: "static executor",
	messages: [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: "accepted slice brief" }],
		},
	],
	tools: definitions,
	allowedTools: ["searchBlueprint", "finishWorkflow"],
	signal: new AbortController().signal,
});
function event(response: ServerResponse, value: unknown) {
	response.write(`data: ${JSON.stringify(value)}\n\n`);
}

describe("production executor Responses boundary", () => {
	it("serializes the cache, privacy and tool policy and returns fully decoded text/reasoning/usage", async () => {
		let requestBody: unknown;
		await withResponsesPeer(
			(request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					requestBody = JSON.parse(body);
					respondWithObject(response, "Ready", {
						reasoning: "Check the accepted workflow.",
					});
				});
			},
			async (provider) => {
				const result = await productionExecutorStep(
					provider("gpt-5.6-luna"),
					"high",
					"nova:design-executor:session-1",
				)(args());
				expect(result.text).toBe("Ready");
				expect(result.reasoningText).toBe("Check the accepted workflow.");
				expect(result.toolCalls).toEqual([]);
				expect(result.usage).toMatchObject({
					inputTokens: 11,
					outputTokens: 7,
					inputTokenDetails: { cacheReadTokens: 3 },
				});
				expect(result.responseMessages).toEqual([
					expect.objectContaining({
						role: "assistant",
						content: expect.arrayContaining([
							expect.objectContaining({ type: "text", text: "Ready" }),
						]),
					}),
				]);
			},
		);
		expect(requestBody).toMatchObject({
			model: "gpt-5.6-luna",
			store: false,
			stream: true,
			context_management: [
				{ type: "compaction", compact_threshold: OPENAI_COMPACTION_THRESHOLD },
			],
			reasoning: { effort: "high", summary: "auto" },
			prompt_cache_key: "nova:design-executor:session-1",
			prompt_cache_options: { mode: "implicit", ttl: "30m" },
			parallel_tool_calls: true,
			tool_choice: {
				type: "allowed_tools",
				mode: "auto",
				tools: [
					{ type: "function", name: "searchBlueprint" },
					{ type: "function", name: "finishWorkflow" },
				],
			},
			tools: [
				expect.objectContaining({ name: "searchBlueprint", strict: false }),
				expect.objectContaining({ name: "finishWorkflow", strict: false }),
			],
			input: expect.arrayContaining([
				expect.objectContaining({
					role: "developer",
					content: "static executor",
				}),
				expect.objectContaining({
					role: "user",
					content: [{ type: "input_text", text: "accepted slice brief" }],
				}),
			]),
		});
	});
	it("assembles split function arguments and preserves provider call order without executing tools", async () => {
		await withResponsesPeer(
			(_request, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				event(response, {
					type: "response.created",
					response: { id: "resp_tools", created_at: 1, model: "gpt-5.6-luna" },
				});
				for (const [index, name] of [
					"searchBlueprint",
					"finishWorkflow",
				].entries()) {
					const item = {
						type: "function_call",
						id: `fc_${index}`,
						call_id: `call_${index}`,
						name,
						arguments: "{}",
						status: "completed",
					};
					event(response, {
						type: "response.output_item.added",
						output_index: index,
						item: { ...item, arguments: "" },
					});
					for (const delta of ["{", "}"])
						event(response, {
							type: "response.function_call_arguments.delta",
							item_id: item.id,
							output_index: index,
							delta,
						});
					event(response, {
						type: "response.output_item.done",
						output_index: index,
						item,
					});
				}
				event(response, {
					type: "response.completed",
					response: {
						incomplete_details: null,
						usage: { input_tokens: 9, output_tokens: 4 },
					},
				});
				response.end();
			},
			async (provider) => {
				const result = await productionExecutorStep(provider("gpt-5.6-luna"))(
					args(),
				);
				expect(result.toolCalls).toEqual([
					{ toolCallId: "call_0", toolName: "searchBlueprint", input: {} },
					{ toolCallId: "call_1", toolName: "finishWorkflow", input: {} },
				]);
				expect(
					result.responseMessages.flatMap((message) =>
						message.role === "assistant" && Array.isArray(message.content)
							? message.content.filter((part) => part.type === "tool-call")
							: [],
					),
				).toHaveLength(2);
			},
		);
	});
	it("preserves the HTTP refusal rather than replacing it with an empty-generation error", async () => {
		await withResponsesPeer(
			(_request, response) => {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						error: {
							message: "Invalid tool policy",
							type: "invalid_request_error",
							code: "invalid_tools",
						},
					}),
				);
			},
			async (provider) => {
				await expect(
					productionExecutorStep(provider("gpt-5.6-luna"))(args()),
				).rejects.toMatchObject({
					statusCode: 400,
					message: "Invalid tool policy",
				});
			},
		);
	});
	it("cancels a live stream and retains the caller's abort reason", async () => {
		const controller = new AbortController();
		const reason = new Error("Stop this workflow");
		const closed = Promise.withResolvers<void>();
		await withResponsesPeer(
			(_request, response) => {
				response.on("close", () => closed.resolve());
				response.writeHead(200, { "content-type": "text/event-stream" });
				event(response, {
					type: "response.created",
					response: { id: "resp_abort", created_at: 1, model: "gpt-5.6-luna" },
				});
				controller.abort(reason);
			},
			async (provider) => {
				await expect(
					productionExecutorStep(provider("gpt-5.6-luna"))({
						...args(),
						signal: controller.signal,
					}),
				).rejects.toBe(reason);
				await closed.promise;
			},
		);
	});
	it("does not contact the HTTP peer for an already cancelled call", async () => {
		let calls = 0;
		await withResponsesPeer(
			(_request, response) => {
				calls++;
				response.end();
			},
			async (provider) => {
				const controller = new AbortController();
				const reason = new Error("Already stopped");
				controller.abort(reason);
				await expect(
					productionExecutorStep(provider("gpt-5.6-luna"))({
						...args(),
						signal: controller.signal,
					}),
				).rejects.toBe(reason);
			},
		);
		expect(calls).toBe(0);
	});
});
