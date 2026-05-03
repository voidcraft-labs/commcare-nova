// lib/case-store/sql/compileLiteral.ts
//
// Compile a `Literal` AST node to a parameter-bound (or `NULL`-keyword)
// Kysely expression. Two compile-stack consumers — the Term compiler's
// `literal` arm and the Predicate compiler's `in.values` arm — both need
// the same literal-emission semantics (typed parameter binding, optional
// `data_type` cast lift, `eb.lit(null)` for the SQL `NULL` keyword), so
// the helper lives in one module both consumers import from.
//
// The shipped semantic is byte-equivalent to the on-device wire emitter's
// literal handling (`lib/commcare/expression/onDeviceEmitter.ts`) up to
// the dialect difference: Postgres carries the `data_type` through to a
// real parameter cast (`cast($N as date)`), while the on-device dialect
// embeds the literal in a quoted XPath string. Both encodings are
// driven from the same `Literal.value` + `Literal.data_type` pair the
// AST carries.
//
// ## Three concerns interact in one helper
//
//   1. **Value typing.** The AST admits `string | number | boolean |
//      null`. Each maps to a corresponding pg-driver-bindable runtime
//      value; `null` is handled specially because SQL's `NULL` is a
//      keyword, not a value. Binding `null` as a `$N` parameter
//      inflates the parameter list without expressivity gain and shifts
//      EXPLAIN-output readability for no reason; `eb.lit(null)` emits
//      the SQL `NULL` keyword directly.
//   2. **Parameter binding.** Non-null primitives flow through Kysely's
//      `eb.val(value)` which binds as a `$N` placeholder. Inlining the
//      value would be unsafe (no escaping in the type-erased path) and
//      would invalidate plan-cache reuse on the Postgres side; binding
//      is the canonical pattern.
//   3. **Optional `data_type` cast.** When the literal carries an
//      explicit `data_type` (typed temporal literals construct this
//      shape via `dateLiteral` / `datetimeLiteral` / `timeLiteral` in
//      `lib/domain/predicate/builders.ts`), the compiler emits
//      `cast($N as <type>)` via `eb.cast<T>(eb.val(value), dataType)`
//      so the bound parameter is well-typed for comparison against a
//      typed `prop` read. Without `data_type`, the parameter binds bare
//      and Postgres's implicit type coercion handles the comparison.
//
// ## Why this is a sibling module rather than a re-export from compileTerm
//
// The `Literal` type lives in `lib/domain/predicate/types.ts:560-565`
// and carries `{ kind: "literal", value, data_type? }`. Both consumers
// have a `Literal`-shaped input at the call site:
//
//   - `compileTerm`'s switch dispatches `case "literal": return
//     compileLiteral(term)` where `term` narrows to
//     `Extract<Term, { kind: "literal" }>` — structurally identical to
//     `Literal` (both carry the same three fields including the
//     discriminator).
//   - `compilePredicate`'s `compileIn` walks `pred.values: Literal[]`
//     and calls `compileLiteral(v)` per value.
//
// A re-export from `compileTerm` would force the predicate-side caller
// to import a helper from a sibling module that owns Term-shaped
// dispatch, coupling literal emission to term-compiler internals.
// Sibling-module placement (this file) keeps each consumer's import
// graph local: the Term compiler imports `compileLiteral` from `./
// compileLiteral`, and so does the Predicate compiler.
//
// ## Cast-token lookup is single-source via POSTGRES_CAST_FOR_DATA_TYPE
//
// The `data_type` → Postgres cast-token mapping
// (`POSTGRES_CAST_FOR_DATA_TYPE`) lives on the Term compiler because
// every property-read site uses it too. Importing the same constant
// here keeps the cast logic single-source — extending the blueprint's
// `data_type` enum forces the `Record<...>` exhaustivity check in the
// one shared table to surface the missing entry. No parallel table
// lives on this module's surface.

import type { AliasableExpression } from "kysely";
import { expressionBuilder } from "kysely";
import type { Literal } from "@/lib/domain/predicate/types";
import { POSTGRES_CAST_FOR_DATA_TYPE } from "./compileTerm";
import type { Database } from "./database";

// ---------------------------------------------------------------
// Shared expression builder
// ---------------------------------------------------------------

/**
 * The standalone expression builder bound to the case-store
 * `Database` type with every table in scope. Mirrors the same shape
 * used in sibling compilers (`compileTerm`, `compilePredicate`,
 * `compileExpression`). The builder is module-scoped because every
 * call from this helper produces an expression independent of the
 * outer query's table context — `eb.val`, `eb.lit`, and `eb.cast`
 * read no column names from `DB[TB]`, so binding to
 * `<Database, keyof Database>` carries no narrowing cost.
 */
const eb = expressionBuilder<Database, keyof Database>();

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

/**
 * Compile a `Literal` AST node to a parameter-bound (or `NULL`-keyword)
 * Kysely expression.
 *
 * Three branches map to the three concerns documented in the file
 * header:
 *
 *   - `value === null` → `eb.lit(null)`. Emits the SQL `NULL` keyword
 *     directly rather than binding a parameter; SQL distinguishes
 *     value-position `NULL` from a `$N`-bound `null` parameter only
 *     in EXPLAIN output, but the keyword form keeps the parameter
 *     list lean and matches every other compile-stack consumer's
 *     null emission (the predicate compiler's null-arm emits
 *     `IS NULL` via Kysely's typed `where(...)` clause; this module
 *     emits the value-position `NULL`).
 *   - `data_type !== undefined` → `eb.cast(eb.val(value), <token>)`.
 *     The cast token comes from the closed `POSTGRES_CAST_FOR_DATA_TYPE`
 *     table on `compileTerm`. The cast lifts the bound parameter into
 *     the typed Postgres value the comparison expects on the other
 *     side — without it, `cast(date '2025-01-01' as date) =
 *     properties->>'birthdate'::date` would compare typed `date`
 *     against text on the right, surfacing as a type-mismatch error
 *     at execution.
 *   - Otherwise → `eb.val(value)`. Bare parameter binding; Postgres's
 *     implicit type coercion handles the comparison against any
 *     scalar type the `properties->>'X'` path produces.
 *
 * The return type is `AliasableExpression<unknown>` — Kysely's
 * `.as(alias)`-bearing operand contract that every concrete return
 * shape (`ExpressionWrapper`, `RawBuilder`) implements. Consumers
 * thread the result into `eb(left, op, right)` binary calls and
 * `in: [...]` value lists uniformly; the unknown payload is
 * deliberate because each branch resolves to a different
 * per-Postgres-type expression but the runtime dispatches by
 * `lit.value` shape.
 */
export function compileLiteral(lit: Literal): AliasableExpression<unknown> {
	if (lit.value === null) {
		return eb.lit(null);
	}
	if (lit.data_type !== undefined) {
		const cast = POSTGRES_CAST_FOR_DATA_TYPE[lit.data_type];
		// `eb.cast(eb.val(value), <ColumnDataType>)` emits a typed
		// `CAST(<param> AS <type>)` expression. The closed-enum lookup
		// keeps the cast token within Kysely's accepted `ColumnDataType`
		// literals; adding a new `data_type` arm to the blueprint
		// surfaces here as a missing-key TypeScript error on the
		// `Record<CasePropertyDataType, ColumnDataType>` table.
		return eb.cast(eb.val(lit.value), cast);
	}
	return eb.val(lit.value);
}
