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

import { fireEvent, render, screen } from "@testing-library/react";
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
	match,
	multiSelectAny,
	prop,
	relationStep,
	selfPath,
	subcasePath,
	term,
	today,
	within,
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
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select",
			options: [{ value: "vip", label: "VIP" }],
		},
		{ name: "location", label: "Home", data_type: "geopoint" },
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

describe("PropertyRefPicker (mode=left) — non-Term LEFT-slot round-trip preservation", () => {
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

describe("PropertyRefPicker — `prop.via` round-trip preservation", () => {
	// Every property picker (LEFT-slot + property-only) must
	// round-trip a `prop` Term carrying a non-self `via:
	// RelationPath` walk verbatim. The schema admits `via` as
	// optional on `propertyRefSchema`; rebuilding via two-arg
	// `prop(caseType, name)` after the user picks a property
	// would silently drop the walk. The picker routes prop refs
	// with non-self `via` through the read-only badge; the badge's
	// Replace button is the only path that overwrites.
	//
	// Eight surfaces total — five LEFT-slot cards + three
	// property-only cards.

	const VIA = ancestorPath(relationStep("parent"));

	/** Click the badge's Replace button and assert the next
	 *  emitted AST is a canonical `term(prop(...))` with no `via`
	 *  walk. Verifies the Replace path produces the right shape;
	 *  paired with the no-onChange-on-render assertion above to
	 *  pin the full Replace contract. */
	function clickReplaceAndAssertCanonicalLeft(
		onChange: ReturnType<typeof vi.fn>,
		expectedCaseType: string,
	) {
		const replaceButton = screen.getByRole("button", {
			name: /Replace .* expression/i,
		});
		fireEvent.click(replaceButton);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0];
		// Walk into the predicate's left slot. The structural
		// assertion holds for every LEFT-slot card; we read through
		// `(next as any).left` because the precise predicate kind
		// varies per card.
		const left = (
			next as {
				left?: { kind?: string; term?: { kind?: string; via?: unknown } };
			}
		).left;
		expect(left?.kind).toBe("term");
		expect(left?.term?.kind).toBe("prop");
		expect(left?.term?.via).toBeUndefined();
		// Confirm the case type was preserved on the replaced ref.
		expect((left?.term as { caseType?: string } | undefined)?.caseType).toBe(
			expectedCaseType,
		);
	}

	/** Property-only counterpart — the predicate's `property` slot
	 *  carries the PropertyRef directly (no `term` wrapper). */
	function clickReplaceAndAssertCanonicalProperty(
		onChange: ReturnType<typeof vi.fn>,
		expectedCaseType: string,
	) {
		const replaceButton = screen.getByRole("button", {
			name: /Replace .* expression/i,
		});
		fireEvent.click(replaceButton);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0];
		const property = (
			next as { property?: { kind?: string; caseType?: string; via?: unknown } }
		).property;
		expect(property?.kind).toBe("prop");
		expect(property?.via).toBeUndefined();
		expect(property?.caseType).toBe(expectedCaseType);
	}

	// ── LEFT-slot cards (5) ─────────────────────────────────────────

	it("ComparisonCard preserves prop.via on render; Replace clears it", () => {
		const value = gt(term(prop("patient", "age", VIA)), term(literal(18)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		clickReplaceAndAssertCanonicalLeft(onChange, "patient");
	});

	it("InCard preserves prop.via on render; Replace clears it", () => {
		const value = isIn(
			term(prop("patient", "age", VIA)),
			literal(1),
			literal(2),
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
		expect(container.textContent).toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		clickReplaceAndAssertCanonicalLeft(onChange, "patient");
	});

	it("BetweenCard preserves prop.via on render; Replace clears it", () => {
		const value = between(term(prop("patient", "age", VIA)), {
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
		expect(container.textContent).toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		clickReplaceAndAssertCanonicalLeft(onChange, "patient");
	});

	it("IsNullCard preserves prop.via on render; Replace clears it", () => {
		const value = isNull(term(prop("patient", "age", VIA)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		clickReplaceAndAssertCanonicalLeft(onChange, "patient");
	});

	it("IsBlankCard preserves prop.via on render; Replace clears it", () => {
		const value = isBlank(term(prop("patient", "age", VIA)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		clickReplaceAndAssertCanonicalLeft(onChange, "patient");
	});

	// ── Property-only cards (3) ─────────────────────────────────────

	it("MatchCard preserves prop.via on render; Replace clears it", () => {
		const value = match(
			prop("patient", "name", VIA),
			term(literal("alice")),
			"fuzzy",
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
		expect(container.textContent).toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		clickReplaceAndAssertCanonicalProperty(onChange, "patient");
	});

	it("MultiSelectContainsCard preserves prop.via on render; Replace clears it", () => {
		const value = multiSelectAny(prop("patient", "tags", VIA), literal("vip"));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		expect(container.textContent).toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		clickReplaceAndAssertCanonicalProperty(onChange, "patient");
	});

	it("WithinDistanceCard preserves prop.via on render; Replace clears it", () => {
		const value = within(
			prop("patient", "location", VIA),
			term(literal("0 0")),
			1,
			"miles",
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
		expect(container.textContent).toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		clickReplaceAndAssertCanonicalProperty(onChange, "patient");
	});
});

describe('PropertyRefPicker — `via.kind === "self"` is canonical', () => {
	// `selfPath()` is semantically equivalent to "no walk" — the
	// `isCanonicalPropertyRef` guard accepts both `via === undefined`
	// AND `via.kind === "self"` as canonical shapes that round-trip
	// through the editing surface (no badge). One test per mode
	// pins the symmetry: the editing surface renders, and picking a
	// different property name preserves `via.kind === "self"` in the
	// emitted result rather than dropping or rebadging it.

	const SELF_VIA = selfPath();

	it("LEFT-slot mode renders the editing surface for prop with via=self", () => {
		// IsBlankCard exercises the LEFT-slot mode. The selfPath value
		// must NOT trigger the badge — it's canonical per the picker's
		// guard contract.
		const value = isBlank(term(prop("patient", "name", SELF_VIA)));
		const onChange = vi.fn();
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
			/>,
		);
		// No badge — the canonical guard accepted via=self.
		expect(container.textContent).not.toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		// Picking a different property must preserve via=self verbatim.
		// The picker rebuilds via `prop(caseType, name, via)` (three-arg
		// form) so the via slot survives the edit.
		const propertyTrigger = screen.getByRole("button", {
			name: /^Property:/i,
		});
		fireEvent.click(propertyTrigger);
		const ageOption = screen.getByRole("menuitem", { name: /^age/i });
		fireEvent.click(ageOption);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as {
			left: {
				term: { kind: string; property: string; via?: { kind: string } };
			};
		};
		expect(next.left.term.kind).toBe("prop");
		expect(next.left.term.property).toBe("age");
		expect(next.left.term.via?.kind).toBe("self");
	});

	it("property-only mode renders the editing surface for prop with via=self", () => {
		// MatchCard exercises the property-only mode. Same canonical
		// contract: via=self is editable in place, and the via slot
		// survives a property name change.
		const value = match(
			prop("patient", "name", SELF_VIA),
			term(literal("alice")),
			"fuzzy",
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
		expect(container.textContent).not.toMatch(/Property via relation walk/i);
		expect(onChange).not.toHaveBeenCalled();
		// Pick the dropdown trigger by its accessible label
		// ("Property: <current>"). The match card filters its picker
		// to text-shaped properties; `name` is text-shaped so the
		// picker accepts it.
		const propertyTrigger = screen.getByRole("button", {
			name: /^Property:/i,
		});
		fireEvent.click(propertyTrigger);
		const tagsOption = screen.getByRole("menuitem", { name: /^tags/i });
		fireEvent.click(tagsOption);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0][0] as {
			property: { kind: string; property: string; via?: { kind: string } };
		};
		expect(next.property.kind).toBe("prop");
		expect(next.property.property).toBe("tags");
		expect(next.property.via?.kind).toBe("self");
	});
});
