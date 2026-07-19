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
//     ElasticSearch on the CCHQ server. The emitter runs the shared narrow
//     predicate-subject lowering and then CSQL's relation-read grammar adapter,
//     before it
//     walks the lifted AST emitting a `concat(...)` wrapper. Non-
//     grammar value expressions (`if`, `switch`, `arith`, `concat`,
//     `coalesce`, `format-date`, ancestor / any-relation `count`, and
//     `count` outside the comparison-LHS subcase position) inline as
//     runtime on-device XPath fragments inside the concat — the
//     canonical CCHQ pattern documented at
//     `commcare-hq/docs/case_search_query_language.rst`. No sibling
//     `<data>` slots are produced; the result is a single wrapper
//     string the wire layer drops into `<data key="_xpath_query">`.
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
export type {
	CsqlRepresentabilityIssue,
	CsqlRepresentabilityReason,
} from "./csqlRepresentability";
export {
	checkCsqlRepresentability,
	normalizeCsqlPredicate,
} from "./csqlRepresentability";
export {
	type CsqlOnDeviceNodeVisitor,
	walkCsqlOnDeviceNodes,
} from "./csqlRuntimeWalk";
export {
	collectRuntimeGeopointInputNames,
	isValidStaticGeopointCenter,
} from "./geopoint";
export {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "./instances";
export { collectRuntimeCsqlStringInputNames } from "./runtimeCsqlQuoteSafety";
export type { WireDialect } from "./stringQuoting";
export { formatNumeric, quoteIdentifier, quoteLiteral } from "./stringQuoting";
