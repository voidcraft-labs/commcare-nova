import { describe, expect, it } from "vitest";
import { datePatternProblem, insertDatePiece } from "../datePatternDraft";

describe("custom date pattern draft", () => {
	it("retains exact authored spaces and supported concrete date pieces", () => {
		expect(datePatternProblem("   ")).toBeNull();
		expect(datePatternProblem("Report %A, %B %e (%Y)")).toBeNull();
	});
	it("distinguishes missing input, an unfinished escape and an unsupported piece", () => {
		expect(datePatternProblem("")).toBe(
			"Enter a custom style or choose a date piece",
		);
		expect(datePatternProblem("Date %")).toBe(
			"Finish the date piece after % or remove it",
		);
		expect(datePatternProblem("%Q")).toBe(
			"%Q isn't a date piece. Choose another piece or remove it",
		);
	});
	it("inserts at the caret, replaces a selection and returns the caret after the inserted token", () => {
		expect(insertDatePiece("%Y-", "%m", 3)).toEqual({
			draft: "%Y-%m",
			caret: 5,
		});
		expect(insertDatePiece("Date YYYY report", "%Y", 5, 9)).toEqual({
			draft: "Date %Y report",
			caret: 7,
		});
		expect(insertDatePiece("Year ", "%Y")).toEqual({
			draft: "Year %Y",
			caret: 7,
		});
	});
});
