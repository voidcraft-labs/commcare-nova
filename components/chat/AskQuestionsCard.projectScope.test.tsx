// @vitest-environment happy-dom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskQuestionsCard } from "./AskQuestionsCard";

afterEach(cleanup);
const input = {
	header: "Visit details",
	questions: [
		{ question: "Who will use it?", options: [] },
		{ question: "Where will they work?", options: [] },
	],
};
function answerRoute() {
	return { current: null as ((text: string) => void) | null };
}
function currentAnswer(route: ReturnType<typeof answerRoute>) {
	if (!route.current)
		throw new Error("Committed card did not register the answer route");
	return route.current;
}

describe("AskQuestionsCard committed composer binding", () => {
	it("retires the typed route while disabled and resumes partial answers exactly once", () => {
		const pendingAnswerRef = answerRoute();
		const addToolOutput = vi.fn();
		const props = {
			toolCallId: "round",
			input,
			state: "input-available",
			pendingAnswerRef,
			addToolOutput,
		};
		const view = render(<AskQuestionsCard {...props} />);
		act(() => currentAnswer(pendingAnswerRef)("Nurses"));
		view.rerender(<AskQuestionsCard {...props} disabled />);
		expect(pendingAnswerRef.current).toBeNull();
		expect(addToolOutput).not.toHaveBeenCalled();
		view.rerender(<AskQuestionsCard {...props} />);
		const finalAnswer = currentAnswer(pendingAnswerRef);
		act(() => {
			finalAnswer("Clinics");
			finalAnswer("Duplicate completion");
		});
		expect(addToolOutput).toHaveBeenCalledExactlyOnceWith({
			tool: "askQuestions",
			toolCallId: "round",
			output: { "0": "User Responded: Nurses", "1": "User Responded: Clinics" },
		});
		expect(pendingAnswerRef.current).toBeNull();
	});
	it("cleans up its route without removing a later committed card's registration", () => {
		const pendingAnswerRef = answerRoute();
		const addToolOutput = vi.fn();
		const first = render(
			<AskQuestionsCard
				toolCallId="first"
				input={input}
				state="input-available"
				pendingAnswerRef={pendingAnswerRef}
				addToolOutput={addToolOutput}
			/>,
		);
		const firstRoute = currentAnswer(pendingAnswerRef);
		const second = render(
			<AskQuestionsCard
				toolCallId="second"
				input={input}
				state="input-available"
				pendingAnswerRef={pendingAnswerRef}
				addToolOutput={addToolOutput}
			/>,
		);
		const secondRoute = currentAnswer(pendingAnswerRef);
		expect(secondRoute).not.toBe(firstRoute);
		first.unmount();
		expect(pendingAnswerRef.current).toBe(secondRoute);
		second.unmount();
		expect(pendingAnswerRef.current).toBeNull();
		expect(addToolOutput).not.toHaveBeenCalled();
	});
});
