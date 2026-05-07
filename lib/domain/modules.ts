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
import type { CasePropertyDataType } from "./casePropertyTypes";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "./predicate/types";
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
 *
 * `pattern` rejects empty strings (`z.string().min(1)`) — symmetric
 * with `formatDateSchema.pattern` on the ValueExpression side.
 * Both fields drive the same CCHQ format-date runtime; an empty
 * pattern would render the property's raw ISO string at the wire
 * boundary, defeating the column's purpose. Backed at the editor
 * by an inline empty-pattern signal in the shared
 * `CustomDatePatternInput` primitive.
 */
const dateColumnSchema = z.object({
	kind: z.literal("date"),
	field: z.string(),
	header: z.string(),
	pattern: z.string().min(1),
});

/**
 * Time-since/time-until interval units. Single source of truth
 * for both the schema's `z.enum(...)` constraint AND every
 * consumer that renders a unit picker — exporting the tuple keeps
 * the dropdown options in lockstep with the schema's accepted set.
 * Adding a unit here cascades to the picker without a parallel
 * edit (the structural-subtype `readonly TimeSinceUnit[]` array
 * shape can silently accept a strict subset).
 */
export const TIME_SINCE_UNITS = ["days", "weeks", "months", "years"] as const;
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

/** Single id-mapping entry — value-to-label pair surfaced by
 *  `idMappingColumn`'s lookup table. The pair is the canonical
 *  shape parsed by `idMappingEntrySchema`; constructing through
 *  this helper pins the key order and avoids ad-hoc literals
 *  drifting out of the schema. */
export type IdMappingEntry = z.infer<typeof idMappingEntrySchema>;

// ── Column builders ───────────────────────────────────────────────
//
// One thin builder per `ColumnKind` arm, each pinning the
// discriminator and threading the per-arm structural fields onto
// the constructed object. Mirrors the predicate-side pattern at
// `lib/domain/predicate/builders.ts`: every per-arm precise type is
// preserved on the return value, so callers narrowing on `kind`
// after a builder call get the per-variant fields directly without
// re-narrowing.
//
// The builders are the single construction surface for Column AST
// nodes — every Column-producing call site routes through these so
// the bug class "ad-hoc literal drifts out of schema shape" is
// structurally impossible at the editor's mutation paths.

/**
 * Constructs a plain-text column. `field` references the case
 * property name; `header` is the column's display label.
 */
export function plainColumn(
	field: string,
	header: string,
): Extract<Column, { kind: "plain" }> {
	return { kind: "plain", field, header };
}

/**
 * Constructs a date-formatted column. `pattern` carries the wire-
 * form date format string consumed by the runtime formatter (e.g.
 * `%Y-%m-%d` for ISO output, `%d-%b-%Y` for `27-Apr-2025`).
 *
 * Schema constraint: `pattern` must be non-empty. The schema layer
 * (`dateColumnSchema.pattern: z.string().min(1)`) enforces it at
 * parse — same shape as `formatDateSchema.pattern` on the
 * ValueExpression side. TypeScript can't structurally encode
 * "non-empty string" without a branded subtype + runtime guard at
 * every constructor; the schema is the structural defense, mirroring
 * `formatDate`'s parallel pattern. The editor's
 * `CustomDatePatternInput` primitive surfaces the rejection inline
 * before save.
 */
export function dateColumn(
	field: string,
	header: string,
	pattern: string,
): Extract<Column, { kind: "date" }> {
	return { kind: "date", field, header, pattern };
}

/**
 * Constructs a time-since-until interval column. `threshold` +
 * `unit` drive the per-row "is this overdue?" decision; the
 * `displayLabel` text surfaces when the threshold is exceeded.
 * Wire-emit binds `unit` to one of the `TIME_SINCE_UNITS` enum
 * values; passing a non-enum value is a compile-time error.
 */
export function timeSinceUntilColumn(
	field: string,
	header: string,
	threshold: number,
	unit: TimeSinceUnit,
	displayLabel: string,
): Extract<Column, { kind: "time-since-until" }> {
	return {
		kind: "time-since-until",
		field,
		header,
		threshold,
		unit,
		displayLabel,
	};
}

/**
 * Constructs a phone-number column. The runtime renders the
 * referenced property as a tappable telephone link; static
 * contexts fall back to plain text.
 */
export function phoneColumn(
	field: string,
	header: string,
): Extract<Column, { kind: "phone" }> {
	return { kind: "phone", field, header };
}

/**
 * Constructs an ID-mapping column. `mapping` is the lookup table
 * from raw property value to display label; the runtime renders
 * the matched label or falls back to the raw value when no entry
 * matches.
 */
export function idMappingColumn(
	field: string,
	header: string,
	mapping: readonly IdMappingEntry[],
): Extract<Column, { kind: "id-mapping" }> {
	return {
		kind: "id-mapping",
		field,
		header,
		mapping: [...mapping],
	};
}

/**
 * Constructs a single id-mapping entry. The thin builder mirrors
 * the column-level builder pattern — every IdMappingEntry-producing
 * call site routes through this helper so the bug class "ad-hoc
 * literal drifts out of schema shape" stays structurally
 * impossible. Adding a required field to `idMappingEntrySchema`
 * would surface here as a builder-signature change rather than a
 * silently-rotting raw literal.
 */
export function idMappingEntry(value: string, label: string): IdMappingEntry {
	return { value, label };
}

/**
 * Constructs a late-flag column. The runtime surfaces
 * `flagDisplayValue` when the date property exceeds `threshold ×
 * unit` from the current date; otherwise the cell renders empty.
 */
export function lateFlagColumn(
	field: string,
	header: string,
	threshold: number,
	unit: TimeSinceUnit,
	flagDisplayValue: string,
): Extract<Column, { kind: "late-flag" }> {
	return {
		kind: "late-flag",
		field,
		header,
		threshold,
		unit,
		flagDisplayValue,
	};
}

/**
 * Constructs a search-only column — declares the property as
 * searchable without surfacing a visible cell on the case list.
 * `header` is preserved for the authoring-surface label even
 * though the wire layer skips emission for this kind.
 */
export function searchOnlyColumn(
	field: string,
	header: string,
): Extract<Column, { kind: "search-only" }> {
	return { kind: "search-only", field, header };
}

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
/** Per-column sort config — surfaced from the `CalculatedColumn.sort`
 *  slot and the `SortKey`-side `(type, direction)` pair. Sourced from
 *  the schema so consumers narrowing on the field stay in lockstep
 *  with `sortConfigSchema`. */
export type SortConfig = z.infer<typeof sortConfigSchema>;

/**
 * Constructs a calculated column. The `id` slot is the stable
 * identifier sort keys reference (per the `SortKey.source.calculated`
 * arm) and the live-preview projection labels each computed value
 * by; the `header` slot is the case-list column heading. The
 * `expression` is the AST the wire / SQL emitters lower into a
 * derived per-row value. `sort` is the optional per-column sort
 * config — when present, the runtime can sort the case list by the
 * calculated value without recomputing per row.
 *
 * Routes the structural assembly through one builder so every site
 * that constructs a CalculatedColumn (case-list-config editor,
 * migration script, SA tools wiring, test helpers) carries the same
 * key-order and the same handling of the optional `sort` slot —
 * setting `sort: undefined` would round-trip as a present-with-
 * undefined key under Zod's default strip mode and break equality
 * assertions like `expect(parsed).toEqual(input)`. Builder omits
 * the key when no sort is supplied.
 */
export function calculatedColumn(
	id: string,
	header: string,
	expression: import("./predicate/types").ValueExpression,
	sort?: SortConfig,
): CalculatedColumn {
	return sort === undefined
		? { id, header, expression }
		: { id, header, expression, sort };
}

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

// ── SortKey builders ──────────────────────────────────────────────
//
// Thin builder per discriminated arm + the top-level `sortKey`
// builder. Mirrors the per-arm column-builder pattern above: every
// SortKey-producing call site routes through these so the
// constructed shape always matches the schema. Adding a required
// field to the source / sort key schema surfaces here as a
// builder-signature change rather than a silently-rotting raw
// literal at editor mutation paths.

/**
 * Constructs a property-rooted sort source. The runtime reads the
 * referenced property's value per row and applies the comparator
 * the surrounding `SortKey.type` selects. The `property` slot is a
 * case-property name on the originating case type (no relation
 * walks at the sort layer — those resolve through a calculated
 * column whose expression encodes the walk).
 */
export function propertySortSource(
	property: string,
): Extract<SortKeySource, { kind: "property" }> {
	return { kind: "property", property };
}

/**
 * Constructs a calculated-column sort source. The `columnId`
 * references one of the case-list's `calculatedColumns[i].id`
 * entries; the runtime evaluates the matching expression per row
 * and applies the comparator the surrounding `SortKey.type`
 * selects.
 */
export function calculatedSortSource(
	columnId: string,
): Extract<SortKeySource, { kind: "calculated" }> {
	return { kind: "calculated", columnId };
}

/**
 * Constructs a single sort key. The runtime applies sort keys in
 * declaration order — the first key is the primary sort, each
 * subsequent key acts as a tiebreaker on the previous keys.
 */
export function sortKey(
	source: SortKeySource,
	type: SortType,
	direction: SortDirection,
): SortKey {
	return { source, type, direction };
}

/**
 * Compatibility table from a property's effective `data_type` to
 * the `SortType` set the comparator can meaningfully apply. The
 * editor's per-row type-picker filters on this set; the inline
 * type-mismatch error reads it to decide whether the current
 * `(source, type)` pair is structurally rejected.
 *
 * The matrix:
 *   - text / single_select / multi_select / geopoint → ["plain"].
 *     Only lexicographic comparison is meaningful — these values
 *     are stored as strings at the wire layer; numeric / temporal
 *     casts would silently coerce nonsense.
 *   - int → ["integer", "plain"]. Numeric comparison is the
 *     canonical sort; lexicographic stays available for the rare
 *     "stable display order" case.
 *   - decimal → ["decimal", "plain"]. Same shape as int; the
 *     numeric comparator promotes through the runtime's decimal
 *     arithmetic.
 *   - date / datetime / time → ["date", "plain"]. Calendar
 *     comparison is canonical; lexicographic on ISO strings is a
 *     valid fallback because ISO 8601 is order-preserving. `time`
 *     joins date/datetime here because it's temporally shaped —
 *     the on-device runtime parses it through the same calendar
 *     comparator the wire emitter binds for `date` / `datetime`.
 *
 * Calculated-column sources have no resolvable property type at
 * the source layer; the editor admits all four sort types for
 * them and trusts the user's pick.
 */
export function applicableSortTypes(
	dataType: string | undefined,
): readonly SortType[] {
	switch (dataType) {
		case "int":
			return ["integer", "plain"];
		case "decimal":
			return ["decimal", "plain"];
		case "date":
		case "datetime":
		case "time":
			return ["date", "plain"];
		// `text` / `single_select` / `multi_select` / `geopoint` and
		// the unresolved (`undefined`) case all collapse to plain.
		// Permissive default: when the property isn't declared (or
		// resolves to a non-numeric / non-temporal type), only
		// lexicographic comparison is structurally sound.
		default:
			return ["plain"];
	}
}

// ── Search inputs ─────────────────────────────────────────────────
//
// Search input definitions. Each input declares an authoring-
// surface widget (`type`), an optional case property the input
// targets (`property`), an optional relation walk (`via`), an
// explicit search mode (`mode`), an optional default value
// (`default`), and an optional advanced predicate (`xpath`).

/**
 * Search-input authoring widget kinds. Exported so every consumer
 * that reasons about the closed set — the editor's type picker, the
 * SA tools' tool-schema enum, the validator's per-type / per-mode
 * applicability gate — shares one tuple rather than maintaining
 * parallel copies. Adding a kind cascades to all surfaces in one
 * edit, the same shape `TIME_SINCE_UNITS` / `SORT_TYPES` /
 * `MULTI_SELECT_QUANTIFIERS` use above.
 */
export const SEARCH_INPUT_TYPES = [
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

// ── SearchInputMode builders ──────────────────────────────────────
//
// Thin per-arm constructors. Mirror the per-arm column / sort-key
// builder pattern: every SearchInputMode-producing call site routes
// through one of these so the constructed shape stays in lockstep
// with `searchInputModeSchema`. Adding a required field to a mode
// arm surfaces here as a builder-signature change rather than a
// silently-rotting raw literal at editor mutation paths.

/** Equality match. Wire layer: `prop = value` for property modes;
 *  `prop = ''` for empty-input short-circuits. */
export function exactMode(): Extract<SearchInputMode, { kind: "exact" }> {
	return { kind: "exact" };
}

/** pg_trgm `%` similarity — text-only. Validator gates against
 *  text-shaped property data types. */
export function fuzzyMode(): Extract<SearchInputMode, { kind: "fuzzy" }> {
	return { kind: "fuzzy" };
}

/** Prefix match — text-only. Validator gates against text-shaped
 *  property data types. */
export function startsWithMode(): Extract<
	SearchInputMode,
	{ kind: "starts-with" }
> {
	return { kind: "starts-with" };
}

/** fuzzystrmatch dmetaphone — text-only. Validator gates against
 *  text-shaped property data types. */
export function phoneticMode(): Extract<SearchInputMode, { kind: "phonetic" }> {
	return { kind: "phonetic" };
}

/** Date-permutation match — text-only (the property holds free-form
 *  date text rather than a typed date column). Validator gates
 *  against text-shaped property data types. */
export function fuzzyDateMode(): Extract<
	SearchInputMode,
	{ kind: "fuzzy-date" }
> {
	return { kind: "fuzzy-date" };
}

/** Between-with-bounds — numeric / temporal types. Validator gates
 *  against ordered property data types. */
export function rangeMode(): Extract<SearchInputMode, { kind: "range" }> {
	return { kind: "range" };
}

/** JSONB `@>` (`all`) / `?` (`any`) against a multi-select
 *  property. Validator gates the property's data type to
 *  `multi_select`; the quantifier picks the membership shape. */
export function multiSelectContainsMode(
	quantifier: MultiSelectQuantifier,
): Extract<SearchInputMode, { kind: "multi-select-contains" }> {
	return { kind: "multi-select-contains", quantifier };
}

// ── SearchInputDef builder ────────────────────────────────────────
//
// Single construction surface for `SearchInputDef`. Mirrors the
// pattern `calculatedColumn(...)` uses for its optional `sort` slot:
// when the caller supplies an optional slot whose content is
// absent-equivalent (an undefined value, or — for `via` — the
// `selfPath()` shape that's structurally equivalent to "no walk"),
// the builder OMITS the key entirely so the constructed shape
// round-trips through `safeParse(...).toEqual(input)` against the
// original-shaped persisted document.
//
// This matters at the editor's `RelationPathBuilder` slot: the
// builder defaults to `selfPath()` when the user doesn't author a
// walk, but the schema treats `via: undefined` as the canonical
// "self" shape (per the `searchInputDefSchema`'s "absent ≡ self"
// contract on line 579-582). Without omission here, the editor
// would author `via: { kind: "self" }` on every save and break
// equality assertions.

interface SearchInputDefOptionalSlots {
	/** Optional case property the input targets. When absent, the
	 *  input is "advanced" — every predicate is expressed via
	 *  `xpath`. */
	readonly property?: string;
	/** Optional relation walk to a destination case type. `selfPath()`
	 *  is structurally equivalent to absent and the builder omits
	 *  the key in that case to preserve schema-shape equality. */
	readonly via?: RelationPath;
	/** Optional explicit search mode. When absent, the wire layer
	 *  picks the per-`type` default (text → exact, date-range →
	 *  range, etc.). */
	readonly mode?: SearchInputMode;
	/** Optional default-value expression seeded into the input's
	 *  initial state (e.g. `today()` for date-typed inputs). */
	readonly default?: ValueExpression;
	/** Optional advanced predicate that replaces the
	 *  `(property, mode)`-derived predicate when present. */
	readonly xpath?: Predicate;
}

/**
 * Constructs a `SearchInputDef`. Required slots (`name`, `label`,
 * `type`) are positional; every optional slot is supplied via the
 * `slots` object. The builder OMITS keys whose values are
 * absent-equivalent so the constructed shape round-trips through
 * the schema's strip-mode parse without an `undefined`-valued key
 * leaking past `expect(parsed).toEqual(input)` assertions:
 *
 *   - `via === undefined` OR `via.kind === "self"` → omitted.
 *     `selfPath()` is the schema's canonical "no walk" shape and
 *     `via: undefined` is equivalent (per the schema's "absent ≡
 *     self" contract).
 *   - Every other optional whose value is `undefined` → omitted.
 *
 * Routes the structural assembly through one builder so every
 * `SearchInputDef`-producing call site (case-list-config editor,
 * SA tools wiring, validator test fixtures, migration scripts)
 * carries the same key-order and the same handling of optional
 * slots.
 */
export function searchInputDef(
	name: string,
	label: string,
	type: SearchInputType,
	slots: SearchInputDefOptionalSlots = {},
): SearchInputDef {
	const out: SearchInputDef = { name, label, type };
	// Property — omit when undefined (absent-equivalent at the schema
	// layer). Empty-string is preserved verbatim as the user's
	// "I haven't filled this in yet" state, which the editor surfaces
	// distinctly from "I don't want a property at all" (the former
	// shows the picker placeholder; the latter omits the slot).
	if (slots.property !== undefined) out.property = slots.property;
	// Via — omit when undefined OR `selfPath()`. The latter is the
	// schema's canonical "no walk" shape; both shapes are
	// semantically equivalent at the wire layer (see relationPath
	// emission at `lib/commcare/predicate/...`). Treating both as
	// "omit" keeps round-trip equality against persisted documents
	// that omitted the slot.
	if (slots.via !== undefined && slots.via.kind !== "self") {
		out.via = slots.via;
	}
	if (slots.mode !== undefined) out.mode = slots.mode;
	if (slots.default !== undefined) out.default = slots.default;
	if (slots.xpath !== undefined) out.xpath = slots.xpath;
	return out;
}

// ── Per-type / per-mode applicability ─────────────────────────────
//
// The matrix authoring surfaces use to gate available modes per
// input type AND to surface type-coupling validation errors when
// the targeted property's `data_type` doesn't satisfy the picked
// `(type, mode)` pair. Centralized here so the editor's mode
// picker, the validator's per-input rule, and the SA tool surface
// all read from one source of truth — two independent copies would
// drift; one shared table keeps every surface aligned by
// construction.

/**
 * Modes admitted by each `SearchInputType`. The wire layer's
 * default-mode contract (per `searchInputDefSchema`'s `mode`
 * comment, lines 583-585) selects the first entry of each tuple
 * when the slot is absent: text → exact, select → exact,
 * date → exact, date-range → range, barcode → exact.
 *
 * The order also drives the editor's picker — the first entry is
 * the default; subsequent entries surface as alternative modes the
 * author can pick when their semantics fit.
 */
export const APPLICABLE_SEARCH_MODES: Readonly<
	Record<SearchInputType, readonly SearchInputMode["kind"][]>
> = {
	text: [
		"exact",
		"fuzzy",
		"starts-with",
		"phonetic",
		"fuzzy-date",
		"multi-select-contains",
	],
	select: ["exact", "multi-select-contains"],
	date: ["exact", "range"],
	"date-range": ["range"],
	barcode: ["exact"],
};

/**
 * The tuple of modes admitted for a given input `type`. Read by:
 *
 *   - The editor's per-row mode picker (filters the menu items the
 *     user sees).
 *   - The validator's per-input rule (rejects `(type, mode)` pairs
 *     not in this table at parse time).
 *
 * Never falls through to a fallback — every entry of
 * `SEARCH_INPUT_TYPES` has an explicit row in
 * `APPLICABLE_SEARCH_MODES` (the readonly mapping is keyed on the
 * full tuple, so adding a new type without adding its row is a
 * compile error).
 */
export function applicableSearchModes(
	type: SearchInputType,
): readonly SearchInputMode["kind"][] {
	return APPLICABLE_SEARCH_MODES[type];
}

/**
 * Property `data_type`s admitted by each search-input mode. The
 * editor's per-row type-coupling check + the validator's per-input
 * rule both read this table to flag mismatches between a picked
 * mode and the targeted property's data type.
 *
 * `undefined` in a tuple's place means the mode is unrestricted
 * against the property's `data_type` — `exact` widens to every
 * property type (the wire equality compares serialized values
 * regardless of declared type).
 *
 * Routes through `effectiveDataType(property)` at the call site so
 * un-annotated properties (no `data_type` declared) resolve to
 * `"text"`, matching the type-checker's fallback convention.
 */
export const SEARCH_MODE_PROPERTY_TYPES: Readonly<
	Record<SearchInputMode["kind"], readonly CasePropertyDataType[] | undefined>
> = {
	// `exact` is unrestricted — equality compares against the
	// property's serialized value at the wire layer regardless of
	// declared type.
	exact: undefined,
	// Approximate-string modes — text-shaped only.
	fuzzy: ["text", "single_select", "multi_select"],
	"starts-with": ["text", "single_select", "multi_select"],
	phonetic: ["text", "single_select", "multi_select"],
	// `fuzzy-date` widens to text + temporal — the operator recovers
	// from transposed date input against typed dates AND free-form
	// date text. Mirrors the type-checker's `MATCH_PROPERTY_TYPES_FUZZY_DATE`
	// allow-list at `lib/domain/predicate/typeChecker.ts:301-306`.
	"fuzzy-date": ["text", "single_select", "multi_select", "date", "datetime"],
	// `range` requires totally-ordered types — numeric or temporal.
	range: ["int", "decimal", "date", "datetime", "time"],
	// `multi-select-contains` requires a `multi_select` property at
	// the JSONB layer; `single_select` is also admitted because its
	// option-value semantics overlap with single-element multi-select
	// (the SQL emitter normalizes to a singleton array). The validator
	// surface keeps both admitted; if a future tightening narrows to
	// `multi_select`-only, the change lives here and propagates to
	// every consumer.
	"multi-select-contains": ["multi_select", "single_select"],
};

/**
 * The data types admitted by each `SearchInputType`'s widget kind.
 * Used by the editor's type-coupling check to flip `valid: false`
 * when the picked widget kind doesn't match the targeted property's
 * `data_type`:
 *
 *   - `text` — admits every type; the input always serializes as a
 *     string and the wire layer handles the cast at evaluation.
 *   - `select` — admits select-typed properties (single + multi).
 *   - `date` / `date-range` — admit calendar-shaped properties
 *     (`date` / `datetime`). `time` is excluded — neither widget
 *     surfaces a time-only picker.
 *   - `barcode` — admits text-only properties; barcodes scan as
 *     plain strings.
 *
 * `undefined` in a tuple's place means the widget kind is
 * unrestricted against the property's `data_type` — surfaced for
 * `text`, where every wire-shape coerces through string.
 */
export const SEARCH_INPUT_TYPE_PROPERTY_TYPES: Readonly<
	Record<SearchInputType, readonly CasePropertyDataType[] | undefined>
> = {
	text: undefined,
	select: ["single_select", "multi_select"],
	date: ["date", "datetime"],
	"date-range": ["date", "datetime"],
	barcode: ["text"],
};

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
