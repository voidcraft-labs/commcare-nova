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
});
