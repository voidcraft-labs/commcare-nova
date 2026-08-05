import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "../schema";

describe("chatRequestSchema new-app scope", () => {
	it("accepts an opaque expected Project id without treating it as capability", () => {
		expect(
			chatRequestSchema.safeParse({
				expectedProjectId: "project-seeded-by-build-new",
			}).success,
		).toBe(true);
	});

	it("rejects blank or unbounded Project ids", () => {
		expect(
			chatRequestSchema.safeParse({ expectedProjectId: "   " }).success,
		).toBe(false);
		expect(
			chatRequestSchema.safeParse({ expectedProjectId: "x".repeat(256) })
				.success,
		).toBe(false);
	});

	it("rejects an empty appId: presence is the existing-app classifier", () => {
		/* The credit pre-flight keys on `appId !== undefined` while the
		 * admission branch keys on truthiness. An empty string is the one value
		 * the two reads would classify differently (edit-rate floor, then the
		 * new-build branch minting an orphan app), so it must die at parse. */
		expect(chatRequestSchema.safeParse({ appId: "" }).success).toBe(false);
		expect(chatRequestSchema.safeParse({ appId: "app-1" }).success).toBe(true);
		expect(chatRequestSchema.safeParse({}).success).toBe(true);
	});
});
