/**
 * Wire pin for the design pipeline's structured calls — the same
 * capturing-fetch discipline as `wireCacheConfig.test.ts`, nothing sent.
 *
 * What must hold for every author/reviewer/reviser/planner call:
 * `store: false` (stateless, no provider retention, excluded from training
 * by API terms), the reasoning options riding the `openai` key, the exact
 * model id, and a live abort signal on the request — cancellation is part
 * of the §7.5 contract, not an afterthought. A successful body also proves
 * the shared adapter parses the object and meters usage.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
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
		reasoning?: { effort?: string; summary?: string };
		max_output_tokens?: number;
	};
	signal: AbortSignal | null | undefined;
}

/** A minimal COMPLETE Responses API body the SDK parses into an object. */
function completedResponseBody(json: string) {
	return {
		id: "resp_fake",
		object: "response",
		created_at: 0,
		status: "completed",
		model: "gpt-test",
		output: [
			{
				type: "message",
				id: "msg_fake",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: json, annotations: [] }],
			},
		],
		usage: {
			input_tokens: 11,
			output_tokens: 7,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("DesignGenerationContext.runStructured wire body", () => {
	it("sends store:false + reasoning options + model id, carries the abort signal, parses, and meters", async () => {
		let captured: CapturedRequest | null = null;
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			captured = {
				body: JSON.parse(init?.body as string),
				signal: init?.signal,
			};
			return new Response(
				JSON.stringify(completedResponseBody('{"answer":"yes"}')),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const tracked: unknown[] = [];
		const ctx = makeContext({ track: (u) => tracked.push(u) });
		const controller = new AbortController();
		// The provider forwards reasoning options only for reasoning-family
		// model ids, so the pin runs against the real default model.
		const result = await ctx.runStructured({
			schema: z.object({ answer: z.string() }),
			modelId: MODEL_DEFAULT,
			system: "You answer.",
			prompt: "Say yes.",
			maxOutputTokens: 500,
			providerOptions: reasoningProviderOptions("high"),
			signal: controller.signal,
		});

		expect(result.object).toEqual({ answer: "yes" });

		const request = captured as CapturedRequest | null;
		if (!request) throw new Error("no request captured");
		expect(request.body.model).toBe(MODEL_DEFAULT);
		expect(request.body.store).toBe(false);
		expect(request.body.reasoning?.effort).toBe("high");
		expect(request.body.max_output_tokens).toBe(500);
		expect(request.signal).toBeInstanceOf(AbortSignal);

		expect(tracked).toEqual([
			{
				inputTokens: 11,
				outputTokens: 7,
				cacheReadTokens: 4,
				cacheWriteTokens: undefined,
			},
		]);
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

	it("returns null (with usage) when the model output does not fit the schema", async () => {
		vi.stubGlobal("fetch", async () => {
			return new Response(
				JSON.stringify(completedResponseBody('{"wrong":"shape"}')),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const tracked: unknown[] = [];
		const ctx = makeContext({ track: (u) => tracked.push(u) });
		const result = await ctx.runStructured({
			schema: z.object({ answer: z.string() }),
			modelId: "gpt-test",
			system: "You answer.",
			prompt: "Say yes.",
			maxOutputTokens: 500,
			signal: new AbortController().signal,
		});
		expect(result.object).toBeNull();
		// Spent tokens are spent: the failed parse still meters.
		expect(tracked).toHaveLength(1);
	});
});
