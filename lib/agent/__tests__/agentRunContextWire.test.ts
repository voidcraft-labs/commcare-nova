import { describe, expect, it, vi } from "vitest";
import { collectTranslationUnits } from "@/lib/domain";
import { AgentRunContext } from "../agentRunContext";
import type { SubGenerationUsageMeter } from "../modelRunContext";
import {
	createProductionTranslationBatchRunner,
	encodeTranslationUnit,
	translationBatchOutputSchema,
	translationLanguage,
} from "../translation/translator";
import { surveyFixture } from "./admittedFixture";
import { respondWithObject, withResponsesPeer } from "./responsesPeer";

const SESSION_ID = "00000000-0000-4000-8000-000000000600";
function makeContext(
	meter?: SubGenerationUsageMeter,
	transport?: typeof globalThis.fetch,
) {
	return new AgentRunContext({
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
describe("structured agent context", () => {
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

	it("returns a validated translation and meters the native response", async () => {
		const doc = surveyFixture();
		const unit = collectTranslationUnits(doc).find(
			(candidate) => candidate.role === "field-label",
		);
		if (!unit) throw new Error("The survey must have a question label");
		const translated = {
			translations: [{ unitId: unit.id, translatedText: "Note" }],
		};
		let received: unknown;
		await withResponsesPeer(
			(request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk) => {
					body += chunk;
				});
				request.on("end", () => {
					received = JSON.parse(body);
					respondWithObject(response, JSON.stringify(translated));
				});
			},
			async (_provider, transport) => {
				const tracked: unknown[] = [];
				const context = makeContext(
					{ track: (usage, options) => tracked.push({ usage, options }) },
					transport,
				);
				const result = await createProductionTranslationBatchRunner(context)(
					{
						sourceLanguage: translationLanguage({ language: "eng" }),
						targetLanguage: translationLanguage({ language: "fra" }),
						appObjective: doc.appName,
						units: [encodeTranslationUnit(unit)],
						glossary: [],
					},
					new AbortController().signal,
				);
				expect(received).toMatchObject({
					model: "gpt-6.1-sol",
					reasoning: { effort: "xhigh", summary: "auto" },
					store: false,
				});
				expect(result.object).toEqual(
					translationBatchOutputSchema.parse(translated),
				);
				expect(tracked).toEqual([
					{
						usage: {
							inputTokens: 11,
							outputTokens: 7,
							cacheReadTokens: 3,
							cacheWriteTokens: undefined,
						},
						options: { model: "gpt-6.1-sol", phase: "design-author" },
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
