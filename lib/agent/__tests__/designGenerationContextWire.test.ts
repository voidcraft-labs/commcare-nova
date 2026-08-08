/**
 * Wire pin for the design pipeline's structured calls — the same
 * capturing-fetch discipline as `wireCacheConfig.test.ts`, nothing sent.
 *
 * What must hold on the wire for every author/reviewer/reviser/planner
 * call: `store: false` (stateless, no provider retention, excluded from
 * training by API terms), `stream: true` (a blocking call's headers wait
 * on the whole generation, which undici's 300s headersTimeout kills for
 * every long reasoning call — observed live), a NON-STRICT json_schema
 * response format (the design schemas carry optional slots and `oneOf`
 * unions, which OpenAI's strict validator rejects with a 400 before the
 * model runs — observed live; Zod is the real gate), the reasoning
 * options riding the `openai` key, the exact model id, and a live abort
 * signal on the request.
 *
 * The pin is SPLIT across two seams because a real `streamText` run —
 * success or failure — strands internal tee/stitch machinery the
 * async-leak gate flags: `modelRunContext.test.ts` proves Nova passes
 * these options to `streamText` (mocked seam), and this file proves the
 * provider maps them onto the wire body by invoking the model's
 * `doStream` directly — the full streaming request body is built and
 * captured, and the rejected fetch means no stream machinery exists to
 * strand. The abort contract stays at the full `runStructured` level,
 * which refuses a dead signal before any construction.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import { createNovaOpenAI } from "@/lib/agent/openaiProvider";
import { MODEL_DEFAULT, reasoningProviderOptions } from "@/lib/models";

const SESSION_ID = "00000000-0000-4000-8000-000000000600";

function makeContext(meter?: { track(u: unknown): void }) {
	return new DesignGenerationContext({
		apiKey: "sk-fake-never-sent",
		userId: "user-1",
		projectId: "proj-1",
		runId: "run-1",
		designSessionId: SESSION_ID,
		meter: meter as never,
	});
}

interface CapturedRequest {
	body: {
		model?: string;
		store?: boolean;
		stream?: boolean;
		reasoning?: { effort?: string; summary?: string };
		max_output_tokens?: number;
		text?: {
			format?: { type?: string; strict?: boolean; schema?: unknown };
		};
	};
	signal: AbortSignal | null | undefined;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("design structured-call wire body", () => {
	it("streams a store:false + non-strict json_schema request with reasoning options and the abort signal", async () => {
		let captured: CapturedRequest | null = null;
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			captured = {
				body: JSON.parse(init?.body as string),
				signal: init?.signal,
			};
			return new Response("captured", { status: 500 });
		});

		const model = createNovaOpenAI("sk-fake-never-sent")(MODEL_DEFAULT);
		const controller = new AbortController();
		await expect(
			model.doStream({
				prompt: [
					{ role: "user", content: [{ type: "text", text: "Say yes." }] },
				],
				maxOutputTokens: 500,
				responseFormat: {
					type: "json",
					name: "response",
					// A shape OpenAI's STRICT validator would reject (`oneOf`,
					// non-required optional) — legal on the wire only because
					// the format ships strict:false.
					schema: {
						type: "object",
						properties: {
							answer: {
								oneOf: [{ type: "string" }, { type: "number" }],
							},
							note: { type: "string" },
						},
						required: ["answer"],
					},
				},
				providerOptions: {
					openai: {
						...reasoningProviderOptions("high").openai,
						strictJsonSchema: false,
					},
				},
				abortSignal: controller.signal,
				includeRawChunks: false,
			}),
		).rejects.toThrow();

		const request = captured as CapturedRequest | null;
		if (!request) throw new Error("no request captured");
		expect(request.body.model).toBe(MODEL_DEFAULT);
		expect(request.body.store).toBe(false);
		// Streaming is the seam's law, not a caller choice: blocking-mode
		// headers arrive only after the full generation, which undici's 300s
		// headersTimeout kills for every long reasoning call.
		expect(request.body.stream).toBe(true);
		expect(request.body.reasoning?.effort).toBe("high");
		expect(request.body.max_output_tokens).toBe(500);
		// Non-strict json_schema: the design schemas are outside OpenAI's
		// strict subset, and a strict format 400s the request pre-model.
		expect(request.body.text?.format?.type).toBe("json_schema");
		expect(request.body.text?.format?.strict).toBe(false);
		expect(request.body.text?.format?.schema).toBeDefined();
		expect(request.signal).toBeInstanceOf(AbortSignal);
	});

	it("rejects on an already-aborted signal without swallowing the abort", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("fetch must not run for an aborted call");
		});
		const ctx = makeContext();
		const controller = new AbortController();
		controller.abort();
		await expect(
			ctx.runStructured({
				schema: z.object({ answer: z.string() }),
				modelId: "gpt-test",
				system: "You answer.",
				prompt: "Say yes.",
				maxOutputTokens: 500,
				signal: controller.signal,
			}),
		).rejects.toThrow();
	});
});
