/**
 * Wire pin for the design pipeline's structured calls — the same
 * capturing-fetch discipline as `wireCacheConfig.test.ts`, nothing sent.
 *
 * What must hold on the wire for every author/reviewer/reviser/planner
 * call: `store: false` (stateless, no provider retention, excluded from
 * training by API terms), `stream: true` (a blocking call's headers wait
 * on the whole generation, which undici's 300s headersTimeout kills for
 * every long reasoning call — observed live), a STRICT json_schema
 * response format carrying the projected schema (grammar-enforced
 * structure; a non-strict format let a complete 57k-char author response
 * fail the Zod parse — observed live — and the raw schemas' `oneOf`
 * spelling 400s strict mode, so the PROJECTION is what ships), the
 * reasoning options riding the `openai` key, the exact model id, and a
 * live abort signal on the request.
 *
 * The pin is SPLIT across two seams because a real `streamText` run —
 * success or failure — strands internal tee/stitch machinery the
 * async-leak gate flags: `modelRunContext.test.ts` proves Nova hands
 * `streamText` the strict projection, and this file proves the provider
 * maps it onto the wire body by invoking the model's `doStream` directly
 * — the full streaming request body is built and captured, and the
 * rejected fetch means no stream machinery exists to strand. The abort
 * contract stays at the full `runStructured` level, which refuses a dead
 * signal before any construction.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import { createNovaOpenAI } from "@/lib/agent/openaiProvider";
import { strictWireJsonSchema } from "@/lib/agent/strictStructuredOutput";
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
	it("streams a store:false + STRICT json_schema request carrying the projection, reasoning options, and the abort signal", async () => {
		let captured: CapturedRequest | null = null;
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			captured = {
				body: JSON.parse(init?.body as string),
				signal: init?.signal,
			};
			return new Response("captured", { status: 500 });
		});

		// The seam's projection of a design-shaped schema: a discriminated
		// union (raw spelling: oneOf — the exact construct that 400'd live)
		// plus an optional slot.
		const projected = strictWireJsonSchema(
			z.object({
				answer: z.discriminatedUnion("kind", [
					z.object({ kind: z.literal("text"), value: z.string() }).strict(),
					z.object({ kind: z.literal("count"), value: z.number() }).strict(),
				]),
				note: z.string().optional(),
			}),
		);

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
					schema: projected as never,
				},
				providerOptions: {
					openai: reasoningProviderOptions("high").openai,
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
		// STRICT json_schema (the provider default Nova keeps): the wire
		// carries the projection — no oneOf, every property required.
		expect(request.body.text?.format?.type).toBe("json_schema");
		expect(request.body.text?.format?.strict).toBe(true);
		const wireSchema = request.body.text?.format?.schema as {
			required?: string[];
		};
		expect(JSON.stringify(wireSchema)).not.toContain('"oneOf"');
		expect(wireSchema.required).toEqual(["answer", "note"]);
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
