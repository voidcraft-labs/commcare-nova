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
 * One resolved standard-name read: the `cases` column carrying the
 * value, plus the column's shape. `blankable` drives the `is-blank`
 * arm — `''` is a possible stored value only on text-shaped columns;
 * comparing a timestamp column to `''` is a Postgres type error, so
 * non-blankable columns collapse `is-blank` to plain `IS NULL`.
 */
export interface ReservedScalarColumn {
	readonly column: string;
	readonly blankable: boolean;
}

/**
 * CommCare's standard case-metadata property names resolved onto the
 * `cases` scalar columns that carry their values. A `prop` term whose
 * name matches routes through `eb.ref(...)` on the MAPPED column
 * instead of a JSONB-document read — the value lives in the column,
 * never the JSONB document (a JSONB read would return `NULL`), and
 * these names ARE the wire's authoring vocabulary for case metadata
 * (a CommCare detail column's `field` says `date_opened`; the device
 * reads the case's open timestamp). The `is-null` / `is-blank` arms
 * read the same map so both compilers stay in lockstep, and the
 * running-preview display seam
 * (`lib/preview/engine/caseDataBindingClient.ts::caseRowDisplayValue`)
 * resolves the same names off the row object.
 *
 * Truly internal columns (`app_id`, `project_id`, `closed_on`,
 * `parent_case_id`) stay unmapped — tenant / FK plumbing with no
 * authoring-vocabulary name.
 *
 * **Shadowing:** these names are also syntactically valid property
 * identifiers, but a field cannot write one — the validator's
 * `RESERVED_CASE_PROPERTY` rule rejects every entry here except
 * `case_name` as a `case_property_on` target — so the scalar read
 * can never shadow authored case data; the compilers trust that
 * rejection upstream.
 */
export const RESERVED_SCALAR_COLUMN_BY_PROPERTY: ReadonlyMap<
	string,
	ReservedScalarColumn
> = new Map([
	["case_id", { column: "case_id", blankable: true }],
	["case_type", { column: "case_type", blankable: true }],
	["owner_id", { column: "owner_id", blankable: true }],
	["status", { column: "status", blankable: true }],
	["case_name", { column: "case_name", blankable: true }],
	["name", { column: "case_name", blankable: true }],
	["external_id", { column: "external_id", blankable: true }],
	["external-id", { column: "external_id", blankable: true }],
	["date_opened", { column: "opened_on", blankable: false }],
	["date-opened", { column: "opened_on", blankable: false }],
	["last_modified", { column: "modified_on", blankable: false }],
]);
