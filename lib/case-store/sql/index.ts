// lib/case-store/sql/index.ts
//
// Public barrel for the case-store SQL package. The compiler stack
// lowers `Predicate` / `ValueExpression` / `RelationPath` AST nodes
// into Kysely typed-builder calls Postgres executes natively. Four
// entry points compose through one shared dispatch shape:
// `compilePredicate` recurses back into itself via `compileExpression`'s
// thunk-wired `compilePredicate` callback (the cycle break that lets
// `if.cond` / `count.where` reach the predicate compiler without
// producing an import cycle); `compileTerm` and `compileRelationPath`
// are leaves the higher-order compilers call into.
//
// Tenant-scope contract: callers emit the outer-query
// `(app_id = $1 AND owner_id = $2)` filter; the compiler stack only
// emits its filter on every JOIN-ed `cases` row inside
// `compileRelationPath`'s subquery body.
//
// `compileLiteral` and the type-erased `Dynamic*` views stay
// package-private — callers route through the public entry points.
// `POSTGRES_CAST_FOR_DATA_TYPE` IS re-exported because external
// compile sites composing against externally-supplied expressions
// thread the cast token through their own call sites.
// `expressionContextFor` is exposed because the case store's
// sort-expression compile site reuses the thunk-wired lift.
//
// `export type` for type-only re-exports so consumers honoring
// `verbatimModuleSyntax` don't pull a runtime import.

export type {
	CompilePredicateThunk,
	ExpressionCompileContext,
} from "./compileExpression";
export { compileExpression } from "./compileExpression";
export type { PredicateCompileContext } from "./compilePredicate";
export { compilePredicate, expressionContextFor } from "./compilePredicate";
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
export type {
	FormFieldBindingValue,
	TermBindings,
	TermBindingValue,
	TermCompileContext,
} from "./compileTerm";
export { compileTerm } from "./compileTerm";
export type {
	CaseIndexRelationship,
	CaseIndicesTable,
	CasesTable,
	CaseTypeSchemasTable,
	Database,
	JsonObject,
	JsonPrimitive,
	JsonValue,
	ParkedCaseValuesTable,
} from "./database";
export { POSTGRES_CAST_FOR_DATA_TYPE } from "./dataTypeTokens";
