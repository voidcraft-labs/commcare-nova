// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/roundTripPreservation.test.tsx
//
// Round-trip preservation contract for the picker primitives.
//
// `ValueExpressionPicker` and `RelationPathBuilder` are mounted at
// every value / relation slot in the editor. The schema accepts
// shapes wider than what those pickers EDIT — higher-order
// ValueExpression arms (arith / if / count / etc.) and non-canonical
// RelationPath shapes (multi-hop ancestor walks, qualified
// subcase / ancestor walks, `any-relation`). The pickers MUST
// round-trip those shapes without destruction: rendering the
// editor with a non-canonical shape must NOT trigger an
// `onChange` that overwrites it.
//
// Without these guarantees, a saved predicate emitted by any
// caller that produces higher-order shapes at value / relation
// slots would silently lose its content the moment a user opens
// the editor.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	arith,
	between,
	count,
	eq,
	exists,
	gt,
	isBlank,
	isIn,
	isNull,
	literal,
	prop,
	relationStep,
	subcasePath,
	term,
	today,
} from "@/lib/domain/predicate";
import { PredicateCardEditor } from "../PredicateCardEditor";

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
	],
};
const VISIT: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [{ name: "kind", label: "Kind", data_type: "text" }],
};
const CASE_TYPES = [HOUSEHOLD, PATIENT, VISIT];

describe("ValueExpressionPicker — non-Term round-trip preservation", () => {
	it("renders read-only badge for an `arith` value (does not destroy)", () => {
		// `eq(prop, arith(literal, literal, "+"))` — the right side
		// is a higher-order `arith` expression. Mounting the editor
		// must NOT call onChange on render; the AST must round-trip
		// verbatim through the picker.
		const value = eq(
			prop("patient", "age"),
			arith("+", term(literal(1)), term(literal(2))),
		);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// The badge surfaces the expression kind — verifies the
		// picker chose the read-only branch over the editing branch.
		expect(container.textContent).toMatch(/Arithmetic/i);
		// No onChange fired during mount / render — the AST is
		// preserved verbatim until the user explicitly clicks
		// Replace.
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders read-only badge for a `count` value", () => {
		const value = eq(prop("patient", "age"), count(subcasePath("parent")));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Relational count/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders read-only badge for a `today()` constant value", () => {
		const value = eq(prop("patient", "age"), today());
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Today/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders the editing surface for a Term-wrapped value (no badge)", () => {
		const value = eq(prop("patient", "age"), literal(5));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// No "Expression:" badge — the picker chose the editing
		// branch.
		expect(container.textContent).not.toMatch(/Expression:/i);
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("RelationPathBuilder — non-canonical round-trip preservation", () => {
	it("renders read-only badge for a multi-hop ancestor walk", () => {
		// Two-hop walk: visit → patient → household. The composer's
		// canonical edit shape is single-step; multi-hop must surface
		// as the read-only badge so the second hop isn't lost.
		const value = exists(
			ancestorPath(relationStep("parent"), relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="visit"
			/>,
		);
		expect(container.textContent).toMatch(/Multi-hop ancestor walk/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders read-only badge for a qualified ancestor walk", () => {
		// Single-hop ancestor with a `throughCaseType` qualifier on
		// the step — the composer's canonical edit shape doesn't
		// surface the qualifier, so editing in place would silently
		// drop it.
		const value = exists(ancestorPath(relationStep("parent", "household")));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Qualified ancestor walk/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders read-only badge for an `any-relation` walk", () => {
		const value = exists(anyRelationPath("parent"));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Direction-agnostic walk/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders read-only badge for a qualified subcase walk", () => {
		// `subcasePath("parent", "visit")` — `ofCaseType` qualifier
		// would silently vanish if the composer collapsed it into the
		// canonical (no-qualifier) subcase shape.
		const value = exists(subcasePath("parent", "visit"));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Qualified subcase walk/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("renders the editing surface for a canonical single-step ancestor walk", () => {
		const value = exists(ancestorPath(relationStep("parent")));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// No badge — the canonical shape edits in place.
		expect(container.textContent).not.toMatch(
			/Multi-hop|Direction-agnostic|Qualified/i,
		);
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("LeftPropertyPicker — non-Term LEFT-slot round-trip preservation", () => {
	// Every Predicate operator with a `left: ValueExpression` slot
	// must round-trip non-Term values without destruction. The
	// schema admits any ValueExpression at those slots; the
	// editor's LEFT-slot picker must NOT silently overwrite a
	// higher-order expression on first interaction.
	//
	// The five surfaces: `compare` (ComparisonCard) / `in` (InCard) /
	// `between` (BetweenCard) / `is-null` (IsNullCard) / `is-blank`
	// (IsBlankCard).

	const NON_TERM_LEFT = arith("+", term(literal(1)), term(literal(2)));

	it("ComparisonCard preserves a non-Term left", () => {
		// Construct via parse rather than the typed builders because
		// `gt` requires ordered operands at type-check time and the
		// builder type narrowing rejects `left: arith(...)` shapes
		// directly. The runtime builder accepts the wider shape; we
		// reach it via the typed builder with a cast for the test.
		const value = gt(NON_TERM_LEFT, term(literal(18)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Arithmetic/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("InCard preserves a non-Term left", () => {
		const value = isIn(NON_TERM_LEFT, literal(1), literal(2), literal(3));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Arithmetic/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("BetweenCard preserves a non-Term left", () => {
		const value = between(NON_TERM_LEFT, {
			lower: literal(0),
			upper: literal(100),
		});
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Arithmetic/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("IsNullCard preserves a non-Term left", () => {
		const value = isNull(NON_TERM_LEFT);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Arithmetic/i);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("IsBlankCard preserves a non-Term left", () => {
		const value = isBlank(NON_TERM_LEFT);
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Arithmetic/i);
		expect(onChange).not.toHaveBeenCalled();
	});
});
