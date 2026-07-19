// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	count,
	literal,
	relationStep,
	selfPath,
	subcasePath,
	term,
} from "@/lib/domain/predicate";
import { countDefault } from "../../../cards/expression/CountCard";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const HOUSEHOLD: CaseType = { name: "household", properties: [] };
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [],
};
const ORPHAN: CaseType = { name: "orphan", properties: [] };

describe("Count related cases — viable defaults", () => {
	it("starts with the declared parent when one exists", () => {
		expect(
			countDefault({
				caseTypes: [HOUSEHOLD, PATIENT],
				currentCaseType: "patient",
				knownInputs: [],
			}),
		).toEqual(count(ancestorPath(relationStep("parent"))));
	});

	it("starts with the first declared child when there is no parent", () => {
		expect(
			countDefault({
				caseTypes: [HOUSEHOLD, PATIENT],
				currentCaseType: "household",
				knownInputs: [],
			}),
		).toEqual(count(subcasePath("parent", "patient")));
	});

	it("keeps the total factory valid when no related case type exists", () => {
		expect(
			countDefault({
				caseTypes: [ORPHAN],
				currentCaseType: "orphan",
				knownInputs: [],
			}),
		).toEqual(count(selfPath()));
	});

	it("disables a new Count with a specific next step when no relation exists", async () => {
		render(
			<ExpressionCardEditor
				value={term(literal(""))}
				onChange={() => {}}
				caseTypes={[ORPHAN]}
				currentCaseType="orphan"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Value source: A value" }),
		);
		const countItem = await screen.findByRole("menuitem", {
			name: /^Count related cases/i,
		});
		expect(
			screen.queryByRole("menuitem", { name: /^Saved selections/i }),
		).toBeNull();
		expect(countItem.getAttribute("aria-disabled")).toBe("true");
		expect(countItem.textContent).toMatch(
			/Add a parent or child case type before counting related cases/i,
		);
	});

	it("round-trips an imported current-case count without rewriting it", () => {
		const value = count(selfPath());
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[ORPHAN]}
				currentCaseType="orphan"
			/>,
		);

		expect(
			screen.getByRole("combobox", { name: "Where to look" }).textContent,
		).toMatch(/This case/i);
		expect(onChange).not.toHaveBeenCalled();
	});
});
