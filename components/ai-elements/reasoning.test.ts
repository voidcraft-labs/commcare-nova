import { describe, expect, it } from "vitest";
import { formatThinkingDuration, reasoningAutoBehavior } from "./reasoning";

describe("reasoningAutoBehavior", () => {
	const base = {
		isStreaming: false,
		isOpen: false,
		userToggled: false,
		explicitlyClosed: false,
		hasAutoClosed: false,
		everStreamed: false,
	};

	it("opens an untouched block when its reasoning starts streaming", () => {
		expect(reasoningAutoBehavior({ ...base, isStreaming: true })).toBe("open");
	});

	it("respects an explicit defaultOpen={false} while streaming", () => {
		expect(
			reasoningAutoBehavior({
				...base,
				isStreaming: true,
				explicitlyClosed: true,
			}),
		).toBe("none");
	});

	it("schedules one close after the stream ends on an untouched block", () => {
		const settled = { ...base, isOpen: true, everStreamed: true };
		expect(reasoningAutoBehavior(settled)).toBe("scheduleClose");
		expect(reasoningAutoBehavior({ ...settled, hasAutoClosed: true })).toBe(
			"none",
		);
	});

	it("never closes a block after the stream ends if it never streamed here", () => {
		expect(reasoningAutoBehavior({ ...base, isOpen: true })).toBe("none");
	});

	it("never moves a block the user has toggled", () => {
		/* The anti-pattern this pins dead: the user opens the trailing block to
		 * read it, the model emits its next part, and one second later the block
		 * collapses under them. A user toggle retires the automation for good,
		 * in both directions. */
		const toggled = { ...base, userToggled: true };
		expect(
			reasoningAutoBehavior({ ...toggled, isOpen: true, everStreamed: true }),
		).toBe("none");
		expect(reasoningAutoBehavior({ ...toggled, isStreaming: true })).toBe(
			"none",
		);
	});
});

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
