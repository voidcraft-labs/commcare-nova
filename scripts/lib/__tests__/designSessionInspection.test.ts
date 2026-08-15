import { describe, expect, it } from "vitest";
import {
	collectRunIds,
	designSessionSnapshotFingerprint,
	selectDesignSessionResolution,
	summarizeModelMessage,
} from "../designSessionInspection";

describe("selectDesignSessionResolution", () => {
	it("deduplicates lookup paths and selects the newest session", () => {
		const result = selectDesignSessionResolution([
			{
				sessionId: "older",
				reason: "app id",
				updatedAt: "2026-08-14T01:00:00.000Z",
			},
			{
				sessionId: "newer",
				reason: "run id",
				updatedAt: "2026-08-14T02:00:00.000Z",
			},
			{
				sessionId: "newer",
				reason: "thread id",
				updatedAt: "2026-08-14T02:00:00.000Z",
			},
		]);
		expect(result?.selected.sessionId).toBe("newer");
		expect(result?.alternatives.map((match) => match.sessionId)).toEqual([
			"older",
		]);
	});
});

describe("collectRunIds", () => {
	it("preserves evidence order while removing nulls and duplicates", () => {
		expect(
			collectRunIds([null, "session"], ["thread", "session"], [undefined]),
		).toEqual(["session", "thread"]);
	});
});

describe("summarizeModelMessage", () => {
	it("reports shape and bytes without including persisted content", () => {
		const summary = summarizeModelMessage({
			role: "user",
			content: [{ type: "text", text: "private design prose" }],
		});
		expect(summary).toMatch(/^user · 1 part · \d+ B$/);
		expect(summary).not.toContain("private design prose");
	});
});

describe("designSessionSnapshotFingerprint", () => {
	it("changes only when durable snapshot content changes", () => {
		const left = designSessionSnapshotFingerprint({
			state: "active",
			steps: 2,
		});
		expect(
			designSessionSnapshotFingerprint({ state: "active", steps: 2 }),
		).toBe(left);
		expect(
			designSessionSnapshotFingerprint({ state: "active", steps: 3 }),
		).not.toBe(left);
	});
});
