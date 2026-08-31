import { describe, expect, it } from "vitest";
import {
	addVisiblePreviewCaseChoices,
	previewCaseSelectionMessage,
	reconcilePreviewCaseChoices,
	togglePreviewCaseChoice,
} from "@/lib/preview/orderedCaseSelection";

describe("ordered Preview case selection", () => {
	it("appends new choices and moves a reselected case to the end", () => {
		const selected = [
			{ caseId: "a", caseName: "A" },
			{ caseId: "b", caseName: "B" },
		];
		const withoutA = togglePreviewCaseChoice(selected, selected[0]);
		expect(togglePreviewCaseChoice(withoutA, selected[0])).toEqual([
			{ caseId: "b", caseName: "B" },
			{ caseId: "a", caseName: "A" },
		]);
	});

	it("selects visible cases in row order without crossing the maximum", () => {
		expect(
			addVisiblePreviewCaseChoices(
				[{ caseId: "old" }],
				[{ caseId: "old" }, { caseId: "c" }, { caseId: "b" }, { caseId: "a" }],
				3,
			),
		).toEqual({
			choices: [{ caseId: "old" }, { caseId: "c" }, { caseId: "b" }],
			skipped: 1,
		});
	});

	it("reconciles authoritative rows in selection order", () => {
		expect(
			reconcilePreviewCaseChoices(
				[{ caseId: "c" }, { caseId: "gone" }, { caseId: "a" }],
				[{ case_id: "a" }, { case_id: "c" }],
			),
		).toEqual({
			choices: [{ caseId: "c" }, { caseId: "a" }],
			rows: [{ case_id: "c" }, { case_id: "a" }],
			removed: 1,
		});
	});

	it("names zero and over-limit blockers precisely", () => {
		expect(previewCaseSelectionMessage(0, 5)).toBe(
			"Choose at least one case to continue",
		);
		expect(previewCaseSelectionMessage(6, 5)).toBe(
			"Choose 1 fewer case to continue",
		);
		expect(previewCaseSelectionMessage(8, 5)).toBe(
			"Choose 3 fewer cases to continue",
		);
		expect(previewCaseSelectionMessage(5, 5)).toBeUndefined();
	});
});
