// lib/commcare/predicate/index.ts
//
// Public surface of the CommCare-side predicate emitter package.
// Predicate ASTs originate in `lib/domain/predicate` and cross the
// domain → CommCare boundary here at wire-emission time. The package
// exposes one emitter per CommCare wire dialect plus the lexical
// helpers that both emitters share, so callers never reach into the
// per-dialect implementation files.
//
// The package's two emitters cover the two on-CCHQ wire dialects a
// predicate compiles to:
//
//   - `emitCaseListFilter(predicate)` produces the on-device XPath
//     dialect, usable in both the case-list `<detail nodeset>` slot
//     and the post-ElasticSearch `<search_filter>` slot. Both slots
//     run on the same on-device evaluator, so a single emitter covers
//     both surfaces; the wire-routing layer drops the same string into
//     whichever slot the consumer needs.
//   - `emitCsql(predicate)` produces the CSQL dialect evaluated by
//     ElasticSearch on the CCHQ server. The emitter runs a total
//     hoist pass first, lifting non-grammar value expressions
//     (`if` / `switch` / `arith` / `concat` / `coalesce` /
//     `format-date` / non-comparison-LHS `count`) into on-device
//     wrapper expressions and replacing each with a synthetic
//     search-input ref. The result carries both the `concat(...)` XPath
//     wrapper and the wrapper-expression list the wire layer threads
//     into the enclosing form's `<data>` section before the CSQL data
//     element.
//
// `hoistForCsql` is intentionally not re-exported here. `emitCsql`
// already returns the wrapper-expression list in its
// `CsqlEmissionResult.hoists` field, so consumers that want the
// hoisted shape read it from the emit result rather than running the
// hoist pass standalone. Re-exporting `hoistForCsql` would invite a
// double-walk where a caller scans, discards the hoisted predicate,
// then calls `emitCsql` which re-scans — keeping the function package-
// private constrains callers to the supported single-call shape.
//
// Lexical helpers (`quoteLiteral` / `quoteIdentifier` /
// `formatNumeric`) flow out of `./stringQuoting` so any consumer that
// needs to embed a value in a hand-built CommCare wire string (the
// expression emitters in `lib/commcare/expression`, future per-slot
// builders) can reuse the same per-dialect escape strategy as the
// predicate emitters. `WireDialect` is the discriminator they branch
// on.
//
// Type-only re-exports use `export type` so consumers paying attention
// to TypeScript's `verbatimModuleSyntax` don't pull a runtime import
// for a type-only reference.

export { emitCaseListFilter } from "./caseListFilterEmitter";
export type { CsqlEmissionResult } from "./csqlEmitter";
export { emitCsql } from "./csqlEmitter";
export type { CsqlHoistResult, HoistedWrapper } from "./csqlHoist";
export {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "./instances";
export type { WireDialect } from "./stringQuoting";
export { formatNumeric, quoteIdentifier, quoteLiteral } from "./stringQuoting";
