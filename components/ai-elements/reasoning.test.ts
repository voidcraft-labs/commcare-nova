import { describe, expect, it } from "vitest";
import { formatThinkingDuration } from "./reasoning";

describe("formatThinkingDuration", () => {
	it.each<[number, string]>([
		[0, "0s"],
		[59, "59s"],
		[60, "1m"],
		[344, "5m 44s"],
		[3600, "1h"],
		[3900, "1h 5m"],
	])("formats %i seconds as %s", (seconds, expected) => {
		expect(formatThinkingDuration(seconds)).toBe(expected);
	});
});
