// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	count,
	eq,
	exists,
	input,
	literal,
	matchAll,
	prop,
	relationStep,
	selfPath,
	subcasePath,
	whenInput,
} from "@/lib/domain/predicate";
import { whenInputPresentDefault } from "../cards/WhenInputPresentCard";
import { ExpressionCardEditor } from "../ExpressionCardEditor";
import { PredicateCardEditor } from "../PredicateCardEditor";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [{ name: "status", label: "Status", data_type: "text" }],
	},
	{
		name: "household",
		properties: [{ name: "region", label: "Region", data_type: "text" }],
	},
];
const KNOWN_INPUTS = [{ name: "query", data_type: "text" }] as const;
const VIA = ancestorPath(relationStep("parent", "household"));
const PATIENT_FIRST = eq(prop("patient", "status"), literal(""));
const HOUSEHOLD_FIRST = eq(prop("household", "region"), literal(""));
const RELATION_ONLY_CASE_TYPES: readonly CaseType[] = [
	{ name: "household", properties: [] },
	{ name: "visit", parent_type: "household", properties: [] },
	{ name: "patient", parent_type: "household", properties: [] },
];
const RELATION_ONLY_FIRST = exists(subcasePath("parent", "visit"));
const EMPTY_CASE_TYPES: readonly CaseType[] = [
	{ name: "orphan", properties: [] },
];

describe("friendly first-condition seeds", () => {
	it("starts a new search-answer wrapper with an editable Is condition", () => {
		expect(
			whenInputPresentDefault({
				caseTypes: CASE_TYPES,
				currentCaseType: "patient",
				knownInputs: KNOWN_INPUTS,
				caseDataScope: "per-case",
			}),
		).toEqual(whenInput(input("query"), PATIENT_FIRST));
	});

	it("starts a Count filter in the related case scope", () => {
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={count(VIA)}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));

		expect(onChange).toHaveBeenLastCalledWith(count(VIA, HOUSEHOLD_FIRST));
	});

	it("starts a legacy related-case filter in the related case scope", () => {
		const onChange = vi.fn();
		render(
			<PredicateCardEditor
				value={exists(VIA)}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));

		expect(onChange).toHaveBeenLastCalledWith(exists(VIA, HOUSEHOLD_FIRST));
	});

	it("starts optional related-case filters from a real relation when the destination has no information", () => {
		const countChange = vi.fn();
		const countView = render(
			<ExpressionCardEditor
				value={count(VIA)}
				onChange={countChange}
				caseTypes={RELATION_ONLY_CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		expect(countChange).toHaveBeenLastCalledWith(
			count(VIA, RELATION_ONLY_FIRST),
		);
		countView.unmount();

		const existsChange = vi.fn();
		render(
			<PredicateCardEditor
				value={exists(VIA)}
				onChange={existsChange}
				caseTypes={RELATION_ONLY_CASE_TYPES}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		expect(existsChange).toHaveBeenLastCalledWith(
			exists(VIA, RELATION_ONLY_FIRST),
		);
	});

	it("explains disabled optional filters when no valid condition can be created", () => {
		const countView = render(
			<ExpressionCardEditor
				value={count(selfPath())}
				onChange={() => {}}
				caseTypes={EMPTY_CASE_TYPES}
				currentCaseType="orphan"
			/>,
		);
		const countButton = screen.getByRole("button", {
			name: "Add condition",
		}) as HTMLButtonElement;
		const countReason = screen.getByText(
			"Add case information or choose another connection before adding a condition",
		);
		expect(countButton.disabled).toBe(true);
		expect(countButton.getAttribute("aria-describedby")).toBe(countReason.id);
		countView.unmount();

		render(
			<PredicateCardEditor
				value={exists(selfPath())}
				onChange={() => {}}
				caseTypes={EMPTY_CASE_TYPES}
				currentCaseType="orphan"
			/>,
		);
		const existsButton = screen.getByRole("button", {
			name: "Add condition",
		}) as HTMLButtonElement;
		const existsReason = screen.getByText(
			"Add case information or choose another connection before adding a condition",
		);
		expect(existsButton.disabled).toBe(true);
		expect(existsButton.getAttribute("aria-describedby")).toBe(existsReason.id);
	});

	it("does not rewrite imported Always match nodes on render", () => {
		const countChange = vi.fn();
		const countView = render(
			<ExpressionCardEditor
				value={count(VIA, matchAll())}
				onChange={countChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>,
		);
		expect(countChange).not.toHaveBeenCalled();
		countView.unmount();

		const existsChange = vi.fn();
		const existsView = render(
			<PredicateCardEditor
				value={exists(VIA, matchAll())}
				onChange={existsChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>,
		);
		expect(existsChange).not.toHaveBeenCalled();
		existsView.unmount();

		const whenChange = vi.fn();
		render(
			<PredicateCardEditor
				value={whenInput(input("query"), matchAll())}
				onChange={whenChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>,
		);
		expect(whenChange).not.toHaveBeenCalled();
	});
});
