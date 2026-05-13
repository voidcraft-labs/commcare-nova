// lib/case-store/sql/dataTypeTokens.ts
//
// Shared compiler constants — pure data, no dispatch. Three
// compilers (`compileTerm`, `compilePredicate`, `compileLiteral`)
// each import from here so a new `CasePropertyDataType` arm
// surfaces as a compile-time error in one file rather than
// tangling across compilers.

import type { ColumnDataType } from "kysely";
import type { CasePropertyDataType } from "@/lib/domain";

/**
 * The Postgres cast token per `data_type`. Tokens are spelled in
 * Kysely-recognised `ColumnDataType` form so `eb.cast<T>(expr,
 * dataType)` accepts them without raw-SQL escape hatches.
 *
 * - `integer` (NOT `int`) — Kysely's `ColumnDataType` literal;
 *   Postgres parses both identically.
 * - `numeric` — Postgres's arbitrary-precision decimal; matches
 *   the JSON Schema generator's `{ type: "number" }`.
 * - `timestamptz` (NOT `timestamp`) — preserves timezone from the
 *   wire-form ISO string.
 * - `jsonb` — for `multi_select`, paired with `->` (NOT `->>`) so
 *   the predicate compiler can use JSONB on the left side of
 *   `?|` / `?&` / `@>`.
 *
 * Re-exported from `./index.ts` so external compile sites can
 * thread the cast token through their own call sites.
 */
export const POSTGRES_CAST_FOR_DATA_TYPE: Readonly<
	Record<CasePropertyDataType, ColumnDataType>
> = {
	text: "text",
	int: "integer",
	decimal: "numeric",
	date: "date",
	time: "time",
	datetime: "timestamptz",
	single_select: "text",
	multi_select: "jsonb",
	geopoint: "text",
};

/**
 * JSONB property-read operator per `data_type`. `->>` returns
 * text; `->` returns jsonb (used for `multi_select` because
 * `multi-select-contains` operates on JSONB arrays). The redundant
 * `cast(... as jsonb)` on `->` keeps the read site uniform with
 * the other arms' "read + cast" shape.
 *
 * Package-internal — outside callers route through `compileTerm`.
 */
export const JSONB_READ_OPERATOR_FOR_DATA_TYPE: Readonly<
	Record<CasePropertyDataType, "->" | "->>">
> = {
	text: "->>",
	int: "->>",
	decimal: "->>",
	date: "->>",
	time: "->>",
	datetime: "->>",
	single_select: "->>",
	multi_select: "->",
	geopoint: "->>",
};

/**
 * `cases` columns that surface as first-class scalar reads instead
 * of JSONB-document keys. A `prop` term whose `property` matches
 * routes through `eb.ref(...)` because the column is indexed and
 * because the column isn't in the JSONB document (a JSONB read
 * would return `NULL`). The `is-null` / `is-blank` arms read the
 * same set so both compilers stay in lockstep.
 *
 * Other scalar columns (`app_id`, `opened_on`, `modified_on`,
 * `closed_on`, `parent_case_id`) are intentionally NOT routed
 * through `prop` — they're tenant / timestamp / FK columns whose
 * authoring belongs to query-shape primitives, not the case's
 * authored property document. Future term-level support gets a
 * dedicated AST shape rather than `prop`-as-scalar overloading.
 *
 * **Shadowing:** these names are also valid CommCare property
 * identifiers. A blueprint declaring a property with one of these
 * names is silently shadowed by the scalar-column read. The
 * blueprint validator is responsible for rejecting these names
 * (CommCare's wire layer reserves them too); the compilers trust
 * that rejection upstream.
 */
export const RESERVED_SCALAR_COLUMNS: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
	"case_name",
]);
