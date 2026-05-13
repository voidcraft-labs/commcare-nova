// lib/domain/predicate/reduction.ts
//
// Construction-time reductions for the predicate AST. The reductions
// are deliberately scoped to the empty / single-clause / double-
// negation identities — the cases where the canonical form is the
// only sensible representation. Multi-clause `and` / `or` lists
// preserve sentinels and nested same-kind clauses verbatim:
//
//   - `and([])` ≡ identity element of conjunction → `match-all`
//   - `or([])`  ≡ absorbing element of disjunction → `match-none`
//   - `and([x])` ≡ `x` (single-clause unwrap)
//   - `or([x])`  ≡ `x` (single-clause unwrap)
//   - `not(match-all)`  ≡ `match-none`
//   - `not(match-none)` ≡ `match-all`
//   - `not(not(x))` ≡ `x` (double-negation elimination)
//
// What the reducers DO NOT do (intentional non-coverage): flatten
// nested `and` / `or` clauses, drop identity sentinels from multi-
// clause lists, or short-circuit on absorbing sentinels in multi-
// clause lists. Authors compose ASTs progressively through the
// builder layer and editor surfaces — a multi-clause `and` whose
// middle element is a `match-all` is a meaningful intermediate
// editing state, not noise to collapse. The wire emitters faithfully
// emit whatever the builder constructed; CCHQ's runtime evaluates
// `true() and X` as `X` natively, so the wire passes through the
// extra sentinel without runtime cost.
//
// Why a separate module: the `and` / `or` / `not` builders in
// `builders.ts` call these reducers before falling through to the
// standard n-ary construction. Keeping the reduction logic in its
// own module isolates the structural-match code from the builders'
// per-arm pinning code, makes each reduction independently unit-
// testable, and keeps the reducers independent of the builders so a
// non-builder consumer (e.g. a UI surface that simplifies a filter
// tree on every edit) can apply them directly without going through
// the builder layer. The matching test file pins each reduction's
// behavior; the integration check that the builders actually call
// the reducers lives in `builders.test.ts`.
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
// Why inline sentinel literals (rather than calling `matchAll()` /
// `matchNone()` from `builders.ts`): this module sits below
// `builders.ts` in the dependency graph — the builders import the
// reducers and call them at construction time. A reverse import
// (reducers calling sentinel builders) would create a cycle: it
// happens to work today only because `matchAll` / `matchNone` are
// `function` declarations and so fully hoisted, but rewriting either
// as a `const` arrow function (the project's modern idiom for thin
// helpers, e.g. `comparison` in `builders.ts`) would either throw
// `ReferenceError` at module init or, worse, silently return
// `undefined` from the reducer and bypass the schema's non-empty
// tuple guard. Biome has no cycle detector, so nothing would catch
// the regression.
//
// The inline form keeps this module zero-import on the predicate
// package except for the `Predicate` type — the cleanest dependency
// shape and the one that survives any rewrite of the builders'
// helper style. The sentinel kinds are discriminator-only by design
// (the schema declares them as `z.object({ kind: z.literal("match-
// all") })`), so the literal carries no payload that could drift
// across modules. If a metadata slot is ever added to a sentinel
// kind, the inline literal here fails typecheck with a missing-
// field error and the divergence is caught at compile time — the
// same protection the cyclic call would have offered, without the
// runtime cycle.

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
 * Multi-clause lists are preserved verbatim — the reducer does NOT
 * flatten nested `and` clauses, drop `match-all` identity clauses,
 * or short-circuit on `match-none` absorbing clauses. See the
 * file-level comment for the editor-state-preservation rationale.
 *
 * The undefined return convention lets the builder layer dispatch
 * with one branch — `const reduced = reduceAnd(clauses); if
 * (reduced !== undefined) return reduced;` — rather than
 * duplicating the structural match.
 */
export function reduceAnd(
	clauses: readonly Predicate[],
): Predicate | undefined {
	if (clauses.length === 0) return { kind: "match-all" };
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
 * — same shape, same undefined-on-no-reduction contract, same
 * multi-clause-list-preservation policy.
 */
export function reduceOr(clauses: readonly Predicate[]): Predicate | undefined {
	if (clauses.length === 0) return { kind: "match-none" };
	if (clauses.length === 1) return clauses[0];
	return undefined;
}

/**
 * Reduce a logical NOT to its canonical form. The parameter `clause`
 * represents the predicate being negated — i.e. the reducer returns
 * the canonical form of the notional `not(clause)` wrap. The name
 * mirrors the builder's `not(clause: Predicate)` signature so the
 * reduction reads as "reduce the NOT of this clause" at every call
 * site.
 *
 * Three reductions apply: `not(match-all)` collapses to
 * `match-none`, `not(match-none)` collapses to `match-all`, and
 * `not(not(x))` collapses to `x` (double-negation elimination — the
 * `clause` parameter is itself a `{ kind: "not", clause: x }` shape,
 * so the reduction unwraps to `x`). Returns `undefined` for any
 * other clause shape, signaling "no reduction applies; use the
 * standard `{ kind: "not", clause }` shape."
 *
 * The double-negation case reads `clause.clause` — see `notSchema`
 * in `types.ts`, which declares the wrapped predicate as `clause`.
 */
export function reduceNot(clause: Predicate): Predicate | undefined {
	if (clause.kind === "match-all") return { kind: "match-none" };
	if (clause.kind === "match-none") return { kind: "match-all" };
	// Double-negation elimination: `not(not(x))` → `x`. The
	// passed-in clause is itself a `{ kind: "not", clause: <inner> }`
	// shape, so the returned value is the inner predicate the outer
	// `not` would have wrapped twice. The reducer returns the
	// predicate by reference (no clone) — the caller receives the
	// same object the AST already owned, which is safe because the
	// AST is treated as immutable everywhere downstream.
	if (clause.kind === "not") return clause.clause;
	return undefined;
}
