// lib/domain/predicate/reduction.ts
//
// Construction-time reductions for the predicate AST. The seven
// reductions mirror the foundational boolean-algebra identities:
//
//   - `and([])` ≡ identity element of conjunction → `match-all`
//   - `or([])`  ≡ absorbing element of disjunction → `match-none`
//   - `and([x])` ≡ `x` (single-clause unwrap)
//   - `or([x])`  ≡ `x` (single-clause unwrap)
//   - `not(match-all)`  ≡ `match-none`
//   - `not(match-none)` ≡ `match-all`
//   - `not(not(x))` ≡ `x` (double-negation elimination)
//
// Why a separate module: the `and` / `or` / `not` builders in
// `builders.ts` call these reducers before falling through to the
// standard n-ary construction. Keeping the reduction logic in its
// own module isolates the structural-match code from the builders'
// per-arm pinning code, lets a future consumer (e.g. a UI surface
// that simplifies a filter tree on every edit) call the same
// reducers without going through the builders, and makes each
// reduction independently unit-testable. The matching test file
// pins each reduction's behavior; the integration check that the
// builders actually call the reducers lives in `builders.test.ts`.
//
// Why `undefined` for the no-reduction case: the reducers are pure
// "match-and-rewrite" functions — they return the rewritten shape
// when one of the seven identities matches and `undefined` when no
// rewrite applies. The undefined return is the explicit "fall
// through to the standard construction" signal; alternative shapes
// (returning the input unchanged, throwing, returning a result
// object) all push more branching onto the call site. Builders do
// `const reduced = reduceAnd(clauses); if (reduced !== undefined)
// return reduced;` exactly once per arm — branch-light and reads
// in one direction.
//
// Why the shapes here use the builders rather than constructing
// AST literals: `matchAll()` / `matchNone()` are the builders for
// the sentinel arms in `builders.ts`. Reusing them here keeps the
// sentinel-shape construction in one place — if the AST ever gains
// a metadata slot on the sentinel kinds, the builder change
// propagates here without further edits.

import { matchAll, matchNone } from "./builders";
import type { Predicate } from "./types";

/**
 * Reduce a logical AND clause set to its canonical form.
 *
 * Returns the `match-all` sentinel for empty input (the
 * boolean-algebra identity element of conjunction), the inner
 * clause for one-element input (single-clause `and` is identity),
 * or `undefined` for two-or-more clauses to signal "no reduction
 * applies; use the n-ary form."
 *
 * The undefined return convention lets the builder layer dispatch
 * with one branch — `const reduced = reduceAnd(clauses); if
 * (reduced !== undefined) return reduced;` — rather than
 * duplicating the structural match. See the file-level comment for
 * the full rationale.
 */
export function reduceAnd(
	clauses: readonly Predicate[],
): Predicate | undefined {
	if (clauses.length === 0) return matchAll();
	// Single-clause unwrap is the boolean-algebra identity for
	// conjunction over a single predicate. The `clauses[0]`
	// access is bounds-safe under the length === 1 guard;
	// `noUncheckedIndexedAccess` is not enabled in this project's
	// `tsconfig.json` so the indexed access narrows directly to
	// `Predicate` (rather than `Predicate | undefined`).
	if (clauses.length === 1) return clauses[0];
	return undefined;
}

/**
 * Reduce a logical OR clause set to its canonical form.
 *
 * Returns the `match-none` sentinel for empty input (the
 * boolean-algebra absorbing element of disjunction — `or()` over
 * zero clauses evaluates trivially to false), the inner clause for
 * one-element input (single-clause `or` is identity), or
 * `undefined` for two-or-more clauses. Symmetric with `reduceAnd`
 * — same shape, same undefined-on-no-reduction contract.
 */
export function reduceOr(clauses: readonly Predicate[]): Predicate | undefined {
	if (clauses.length === 0) return matchNone();
	if (clauses.length === 1) return clauses[0];
	return undefined;
}

/**
 * Reduce a logical NOT to its canonical form.
 *
 * Three reductions apply: `not(match-all)` collapses to
 * `match-none`, `not(match-none)` collapses to `match-all`, and
 * `not(not(x))` collapses to `x` (double-negation elimination).
 * Returns `undefined` for any other inner predicate, signaling
 * "no reduction applies; use the standard `{ kind: "not", clause:
 * inner }` shape."
 *
 * The double-negation case reads `inner.clause` — the schema's
 * `notSchema` declares the wrapped predicate as `clause` (see
 * `lib/domain/predicate/types.ts:1568-1571`).
 */
export function reduceNot(inner: Predicate): Predicate | undefined {
	if (inner.kind === "match-all") return matchNone();
	if (inner.kind === "match-none") return matchAll();
	// Double-negation elimination: `not(not(x))` → `x`. The inner
	// shape is `{ kind: "not", clause: <Predicate> }`, so the
	// returned value is the doubly-wrapped predicate. The reducer
	// returns the predicate by reference (no clone) — the caller
	// receives the same object the AST already owned, which is
	// safe because the AST is treated as immutable everywhere
	// downstream.
	if (inner.kind === "not") return inner.clause;
	return undefined;
}
