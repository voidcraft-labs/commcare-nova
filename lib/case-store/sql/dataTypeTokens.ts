// lib/case-store/sql/dataTypeTokens.ts
//
// The two `Record<CasePropertyDataType, <Postgres-token>>` tables
// the compiler stack reads to lower a case property's declared
// `data_type` into Postgres syntax. Both tables are pure data —
// no compiler dispatch logic — so they live in a sibling module
// every consumer imports from rather than concentrating the
// constants on one compiler module the others depend on.
//
// ## Two tables, one keyspace
//
// `CasePropertyDataType` is the closed-enum keyspace
// (`text` / `int` / `decimal` / `date` / `time` / `datetime` /
// `single_select` / `multi_select` / `geopoint`); both tables map
// each arm to a Postgres token used at compile time:
//
//   - `POSTGRES_CAST_FOR_DATA_TYPE` — Kysely-recognised
//     `ColumnDataType` literal the compiler stack lifts a value
//     into via `eb.cast<T>(expr, dataType)`. Used at every site
//     that needs to compare a JSONB-string-shaped property read
//     against a typed Postgres value (`compileTerm`'s
//     `jsonbColumnRead`, `compileLiteral`'s typed-literal arm).
//   - `JSONB_READ_OPERATOR_FOR_DATA_TYPE` — the JSONB property-read
//     operator (`->>` returns text, `->` returns jsonb) the term
//     compiler emits when reading a property of the corresponding
//     declared type.
//
// Co-locating the tables here means a new `data_type` arm is one
// edit per table in one file — both tables surface the missing
// arm as a compile-time error on the closed-enum `Record<...>`
// shape. Distributing the tables across compiler modules would
// fragment the addition.
//
// ## Why this is its own module rather than a sub-section of compileTerm
//
// `compileTerm` and `compileLiteral` both read
// `POSTGRES_CAST_FOR_DATA_TYPE`; sharing the constant from
// `compileTerm` produces a dependency edge that points "away from"
// the leaf-value compiler the constants describe. A standalone
// data-only module makes the dependency graph point AT the data
// from every reading compiler — three siblings of equal weight,
// each importing what it needs from the data module, none
// importing from another compiler's internals.

import type { ColumnDataType } from "kysely";
import type { CasePropertyDataType } from "@/lib/domain";

/**
 * The Postgres cast token a `data_type` lifts into. The values are
 * Postgres type names; callers apply the cast through Kysely's
 * `eb.cast<T>(expr, dataType)`. Tokens are spelled in
 * Kysely-recognised `ColumnDataType` form so the typed builder
 * accepts them directly without falling back to a raw SQL escape
 * hatch.
 *
 * Cast choices:
 *
 *   - `text` — explicit cast on text-flavored properties (`text`,
 *     `single_select`, `geopoint`, undefined). `properties->>'X'`
 *     already returns text, but the explicit cast documents intent
 *     and stays uniform with the other arms' shape.
 *   - `integer` — `data_type: "int"`. Rejects fractional decoding
 *     from a JSONB number that happens to be stored without a
 *     decimal point. Spelled `integer` rather than `int` so the
 *     typed builder accepts it as a `ColumnDataType` literal;
 *     Postgres parses the two forms identically.
 *   - `numeric` — `data_type: "decimal"`. Postgres's arbitrary-
 *     precision decimal; matches the JSON Schema generator's
 *     `{ type: "number" }` shape.
 *   - `date` / `time` / `timestamptz` — temporal cast tokens. The
 *     JSONB read returns the wire-form ISO string; the cast lifts
 *     to the typed temporal value Postgres can compare ordinally.
 *     `timestamptz` (rather than `timestamp`) preserves timezone
 *     info from the wire string.
 *   - `jsonb` — `data_type: "multi_select"`. The predicate compiler
 *     needs JSONB on the left side of `?|` / `?&` / `@>`; reading
 *     via `->>` yields a stringified blob those operators can't
 *     process. The corresponding read operator is `->` (returns
 *     JSONB) rather than `->>` — see
 *     `JSONB_READ_OPERATOR_FOR_DATA_TYPE` below.
 *
 * Re-exported from the package's barrel `./index.ts` because some
 * consumers (the compiler stack itself, future case-list query
 * compilers) thread the cast token through call sites that
 * compose against externally-supplied expressions.
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
 * The JSONB property-read operator that resolves a property of a
 * given `data_type`. Two variants:
 *
 *   - `->>` returns text. Used for every text-flavored arm — the
 *     JSON Schema generator stores these as JSON strings, and the
 *     outer `cast(... as <type>)` lifts the text into the typed
 *     Postgres value.
 *   - `->` returns jsonb. Used for `multi_select` because the
 *     predicate compiler's `multi-select-contains` arm operates on
 *     JSONB arrays. The `cast(... as jsonb)` wrapper is
 *     structurally redundant (the operator already returns jsonb)
 *     but stays uniform with the other arms' "read + cast" shape
 *     and makes the column-type explicit at the read site.
 *
 * Package-internal: the only consumer is `compileTerm`'s
 * `jsonbColumnRead`; outside callers route property reads through
 * `compileTerm` rather than constructing a JSONB read directly.
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
