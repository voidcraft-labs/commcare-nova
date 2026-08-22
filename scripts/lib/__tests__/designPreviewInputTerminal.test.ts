import { describe, expect, it } from "vitest";
import { designPreviewInputTerminal } from "../designPreviewInputTerminal";

const call = (toolCallId: string, toolName: string, invalid = false) => ({
	toolCallId,
	toolName,
	input: {},
	invalid,
});

describe("design preview input-terminal arbitration", () => {
	it("suppresses every question when the ordered queue accepted a wait", () => {
		expect(
			designPreviewInputTerminal(
				[call("wait", "waitForInput"), call("question", "askQuestions")],
				[
					{
						toolName: "waitForInput",
						output: { ok: true, awaitingInput: true },
					},
				],
			),
		).toEqual({ kind: "wait" });
	});

	it("prompts only the first valid question when it won before a refused wait", () => {
		expect(
			designPreviewInputTerminal(
				[
					call("invalid", "askQuestions", true),
					call("winner", "askQuestions"),
					call("later", "askQuestions"),
				],
				[
					{
						toolName: "waitForInput",
						output: { error: "An earlier input terminal won." },
					},
				],
			),
		).toEqual({
			kind: "questions",
			questions: [expect.objectContaining({ toolCallId: "winner" })],
		});
	});

	it("distinguishes no input terminal from a successful wait", () => {
		expect(designPreviewInputTerminal([], [])).toEqual({ kind: "none" });
	});
});
