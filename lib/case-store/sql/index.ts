// lib/case-store/sql/index.ts
//
// Public barrel for the case-store SQL package. See
// `lib/case-store/sql/CLAUDE.md` for the four-compilers / one-
// composition shape; the dispatch contract; the depth-thread for
// nested-walk composition; the zero-raw-SQL emission rule; and the
// tenant-scope contract (callers emit the outer-query filter).
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
	TermBindings,
	TermBindingValue,
	TermCompileContext,
} from "./compileTerm";
export { compileTerm } from "./compileTerm";
export type {
	CaseIndexRelationship,
	CaseIndicesTable,
	CasesQuarantineTable,
	CasesTable,
	CaseTypeSchemasTable,
	Database,
	JsonObject,
	JsonPrimitive,
	JsonValue,
} from "./database";
export { POSTGRES_CAST_FOR_DATA_TYPE } from "./dataTypeTokens";
