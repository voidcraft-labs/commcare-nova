import { describe, expect, it } from "vitest";
import { designPreviewPendingQuestions } from "../designPreviewInputTerminal";

const call = (toolCallId: string, toolName: string, invalid = false) => ({
	toolCallId,
	toolName,
	input: {},
	invalid,
});

describe("design preview input-terminal arbitration", () => {
	it("suppresses every question when the ordered queue accepted a wait", () => {
		expect(
			designPreviewPendingQuestions(
				[call("wait", "waitForInput"), call("question", "askQuestions")],
				[
					{
						toolName: "waitForInput",
						output: { ok: true, awaitingInput: true },
					},
				],
			),
		).toEqual([]);
	});

	it("prompts only the first valid question when it won before a refused wait", () => {
		expect(
			designPreviewPendingQuestions(
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
			).map((question) => question.toolCallId),
		).toEqual(["winner"]);
	});
});
