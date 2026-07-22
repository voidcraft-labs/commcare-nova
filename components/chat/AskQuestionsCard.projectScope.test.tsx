// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskQuestionsCard } from "./AskQuestionsCard";

const input = {
	header: "A few details",
	questions: [
		{ question: "First?", options: [{ label: "One" }] },
		{ question: "Second?", options: [{ label: "Two" }] },
	],
};

describe("AskQuestionsCard Project hydration gate", () => {
	it("makes options inert while preserving partial app-owned answers", () => {
		const addToolOutput = vi.fn();
		const view = render(
			<AskQuestionsCard
				toolCallId="tool-1"
				input={input}
				state="input-available"
				addToolOutput={addToolOutput}
				disabled
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "One" }));
		expect(screen.getByText("Question 1 of 2")).toBeTruthy();
		expect(addToolOutput).not.toHaveBeenCalled();

		view.rerender(
			<AskQuestionsCard
				toolCallId="tool-1"
				input={input}
				state="input-available"
				addToolOutput={addToolOutput}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "One" }));
		expect(screen.getByText("Question 2 of 2")).toBeTruthy();

		view.rerender(
			<AskQuestionsCard
				toolCallId="tool-1"
				input={input}
				state="input-available"
				addToolOutput={addToolOutput}
				disabled
			/>,
		);
		expect(screen.getByText("Question 2 of 2")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Two" }));
		expect(addToolOutput).not.toHaveBeenCalled();
	});
});
