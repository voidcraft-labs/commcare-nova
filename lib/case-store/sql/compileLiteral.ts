// lib/case-store/sql/compileLiteral.ts
//
// Compile a `Literal` AST node to a parameter-bound (or
// `NULL`-keyword) Kysely expression. Two consumers share this
// helper: `compileTerm`'s `literal` arm and `compilePredicate`'s
// `in.values` arm. The byte-shape mirrors the on-device wire
// emitter (`lib/commcare/expression/onDeviceEmitter.ts`) up to
// dialect — Postgres carries `data_type` through to
// `cast($N as date)` while on-device embeds the literal in a
// quoted XPath string.
//
// `null` emits as the SQL `NULL` keyword via `eb.lit(null)` rather
// than a `$N` parameter — binding `null` would inflate the
// parameter list and shift EXPLAIN-output readability without
// expressivity gain. Non-null primitives bind via `eb.val` (the
// canonical pattern; inlining would be unsafe in the type-erased
// path and would invalidate plan-cache reuse). When `data_type` is
// present, `eb.cast(eb.val(value), <token>)` lifts the bound
// parameter to the typed value the comparison expects. Temporal
// strings pass through `nullif(value, '')` before their cast: the
// builder deliberately uses an empty typed literal while an optional
// date/time control is unset, and Postgres must treat that transient
// state as no value rather than trying to parse `''::date`.

import type { AliasableExpression } from "kysely";
import { expressionBuilder } from "kysely";
import type { Literal } from "@/lib/domain/predicate/types";
import type { Database } from "./database";
import { POSTGRES_CAST_FOR_DATA_TYPE } from "./dataTypeTokens";

/**
 * Module-scoped expression builder. `eb.val` / `eb.lit` / `eb.cast`
 * read no column names from `DB[TB]` so binding to
 * `<Database, keyof Database>` has no narrowing cost.
 */
const eb = expressionBuilder<Database, keyof Database>();

/**
 * Compile a `Literal` to a Kysely expression. Three branches:
 * `null` → `eb.lit(null)` (SQL `NULL` keyword); `data_type !==
 * undefined` → `eb.cast(eb.val(value), <token>)` lifts the bound
 * parameter to the typed value; otherwise → bare `eb.val(value)`.
 * Date / time / datetime strings first pass through SQL `nullif`, so
 * the editor's intentional empty-string draft becomes typed `NULL`
 * instead of a Postgres `22007` cast failure. Non-empty values retain
 * the same cast and still fail loudly when genuinely malformed.
 *
 * Returns `AliasableExpression<unknown>` because each branch
 * resolves to a different per-Postgres-type expression but the
 * runtime dispatches by `lit.value` shape; consumers thread the
 * result into `eb(left, op, right)` and `in: [...]` slots
 * uniformly.
 */
export function compileLiteral(lit: Literal): AliasableExpression<unknown> {
	if (lit.value === null) {
		return eb.lit(null);
	}
	if (lit.data_type !== undefined) {
		const cast = POSTGRES_CAST_FOR_DATA_TYPE[lit.data_type];
		if (
			typeof lit.value === "string" &&
			(lit.data_type === "date" ||
				lit.data_type === "datetime" ||
				lit.data_type === "time")
		) {
			return eb.cast(eb.fn("nullif", [eb.val(lit.value), eb.val("")]), cast);
		}
		return eb.cast(eb.val(lit.value), cast);
	}
	return eb.val(lit.value);
}
