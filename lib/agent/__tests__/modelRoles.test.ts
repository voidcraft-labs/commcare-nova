import { describe, expect, it } from "vitest";
import { MODEL_PRICING, MODEL_ROLES } from "@/lib/models";

describe("production model roles", () => {
	it("pins each LLM responsibility to its independently tunable model and effort", () => {
		expect(MODEL_ROLES).toEqual({
			designAuthor: {
				modelId: "gpt-5.6-sol",
				reasoningEffort: "medium",
				msPerModelStep: 60_000,
			},
			designReviewer: {
				modelId: "gpt-5.6-sol",
				reasoningEffort: "medium",
				msPerModelStep: 60_000,
			},
			executorHelper: {
				modelId: "gpt-5.6-sol",
				reasoningEffort: "medium",
				msPerModelStep: 60_000,
			},
			buildExecutor: {
				modelId: "gpt-5.6-luna",
				reasoningEffort: "xhigh",
				msPerModelStep: 90_000,
			},
			followUpEditor: {
				modelId: "gpt-5.6-luna",
				reasoningEffort: "xhigh",
				msPerModelStep: 90_000,
			},
			documentExtractor: {
				modelId: "gpt-5.6-luna",
				reasoningEffort: "xhigh",
				msPerModelStep: 90_000,
			},
			translator: {
				modelId: "gpt-5.6-sol",
				reasoningEffort: "medium",
				msPerModelStep: 60_000,
			},
		});
	});

	it("has an exact pricing card for every configured model", () => {
		for (const role of Object.values(MODEL_ROLES)) {
			expect(MODEL_PRICING[role.modelId]).toBeDefined();
		}
	});
});
