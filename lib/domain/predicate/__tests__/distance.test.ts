import { describe, expect, it } from "vitest";
import { distanceToMeters, distanceValidationIssue } from "../distance";

describe("distance", () => {
	it("converts Nova's authored units to meters", () => {
		expect(distanceToMeters(1, "miles")).toBe(1609.344);
		expect(distanceToMeters(1, "kilometers")).toBe(1000);
	});

	it("rejects nonpositive, nonfinite, and converted-overflow radii", () => {
		expect(distanceValidationIssue(0, "miles")).toBe("not-positive-finite");
		expect(distanceValidationIssue(-1, "miles")).toBe("not-positive-finite");
		expect(distanceValidationIssue(Number.POSITIVE_INFINITY, "miles")).toBe(
			"not-positive-finite",
		);

		const unitBoundary = Number.MAX_VALUE / 1200;
		expect(distanceValidationIssue(unitBoundary, "kilometers")).toBeUndefined();
		expect(distanceValidationIssue(unitBoundary, "miles")).toBe(
			"meters-overflow",
		);
	});
});
