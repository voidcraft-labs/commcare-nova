// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/expression/ArithCard.test.tsx
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
		// message names the operator and the offending side.
		expect(container.textContent).toMatch(/numeric operands/i);
	});

	it("renders the numeric-required error EXACTLY ONCE per offending operand", () => {
		// Duplicate-render contract: each error message renders once,
		// not in three places (the picker shell footer + an outer
		// inline error + the inner term card's inline error). The
		// inline-error rows carry the `text-nova-error` accent class
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
		// Filter to error rows that contain the operator-side message
		// — `numeric operands` appears only in the type checker's
		// arith-side rejection. One render = one DOM row carrying it.
		const errorRows = Array.from(
			container.querySelectorAll<HTMLElement>(".text-nova-error\\/90"),
		).filter((el) => /numeric operands/i.test(el.textContent ?? ""));
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
		expect(container.textContent).not.toMatch(/numeric operands/i);
	});
});
