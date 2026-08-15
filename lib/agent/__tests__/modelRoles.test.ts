import { describe, expect, it } from "vitest";
import { MODEL_PRICING, MODEL_ROLES } from "@/lib/models";

describe("production model roles", () => {
	it("pins each LLM responsibility to its independently tunable model and effort", () => {
		expect(MODEL_ROLES).toEqual({
			designAuthor: {
				modelId: "gpt-5.6-sol",
				reasoningEffort: "medium",
			},
			designReviewer: {
				modelId: "gpt-5.6-sol",
				reasoningEffort: "medium",
			},
			executorHelper: {
				modelId: "gpt-5.6-sol",
				reasoningEffort: "medium",
			},
			buildExecutor: {
				modelId: "gpt-5.6-luna",
				reasoningEffort: "xhigh",
			},
			followUpEditor: {
				modelId: "gpt-5.6-sol",
				reasoningEffort: "medium",
			},
			documentExtractor: {
				modelId: "gpt-5.6-luna",
				reasoningEffort: "xhigh",
			},
		});
	});

	it("has an exact pricing card for every configured model", () => {
		for (const role of Object.values(MODEL_ROLES)) {
			expect(MODEL_PRICING[role.modelId]).toBeDefined();
		}
	});
});
