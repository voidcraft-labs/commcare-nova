// lib/case-store/sql/dataTypeTokens.ts
//
// Shared compiler constants — pure data, no dispatch logic. The
// compilers (`compileTerm`, `compilePredicate`, `compileLiteral`)
// each import what they need from this module; concentrating the
// constants here keeps the dependency graph pointing AT the data
// from every reading compiler rather than tangling cross-compiler
// edges to share a `const`.
//
// Two flavors live here:
//
// 1. **Per-`CasePropertyDataType` token tables** — one entry per
//    arm of the closed `data_type` enum, keyed via `Record<...>`
//    so a new arm surfaces as a compile-time error in this one
//    file rather than across multiple compilers.
// 2. **Reserved scalar-column set** — the `cases` columns that
//    surface as first-class scalar reads at the term layer rather
//    than as JSONB-document keys. Shared by `compileTerm`'s
//    `prop` arm and `compilePredicate`'s `is-null` / `is-blank`
//    arms; both compilers branch on membership identically.
//
// The data-type tables predate the column set; the file's
// historical name reflects that. The set lives here because the
// same "shared compiler constant, no dispatch" rationale applies
// — extracting to its own module would produce a sibling file
// with one declaration in it.

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

/**
 * The `cases` columns that surface as first-class scalar reads
 * rather than as JSONB-document keys. A `prop` term whose
 * `property` matches one of these names reads from the scalar
 * column directly via `eb.ref(...)`, both because the column is
 * indexed (the JSONB read skips the index) and because the column
 * is not present in the JSONB document (the JSONB read returns
 * `NULL`). The predicate compiler's `is-null` / `is-blank` arms
 * branch on the same set so both compilers stay in lockstep on
 * which property names route to the column shape.
 *
 * The other scalar columns on `cases` (`app_id`, `opened_on`,
 * `modified_on`, `closed_on`, `parent_case_id`) are intentionally
 * NOT routed through `prop` at the term layer. They are tenant /
 * timestamp / FK columns whose authoring surface belongs to query-
 * shape primitives (the outer query's tenant filter, sort order,
 * opened-vs-closed filter, parent navigation) rather than to the
 * case's authored property document. Any future term-level support
 * for those columns gets a dedicated AST shape rather than `prop`-
 * as-scalar overloading.
 *
 * **Shadowing caveat:** these names are also valid CommCare case-
 * property identifiers (the `casePropertyField` validator on
 * `propertyRefSchema.property` admits any
 * `[a-zA-Z][a-zA-Z0-9_-]*` shape). A blueprint that declares a
 * property whose name matches one of these will be silently
 * shadowed by the scalar-column read — the term compiler reads
 * from the column instead of the JSONB document the blueprint
 * author intended. The blueprint validator is responsible for
 * rejecting these names (CommCare's wire layer also reserves them,
 * so the blueprint validator's rejection is independently load-
 * bearing); the compilers trust that rejection upstream and route
 * uniformly. If the blueprint validator gains a per-property
 * reservation check, this constant is the source of truth.
 */
export const RESERVED_SCALAR_COLUMNS: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
	"case_name",
]);
