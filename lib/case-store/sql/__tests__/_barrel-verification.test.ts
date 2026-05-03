// lib/case-store/sql/__tests__/_barrel-verification.test.ts
//
// Tested invariants of the case-store SQL package's public barrel
// (`./index.ts`):
//
//   1. Every public compiler entry point and supporting runtime
//      constant is reachable through the barrel — asserted by
//      runtime presence checks (`typeof X === "function"`, equality
//      against the known constant value).
//   2. Every public compile-context interface and supporting type is
//      reachable through the barrel — asserted at compile time by the
//      `import type { ... } from "../index"` statement below. If the
//      barrel ever drops a re-export, `tsc` errors with "Module
//      '../index' has no exported member 'X'" on the import line, and
//      the file fails to compile.
//   3. Internal helpers (`compileLiteral`, `JSONB_READ_OPERATOR_FOR_DATA_TYPE`)
//      do NOT leak through the barrel — asserted by enumerating the
//      barrel's runtime export record and checking the helper names
//      are absent.
//
// The aggregating-type alias `_BarrelTypeSurface` aggregates every
// re-exported type through one struct, so all `import type` names are
// "used" from a Biome organize-imports standpoint without 14 separate
// per-name pin sites. The struct itself is not asserted at runtime —
// the load-bearing assertion is the import line resolving each name
// through the barrel at compile time.

import { expect, it } from "vitest";
// Type-only re-exports — the import line itself is the load-bearing
// assertion; if the barrel drops any of these, `tsc` errors here.
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

// Aggregating struct that references each re-exported type once. The
// struct keeps every type-import "used" (so Biome's organize-imports
// rule doesn't strip it) without 14 per-name pin sites. The type is
// declared `type` (not `interface`) so `tsc` is forced to resolve
// every member type at declaration time.
type _BarrelTypeSurface = {
	caseIndexRelationship: CaseIndexRelationship;
	caseIndicesTable: CaseIndicesTable;
	casesTable: CasesTable;
	caseTypeSchemasTable: CaseTypeSchemasTable;
	compiledRelationPath: CompiledRelationPath;
	compilePredicateThunk: CompilePredicateThunk;
	database: Database;
	expressionCompileContext: ExpressionCompileContext;
	predicateCompileContext: PredicateCompileContext;
	relationPathCompileContext: RelationPathCompileContext;
	relationPathLeafRow: RelationPathLeafRow;
	termBindings: TermBindings;
	termBindingValue: TermBindingValue;
	termCompileContext: TermCompileContext;
};
// Touch the alias once so the unused-variable lint stays quiet
// without adding a per-member runtime assertion.
void (undefined as unknown as _BarrelTypeSurface | undefined);

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

it("barrel does NOT leak package-internal helpers", async () => {
	// Two names stay package-internal:
	//
	//   - `compileLiteral` — the helper consumed by both
	//     `compileTerm`'s `literal` arm and `compilePredicate`'s
	//     `in.values` arm. Outside callers route literal emission
	//     through `compileTerm`, so re-exporting it would expose
	//     internal-only API as public surface.
	//   - `JSONB_READ_OPERATOR_FOR_DATA_TYPE` — the `data_type` →
	//     JSONB-read-operator mapping on `dataTypeTokens`. Read only
	//     by `compileTerm`'s `jsonbColumnRead`; outside callers route
	//     property reads through `compileTerm` rather than
	//     constructing a JSONB read directly.
	//
	// The dynamic import reads the actual barrel module record;
	// neither helper name appears among the exported keys.
	const barrel = await import("../index");
	const exportedKeys = Object.keys(barrel);
	expect(exportedKeys).not.toContain("compileLiteral");
	expect(exportedKeys).not.toContain("JSONB_READ_OPERATOR_FOR_DATA_TYPE");
});
