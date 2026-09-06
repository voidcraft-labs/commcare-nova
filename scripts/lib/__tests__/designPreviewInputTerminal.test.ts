import { describe, expect, it } from "vitest";
import { designPreviewInputTerminal } from "../designPreviewInputTerminal";

const call = (toolCallId: string, toolName: string, invalid = false) => ({
	toolCallId,
	toolName,
	input:
		toolName === "askQuestions"
			? {
					header: "Visit schedule",
					questions: [
						{
							question: "How often do workers visit?",
							options: [{ label: "Weekly" }],
						},
					],
				}
			: {},
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
			questions: [call("winner", "askQuestions")],
		});
	});

	it("distinguishes no input terminal from a successful wait", () => {
		expect(designPreviewInputTerminal([], [])).toEqual({ kind: "none" });
	});
	it("does not treat an uncompleted wait or an invalid question as accepted input", () => {
		expect(
			designPreviewInputTerminal(
				[call("wait", "waitForInput"), call("bad", "askQuestions", true)],
				[],
			),
		).toEqual({ kind: "none" });
	});

	it.each([
		null,
		{},
		{ ok: true },
		{ awaitingInput: true },
		{ ok: false, awaitingInput: true },
	])("keeps the valid question when wait did not succeed: %j", (output) => {
		const question = call("question", "askQuestions");
		expect(
			designPreviewInputTerminal(
				[question],
				[{ toolName: "waitForInput", output }],
			),
		).toEqual({ kind: "questions", questions: [question] });
	});
});
