// lib/commcare/expression/index.ts
//
// Public surface of the CommCare-side value-expression emitter
// package. ValueExpression ASTs originate in `lib/domain/predicate`
// (the `ValueExpression` discriminated union shares the predicate
// module because predicates are themselves expressions of boolean
// type) and cross the domain → CommCare boundary here at wire-
// emission time.
//
// The package's two emitters cover the two on-CCHQ wire dialects a
// value expression compiles to:
//
//   - `emitOnDeviceExpression(expr)` produces the on-device XPath
//     dialect, usable in any on-device value slot — calculated
//     columns, sort keys, late-flag arguments, ID-mapping sources,
//     search-input defaults, the conditional-clause branches inside
//     a predicate's `if` / `switch`. The emitter is total: every arm
//     of `ValueExpression` produces a wire string with no structural
//     rejection.
//   - `emitCsqlExpressionSegments(expr)` produces the CSQL dialect
//     value emission as a `CsqlSegment[]`. The emitter handles the
//     eight arms in CCHQ's CSQL value-function whitelist; the
//     remaining seven arms lift in the predicate-side hoist pass
//     before this emitter ever sees them, and reaching one of those
//     arms here throws defensively. The segment-list IR — not a
//     stringified concat-wrap — is the contract because the wire-
//     emission consumer composes the segments with its own
//     surrounding constants (the predicate emitter joins comparison
//     operators; the concat-wrap layer at
//     `lib/commcare/predicate/csqlEmitter.ts` lifts each segment to a
//     separate `concat(...)` argument).
//
// The CSQL emitter's segment-list IR (`CsqlSegment`) re-exports from
// the shared `lib/commcare/predicate/csqlSegment` module so consumers
// composing both predicate and expression emissions never have to
// learn two different segment shapes.
//
// Type-only re-exports use `export type` so consumers paying
// attention to TypeScript's `verbatimModuleSyntax` don't pull a
// runtime import for a type-only reference.

export type { CsqlSegment } from "../predicate/csqlSegment";
export { emitCsqlExpressionSegments } from "./csqlEmitter";
export { emitOnDeviceExpression } from "./onDeviceEmitter";
