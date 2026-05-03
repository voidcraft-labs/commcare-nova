// lib/case-store/sql/index.ts
//
// Public barrel for the case-store SQL package — the AST → Kysely
// compiler stack that lowers Predicate / ValueExpression / RelationPath
// nodes into typed-builder calls Postgres executes natively.
//
// ## Three compilers, one composition contract
//
// The package owns four compiler modules whose dispatch surfaces fan
// out from a single shared compile-context shape:
//
//   - `compileTerm` (term arm) — leaf-level value reads. JSONB
//     property reads with per-`data_type` casts, scalar-column reads
//     for the four reserved columns (`case_id` / `case_type` /
//     `owner_id` / `status`), parameter-bound runtime bindings
//     (`input` / `session-user` / `session-context`), and correlated
//     scalar subqueries for non-self via reads.
//   - `compileExpression` (value-expression arm) — value-bearing
//     composition (arith / concat / coalesce / if / switch /
//     count / format-date / today / now / date-coerce /
//     datetime-coerce / double / date-add / unwrap-list-defensive-
//     throw). Carries an optional `compilePredicate` thunk on its
//     context so the `if.cond` / `count.where` arms recurse back
//     through the predicate compiler without producing an import
//     cycle.
//   - `compilePredicate` (boolean arm) — boolean composition
//     (sentinels / logical / comparison / membership / between /
//     multi-select / match / within-distance / exists / missing /
//     when-input-present / is-null / is-blank). Routes every
//     widened `ValueExpression` operand through one shared
//     `compileValueExprOperand` dispatch (term arm → `compileTerm`;
//     non-term arm → `compileExpression` with the thunk-wired
//     context) so the compiler stays single-source for its dispatch
//     contract.
//   - `compileRelationPath` (relation-walk arm) — `case_indices` +
//     `cases` join chains with depth-suffixed leaf aliases for
//     nested non-self walks. Self paths collapse to a degenerate
//     marker; every other arm produces an aliased subquery the caller
//     joins in.
//
// The shared compile-context shape (`TermCompileContext`) carries the
// Kysely instance, the tenant pair, the anchor alias, the schema map,
// the runtime bindings, and the relation-walk depth counter; every
// compiler reads its own subset and forwards the rest unchanged into
// downstream calls. Predicate-compile context is identical to term
// context (no extra fields); expression-compile context extends it
// with the `compilePredicate` thunk.
//
// `compileLiteral` and `dataTypeTokens` are package-internal sibling
// modules. `compileLiteral` is consumed by both the term compiler's
// `literal` arm and the predicate compiler's `in.values` arm;
// `dataTypeTokens` owns the two `Record<CasePropertyDataType,
// <Postgres-token>>` tables (`POSTGRES_CAST_FOR_DATA_TYPE` and the
// internal `JSONB_READ_OPERATOR_FOR_DATA_TYPE`) that compileTerm
// and compileLiteral both read. Three sibling compiler modules of
// equal weight import from one shared data module — no compiler
// imports from another compiler's internals. Outside callers route
// literal emission through the term compiler (the `Literal` arm of
// the `Term` discriminated union), so `compileLiteral` is not
// re-exported here. `POSTGRES_CAST_FOR_DATA_TYPE` IS re-exported
// (callers composing externally-supplied expressions thread the
// cast token through call sites that need to lift their operand
// into the typed Postgres value the comparison expects).
//
// ## Tenant-scope contract (callers must apply outer-query filter)
//
// None of the dispatch entry points emit the outer-query
// `(app_id = $1 AND owner_id = $2)` tenant filter. The caller that
// emits the `selectFrom('cases as c')` and the corresponding
// `where('c.app_id', '=', appId).where('c.owner_id', '=', ownerId)`
// owns that filter. The compiler stack only emits its filter on every
// JOIN-ed `cases` row inside `compileRelationPath`'s subquery body —
// so a relation walk carries its own tenant defense, but the outer
// scan does not.
//
// ## Postgres-strict null semantics (locked invariant)
//
// `is-null` and `is-blank` distinguish three states at the data-
// model layer: "key absent in JSONB document", "key present with
// JSON null", "key present with empty string". `is-null` matches
// strict-absent only; `is-blank` widens to absent-or-empty. CCHQ's
// wire layer collapses all three states into one match set; Postgres
// distinguishes them natively via `properties ? 'key'` (key
// existence) and `properties->>'key' IS NULL` / `= ''` (value
// shape). The strict semantic is the AST's contract; this compiler
// emits the strict SQL and round-trip tests pin the four distinct
// cases (per `compilePredicate.harness.test.ts`'s null/blank suite).
//
// ## What this barrel does NOT export
//
// Internal dispatch helpers and package-internal data tables stay
// private to their owning modules:
//
//   - `compileLiteral` — sibling helper consumed by both the term
//     compiler's `literal` arm and the predicate compiler's
//     `in.values` arm; outside callers consume literals through the
//     term compiler.
//   - `JSONB_READ_OPERATOR_FOR_DATA_TYPE` — the `data_type` →
//     JSONB-read-operator (`->>` / `->`) mapping on `dataTypeTokens`.
//     Read only by `compileTerm`'s `jsonbColumnRead`; outside callers
//     route property reads through `compileTerm` rather than
//     constructing a JSONB read directly.
//   - `compileValueExprOperand`, `expressionContextFor` — internal
//     dispatch helpers in `compilePredicate` that route widened
//     operands and lift the predicate-compile context into an
//     expression-compile context. Their existence is the dispatch
//     shape, not part of the public composition contract.
//   - `DynamicExprBuilder`, `DynamicCorrelatedQuery`,
//     `DynamicCountQuery`, `DynamicExistsQuery`,
//     `AliasedExpressionLike`, `DynamicQuery`, `DynamicSelection` —
//     type-erased local views that bridge runtime-derived alias /
//     column strings into Kysely's typed-builder surface. Each is
//     scoped to one compile-helper site and is not part of the
//     external composition contract.
//
// Type-only re-exports use `export type` so consumers paying
// attention to TypeScript's `verbatimModuleSyntax` don't pull a
// runtime import for a type-only reference.

// ----- Term compiler -----

export type {
	TermBindings,
	TermBindingValue,
	TermCompileContext,
} from "./compileTerm";
export { compileTerm } from "./compileTerm";

// ----- Data-type → Postgres-token tables -----

export { POSTGRES_CAST_FOR_DATA_TYPE } from "./dataTypeTokens";

// ----- Expression compiler -----

export type {
	CompilePredicateThunk,
	ExpressionCompileContext,
} from "./compileExpression";
export { compileExpression } from "./compileExpression";

// ----- Predicate compiler -----

export type { PredicateCompileContext } from "./compilePredicate";
export { compilePredicate } from "./compilePredicate";

// ----- Relation-path compiler -----

export type {
	CompiledRelationPath,
	RelationPathCompileContext,
	RelationPathLeafRow,
} from "./compileRelationPath";
export {
	compileRelationPath,
	leafAliasForDepth,
	RELATION_PATH_LEAF_ALIAS,
} from "./compileRelationPath";

// ----- Database type contract -----

export type {
	CaseIndexRelationship,
	CaseIndicesTable,
	CasesQuarantineTable,
	CasesTable,
	CaseTypeSchemasTable,
	Database,
} from "./database";
