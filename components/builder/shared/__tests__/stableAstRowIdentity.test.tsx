// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	and,
	coalesce,
	concat,
	dateLiteral,
	eq,
	isIn,
	literal,
	lt,
	type Predicate,
	prop,
	switchCase,
	switchExpr,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../ExpressionCardEditor";
import { PredicateCardEditor } from "../PredicateCardEditor";
import {
	PredicateWorkbench,
	type PredicateWorkbenchProps,
} from "../PredicateWorkbench";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "dob", label: "Date of birth", data_type: "date" },
			{ name: "region", label: "Region", data_type: "text" },
		],
	},
];

const KNOWN_INPUTS = [] as const;
const ACTIVE_RIGHT_REQUEST = {
	token: 1,
	path: ["right"],
} as const satisfies NonNullable<PredicateWorkbenchProps["focusRequest"]>;

function ControlledWorkbench({
	initial,
	focusRequest,
}: {
	readonly initial: Predicate;
	readonly focusRequest?: PredicateWorkbenchProps["focusRequest"];
}) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<PredicateWorkbench
				value={value}
				onChange={(next) => setValue(structuredClone(next))}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
				focusRequest={focusRequest}
			/>
			<output data-testid="predicate-state">{JSON.stringify(value)}</output>
		</>
	);
}

function ControlledExpression({
	initial,
}: {
	readonly initial: ValueExpression;
}) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<ExpressionCardEditor
				value={value}
				onChange={(next) => setValue(structuredClone(next))}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>
			<output data-testid="expression-state">{JSON.stringify(value)}</output>
		</>
	);
}

function ControlledPredicateCard({ initial }: { readonly initial: Predicate }) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<PredicateCardEditor
				value={value}
				onChange={(next) => setValue(structuredClone(next))}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				knownInputs={KNOWN_INPUTS}
			/>
			<output data-testid="predicate-card-state">
				{JSON.stringify(value)}
			</output>
		</>
	);
}

function workbenchRegion(path: readonly (string | number)[]): HTMLElement {
	const id = JSON.stringify(path);
	const region = [
		...document.querySelectorAll<HTMLElement>("[data-workbench-focus-id]"),
	].find((candidate) => candidate.dataset.workbenchFocusId === id);
	if (region === undefined) throw new Error(`Missing workbench region ${id}`);
	return region;
}

function dateInputWithin(root: ParentNode, index = 0): HTMLInputElement {
	const input =
		root.querySelectorAll<HTMLInputElement>('input[type="date"]')[index];
	if (input === undefined) throw new Error(`Missing date input ${index + 1}`);
	return input;
}

function expectDateCommitPreservesDomIdentity({
	input,
	nextValue,
	currentInput,
	stateTestId,
}: {
	readonly input: HTMLInputElement;
	readonly nextValue: string;
	readonly currentInput: () => HTMLInputElement;
	readonly stateTestId:
		| "predicate-state"
		| "predicate-card-state"
		| "expression-state";
}) {
	input.focus();
	expect(document.activeElement).toBe(input);

	fireEvent.change(input, { target: { value: nextValue } });

	expect(input.isConnected).toBe(true);
	expect(currentInput()).toBe(input);
	expect(document.activeElement).toBe(input);
	expect(input.value).toBe(nextValue);
	expect(screen.getByTestId(stateTestId).textContent).toContain(nextValue);
}

describe("stable AST row identity", () => {
	it("keeps a grouped predicate row mounted while a nested date is edited", () => {
		const initial = and(
			lt(prop("patient", "dob"), dateLiteral("2026-01-01")),
			eq(prop("patient", "region"), literal("North")),
		);
		render(<ControlledWorkbench initial={initial} />);

		const input = dateInputWithin(workbenchRegion(["and", 0]));
		expectDateCommitPreservesDomIdentity({
			input,
			nextValue: "2026-02-02",
			currentInput: () => dateInputWithin(workbenchRegion(["and", 0])),
			stateTestId: "predicate-state",
		});
	});

	it("keeps a non-array active expression mounted while its date is edited", () => {
		const initial = lt(prop("patient", "dob"), dateLiteral("2026-03-03"));
		render(
			<ControlledWorkbench
				initial={initial}
				focusRequest={ACTIVE_RIGHT_REQUEST}
			/>,
		);

		const input = dateInputWithin(workbenchRegion(["right"]));
		expectDateCommitPreservesDomIdentity({
			input,
			nextValue: "2026-04-04",
			currentInput: () => dateInputWithin(workbenchRegion(["right"])),
			stateTestId: "predicate-state",
		});
	});

	it("keeps a LogicalGroupCard clause mounted while its nested date is edited", () => {
		const initial = and(
			lt(prop("patient", "dob"), dateLiteral("2026-11-11")),
			eq(prop("patient", "region"), literal("North")),
		);
		const { container } = render(<ControlledPredicateCard initial={initial} />);
		const input = dateInputWithin(container);

		expectDateCommitPreservesDomIdentity({
			input,
			nextValue: "2026-12-12",
			currentInput: () => dateInputWithin(container),
			stateTestId: "predicate-card-state",
		});
	});

	it("keeps an InCard membership row mounted while its date is edited", () => {
		const initial = isIn(
			prop("patient", "dob"),
			dateLiteral("2027-01-01"),
			dateLiteral("2027-02-02"),
		);
		const { container } = render(<ControlledPredicateCard initial={initial} />);
		const input = dateInputWithin(container);

		expectDateCommitPreservesDomIdentity({
			input,
			nextValue: "2027-03-03",
			currentInput: () => dateInputWithin(container),
			stateTestId: "predicate-card-state",
		});
	});

	it.each([
		{
			name: "concat value",
			initial: concat(
				term(dateLiteral("2026-05-05")),
				term(dateLiteral("2026-06-06")),
			),
		},
		{
			name: "coalesce fallback",
			initial: coalesce(
				term(dateLiteral("2026-05-05")),
				term(dateLiteral("2026-06-06")),
			),
		},
	])("keeps a $name row mounted across an immutable leaf edit", ({
		initial,
	}) => {
		const { container } = render(<ControlledExpression initial={initial} />);
		const input = dateInputWithin(container);

		expectDateCommitPreservesDomIdentity({
			input,
			nextValue: "2026-07-07",
			currentInput: () => dateInputWithin(container),
			stateTestId: "expression-state",
		});
	});

	it("keeps a switch choice mounted while its matching date is edited", () => {
		const initial = switchExpr(
			term(prop("patient", "dob")),
			[switchCase(dateLiteral("2026-08-08"), term(literal("scheduled")))],
			term(literal("other")),
		);
		render(<ControlledExpression initial={initial} />);
		const input = screen.getByLabelText("Value to match") as HTMLInputElement;

		expectDateCommitPreservesDomIdentity({
			input,
			nextValue: "2026-09-09",
			currentInput: () =>
				screen.getByLabelText("Value to match") as HTMLInputElement,
			stateTestId: "expression-state",
		});
	});

	it("keeps a boolean leaf's row and focused control mounted", () => {
		const initial = concat(
			term(literal(true)),
			term(dateLiteral("2026-10-10")),
		);
		render(<ControlledExpression initial={initial} />);
		const control = screen.getByRole("button", { name: "No" });
		control.focus();

		fireEvent.click(control);

		expect(control.isConnected).toBe(true);
		expect(screen.getByRole("button", { name: "No" })).toBe(control);
		expect(document.activeElement).toBe(control);
		expect(control.getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByTestId("expression-state").textContent).toContain(
			'"value":false',
		);
	});
});
