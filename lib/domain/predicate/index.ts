// lib/domain/predicate/index.ts
//
// Public barrel for the predicate AST package. Two AST families plus
// every supporting surface live in one package because they
// structurally compose: every Predicate node IS a ValueExpression
// (the boolean-typed arm), and ValueExpression's `if` / `switch` /
// `count` arms carry Predicate operands. Splitting the families into
// sibling packages would force a cross-package `z.lazy` to resolve
// the cross-cycle recursion; one shared package lets the two unions
// reach each other through intra-file `z.lazy` (the canonical Zod
// pattern for self-recursion through discriminated unions).
//
// ## What lives here
//
//   - **AST type definitions** (`./types`) — `predicateSchema` /
//     `valueExpressionSchema` discriminated unions, `Term` (the leaf
//     family covering property reads, search-input refs, session-user
//     refs, session-context refs, and literals), `RelationPath` (self
//     / ancestor / subcase / any-relation), every per-arm operand
//     constant (`COMPARISON_KINDS` / `MATCH_MODES` /
//     `MULTI_SELECT_QUANTIFIERS` / `DISTANCE_UNITS` / `ARITH_OPS` /
//     `DATE_ADD_INTERVALS` / `FORMAT_DATE_PRESETS` /
//     `SESSION_CONTEXT_FIELDS`), and the validation patterns
//     (`CASE_TYPE_PATTERN` / `CASE_PROPERTY_PATTERN` /
//     `XML_ELEMENT_NAME_PATTERN`).
//   - **Construction builders** (`./builders`) — typed helpers
//     covering every AST arm (`eq` / `neq` / `gt` / `lt` / `gte` /
//     `lte` / `and` / `or` / `not` / `match` / `multiSelectAny` /
//     `multiSelectAll` / `within` / `between` / `isIn` / `isNull` /
//     `isBlank` / `exists` / `missing` / `whenInput` / `matchAll` /
//     `matchNone` / `term` / `today` / `now` / `dateAdd` /
//     `dateCoerce` / `datetimeCoerce` / `double` / `arith` / `concat`
//     / `coalesce` / `ifExpr` / `switchExpr` / `switchCase` / `count`
//     / `unwrapList` / `formatDate` / `prop` / `input` / `sessionUser`
//     / `sessionContext` / `literal` / `dateLiteral` /
//     `datetimeLiteral` / `timeLiteral` / `relationStep` / `selfPath`
//     / `ancestorPath` / `subcasePath` / `anyRelationPath`). Builders
//     auto-wrap Term-shaped operands at every widened slot through
//     `toValueExpression` so call-sites can mix Term and
//     ValueExpression arguments interchangeably.
//   - **Type checker** (`./typeChecker`) — `checkPredicate(...)` /
//     `checkExpression(...)` validate a constructed AST against the
//     case-type schema and the search-input declaration list. The
//     checker resolves every term's data type via `resolveTermType`,
//     enforces the per-operator type-compatibility rules, and emits
//     `CheckError[]` keyed by `CheckPath`. `checkRelationPath` walks
//     the relation graph and `checkInDestinationScope` enforces the
//     destination-scope contract on `where`-clause property reads.
//     `ResolvedType` / `ANY_TYPE` / `SEQUENCE_TYPE` / `ORDERED_TYPES`
//     are the type-system primitives the checker drives.
//   - **JSON Schema generator** (`./jsonSchema`) — produces a
//     `CaseTypeJsonSchema` document from a `CaseType` that the case-
//     store's write-time validator runs against (both the application-
//     layer pre-write check and the defense-in-depth Postgres
//     trigger).
//   - **Reduction module** (`./reduction`) — boolean-algebra
//     simplifications (`reduceAnd` / `reduceOr` / `reduceNot`) that
//     the construction builders apply at construction time so an
//     `and([])` reduces to `match-all`, `or([single])` reduces to
//     `single`, `not(not(x))` reduces to `x`, etc.
//
// ## Why two families share one package
//
// Every Predicate node IS a ValueExpression (the boolean-typed arm
// of the broader expression family) — a comparison, a logical join,
// a sentinel: each resolves to a boolean value. Conversely, the
// expression family's conditional arms (`if.cond`, `switch` doesn't
// because its dispatch is literal-driven, `count.where`) carry
// Predicate operands. Splitting the two unions into sibling packages
// forces a cross-package `z.lazy` to resolve every cross-cycle edge,
// which Zod doesn't ergonomically support across module boundaries.
// One shared package lets both unions reach each other through
// intra-file `z.lazy`.
//
// ## Wire-emission boundary
//
// This package is the source of truth for the AST shape; consumers
// emit to wire formats from here:
//
//   - On-device XPath dialect via `lib/commcare/predicate` and
//     `lib/commcare/expression`'s `emitOnDeviceExpression`.
//   - CSQL dialect via the same packages' `emitCsql` /
//     `emitCsqlExpressionSegments`, with a hoist pass at
//     `lib/commcare/predicate/csqlHoist.ts` that lifts non-CSQL-
//     grammar nodes into on-device wrappers.
//   - Postgres SQL via `lib/case-store/sql`'s compiler stack
//     (`compilePredicate` / `compileExpression` / `compileTerm` /
//     `compileRelationPath`).
//
// All three wire targets consume the same AST. The type checker runs
// against the AST before any wire emission, so a typed AST is the
// single contract every consumer trusts.
//
// ## File map
//
//   - `./types`        — Zod schemas, type aliases, every per-arm
//                        operand constant, validation patterns
//   - `./builders`     — typed construction helpers (auto-wrap
//                        Term-vs-ValueExpression at widened slots)
//   - `./typeChecker`  — `checkPredicate` / `checkExpression` /
//                        `checkRelationPath` / `checkInDestinationScope`
//                        / `resolveTermType` / `literalType` /
//                        `typesCompatible` / `describe` /
//                        `ResolvedType` + sentinels
//   - `./jsonSchema`   — `caseTypeToJsonSchema` for the case-store
//                        write-time validator
//   - `./reduction`    — `reduceAnd` / `reduceOr` / `reduceNot`
//                        invariants the builders apply
//   - `./rewrite`      — `renameCasePropertyInPredicate` /
//                        `renameCasePropertyInExpression` /
//                        `relationDestinationCaseType` — structural
//                        case-property rename over stored ASTs
//
// ## Wholesale re-export rationale
//
// Each sibling module already curates its export surface — types,
// builders, the type checker, the JSON Schema generator, and the
// reduction module each export only the names callers depend on.
// Re-exporting wholesale (`export *`) keeps the barrel low-friction:
// adding a new builder, a new type-checker helper, or a new
// reduction rule does not require a parallel edit here. The verbose
// per-name list in this file's documentation block is the
// inventory; the runtime re-export delegates to each module's own
// curation.

export * from "./builders";
export * from "./errors";
export * from "./jsonSchema";
export * from "./reduction";
export * from "./rewrite";
export * from "./slotConstraints";
export * from "./typeChecker";
export * from "./types";
export * from "./walk";
