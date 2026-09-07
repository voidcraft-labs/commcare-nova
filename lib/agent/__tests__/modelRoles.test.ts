import { describe, expect, it } from "vitest";
import { MODEL_PRICING, MODEL_ROLES } from "@/lib/models";

describe("production model roles", () => {
	it("has an exact pricing card for every configured model", () => {
		for (const role of Object.values(MODEL_ROLES)) {
			expect(MODEL_PRICING[role.modelId]).toBeDefined();
		}
	});
});
