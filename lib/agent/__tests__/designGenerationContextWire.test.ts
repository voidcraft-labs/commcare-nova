import { describe, expect, it, vi } from "vitest";
import { MODEL_ROLES, reasoningProviderOptions } from "@/lib/models";
import { makeContract } from "../design/__tests__/fixtures";
import { appDesignContractSchema } from "../design/contract";
import { DesignGenerationContext } from "../design/designGenerationContext";
import type { SubGenerationUsageMeter } from "../modelRunContext";
import { respondWithObject, withResponsesPeer } from "./responsesPeer";

const SESSION_ID = "00000000-0000-4000-8000-000000000600";
function makeContext(
	meter?: SubGenerationUsageMeter,
	transport?: typeof globalThis.fetch,
) {
	return new DesignGenerationContext({
		apiKey: "synthetic-local",
		transport,
		userId: "user-1",
		projectId: "proj-1",
		runId: "run-1",
		designSessionId: SESSION_ID,
		usagePhase: "design-author",
		meter,
	});
}
describe("design structured context", () => {
	it("meters recovered durable usage without invoking the ordinary live sink", () => {
		const meter = {
			track: vi.fn(),
			trackDurable: vi.fn(),
		};
		const ctx = makeContext(meter);
		const usage = {
			inputTokens: 100,
			outputTokens: 25,
			totalTokens: 125,
			inputTokenDetails: {
				noCacheTokens: 60,
				cacheReadTokens: 40,
				cacheWriteTokens: 0,
			},
			outputTokenDetails: { textTokens: 15, reasoningTokens: 10 },
		};
		const identity = { contextId: "context-1", stepKey: "step-1" };

		ctx.trackDurableSubGeneration(usage, identity, "gpt-5.6-luna", {
			step: true,
			phase: "design-author",
		});

		expect(meter.track).not.toHaveBeenCalled();
		expect(meter.trackDurable).toHaveBeenCalledWith(
			identity,
			expect.objectContaining({
				inputTokens: 100,
				outputTokens: 25,
				cacheReadTokens: 40,
			}),
			{
				step: true,
				model: "gpt-5.6-luna",
				phase: "design-author",
			},
		);
	});

	it("returns a production-schema-admitted contract and meters the native response", async () => {
		const contract = makeContract();
		await withResponsesPeer(
			(_request, response) =>
				respondWithObject(response, JSON.stringify(contract)),
			async (_provider, transport) => {
				const tracked: unknown[] = [];
				const context = makeContext(
					{ track: (usage, options) => tracked.push({ usage, options }) },
					transport,
				);
				const role = MODEL_ROLES.designAuthor;
				const result = await context.runStructured({
					schema: appDesignContractSchema,
					modelId: role.modelId,
					system: "Design the app",
					prompt: "Track visits",
					maxOutputTokens: 2000,
					providerOptions: reasoningProviderOptions(role.reasoningEffort),
					signal: new AbortController().signal,
				});
				expect(result.object).toEqual(appDesignContractSchema.parse(contract));
				expect(tracked).toEqual([
					{
						usage: {
							inputTokens: 11,
							outputTokens: 7,
							cacheReadTokens: 3,
							cacheWriteTokens: undefined,
						},
						options: { model: role.modelId, phase: "design-author" },
					},
				]);
				expect(context.target).toEqual({
					kind: "design-session",
					designSessionId: SESSION_ID,
				});
			},
		);
	});
});
