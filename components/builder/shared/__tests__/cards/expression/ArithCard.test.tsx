// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards/expression/ArithCard.test.tsx
//
// Inline-error tests for the ArithCard. The type checker emits
// numeric-required errors at `[..., "left"]` / `[..., "right"]`
// when the operands resolve to non-numeric types; the card's
// `useEditorErrorsAt(appendSlot(path, "left" | "right"))` lookup
// captures them inline next to the matching operand picker.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { arith, literal, term } from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "name", label: "Name", data_type: "text" },
	],
};

describe("ArithCard — inline errors", () => {
	it("renders numeric-required errors for text-typed operands", () => {
		const value = arith("+", term(literal("not-a-number")), term(literal(1)));
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// The type checker rejects the text-typed left operand. The
		// editor turns that into a direct next action.
		expect(container.textContent).toMatch(/Choose a number/i);
	});

	it("renders the numeric-required error EXACTLY ONCE per offending operand", () => {
		// Duplicate-render contract: each error message renders once,
		// not in three places (the picker shell footer + an outer
		// inline error + the inner term card's inline error). The
		// inline-error rows carry the `text-nova-rose` accent class
		// the `CardShell` and `InlineError` primitives render with;
		// counting matching DOM nodes confirms the single-render
		// contract.
		const value = arith("+", term(literal("not-a-number")), term(literal(1)));
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// Filter to error rows that contain the friendly operator-side
		// action. One render = one DOM row carrying it.
		const errorRows = Array.from(
			container.querySelectorAll<HTMLElement>(".text-nova-rose"),
		).filter((el) => /Choose a number/i.test(el.textContent ?? ""));
		expect(errorRows.length).toBe(1);
	});

	it("renders no errors for two numeric operands", () => {
		const value = arith("+", term(literal(1)), term(literal(2)));
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).not.toMatch(/Choose a number/i);
	});
});
