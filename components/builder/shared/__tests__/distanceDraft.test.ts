import { describe, expect, it } from "vitest";
import { positiveDistance } from "../distanceDraft";

describe("distance input commit boundary", () => {
	it.each(["", " ", "bad", "-1", "0", "Infinity", "NaN"])(
		"refuses %j without manufacturing a valid distance",
		(draft) =>
			expect(positiveDistance(draft, "miles")).toEqual({
				error: "Enter a distance greater than 0",
			}),
	);
	it("accepts positive fractions and finite scientific notation", () => {
		expect(positiveDistance("0.25", "miles")).toEqual({ value: 0.25 });
		expect(positiveDistance("1e3", "kilometers")).toEqual({ value: 1000 });
	});
	it("checks actual meter conversion at the selected unit", () => {
		const draft = String(Number.MAX_VALUE / 1200);
		expect(positiveDistance(draft, "kilometers")).toEqual({
			value: Number(draft),
		});
		expect(positiveDistance(draft, "miles")).toEqual({
			error: "Enter a smaller distance in miles",
		});
		expect(positiveDistance(String(Number.MAX_VALUE), "kilometers")).toEqual({
			error: "Enter a smaller distance in kilometers",
		});
	});
});
