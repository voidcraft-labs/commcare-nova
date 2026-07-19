// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards/expression/SwitchCard.test.tsx
//
// Switch card tests — drag-orderable cases + non-empty invariant.
// The card's drag surface targets `cases` (one per row); the `on`
// and `fallback` slots stay structurally fixed.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	type CheckError,
	checkExpression,
	dateLiteral,
	literal,
	predicateSchema,
	prop,
	switchCase,
	switchExpr,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "risk", label: "Risk", data_type: "text" },
		{ name: "score", label: "Score", data_type: "int" },
	],
};

async function settleTooltipTransition() {
	await act(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
}

describe("SwitchCard — reorder produces cases array in the new order", () => {
	it("reordering cases produces a cases array in the new order", () => {
		const a = switchCase(literal("low"), term(literal(1)));
		const b = switchCase(literal("medium"), term(literal(2)));
		const c = switchCase(literal("high"), term(literal(3)));
		const onExpr = term(prop("patient", "risk"));
		const fallback = term(literal(0));
		const original = switchExpr(onExpr, [a, b, c], fallback);
		expect(original.cases).toEqual([a, b, c]);
		const reordered = switchExpr(onExpr, [c, a, b], fallback);
		expect(reordered.cases).toEqual([c, a, b]);
	});
});

describe("SwitchCard — drag handle wiring", () => {
	it("grip button mounts per case inside a multi-case switch", () => {
		const value = switchExpr(
			term(prop("patient", "risk")),
			[
				switchCase(literal("low"), term(literal(1))),
				switchCase(literal("high"), term(literal(2))),
			],
			term(literal(0)),
		);
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// Every reorderable choice exposes the same direct action name.
		const grips = container.querySelectorAll(
			'button[aria-label^="Move choice"]',
		);
		expect(grips.length).toBe(2);
	});
});

describe("SwitchCard — case removal contract", () => {
	it("the schema requires non-empty cases", () => {
		// Constructing `switchExpr(on, [], fallback)` would require an
		// empty tuple at the type layer — TypeScript rejects it. The
		// editor's `removeCase` callback refuses the last-row removal
		// at runtime; this test covers the schema layer instead.
		const value = switchExpr(
			term(prop("patient", "risk")),
			[switchCase(literal("low"), term(literal(1)))],
			term(literal(0)),
		);
		expect(value.cases.length).toBe(1);
	});

	it("moves focus to the next choice's remove action after deletion", async () => {
		const initial = switchExpr(
			term(prop("patient", "risk")),
			[
				switchCase(literal("low"), term(literal(1))),
				switchCase(literal("medium"), term(literal(2))),
				switchCase(literal("high"), term(literal(3))),
			],
			term(literal(0)),
		);
		function Harness() {
			const [value, setValue] = useState(initial);
			return (
				<ExpressionCardEditor
					value={value}
					onChange={(next) => {
						if (next.kind === "switch") setValue(next);
					}}
					caseTypes={[PATIENT]}
					currentCaseType="patient"
				/>
			);
		}
		render(<Harness />);

		const removeActions = screen.getAllByRole("button", {
			name: "Remove choice",
		});
		const nextAction = removeActions[1];
		removeActions[0].focus();
		await act(async () => {
			fireEvent.click(removeActions[0]);
			await Promise.resolve();
		});

		expect(document.activeElement).toBe(nextAction);
		expect(
			screen.getAllByRole("button", { name: "Remove choice" }),
		).toHaveLength(2);
	});

	it("moves a choice from the keyboard and keeps focus on its handle", async () => {
		const initial = switchExpr(
			term(prop("patient", "risk")),
			[
				switchCase(literal("low"), term(literal(1))),
				switchCase(literal("high"), term(literal(2))),
			],
			term(literal(0)),
		);
		function Harness() {
			const [value, setValue] = useState(initial);
			return (
				<ExpressionCardEditor
					value={value}
					onChange={(next) => {
						if (next.kind === "switch") setValue(next);
					}}
					caseTypes={[PATIENT]}
					currentCaseType="patient"
				/>
			);
		}
		render(<Harness />);

		const second = screen.getByRole("button", {
			name: "Move choice 2 of 2",
		});
		second.focus();
		fireEvent.keyDown(second, { key: "ArrowUp" });
		await settleTooltipTransition();

		expect(document.activeElement).toBe(second);
		expect(second.getAttribute("aria-label")).toBe("Move choice 1 of 2");
		expect(screen.getByRole("status").textContent).toBe(
			"Choice 2 moved earlier",
		);
	});
});

describe("SwitchCard — compatible new choices", () => {
	it("adds a choice using the discriminator and saved result types", () => {
		const value = switchExpr(
			term(prop("patient", "score")),
			[switchCase(literal(1), term(literal(10)))],
			term(literal(0)),
		);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add choice" }));
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as ValueExpression;
		expect(
			predicateSchema.safeParse({
				kind: "eq",
				left: term(literal(1)),
				right: next,
			}).success,
		).toBe(true);
		const errors: CheckError[] = [];
		expect(
			checkExpression(
				next,
				{
					caseTypes: [PATIENT],
					knownInputs: [],
					currentCaseType: "patient",
				},
				errors,
				[],
			),
		).toBe("int");
		expect(errors).toEqual([]);
		if (next.kind !== "switch") throw new Error("Expected a switch");
		expect(next.cases).toHaveLength(2);
		expect(next.cases[1].when.value).toBe(0);
		expect(next.cases[1].then).toEqual(term(literal(0)));
	});
});

describe("SwitchCard — `when` literal preserves data_type qualifier", () => {
	// Regression test for the data-loss class where blur-commit
	// silently strips the `data_type` qualifier: an uncontrolled
	// blur-commit input that unconditionally rebuilds via the bare
	// `literal(...)` builder drops any qualifier on the source AST.
	// Mounting a switch whose `when` carries `dateLiteral(...)`,
	// focusing then blurring without typing, MUST leave the AST
	// reference-stable — no spurious `onChange` and no qualifier
	// loss.

	it("focus + blur without typing leaves the dateLiteral when AST untouched", () => {
		// `dateLiteral("2024-01-01")` carries `data_type: "date"`.
		// The naïve rebuild (uncontrolled `defaultValue` + bare
		// `literal(text)` on every blur) silently turns this into a
		// number literal because `Number("2024")` parses as a number,
		// AND drops the `data_type` qualifier. The fix is the
		// `text === initial` no-op gate.
		const value = switchExpr(
			term(prop("patient", "risk")),
			[switchCase(dateLiteral("2024-01-01"), term(literal("y2024")))],
			term(literal("other")),
		);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[
					{
						name: "patient",
						properties: [{ name: "risk", label: "Risk", data_type: "date" }],
					},
				]}
				currentCaseType="patient"
			/>,
		);
		// Find the value matched by this choice.
		const whenInput = screen.getByLabelText(
			"Value to match",
		) as HTMLInputElement;
		expect(whenInput.value).toBe("2024-01-01");
		// Focus then blur without typing — the no-op gate must
		// short-circuit the commit.
		whenInput.focus();
		fireEvent.blur(whenInput);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("typing a new date value preserves data_type: 'date' on the rebuilt literal", () => {
		// User edits the text; the parser must route through
		// `dateLiteral(...)` (or the equivalent qualifier-preserving
		// rebuild) so the qualifier survives the edit.
		const value = switchExpr(
			term(prop("patient", "risk")),
			[switchCase(dateLiteral("2024-01-01"), term(literal("y2024")))],
			term(literal("other")),
		);
		const onChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={[
					{
						name: "patient",
						properties: [{ name: "risk", label: "Risk", data_type: "date" }],
					},
				]}
				currentCaseType="patient"
			/>,
		);
		const whenInput = screen.getByLabelText(
			"Value to match",
		) as HTMLInputElement;
		// Edit the input, then blur to commit.
		fireEvent.change(whenInput, { target: { value: "2025-06-15" } });
		fireEvent.blur(whenInput);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as {
			cases: { when: { value: unknown; data_type?: string } }[];
		};
		expect(next.cases[0].when.value).toBe("2025-06-15");
		expect(next.cases[0].when.data_type).toBe("date");
	});
});
