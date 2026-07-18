// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IntervalThresholdRow } from "../../../cards/column/IntervalThresholdRow";

function renderThreshold(onThresholdChange = vi.fn()) {
	render(
		<IntervalThresholdRow
			threshold={7}
			onThresholdChange={onThresholdChange}
			unit="days"
			onUnitChange={() => {}}
			thresholdLabel="Overdue after"
		/>,
	);
	return {
		input: screen.getByLabelText("Overdue after") as HTMLInputElement,
		onThresholdChange,
	};
}

describe("IntervalThresholdRow validation", () => {
	it.each([
		["an empty value", "", ""],
		["non-numeric input", "not-a-number", ""],
		["a decimal", "1.5", "1.5"],
		["zero", "0", "0"],
		["a negative number", "-2", "-2"],
	])("preserves %s and explains how to fix it", (_label, authoredDraft, visibleDraft) => {
		const { input, onThresholdChange } = renderThreshold();
		expect(input.min).toBe("1");
		expect(input.step).toBe("1");

		input.focus();
		fireEvent.change(input, { target: { value: authoredDraft } });
		fireEvent.blur(input);

		expect(input.value).toBe(visibleDraft);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		const error = screen.getByRole("alert");
		expect(error.textContent).toBe("Enter a whole number greater than 0");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);
		expect(onThresholdChange).not.toHaveBeenCalled();
	});

	it("clears the error and commits a corrected whole number", () => {
		const { input, onThresholdChange } = renderThreshold();
		input.focus();
		fireEvent.change(input, { target: { value: "1.5" } });
		fireEvent.blur(input);
		expect(input.getAttribute("aria-invalid")).toBe("true");

		input.focus();
		fireEvent.change(input, { target: { value: "2" } });
		expect(input.getAttribute("aria-invalid")).toBeNull();
		expect(
			screen.queryByText("Enter a whole number greater than 0"),
		).toBeNull();
		fireEvent.blur(input);

		expect(onThresholdChange).toHaveBeenCalledTimes(1);
		expect(onThresholdChange).toHaveBeenCalledWith(2);
	});
});
