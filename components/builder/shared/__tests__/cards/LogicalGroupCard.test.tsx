// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards/LogicalGroupCard.test.tsx
//
// Logical-group tests:
//   - reduction-shape contract through the public `and` / `or` /
//     `not` builders. The reductions in
//     `lib/domain/predicate/builders.ts` are what guarantee
//     reordering + clause-removal collapse correctly; the editor's
//     behavior reduces to "the builders do the right thing,"
//     which is the load-bearing invariant the editor relies on.
//   - drag-handle wiring — confirms the grip button reaches the
//     DOM when a card sits inside an `and` / `or` clause list, and
//     does NOT reach the DOM at the top-level / inside a `not`
//     wrapper. The grip's presence is the structural signal that
//     pragmatic-drag-and-drop's draggable() registration finds an
//     element to bind to. Testing native drag events through
//     happy-dom is unreliable; the render-time grip-presence
//     assertion is the direct contract.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	and,
	eq,
	literal,
	matchAll,
	matchNone,
	not,
	or,
	prop,
} from "@/lib/domain/predicate";
import { PredicateCardEditor } from "../../PredicateCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "x", label: "X", data_type: "int" },
		{ name: "y", label: "Y", data_type: "int" },
	],
};

describe("logical group — clause reorder preserves AST structure", () => {
	it("reordering and-clauses produces a clause array in the new order", () => {
		const a = eq(prop("patient", "x"), literal(1));
		const b = eq(prop("patient", "y"), literal(2));
		const c = eq(prop("patient", "z"), literal(3));

		// Initial: [a, b, c]
		const original = and(a, b, c);
		expect(original.kind).toBe("and");
		expect(original.clauses).toEqual([a, b, c]);

		// Reorder to [c, a, b] — equivalent to dragging `c` to
		// position 0. The card editor's `onDrop` constructs a new
		// `and(...)` with the rearranged list; the result is the
		// canonical envelope per the reductions module.
		const reordered = and(c, a, b);
		expect(reordered.kind).toBe("and");
		expect(reordered.clauses).toEqual([c, a, b]);
		// Reordering preserves clause references — same a / b / c
		// references appear in the new envelope's clauses.
		expect(reordered.clauses[0]).toBe(c);
		expect(reordered.clauses[1]).toBe(a);
		expect(reordered.clauses[2]).toBe(b);
	});

	it("reordering or-clauses produces a clause array in the new order", () => {
		const a = eq(prop("patient", "x"), literal(1));
		const b = eq(prop("patient", "y"), literal(2));
		const reordered = or(b, a);
		expect(reordered.kind).toBe("or");
		expect(reordered.clauses).toEqual([b, a]);
	});
});

describe("logical group — boolean-algebra reductions", () => {
	// The seven reductions documented in `lib/domain/predicate/reduction.ts`:
	//   - and([]) → match-all
	//   - or([])  → match-none
	//   - and([x]) → x
	//   - or([x])  → x
	//   - not(match-all) → match-none
	//   - not(match-none) → match-all
	//   - not(not(x)) → x
	//
	// Sentinels INSIDE multi-clause and/or lists are NOT dropped
	// or absorbed by the reductions — the canonical shape preserves
	// the literal clause list. The assertion locks the contract so
	// a regression that adds an absorbing-element rewrite is caught
	// here rather than silently changing AST shape.

	it("multi-clause and with a sentinel in the middle keeps the clause list verbatim", () => {
		const a = eq(prop("patient", "x"), literal(1));
		const b = eq(prop("patient", "y"), literal(2));
		const result = and(a, matchAll(), b);
		expect(result.kind).toBe("and");
		if (result.kind === "and") {
			// All three clauses are preserved — the reductions module
			// does NOT collapse identity / absorbing elements inside
			// a multi-clause list. Authors who want a flat list build
			// it via the SA tool surface or by editing each clause.
			expect(result.clauses.length).toBe(3);
			expect(result.clauses[0]).toBe(a);
			expect(result.clauses[1].kind).toBe("match-all");
			expect(result.clauses[2]).toBe(b);
		}
	});

	it("and([only-match-all]) collapses to match-all (single-clause unwrap)", () => {
		// A single-clause and reduces to the inner clause; that
		// clause being match-all means the result is match-all.
		const reduced = and(matchAll());
		expect(reduced.kind).toBe("match-all");
	});

	it("or([only-match-none]) collapses to match-none (single-clause unwrap)", () => {
		const reduced = or(matchNone());
		expect(reduced.kind).toBe("match-none");
	});

	it("multi-clause or with sentinels keeps the clause list verbatim", () => {
		const a = eq(prop("patient", "x"), literal(1));
		const result = or(matchNone(), a);
		expect(result.kind).toBe("or");
		if (result.kind === "or") {
			expect(result.clauses.length).toBe(2);
		}
	});
});

describe("logical group — clause removal collapses correctly", () => {
	it("removing one clause from and(a, b) produces just `a`", () => {
		const a = eq(prop("patient", "x"), literal(1));
		// Simulate the card editor's removeClause: filter out one
		// clause and re-construct via the builder. The single-
		// clause unwrap is the reduction's contract — `and(a)`
		// returns `a` referentially.
		const remaining = and(a);
		expect(remaining).toBe(a);
	});

	it("removing both clauses from and(a, b) leaves match-all", () => {
		// The card editor's removeClause callback emits match-all
		// when the clause list empties — match-all is the
		// conjunction's identity, mirroring `and()` reducing to
		// match-all.
		const empty = and();
		expect(empty.kind).toBe("match-all");
	});

	it("removing both clauses from or(a, b) leaves match-none", () => {
		const empty = or();
		expect(empty.kind).toBe("match-none");
	});
});

describe("logical group — not reductions", () => {
	it("not(not(x)) collapses via double-negation elimination (referential equality)", () => {
		const x = eq(prop("patient", "status"), literal("active"));
		const inner = not(x);
		expect(inner.kind).toBe("not");
		const collapsed = not(inner);
		// Double-negation returns the original reference, not just
		// a structurally-equal copy.
		expect(collapsed).toBe(x);
	});

	it("not(match-all) collapses to match-none", () => {
		expect(not(matchAll()).kind).toBe("match-none");
	});

	it("not(match-none) collapses to match-all", () => {
		expect(not(matchNone()).kind).toBe("match-all");
	});
});

describe("logical group — drag handle wiring", () => {
	it("grip button mounts on each clause inside an and-group", () => {
		// Two clauses → both are draggable rows inside the group.
		const value = and(
			eq(prop("patient", "x"), literal(1)),
			eq(prop("patient", "y"), literal(2)),
		);
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		// The grip button is rendered by `CardShell` whenever a
		// `dragHandleRef` prop is threaded — `LogicalGroupCard`
		// passes one for every clause inside an and/or group.
		// The label is the grip's `aria-label`.
		const grips = container.querySelectorAll(
			'button[aria-label="Reorder card"]',
		);
		expect(grips.length).toBe(2);
	});

	it("no grip button on a top-level (non-grouped) card", () => {
		// A bare `eq` predicate at the root has no group around it,
		// so no clause-level drag affordance.
		const value = eq(prop("patient", "x"), literal(1));
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const grips = container.querySelectorAll(
			'button[aria-label="Reorder card"]',
		);
		expect(grips.length).toBe(0);
	});

	it("no grip button on a card inside a not wrapper", () => {
		// `not.clause` is a single-clause slot — no reorder affordance.
		const value = not(eq(prop("patient", "x"), literal(1)));
		const { container } = render(
			<PredicateCardEditor
				value={value}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
			/>,
		);
		const grips = container.querySelectorAll(
			'button[aria-label="Reorder card"]',
		);
		expect(grips.length).toBe(0);
	});
});
