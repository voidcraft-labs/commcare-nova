// lib/domain/modules.ts
//
// Module schema. Owns the structured `caseListConfig` shape that
// drives every case-list authoring surface (display columns, sort,
// always-on filter, calculated columns, search inputs, optional
// long-detail override). The shape is the single source of truth
// the validator, wire emitters, SA tools, and case-list-config UI
// all read from.
//
// `Predicate`, `ValueExpression`, and `RelationPath` come from
// `@/lib/domain/predicate` — the AST primitives the filter,
// calculated-column expression, and search-input `via` slots
// reference. Importing them here (rather than redefining the
// shapes) keeps the AST cycles consolidated in one package and
// keeps every authoring surface bound against the same Zod
// schemas.

import { z } from "zod";
import {
	predicateSchema,
	relationPathSchema,
	valueExpressionSchema,
} from "./predicate/types";
import { uuidSchema } from "./uuid";

// ── Column kinds ─────────────────────────────────────────────────
//
// Each column kind carries its own per-kind configuration. The
// `kind` discriminant routes the column through the matching wire
// emitter (suite XML `<field>` `<style>`/`<sort>` blocks) and
// builder UI (the per-kind `ColumnEditor` arms).

/**
 * Plain text column — renders the property value as a string.
 *
 * The default kind for any displayed column. `field` references
 * a case property; `header` is the column header text the case
 * list renders.
 */
const plainColumnSchema = z.object({
	kind: z.literal("plain"),
	field: z.string(),
	header: z.string(),
});

/**
 * Date-formatted column — renders the property value through a
 * preset date format. The property must resolve to a date-shaped
 * `data_type` (validator rule); the runtime formatter consumes
 * `pattern` to produce the displayed string.
 */
const dateColumnSchema = z.object({
	kind: z.literal("date"),
	field: z.string(),
	header: z.string(),
	pattern: z.string(),
});

/** Time-since/time-until interval units. */
const TIME_SINCE_UNITS = ["days", "weeks", "months", "years"] as const;
export type TimeSinceUnit = (typeof TIME_SINCE_UNITS)[number];

/**
 * Time-since-until column — renders a relative interval against
 * the property's date value (e.g. "3 days ago"). The threshold +
 * unit drive a per-row "is this overdue?" decision, surfaced via
 * `displayLabel` when the threshold is exceeded; otherwise the
 * raw interval renders.
 */
const timeSinceUntilColumnSchema = z.object({
	kind: z.literal("time-since-until"),
	field: z.string(),
	header: z.string(),
	threshold: z.number(),
	unit: z.enum(TIME_SINCE_UNITS),
	displayLabel: z.string(),
});

/**
 * Phone-number column — renders the property as a tappable phone
 * link in the running app. Plain text in static contexts.
 */
const phoneColumnSchema = z.object({
	kind: z.literal("phone"),
	field: z.string(),
	header: z.string(),
});

/**
 * ID-mapping column — renders a lookup table from property value
 * to display label (e.g. region code → human-readable region
 * name). The mapping table is authored explicitly; values not in
 * the table render as the raw property value.
 */
const idMappingEntrySchema = z.object({
	value: z.string(),
	label: z.string(),
});
const idMappingColumnSchema = z.object({
	kind: z.literal("id-mapping"),
	field: z.string(),
	header: z.string(),
	mapping: z.array(idMappingEntrySchema),
});

/**
 * Late-flag column — surfaces a flag string when the date
 * property exceeds the threshold; otherwise renders empty. Used
 * for "overdue" / "follow-up needed" signals on the case list.
 */
const lateFlagColumnSchema = z.object({
	kind: z.literal("late-flag"),
	field: z.string(),
	header: z.string(),
	threshold: z.number(),
	unit: z.enum(TIME_SINCE_UNITS),
	flagDisplayValue: z.string(),
});

/**
 * Search-only column — declares a property as searchable but
 * NOT displayed. The validator rule `searchInputModeMatchesPropertyType`
 * uses these declarations to widen the indexable property set
 * without forcing a visible column.
 *
 * `header` is retained for authoring-surface display (the
 * column-editor UI lists every column; "search-only" rows still
 * have a title) but is not emitted to the runtime case list.
 */
const searchOnlyColumnSchema = z.object({
	kind: z.literal("search-only"),
	field: z.string(),
	header: z.string(),
});

export const columnSchema = z.discriminatedUnion("kind", [
	plainColumnSchema,
	dateColumnSchema,
	timeSinceUntilColumnSchema,
	phoneColumnSchema,
	idMappingColumnSchema,
	lateFlagColumnSchema,
	searchOnlyColumnSchema,
]);
export type Column = z.infer<typeof columnSchema>;
export type ColumnKind = Column["kind"];

// ── Sort + calculated columns ─────────────────────────────────────
//
// Sort keys reference either a property (typed via `data_type`)
// or a calculated column (typed via the calculated column's
// `expression`). The `SortType` enum picks the comparator the
// runtime applies — `plain` is lexicographic, `date` parses ISO
// strings, `integer`/`decimal` cast through numeric comparison.

export const SORT_TYPES = ["plain", "date", "integer", "decimal"] as const;
export type SortType = (typeof SORT_TYPES)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

const sortConfigSchema = z.object({
	type: z.enum(SORT_TYPES),
	direction: z.enum(SORT_DIRECTIONS),
});

/**
 * Calculated column — author-defined ValueExpression that yields
 * a derived per-row value (e.g. "days since last visit",
 * "concatenated full name"). The optional `sort` slot lets the
 * runtime sort the case list by the computed value without
 * recomputing per row.
 *
 * `id` is a stable per-column identifier (referenced by sort
 * keys when sorting by a calculated column); `header` is the
 * column header text; `expression` is the AST the wire emitter
 * lowers into a Postgres expression / on-device XPath / CSQL
 * fragment.
 */
const calculatedColumnSchema = z.object({
	id: z.string(),
	header: z.string(),
	expression: valueExpressionSchema,
	sort: sortConfigSchema.optional(),
});
export type CalculatedColumn = z.infer<typeof calculatedColumnSchema>;

const sortKeySourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("property"), property: z.string() }),
	z.object({ kind: z.literal("calculated"), columnId: z.string() }),
]);

/**
 * Multi-key sort. Each key resolves a source (case property or a
 * calculated column id), a comparator type, and a direction. The
 * runtime applies keys in order — the first key is the primary
 * sort, each subsequent key is a tiebreaker.
 */
const sortKeySchema = z.object({
	source: sortKeySourceSchema,
	type: z.enum(SORT_TYPES),
	direction: z.enum(SORT_DIRECTIONS),
});
export type SortKey = z.infer<typeof sortKeySchema>;
export type SortKeySource = z.infer<typeof sortKeySourceSchema>;

// ── Search inputs ─────────────────────────────────────────────────
//
// Search input definitions. Each input declares an authoring-
// surface widget (`type`), an optional case property the input
// targets (`property`), an optional relation walk (`via`), an
// explicit search mode (`mode`), an optional default value
// (`default`), and an optional advanced predicate (`xpath`).

const SEARCH_INPUT_TYPES = [
	"text",
	"select",
	"date",
	"date-range",
	"barcode",
] as const;
export type SearchInputType = (typeof SEARCH_INPUT_TYPES)[number];

/** Multi-select-contains quantifier — `any` (∃) or `all` (∀). */
export const MULTI_SELECT_QUANTIFIERS = ["any", "all"] as const;
export type MultiSelectQuantifier = (typeof MULTI_SELECT_QUANTIFIERS)[number];

/**
 * Discriminated union of search-input modes. Each mode targets a
 * specific case-property `data_type` (validator-enforced):
 *
 *   - `exact` — equality match (text/select/date/barcode default).
 *   - `fuzzy` — pg_trgm `%` similarity (text only).
 *   - `starts-with` — pg_trgm-backed prefix match (text only).
 *   - `phonetic` — fuzzystrmatch dmetaphone (text only).
 *   - `fuzzy-date` — date permutation match (text only — the
 *     property holds free-form date text, not a typed date).
 *   - `range` — between-with-bounds (numeric/date/datetime/time).
 *   - `multi-select-contains` — JSONB `@>` / `?` against a
 *     `multi_select` property; the quantifier picks `any` (∃)
 *     vs `all` (∀).
 */
const searchInputModeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("exact") }),
	z.object({ kind: z.literal("fuzzy") }),
	z.object({ kind: z.literal("starts-with") }),
	z.object({ kind: z.literal("phonetic") }),
	z.object({ kind: z.literal("fuzzy-date") }),
	z.object({ kind: z.literal("range") }),
	z.object({
		kind: z.literal("multi-select-contains"),
		quantifier: z.enum(MULTI_SELECT_QUANTIFIERS),
	}),
]);
export type SearchInputMode = z.infer<typeof searchInputModeSchema>;

/**
 * Search input declaration.
 *
 *   - `name` — stable identifier the runtime binds the user input
 *     to; referenced from `xpath` / `default` AST nodes via the
 *     `input` term.
 *   - `label` — author-visible widget label.
 *   - `type` — authoring-surface widget kind.
 *   - `property` — case property the input targets. Absent for
 *     advanced inputs whose predicate is fully expressed via
 *     `xpath`.
 *   - `via` — optional relation walk; absent ≡ self (the
 *     module's case type). Drives the case-store's index-DDL
 *     emission against the destination case-type rather than
 *     the module's case type.
 *   - `mode` — explicit search mode; absent picks the per-`type`
 *     default at the wire-emission boundary (text → exact,
 *     date-range → range, etc.).
 *   - `default` — optional `ValueExpression` evaluated to seed
 *     the input's initial value (e.g. `today()` for date-typed
 *     defaults).
 *   - `xpath` — optional advanced `Predicate` that replaces the
 *     `(property, mode)`-derived predicate when present.
 */
const searchInputDefSchema = z.object({
	name: z.string(),
	label: z.string(),
	type: z.enum(SEARCH_INPUT_TYPES),
	property: z.string().optional(),
	via: relationPathSchema.optional(),
	mode: searchInputModeSchema.optional(),
	default: valueExpressionSchema.optional(),
	xpath: predicateSchema.optional(),
});
export type SearchInputDef = z.infer<typeof searchInputDefSchema>;

// ── CaseListConfig ───────────────────────────────────────────────
//
// The structured case-list configuration. Replaces the legacy
// `caseListColumns` / `caseDetailColumns` fields. A module
// without a case list (survey-only modules) omits the slot
// entirely; a module with a case list always carries every
// sub-field, even if some lists are empty.
//
// `detailColumns` is optional: absent ≡ "long detail mirrors
// the short detail's columns" (matches CommCare's default
// behavior when no explicit long detail is authored).

export const caseListConfigSchema = z.object({
	columns: z.array(columnSchema),
	sort: z.array(sortKeySchema),
	filter: predicateSchema.optional(),
	calculatedColumns: z.array(calculatedColumnSchema),
	searchInputs: z.array(searchInputDefSchema),
	detailColumns: z.array(columnSchema).optional(),
});
export type CaseListConfig = z.infer<typeof caseListConfigSchema>;

// ── Module ───────────────────────────────────────────────────────

export const moduleSchema = z.object({
	uuid: uuidSchema,
	id: z.string(), // semantic id (snake_case display slug)
	name: z.string(),
	caseType: z.string().optional(),
	caseListOnly: z.boolean().optional(),
	purpose: z.string().optional(),
	caseListConfig: caseListConfigSchema.optional(),
});
export type Module = z.infer<typeof moduleSchema>;

export type ModuleKindMetadata = {
	icon: string;
	saDocs: string;
};
export const moduleMetadata: ModuleKindMetadata = {
	icon: "tabler:stack",
	saDocs:
		"A module is a top-level menu in the CommCare app. It groups related forms under one case type.",
};
