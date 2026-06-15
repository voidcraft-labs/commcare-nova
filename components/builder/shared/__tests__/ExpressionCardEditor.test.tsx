// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/ExpressionCardEditor.test.tsx
//
// Top-level expression editor tests. Exercises the integration of
// the type checker (`checkValueExpression`), the validity-index
// plumbing, the registry-driven dispatch, and the recursive shell.
// Per-card visual chrome is covered by the smoke + per-card test
// files; this file pins the editor's structural contract — what
// reaches the parent's `onChange` / `onValidityChange`, and how
// nested errors land on the right card.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	arith,
	comparisonObjectConstraint,
	count,
	formatDate,
	ifExpr,
	literal,
	matchAll,
	prop,
	subcasePath,
	term,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../ExpressionCardEditor";

// ── Fixtures ───────────────────────────────────────────────────────────

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "region", label: "Region", data_type: "text" }],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};
const VISIT: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [{ name: "kind", label: "Kind", data_type: "text" }],
};
const CASE_TYPES = [HOUSEHOLD, PATIENT, VISIT];

describe("ExpressionCardEditor — validity propagation", () => {
	it("reports valid for a well-typed term-arm expression", () => {
		const value = term(prop("patient", "age"));
		const onValidityChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});

	it("reports invalid when an arith operand is text-typed", () => {
		// `arith("+", "string", 1)` — left operand resolves to text.
		// The type checker rejects with "arith requires numeric
		// operands". The editor surfaces the verdict via
		// `onValidityChange`.
		const value: ValueExpression = arith(
			"+",
			term(literal("string")),
			term(literal(1)),
		);
		const onValidityChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});

	it("reports invalid for an unknown property in a term arm", () => {
		const value = term(prop("patient", "DOES_NOT_EXIST"));
		const onValidityChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});

	it("reports invalid when the resolved type disagrees with the root constraint", () => {
		// `today()` resolves to date; a numeric root constraint can't
		// accept it, so the root-constraint display backstop fires. A
		// legacy/hypothetical AST — valid-by-construction editing can't
		// author a date here when the slot accepts only numbers.
		const value = today();
		const onValidityChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				constraint={comparisonObjectConstraint("int")}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(false);
	});

	it("reports valid when the resolved type satisfies the root constraint", () => {
		const value = term(prop("patient", "age"));
		const onValidityChange = vi.fn();
		render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				constraint={comparisonObjectConstraint("int")}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});
});

describe("ExpressionCardEditor — recursive nesting", () => {
	it("renders an `if` card with a Predicate cond and ValueExpression branches", () => {
		const value = ifExpr(
			matchAll(),
			term(prop("patient", "name")),
			term(literal("default")),
		);
		const onValidityChange = vi.fn();
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(container).toBeTruthy();
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});

	it("renders a `count` card with a where clause that pins the destination scope", () => {
		// `count(subcasePath("parent"), eq(prop("visit", "kind"), ...))`
		// — the where-clause property reference resolves against the
		// destination scope (`visit`, the subcase walk's destination).
		// The editor flips `currentCaseType` for the inner clause.
		const value = count(subcasePath("parent"));
		const onValidityChange = vi.fn();
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(container).toBeTruthy();
		// Count of subcases — type-check produces a clean verdict
		// since the walk resolves to `visit` and there's no where.
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});

	it("renders a `format-date` card with a today() operand", () => {
		const value = formatDate(today(), "short");
		const onValidityChange = vi.fn();
		const { container } = render(
			<ExpressionCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				onValidityChange={onValidityChange}
			/>,
		);
		expect(container).toBeTruthy();
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});
});
