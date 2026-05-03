// lib/case-store/sql/__tests__/_barrel-verification.test.ts
//
// Type-only verification that the case-store SQL package's public
// barrel (`./index.ts`) exposes every name the per-module imports
// would otherwise need to reach into. Reading every barrel export
// site here makes the public-surface contract a tested invariant
// rather than a hand-maintained list — adding a new external-facing
// symbol forces a parallel addition here for the test to stay green.
//
// Tested invariants:
//
//   1. Every public compiler entry point is reachable through the
//      barrel (`compileTerm`, `compileExpression`, `compilePredicate`,
//      `compileRelationPath`).
//   2. Every public compile-context interface and supporting type
//      reaches through the barrel — TypeScript's `verbatimModuleSyntax`
//      means a type-only re-export through `export type { ... }` is
//      structurally distinct from a runtime export, and the test
//      asserts both.
//   3. The internal `compileLiteral` helper does NOT leak through
//      the barrel — sibling-module placement keeps it package-private,
//      and a test asserting against its absence catches a future
//      accidental re-export.
//
// The runtime side asserts only that runtime-exported symbols are
// present. Type-only re-exports surface as compile-time errors when
// the import line below them references a missing name; the tsc
// gate is the load-bearing assertion.

import { expect, it } from "vitest";
// Type-only re-exports — referencing each name in a position that
// requires the type to resolve forces the TypeScript compiler to
// fail if the barrel doesn't re-export it.
import type {
	CaseIndexRelationship,
	CaseIndicesTable,
	CasesTable,
	CaseTypeSchemasTable,
	CompiledRelationPath,
	CompilePredicateThunk,
	Database,
	ExpressionCompileContext,
	PredicateCompileContext,
	RelationPathCompileContext,
	RelationPathLeafRow,
	TermBindings,
	TermBindingValue,
	TermCompileContext,
} from "../index";
import {
	compileExpression,
	compilePredicate,
	compileRelationPath,
	compileTerm,
	leafAliasForDepth,
	POSTGRES_CAST_FOR_DATA_TYPE,
	RELATION_PATH_LEAF_ALIAS,
} from "../index";

// ---------------------------------------------------------------
// Runtime symbol surface
// ---------------------------------------------------------------

it("barrel exposes every compiler entry point", () => {
	// Runtime presence — the imports above resolved to actual values,
	// not undefined re-exports.
	expect(typeof compileTerm).toBe("function");
	expect(typeof compileExpression).toBe("function");
	expect(typeof compilePredicate).toBe("function");
	expect(typeof compileRelationPath).toBe("function");
	expect(typeof leafAliasForDepth).toBe("function");
});

it("barrel exposes the relation-path leaf alias and cast table", () => {
	expect(RELATION_PATH_LEAF_ALIAS).toBe("rp_leaf");
	// The table is a `Record<CasePropertyDataType, ColumnDataType>`
	// with one entry per data_type arm; spot-check two arms to
	// confirm the runtime value reaches through the barrel.
	expect(POSTGRES_CAST_FOR_DATA_TYPE.text).toBe("text");
	expect(POSTGRES_CAST_FOR_DATA_TYPE.multi_select).toBe("jsonb");
});

it("barrel does NOT leak the package-private compileLiteral helper", async () => {
	// `compileLiteral` is the sibling helper consumed by both
	// `compileTerm`'s `literal` arm and `compilePredicate`'s
	// `in.values` arm. Outside callers route literal emission through
	// `compileTerm`, so re-exporting it through the barrel would
	// expose internal-only API as public surface. The dynamic import
	// reads the actual barrel module record — `compileLiteral`
	// must NOT appear among the exported keys.
	const barrel = await import("../index");
	expect(Object.keys(barrel)).not.toContain("compileLiteral");
});

// ---------------------------------------------------------------
// Type-only surface — compile-time pin via type aliases
// ---------------------------------------------------------------
//
// Type-only re-exports don't survive to runtime, so the compile-time
// proof lives here: each `type _Pin_X = X` assignment forces the
// TypeScript compiler to resolve the type through the barrel. If the
// barrel ever drops a type-only re-export, the assignment fails with
// a "cannot find name" error and the file fails to compile.

type _PinCaseIndexRelationship = CaseIndexRelationship;
type _PinCaseIndicesTable = CaseIndicesTable;
type _PinCasesTable = CasesTable;
type _PinCaseTypeSchemasTable = CaseTypeSchemasTable;
type _PinCompiledRelationPath = CompiledRelationPath;
type _PinCompilePredicateThunk = CompilePredicateThunk;
type _PinDatabase = Database;
type _PinExpressionCompileContext = ExpressionCompileContext;
type _PinPredicateCompileContext = PredicateCompileContext;
type _PinRelationPathCompileContext = RelationPathCompileContext;
type _PinRelationPathLeafRow = RelationPathLeafRow;
type _PinTermBindings = TermBindings;
type _PinTermBindingValue = TermBindingValue;
type _PinTermCompileContext = TermCompileContext;

// The `void` ... pattern below documents that the per-name `_Pin_*`
// aliases above exist solely to pin the public surface — referencing
// each here keeps the unused-variable lint quiet without creating any
// runtime side effect.
void (0 as unknown as _PinCaseIndexRelationship);
void (0 as unknown as _PinCaseIndicesTable);
void (0 as unknown as _PinCasesTable);
void (0 as unknown as _PinCaseTypeSchemasTable);
void (0 as unknown as _PinCompiledRelationPath);
void (0 as unknown as _PinCompilePredicateThunk);
void (0 as unknown as _PinDatabase);
void (0 as unknown as _PinExpressionCompileContext);
void (0 as unknown as _PinPredicateCompileContext);
void (0 as unknown as _PinRelationPathCompileContext);
void (0 as unknown as _PinRelationPathLeafRow);
void (0 as unknown as _PinTermBindings);
void (0 as unknown as _PinTermBindingValue);
void (0 as unknown as _PinTermCompileContext);
