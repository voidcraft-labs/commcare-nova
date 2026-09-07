import { describe, expect, it } from "vitest";
import {
	collectRunIds,
	selectDesignSessionResolution,
	summarizeDesignEvent,
	summarizeModelMessage,
} from "../designSessionInspection";

describe("selectDesignSessionResolution", () => {
	it("reports no match instead of inventing a selection", () => {
		expect(selectDesignSessionResolution([])).toBeNull();
	});

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
	it("keeps database Date milliseconds when choosing among sessions and repeated evidence", () => {
		const older = {
			sessionId: "older",
			reason: "app id",
			updatedAt: new Date("2026-08-14T02:00:00.100Z"),
		};
		const newer = {
			sessionId: "newer",
			reason: "thread id",
			updatedAt: new Date("2026-08-14T02:00:00.900Z"),
		};
		const latest = {
			...newer,
			reason: "run id",
			updatedAt: "2026-08-14T02:00:00.950Z",
		};
		expect(selectDesignSessionResolution([older, newer])).toEqual({
			selected: newer,
			alternatives: [older],
		});
		expect(selectDesignSessionResolution([older, newer, latest])).toEqual({
			selected: latest,
			alternatives: [older],
		});
	});
});

describe("collectRunIds", () => {
	it("preserves evidence order while removing nulls and duplicates", () => {
		expect(
			collectRunIds([null, "", "session"], ["thread", "session"], [undefined]),
		).toEqual(["session", "thread"]);
	});
});

describe("compact inspection output", () => {
	it.each([
		[{ role: "user", content: "é🙂" }, "user · 1 part · 34 B"],
		[
			{
				role: "assistant",
				content: [
					{ type: "text", text: "é🙂" },
					{ type: "text", text: "private" },
				],
			},
			"assistant · 2 parts · 97 B",
		],
		[
			{ type: "checkpoint", kind: "summary" },
			"checkpoint/summary · 0 parts · 38 B",
		],
	])(
		"reports UTF-8 byte pressure without exposing the message content",
		(message, expected) => {
			expect(summarizeModelMessage(message)).toBe(expected);
		},
	);

	it("keeps tool payloads out of event summaries while reporting their byte sizes", () => {
		const envelope = {
			kind: "conversation" as const,
			runId: "run",
			source: "chat" as const,
			ts: 1,
			seq: 1,
		};
		expect(
			summarizeDesignEvent({
				...envelope,
				payload: {
					type: "tool-call",
					toolName: "inspectApp",
					toolCallId: "call",
					input: { private: "é🙂" },
				},
			}),
		).toBe("tool call inspectApp (20 B input)");
		expect(
			summarizeDesignEvent({
				...envelope,
				payload: {
					type: "tool-result",
					toolName: "inspectApp",
					toolCallId: "call",
					output: { private: "é🙂" },
				},
			}),
		).toBe("tool result inspectApp (20 B output)");
	});

	it("distinguishes a terminal error from a nonfatal error", () => {
		const envelope = {
			kind: "conversation" as const,
			runId: "run",
			source: "chat" as const,
			ts: 1,
			seq: 1,
		};
		for (const fatal of [false, true]) {
			const output = summarizeDesignEvent({
				...envelope,
				payload: {
					type: "error",
					error: { type: "rate_limit", fatal, message: "Try again" },
				},
			});
			expect(output.includes(" fatal:")).toBe(fatal);
			expect(output).toContain("rate_limit");
			expect(output).toContain("Try again");
		}
	});
});
