import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { log } from "@/lib/logger";
import { MODEL_ROLES, reasoningProviderOptions } from "@/lib/models";
import { classifyError } from "../errorClassifier";
import { runStructuredWith } from "../modelRunContext";
import { generateObjectWith, streamObjectWith } from "../subGeneration";
import { respondWithObject, withResponsesPeer } from "./responsesPeer";

// The SDK and provider run unchanged. Socket ownership, final results and
// rejection are the evidence; SDK-internal inert promise allocations are not
// replaced with mocks merely to silence async-hooks diagnostics.
const MODEL = MODEL_ROLES.designReviewer.modelId;
const schema = z.object({
	answer: z.literal("yes"),
	note: z.string().optional(),
});
const args = {
	schema,
	modelId: MODEL,
	system: "System instruction",
	prompt: "Question",
	maxOutputTokens: 500,
	providerOptions: reasoningProviderOptions("high"),
	signal: new AbortController().signal,
};
beforeEach(() => vi.clearAllMocks());

it("validates streamed JSON and strict wire options, restores omission, and meters decoded usage", async () => {
	const received = Promise.withResolvers<unknown>();
	await withResponsesPeer(
		(request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				received.resolve(JSON.parse(body));
				respondWithObject(response, '{"answer":"yes","note":null}', {
					reasoning: "Check the answer.",
				});
			});
		},
		async (provider) => {
			const tracked: unknown[] = [];
			const progress: number[] = [];
			const result = await runStructuredWith(
				provider(MODEL),
				{ ...args, onProgress: (size) => progress.push(size) },
				(usage) => tracked.push(usage),
			);
			expect(result.object).toEqual({ answer: "yes" });
			expect(result.reasoningText).toBe("Check the answer.");
			expect(progress.reduce((sum, size) => sum + size, 0)).toBe(
				'Check the answer.{"answer":"yes","note":null}'.length,
			);
			expect(result.usage).toMatchObject({
				inputTokens: 11,
				outputTokens: 7,
				inputTokenDetails: { cacheReadTokens: 3 },
			});
			expect(tracked).toEqual([result.usage]);
			expect(await received.promise).toMatchObject({
				model: MODEL,
				store: false,
				stream: true,
				max_output_tokens: 500,
				reasoning: { effort: "high", summary: "auto" },
				text: {
					format: {
						strict: true,
						type: "json_schema",
						schema: {
							required: ["answer", "note"],
							additionalProperties: false,
						},
					},
				},
			});
		},
	);
});

it.each([
	["malformed JSON", "private_document_prose", false],
	["schema mismatch", '{"answer":"private_document_prose"}', false],
	["truncated JSON", '{"answer":', true],
] as const)(
	"returns no partial object for %s and still meters usage",
	async (_name, text, incomplete) => {
		await withResponsesPeer(
			(_request, response) => respondWithObject(response, text, { incomplete }),
			async (provider) => {
				const tracked: unknown[] = [];
				const result = await runStructuredWith(provider(MODEL), args, (usage) =>
					tracked.push(usage),
				);
				expect(result.object).toBeNull();
				expect(result.finishReason).toBe(incomplete ? "length" : "stop");
				expect(result.usage?.inputTokens).toBe(11);
				expect(tracked).toEqual([result.usage]);
			},
		);
		expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(
			"private_document_prose",
		);
		for (const call of vi.mocked(log.error).mock.calls) {
			const error = call[1];
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).cause).toBeUndefined();
			expect((error as Error).message).not.toContain("private_document_prose");
		}
		expect(incomplete ? log.warn : log.error).toHaveBeenCalledOnce();
	},
);

it("finishes generation even when the progress display throws", async () => {
	await withResponsesPeer(
		(_request, response) => respondWithObject(response, '{"answer":"yes"}'),
		async (provider) => {
			const result = await streamObjectWith({
				model: provider(MODEL),
				system: "s",
				schema,
				prompt: "p",
				onProgress() {
					throw new Error("Disconnected display");
				},
			});
			expect(result.object).toEqual({ answer: "yes" });
		},
	);
});

it.each(["headers", "body"] as const)(
	"cancellation during %s rejects and closes the socket",
	async (phase) => {
		const received = Promise.withResolvers<void>();
		const disconnected = Promise.withResolvers<void>();
		const controller = new AbortController();
		await withResponsesPeer(
			(request, response) => {
				request.resume();
				response.once("close", () => disconnected.resolve());
				if (phase === "body") writePartial(response);
				else received.resolve();
			},
			async (provider) => {
				const outcome = runStructuredWith(
					provider(MODEL),
					{
						...args,
						signal: controller.signal,
						onProgress: () => received.resolve(),
					},
					() => {
						throw new Error("Aborted request has no usage receipt");
					},
				).then(
					() => ({ ok: true as const }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				try {
					await Promise.race([
						received.promise,
						outcome.then(() => {
							throw new Error("Call ended before cancellation barrier");
						}),
					]);
					controller.abort();
					const result = await outcome;
					expect(result).toMatchObject({
						ok: false,
						error: { name: "AbortError" },
					});
					await disconnected.promise;
				} finally {
					controller.abort();
					await outcome;
				}
			},
		);
	},
);

it("preserves the actual HTTP refusal instead of replacing it with a missing-output error", async () => {
	await withResponsesPeer(
		(_request, response) => {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					error: {
						message: "Request refused",
						type: "invalid_request_error",
						code: "bad_request",
					},
				}),
			);
		},
		async (provider) => {
			await expect(
				runStructuredWith(provider(MODEL), args, () => {
					throw new Error("Refusal cannot accrue tokens");
				}),
			).rejects.toMatchObject({ message: "Request refused", statusCode: 400 });
		},
	);
});

it("rejects a disconnected partial stream and closes the socket before returning", async () => {
	const responseReady = Promise.withResolvers<ServerResponse>();
	const progressed = Promise.withResolvers<void>();
	const disconnected = Promise.withResolvers<void>();
	const controller = new AbortController();
	await withResponsesPeer(
		(request, response) => {
			request.resume();
			response.once("close", () => disconnected.resolve());
			writePartial(response);
			responseReady.resolve(response);
		},
		async (provider) => {
			const outcome = runStructuredWith(
				provider(MODEL),
				{
					...args,
					signal: controller.signal,
					onProgress: () => progressed.resolve(),
				},
				() => {},
			).then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			try {
				const response = await responseReady.promise;
				await Promise.race([
					progressed.promise,
					outcome.then(() => {
						throw new Error("Call ended before body interruption");
					}),
				]);
				response.destroy();
				const result = await outcome;
				expect(result).toMatchObject({
					ok: false,
					error: {
						name: "AI_APICallError",
						cause: { cause: { code: "UND_ERR_SOCKET" } },
					},
				});
				await disconnected.promise;
			} finally {
				controller.abort();
				await outcome;
			}
		},
	);
});

it("rejects an already-aborted call before reaching HTTP", async () => {
	const controller = new AbortController();
	controller.abort();
	await withResponsesPeer(
		() => {
			throw new Error("Already-aborted call reached HTTP");
		},
		async (provider) => {
			await expect(
				runStructuredWith(
					provider(MODEL),
					{ ...args, signal: controller.signal },
					() => {
						throw new Error("No call can have usage");
					},
				),
			).rejects.toMatchObject({ name: "AbortError" });
		},
	);
});

it.each(["streaming", "blocking"] as const)(
	"serializes images and native PDF input through the real %s adapter",
	async (mode) => {
		for (const nativePdf of [false, true]) {
			const received = Promise.withResolvers<{ input: unknown[] }>();
			await withResponsesPeer(
				(request, response) => {
					let body = "";
					request.setEncoding("utf8");
					request.on("data", (chunk) => {
						body += chunk;
					});
					request.on("end", () => {
						received.resolve(JSON.parse(body));
						if (mode === "streaming")
							respondWithObject(response, '{"answer":"yes"}');
						else {
							response.writeHead(200, { "content-type": "application/json" });
							response.end(
								JSON.stringify({
									id: "resp_local",
									created_at: 1,
									model: MODEL,
									output: [
										{
											type: "message",
											role: "assistant",
											id: "msg_local",
											content: [
												{
													type: "output_text",
													text: '{"answer":"yes"}',
													annotations: [],
												},
											],
										},
									],
									usage: { input_tokens: 11, output_tokens: 7 },
								}),
							);
						}
					});
				},
				async (provider) => {
					const generate =
						mode === "streaming" ? streamObjectWith : generateObjectWith;
					const result = await generate({
						model: provider(MODEL),
						system: "Extract",
						schema,
						prompt: "Document body",
						...(nativePdf && {
							file: {
								mediaType: "application/pdf",
								data: "data:application/pdf;base64,JVBERi0=",
							},
							instruction: "Read PDF",
						}),
						images: [
							{
								mediaType: "image/png",
								data: "data:image/png;base64,iVBORw==",
								label: "Figure 1",
							},
						],
					});
					expect(result.object).toEqual({ answer: "yes" });
					const wire = await received.promise;
					expect(wire.input).toContainEqual({
						role: "user",
						content: nativePdf
							? [
									{ type: "input_text", text: "Read PDF" },
									{
										type: "input_file",
										filename: "part-1.pdf",
										file_data: "data:application/pdf;base64,JVBERi0=",
									},
								]
							: [
									{ type: "input_text", text: "Document body" },
									{ type: "input_text", text: "Figure 1" },
									{
										type: "input_image",
										image_url: "data:image/png;base64,iVBORw==",
									},
								],
					});
				},
			);
		}
	},
);

function writePartial(response: ServerResponse) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(
		'data: {"type":"response.created","response":{"id":"resp_partial","created_at":1,"model":"gpt-5"}}\n\n',
	);
	response.write(
		'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_partial"}}\n\n',
	);
	response.write(
		'data: {"type":"response.output_text.delta","item_id":"msg_partial","delta":"{\\"ans"}\n\n',
	);
}

it("finishes an enabled local diagnostic write before returning malformed output", async () => {
	const dir = await mkdtemp(join(tmpdir(), "nova-structured-diagnostic-"));
	const previous = process.env.NOVA_DEBUG_STRUCTURED_OUTPUT_DIR;
	process.env.NOVA_DEBUG_STRUCTURED_OUTPUT_DIR = dir;
	try {
		await withResponsesPeer(
			(_request, response) =>
				respondWithObject(response, "unparseable diagnostic fixture"),
			async (provider) => {
				const result = await runStructuredWith(provider(MODEL), args, () => {});
				expect(result.object).toBeNull();
			},
		);
		const files = await readdir(dir);
		expect(files).toHaveLength(1);
		expect(await readFile(join(dir, files[0]), "utf8")).toBe(
			"unparseable diagnostic fixture",
		);
	} finally {
		if (previous === undefined)
			delete process.env.NOVA_DEBUG_STRUCTURED_OUTPUT_DIR;
		else process.env.NOVA_DEBUG_STRUCTURED_OUTPUT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

it.each([
	[
		"invalid_prompt",
		"Invalid prompt was flagged as potentially violating usage policy",
		"prompt_flagged",
	],
	[
		"server_error",
		"The server had an error processing the request",
		"api_server",
	],
] as const)(
	"preserves the native mid-stream %s event for classification",
	async (code, message, expected) => {
		await withResponsesPeer(
			(request, response) => {
				request.resume();
				writePartial(response);
				response.end(
					`data: ${JSON.stringify({ type: "error", sequence_number: 1, error: { type: code === "server_error" ? "server_error" : "invalid_request_error", code, message, param: null } })}\n\n`,
				);
			},
			async (provider) => {
				const outcome = await runStructuredWith(
					provider(MODEL),
					args,
					() => {},
				).then(
					() => ({ ok: true as const }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				expect(outcome.ok).toBe(false);
				if (outcome.ok)
					throw new Error("Provider error unexpectedly produced an object");
				expect(classifyError(outcome.error).type).toBe(expected);
			},
		);
	},
);
