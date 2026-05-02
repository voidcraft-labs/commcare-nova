// lib/domain/predicate/__tests__/reduction.test.ts
//
// Acceptance tests for the predicate reduction module. The seven
// reductions (`and([])` → `match-all`, `or([])` → `match-none`,
// single-clause unwrap for both, double-negation collapse, and the two
// `not(sentinel)` collapses) are construction-time normalizers wired
// into the `and` / `or` / `not` builders. Tests here pin each
// reduction independently — the integration check that the builders
// actually call the reductions lives in `builders.test.ts`.
//
// `reduceAnd` / `reduceOr` / `reduceNot` return `undefined` when no
// reduction applies; the caller (a builder or other consumer) falls
// through to the standard n-ary construction. The undefined return is
// the "no canonical-form rewrite available — proceed with the literal
// shape" signal, NOT an error condition. The convention lets the
// builder code stay branch-light (one `if (reduced !== undefined)
// return reduced;` per builder) instead of duplicating the
// reduction's structural match.

import { describe, expect, it } from "vitest";
import { eq, literal, matchAll, matchNone, not, prop } from "../builders";
import { reduceAnd, reduceNot, reduceOr } from "../reduction";

describe("reduceAnd", () => {
	it("collapses empty clause list to the match-all sentinel", () => {
		// Empty conjunction is the boolean-algebra identity element —
		// `and()` over zero clauses evaluates trivially to true. The
		// canonical AST shape for "always true" is `match-all`, so the
		// reduction returns the sentinel rather than relying on a
		// schema-rejected `{ kind: "and", clauses: [] }`.
		expect(reduceAnd([])).toEqual(matchAll());
	});

	it("unwraps a single-clause input to the clause itself", () => {
		// `and(x)` with one clause is semantically identity — it adds
		// no constraint beyond `x`. The reduction unwraps so consumers
		// reading the reduced shape see `x` directly rather than a
		// no-op `{ kind: "and", clauses: [x] }` envelope. The test
		// uses a real predicate (an `eq`) rather than `matchAll()` so
		// the unwrap is visible in the assertion.
		const x = eq(prop("patient", "status"), literal("open"));
		expect(reduceAnd([x])).toBe(x);
	});

	it("returns undefined when two or more clauses are present (no reduction applies)", () => {
		// Two-or-more clauses is the standard n-ary `and` shape —
		// no reduction applies, and the caller falls through to the
		// standard construction. Returning `undefined` (rather than
		// a synthesized `and` shape) keeps this module a pure
		// reducer — building the literal shape is the builder's job.
		const a = eq(prop("patient", "status"), literal("open"));
		const b = eq(prop("patient", "age"), literal(18));
		expect(reduceAnd([a, b])).toBeUndefined();
	});
});

describe("reduceOr", () => {
	it("collapses empty clause list to the match-none sentinel", () => {
		// Empty disjunction is the boolean-algebra absorbing element
		// — `or()` over zero clauses evaluates trivially to false.
		// The canonical AST shape for "always false" is `match-none`,
		// so the reduction returns the sentinel.
		expect(reduceOr([])).toEqual(matchNone());
	});

	it("unwraps a single-clause input to the clause itself", () => {
		// Symmetric with `reduceAnd`'s single-clause case — `or(x)`
		// with one clause is identity, so the reduction unwraps.
		const x = eq(prop("patient", "status"), literal("open"));
		expect(reduceOr([x])).toBe(x);
	});

	it("returns undefined when two or more clauses are present (no reduction applies)", () => {
		const a = eq(prop("patient", "status"), literal("open"));
		const b = eq(prop("patient", "age"), literal(18));
		expect(reduceOr([a, b])).toBeUndefined();
	});
});

describe("reduceNot", () => {
	it("collapses not(match-all) to match-none", () => {
		// `match-all` is the boolean-algebra identity for `and` and the
		// universal-true predicate; its negation is universal-false,
		// the canonical `match-none` sentinel. The reduction lets
		// algebraic simplifications produce sentinel forms directly.
		expect(reduceNot(matchAll())).toEqual(matchNone());
	});

	it("collapses not(match-none) to match-all", () => {
		// Symmetric with the previous case — `match-none` is universal-
		// false and its negation is universal-true.
		expect(reduceNot(matchNone())).toEqual(matchAll());
	});

	it("collapses not(not(x)) to x (double-negation elimination)", () => {
		// Double-negation elimination is one of the foundational
		// boolean-algebra identities. `reduceNot(inner)` represents
		// the reduction of a notional `not(inner)` wrap — i.e. the
		// caller passes the predicate they want to negate, and the
		// reducer returns the canonical form of the negation. So
		// when `inner` is itself a `not(x)`, the notional outer
		// `not(not(x))` collapses to `x`. The assertion `toBe(x)`
		// (referential equality) confirms the inner clause flows
		// through unchanged — no clone, no rewrap.
		const x = eq(prop("patient", "status"), literal("open"));
		const innerNot = not(x);
		expect(reduceNot(innerNot)).toBe(x);
	});

	it("returns undefined for a non-collapsing inner predicate (no reduction applies)", () => {
		// `not(eq(...))` has no canonical reduction — the negation is
		// the natural shape. The reducer returns `undefined` to signal
		// "no reduction; fall through to standard `not` construction."
		const inner = eq(prop("patient", "status"), literal("open"));
		expect(reduceNot(inner)).toBeUndefined();
	});
});
