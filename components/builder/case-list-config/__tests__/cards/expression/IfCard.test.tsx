// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/cards/expression/IfCard.test.tsx
//
// Cross-family integration tests for the IfCard. The card's `cond`
// slot mounts a `ChildPredicateEditor` (the Predicate-side dispatch
// shell), so a Predicate referencing properties on the current case
// type must render correctly inside an Expression-side card.
//
// The type checker emits at `[..., "if", "cond" | "then" | "else"]`
// for the per-slot errors and at `[..., "if"]` for the operator-
// level branch-mismatch error. The card's slot lookups thread
// through both paths.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import { eq, gt, ifExpr, literal, prop, term } from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../../../ExpressionCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "name", label: "Name", data_type: "text" },
	],
};

describe("IfCard — cross-family Predicate cond", () => {
	it("renders an `if` whose cond is a comparison against the current case type", () => {
		const value = ifExpr(
			gt(prop("patient", "age"), literal(18)),
			term(literal("adult")),
			term(literal("minor")),
		);
		const onValidityChange = vi.fn();
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		// The cond's "Greater than" comparison card mounts inside the
		// outer If card; the registry surfaces the matching label.
		expect(container.textContent).toMatch(/Greater than/i);
		// Both then/else are text-typed; the editor reports valid.
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});

	it("surfaces a branch-mismatch error when then/else types disagree", () => {
		// `then = literal(1)` (int), `else = literal("x")` (text). The
		// type checker emits "if branches must agree on type" at the
		// operator-level path `[..., "if"]`.
		const value = ifExpr(
			eq(prop("patient", "age"), literal(0)),
			term(literal(1)),
			term(literal("x")),
		);
		const onValidityChange = vi.fn();
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(container.textContent).toMatch(/branches must agree/i);
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});
});
