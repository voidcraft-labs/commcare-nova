import { describe, expect, it } from "vitest";
import { GenerationStage } from "@/lib/session/types";
import { generationProgressPercent } from "../GenerationProgress";

describe("generationProgressPercent", () => {
	it("uses the current two-milestone layout plus Done as its denominator", () => {
		expect(
			generationProgressPercent(GenerationStage.Foundation, 2),
		).toBeCloseTo(100 / 3);
		expect(generationProgressPercent(GenerationStage.Build, 2)).toBeCloseTo(
			200 / 3,
		);
	});

	it("includes the historical Fix milestone only when it is visible", () => {
		expect(generationProgressPercent(GenerationStage.Fix, 3)).toBe(75);
	});
});
