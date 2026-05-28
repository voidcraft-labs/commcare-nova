// lib/domain/modules.ts
//
// Module schema. Owns the structured `caseListConfig` shape that
// drives every case-list authoring surface. The shape is the single
// source of truth the validator, wire emitters, SA tools, and case-
// list-config UI all read from.
//
// `caseListConfig` collapses to three slots:
//
//   - `columns: Column[]` — display + sort + calc + visibility, all
//     here. Each column carries its own `uuid` (UI identity, drag /
//     reorder handle, AST references), an optional `sort` (per-
//     column direction + priority on the column itself), and optional
//     `visibleInList` / `visibleInDetail` flags (absent ≡ visible).
//   - `filter?: Predicate` — single optional always-on predicate
//     applied to every row before display.
//   - `searchInputs: SearchInputDef[]` — discriminated union of
//     simple `(property, mode, via)` inputs and advanced inputs
//     whose body is a free-form `predicate`.
//
// `Predicate`, `ValueExpression`, and `RelationPath` come from
// `@/lib/domain/predicate` — the AST primitives the filter,
// calculated-column expression, search-input default, and search-
// input advanced predicate slots reference. Importing them here
// (rather than redefining the shapes) keeps the AST cycles
// consolidated in one package and keeps every authoring surface
// bound against the same Zod schemas.

import { z } from "zod";
import type { CasePropertyDataType } from "./casePropertyTypes";
import { assetIdSchema } from "./multimedia";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "./predicate/types";
import {
	CASE_PROPERTY_PATTERN,
	predicateSchema,
	relationPathSchema,
	valueExpressionSchema,
	XML_ELEMENT_NAME_PATTERN,
} from "./predicate/types";
import { type Uuid, uuidSchema } from "./uuid";

// ── Sort + visibility — common column slots ──────────────────────
//
// Column-level sort: a column optionally carries its own sort
// direction + priority. The sort runtime applies columns in
// ascending `priority` order — `priority: 0` is the primary sort,
// subsequent priorities act as tiebreakers.
//
// `priority` is a non-negative integer (the schema's `int().min(0)`
// rejects negatives at parse). Two columns at the same priority
// tie-break to display order in `caseListConfig.columns` — that
// rule binds at the saga, preview, and wire-emission layers; the
// editor maintains uniqueness on save, but the tie-break exists for
// transient (undo / partial-save) editor states. No layer assumes
// uniqueness.
//
// The comparator type (lexicographic / numeric / date / decimal)
// is NOT authored here — wire emission derives it from the case
// property's `data_type` (or, for calculated columns, from the
// expression's resolved result type).

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * Sort comparator types — `plain` (lexicographic) / `date`
 * (calendar) / `integer` / `decimal` (numeric). Wire emitters
 * select the comparator from a column's resolved data type;
 * authoring never names one directly.
 */
export const SORT_TYPES = ["plain", "date", "integer", "decimal"] as const;
export type SortType = (typeof SORT_TYPES)[number];

/**
 * Per-column sort directive. Carries direction + priority only —
 * the comparator type is derived at wire emission, not authored.
 *
 * `priority` is a non-negative integer; tie-break to column display
 * order is uniform across saga / preview / wire layers (no layer
 * assumes uniqueness).
 */
export const columnSortSchema = z
	.object({
		direction: z.enum(SORT_DIRECTIONS),
		priority: z.number().int().min(0),
	})
	.strict();
export type ColumnSort = z.infer<typeof columnSortSchema>;

// ── Interval-column units ────────────────────────────────────────

/**
 * Interval-column unit set. Single source of truth for both the
 * schema's `z.enum(...)` constraint AND every consumer that renders
 * a unit picker — exporting the tuple keeps the dropdown options in
 * lockstep with the schema's accepted set. Adding a unit here
 * cascades to the picker without a parallel edit (the structural-
 * subtype `readonly TimeSinceUnit[]` array shape can silently
 * accept a strict subset).
 */
export const TIME_SINCE_UNITS = ["days", "weeks", "months", "years"] as const;
export type TimeSinceUnit = (typeof TIME_SINCE_UNITS)[number];

/**
 * Display dispatch for `interval` columns:
 *
 *   - `"always"` — always show the relative interval (e.g. "3
 *     days ago"). The threshold + unit drive an "is this overdue?"
 *     decision the runtime can surface in the cell.
 *   - `"flag"` — only show `text` when the threshold is exceeded;
 *     otherwise the cell is empty. Used for "overdue" / "follow-up
 *     needed" signal columns where the absence-of-flag is itself
 *     the typical state.
 */
export const INTERVAL_DISPLAYS = ["always", "flag"] as const;
export type IntervalDisplay = (typeof INTERVAL_DISPLAYS)[number];

// ── Common column-slot helpers ───────────────────────────────────
//
// Every column kind carries the same base slots: `uuid` for UI
// identity, optional `sort` for column-level sort directive,
// optional `visibleInList` / `visibleInDetail` for surface
// filtering. Centralized here so every per-kind schema below
// extends the same base.

/**
 * Optional surface-visibility + sort slots shared by every column
 * kind. Absent slots default to "visible" at the wire layer; the
 * schema preserves the slot's presence so the editor can
 * distinguish "user explicitly toggled off" from "user never
 * toggled".
 */
const columnCommonSlots = z
	.object({
		sort: columnSortSchema.optional(),
		visibleInList: z.boolean().optional(),
		visibleInDetail: z.boolean().optional(),
	})
	.strict();

/** Base shape every column kind extends — uuid + the common
 *  optional slots (sort, visibility). Per-kind schemas add their
 *  required configuration on top. The `.strict()` on the base
 *  propagates through every `columnBase.extend({...})` chain below,
 *  so per-kind schemas reject unknown keys without restating
 *  `.strict()` on each arm. */
const columnBase = z
	.object({ uuid: uuidSchema })
	.extend(columnCommonSlots.shape)
	.strict();

// ── Column kinds ─────────────────────────────────────────────────
//
// Seven discriminated arms. The `kind` discriminant routes the column
// through the matching wire emitter and editor body. Calculated
// columns have no `field` slot — the expression is the source.

/**
 * Plain text column — renders the property value as a string.
 * Default kind for any displayed column.
 */
const plainColumnSchema = columnBase.extend({
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
 * `pattern` rejects empty strings — symmetric with `formatDateSchema.pattern`
 * on the ValueExpression side. Both fields drive the same CCHQ
 * format-date runtime; an empty pattern would render the property's
 * raw ISO string at the wire boundary, defeating the column's
 * purpose. Backed at the editor by an inline empty-pattern signal
 * in the shared `CustomDatePatternInput` primitive.
 */
const dateColumnSchema = columnBase.extend({
	kind: z.literal("date"),
	field: z.string(),
	header: z.string(),
	pattern: z.string().min(1),
});

/**
 * Phone-number column — renders the property as a tappable phone
 * link in the running app. Plain text in static contexts.
 */
const phoneColumnSchema = columnBase.extend({
	kind: z.literal("phone"),
	field: z.string(),
	header: z.string(),
});

/**
 * ID-mapping column — renders a lookup table from property value
 * to display label (e.g. region code → human-readable region
 * name). The mapping is authored explicitly; values not in the
 * table render as the raw property value.
 */
const idMappingEntrySchema = z
	.object({
		// Whitespace-free token (or empty during authoring). The wire
		// emits the entry as `selected(field, '<value>')`; CommCare's
		// `selected()` is the XPath 1.0 space-tokenized membership
		// predicate (it splits the property value on whitespace and
		// checks set membership), so a `value` carrying whitespace
		// would never match any case row — silent runtime failure.
		// Reject whitespace at the schema layer where the shape is
		// constructed; admit empty as the "row added, not yet filled"
		// state the editor seeds before the user types.
		value: z
			.string()
			.regex(
				/^\S*$/,
				"ID-mapping value must be a single whitespace-free token — the wire layer matches it via XPath's space-tokenized `selected()` predicate, which splits both sides on whitespace before testing set membership. A value with spaces would never match any property and the cell would silently fall through to the raw property value.",
			),
		label: z.string(),
	})
	.strict();
const idMappingColumnSchema = columnBase.extend({
	kind: z.literal("id-mapping"),
	field: z.string(),
	header: z.string(),
	// Mapping values must be unique within a column. The wire emitter
	// builds the cell text by joining one `if(selected(field, '<value>'),
	// '<label>', '')` arm per entry — duplicate values match the same
	// row and the cell concatenates every matching arm's label, which
	// surfaces nothing the authoring layer predicts. Authors who
	// genuinely want one value to render as multiple labels concatenate
	// them inside one `label` slot.
	mapping: z
		.array(idMappingEntrySchema)
		.refine(
			(entries) => new Set(entries.map((e) => e.value)).size === entries.length,
			{
				message:
					"Mapping values are not unique within this column — two or more entries share the same `value`. The wire layer matches one row against every entry with a matching value, so duplicates would produce a cell that concatenates each matching label. Keep one entry per value and merge any duplicate labels into that entry's `label` slot.",
			},
		),
});

/**
 * Single image-map entry — pairs a case-property value with the image
 * `AssetId` shown for that value. The image-map analogue of
 * `idMappingEntrySchema`: same whitespace-free `value` token (matched
 * on the wire via XPath's space-tokenized `selected()` predicate), but
 * the cell renders the mapped IMAGE instead of a text label.
 */
const imageMapEntrySchema = z
	.object({
		// Same whitespace-free constraint + rationale as the id-mapping
		// entry's `value`: the wire emits `selected(field, '<value>')`,
		// which splits on whitespace before testing membership, so a value
		// carrying whitespace would never match any case row.
		value: z
			.string()
			.regex(
				/^\S*$/,
				"Image-map value must be a single whitespace-free token — the wire layer matches it via XPath's space-tokenized `selected()` predicate, which splits both sides on whitespace before testing set membership. A value with spaces would never match any property and the cell would render no image.",
			),
		assetId: assetIdSchema,
	})
	.strict();
const imageMapColumnSchema = columnBase.extend({
	kind: z.literal("image-map"),
	field: z.string(),
	header: z.string(),
	// Mapping values must be unique within a column — same rationale as
	// id-mapping: the wire emits one `if(selected(field, '<value>'), …)`
	// arm per entry, so two entries sharing a value both match the same
	// row and the cell concatenates their image paths into one
	// unrenderable string.
	mapping: z
		.array(imageMapEntrySchema)
		.refine(
			(entries) => new Set(entries.map((e) => e.value)).size === entries.length,
			{
				message:
					"Mapping values are not unique within this image-map column — two or more entries share the same `value`. The wire layer matches one row against every entry with a matching value, so duplicates would concatenate each matching image path into one unrenderable cell. Keep one entry per value.",
			},
		),
});

/**
 * Interval column — renders a relative interval against the
 * property's date value. The `display` slot dispatches the cell
 * shape:
 *
 *   - `"always"` — always show the relative interval (e.g. "3
 *     days ago"). `text` is the runtime label that decorates
 *     "overdue" cells when the threshold is exceeded.
 *   - `"flag"` — only show `text` when the threshold is exceeded;
 *     otherwise the cell renders empty.
 *
 * The threshold + unit drive the per-row "is this overdue?"
 * decision in both arms.
 */
const intervalColumnSchema = columnBase.extend({
	kind: z.literal("interval"),
	field: z.string(),
	header: z.string(),
	// Positive integer count of `unit`s. A negative or zero threshold
	// would flag every non-empty cell in the `flag` arm (the wire
	// emits `if(today() - date(field) > <threshold>, '*', '')`) and
	// would show "X days ago" with a negative count in the `always`
	// arm — both shapes are structurally authoring errors masquerading
	// as working configuration, not legitimate authorings to admit.
	threshold: z.number().int().positive(),
	unit: z.enum(TIME_SINCE_UNITS),
	display: z.enum(INTERVAL_DISPLAYS),
	text: z.string(),
});

/**
 * Calculated column — author-defined `ValueExpression` that yields
 * a derived per-row value (e.g. "days since last visit",
 * "concatenated full name"). Has no `field` slot — the expression
 * is the source. The wire emitter lowers the expression into a
 * Postgres expression / on-device XPath / CSQL fragment.
 *
 * Calculated columns participate in column-level sort like every
 * other column; the comparator type at wire emission is derived
 * from the expression's resolved result type.
 */
const calculatedColumnSchema = columnBase.extend({
	kind: z.literal("calculated"),
	header: z.string(),
	expression: valueExpressionSchema,
});

export const columnSchema = z.discriminatedUnion("kind", [
	plainColumnSchema,
	dateColumnSchema,
	phoneColumnSchema,
	idMappingColumnSchema,
	imageMapColumnSchema,
	intervalColumnSchema,
	calculatedColumnSchema,
]);
export type Column = z.infer<typeof columnSchema>;
export type ColumnKind = Column["kind"];

/** Single id-mapping entry — value-to-label pair surfaced by the
 *  id-mapping column's lookup table. Constructing through the
 *  matching builder pins the key order and keeps ad-hoc literals
 *  from drifting out of the schema. */
export type IdMappingEntry = z.infer<typeof idMappingEntrySchema>;

// ── Column builders ───────────────────────────────────────────────
//
// One thin builder per `ColumnKind` arm. Each takes `uuid: Uuid`
// explicitly as the first arg so call sites pin identity before any
// per-kind config — mirrors the explicit-uuid stance the field
// schemas take (`{ uuid, id, ... }` on every Field arm).
//
// Common optional slots (`sort`, `visibleInList`, `visibleInDetail`)
// are passed via a `slots` object. Builders OMIT keys whose values
// are undefined so the constructed shape round-trips through the
// schema's strip-mode parse — equality assertions like
// `expect(parsed).toEqual(input)` would otherwise fail on the
// present-with-undefined keys.

/**
 * Optional surface-visibility + sort slots shared across every
 * column-builder signature. The schema layer makes each slot
 * optional; the builder convention is to OMIT keys whose values are
 * undefined so round-trip equality stays clean.
 */
export interface ColumnCommonSlots {
	readonly sort?: ColumnSort;
	readonly visibleInList?: boolean;
	readonly visibleInDetail?: boolean;
}

/**
 * Spreads the common optional slots onto a column object only when
 * present. Avoids leaking `key: undefined` shapes that would fail
 * `toEqual` round-trip assertions.
 */
function withCommonSlots<T extends Record<string, unknown>>(
	base: T,
	slots: ColumnCommonSlots,
): T & ColumnCommonSlots {
	const out: T & {
		sort?: ColumnSort;
		visibleInList?: boolean;
		visibleInDetail?: boolean;
	} = { ...base };
	if (slots.sort !== undefined) out.sort = slots.sort;
	if (slots.visibleInList !== undefined)
		out.visibleInList = slots.visibleInList;
	if (slots.visibleInDetail !== undefined)
		out.visibleInDetail = slots.visibleInDetail;
	return out;
}

/**
 * Constructs a plain-text column. `field` references the case
 * property name; `header` is the column's display label.
 */
export function plainColumn(
	uuid: Uuid,
	field: string,
	header: string,
	slots: ColumnCommonSlots = {},
): Extract<Column, { kind: "plain" }> {
	return withCommonSlots(
		{ uuid, kind: "plain" as const, field, header },
		slots,
	);
}

/**
 * Constructs a date-formatted column. `pattern` carries the wire-
 * form date format string consumed by the runtime formatter (e.g.
 * `%Y-%m-%d` for ISO output, `%d-%b-%Y` for `27-Apr-2025`).
 *
 * Schema constraint: `pattern` must be non-empty (the schema layer
 * rejects empties at parse — same shape as `formatDateSchema.pattern`
 * on the ValueExpression side). The editor's `CustomDatePatternInput`
 * primitive surfaces the rejection inline before save.
 */
export function dateColumn(
	uuid: Uuid,
	field: string,
	header: string,
	pattern: string,
	slots: ColumnCommonSlots = {},
): Extract<Column, { kind: "date" }> {
	return withCommonSlots(
		{ uuid, kind: "date" as const, field, header, pattern },
		slots,
	);
}

/**
 * Constructs a phone-number column. The runtime renders the
 * referenced property as a tappable telephone link; static
 * contexts fall back to plain text.
 */
export function phoneColumn(
	uuid: Uuid,
	field: string,
	header: string,
	slots: ColumnCommonSlots = {},
): Extract<Column, { kind: "phone" }> {
	return withCommonSlots(
		{ uuid, kind: "phone" as const, field, header },
		slots,
	);
}

/**
 * Constructs an ID-mapping column. `mapping` is the lookup table
 * from raw property value to display label; the runtime renders
 * the matched label or falls back to the raw value when no entry
 * matches.
 */
export function idMappingColumn(
	uuid: Uuid,
	field: string,
	header: string,
	mapping: readonly IdMappingEntry[],
	slots: ColumnCommonSlots = {},
): Extract<Column, { kind: "id-mapping" }> {
	return withCommonSlots(
		{ uuid, kind: "id-mapping" as const, field, header, mapping: [...mapping] },
		slots,
	);
}

/**
 * Constructs a single id-mapping entry. Mirrors the column-level
 * builder pattern — every IdMappingEntry-producing call site routes
 * through this helper so the bug class "ad-hoc literal drifts out of
 * schema shape" stays structurally impossible.
 */
export function idMappingEntry(value: string, label: string): IdMappingEntry {
	return { value, label };
}

/** Single image-map entry — value-to-image-`AssetId` pair surfaced by
 *  an image-map column's lookup. Constructing through the matching
 *  builder pins the key order against schema drift. */
export type ImageMapEntry = z.infer<typeof imageMapEntrySchema>;

/**
 * Constructs an image-map column. `mapping` is the lookup table from
 * raw property value to image `AssetId`; the runtime renders the
 * matched image (no image when no entry matches). Mirrors
 * `idMappingColumn` — same value-keyed lookup shape, image instead of
 * a text label.
 */
export function imageMapColumn(
	uuid: Uuid,
	field: string,
	header: string,
	mapping: readonly ImageMapEntry[],
	slots: ColumnCommonSlots = {},
): Extract<Column, { kind: "image-map" }> {
	return withCommonSlots(
		{ uuid, kind: "image-map" as const, field, header, mapping: [...mapping] },
		slots,
	);
}

/** Constructs a single image-map entry. Routes every entry through one
 *  helper so ad-hoc literals can't drift out of the schema shape. */
export function imageMapEntry(value: string, assetId: string): ImageMapEntry {
	return { value, assetId };
}

/**
 * Constructs an interval column. `display` selects between the two
 * cell shapes:
 *
 *   - `"always"` — always show the relative interval; `text`
 *     decorates the cell when the threshold is exceeded.
 *   - `"flag"` — only show `text` when the threshold is exceeded;
 *     otherwise empty cell.
 *
 * The threshold + unit drive the per-row "is this overdue?"
 * decision in both arms. Wire-emit binds `unit` to a `TIME_SINCE_UNITS`
 * value; passing a non-enum value is a compile-time error.
 */
export function intervalColumn(
	uuid: Uuid,
	field: string,
	header: string,
	threshold: number,
	unit: TimeSinceUnit,
	display: IntervalDisplay,
	text: string,
	slots: ColumnCommonSlots = {},
): Extract<Column, { kind: "interval" }> {
	return withCommonSlots(
		{
			uuid,
			kind: "interval" as const,
			field,
			header,
			threshold,
			unit,
			display,
			text,
		},
		slots,
	);
}

/**
 * Constructs a calculated column. The `expression` AST is the
 * source — there is no `field` slot. The wire / SQL emitters lower
 * the expression into a derived per-row value, and column-level
 * sort uses the expression's resolved result type to pick a
 * comparator at wire emission.
 */
export function calculatedColumn(
	uuid: Uuid,
	header: string,
	expression: ValueExpression,
	slots: ColumnCommonSlots = {},
): Extract<Column, { kind: "calculated" }> {
	return withCommonSlots(
		{ uuid, kind: "calculated" as const, header, expression },
		slots,
	);
}

// ── Search inputs ─────────────────────────────────────────────────
//
// Search input declarations. The discriminated union splits two
// authoring shapes:
//
//   - `simple` — `(property, mode, via)` triple. The wire layer
//     builds the predicate from the targeted property's value, the
//     mode (exact / fuzzy / range / etc.), and the optional
//     relation walk. `property` is REQUIRED on this arm — there is
//     no escape hatch for a property-less simple input.
//   - `advanced` — free-form `predicate` (a `Predicate` AST). The
//     wire layer emits the predicate verbatim; the editor surfaces
//     a `PredicateCardEditor` in this arm.
//
// Common slots (`uuid`, `name`, `label`, `type`, `default?`) appear
// on both arms.

/**
 * Search-input authoring widget kinds. Single source of truth for
 * the editor's type picker, the SA tools' tool-schema enum, and the
 * validator's per-type / per-mode applicability gate.
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
 *   - `fuzzy-date` — date permutation match (text or temporal).
 *   - `range` — between-with-bounds (numeric / date / datetime / time).
 *   - `multi-select-contains` — JSONB `@>` / `?` against a
 *     `multi_select` property; the quantifier picks `any` (∃)
 *     vs `all` (∀).
 */
const searchInputModeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("exact") }).strict(),
	z.object({ kind: z.literal("fuzzy") }).strict(),
	z.object({ kind: z.literal("starts-with") }).strict(),
	z.object({ kind: z.literal("phonetic") }).strict(),
	z.object({ kind: z.literal("fuzzy-date") }).strict(),
	z.object({ kind: z.literal("range") }).strict(),
	z
		.object({
			kind: z.literal("multi-select-contains"),
			quantifier: z.enum(MULTI_SELECT_QUANTIFIERS),
		})
		.strict(),
]);
export type SearchInputMode = z.infer<typeof searchInputModeSchema>;

// Common slots present on every SearchInputDef arm. `.strict()`
// propagates through the `searchInputCommon.extend({...})` chains
// for `simpleSearchInputSchema` and `advancedSearchInputSchema`,
// so each arm rejects unknown keys at parse time.
//
// `name` is constrained to XML element-name vocabulary because the
// wire layer interpolates it as both an attribute value
// (`<prompt key="X">`) and an XPath token
// (`instance('search-input:results')/input/field[@name='X']`). The
// `Term.input` reference shape already gates on the same pattern;
// matching the declaration's character class keeps both halves of
// the binding interchangeable — an authored name can always be
// referenced from a predicate without being silently rejected by
// the predicate's stricter character rules.
const searchInputCommon = z
	.object({
		uuid: uuidSchema,
		name: z
			.string()
			.regex(
				XML_ELEMENT_NAME_PATTERN,
				"Search input `name` must start with a letter or underscore and contain only letters, digits, or underscores. The name is interpolated both as an XML attribute value on the wire `<prompt>` and as an XPath token in the CSQL `instance('search-input:results')/input/field[@name='…']` reference; characters outside that class break one or both bindings.",
			),
		label: z.string(),
		type: z.enum(SEARCH_INPUT_TYPES),
		default: valueExpressionSchema.optional(),
	})
	.strict();

/**
 * Simple search input — the (property, mode, via) shape. The wire
 * layer builds a predicate from the targeted property's value, the
 * mode (defaulted at wire-emit when absent), and an optional
 * relation walk to a destination case type.
 *
 * `property` is REQUIRED on this arm — a property-less input is the
 * `advanced` arm by definition.
 */
const simpleSearchInputSchema = searchInputCommon.extend({
	kind: z.literal("simple"),
	// `property` is constrained to CommCare's case-property identifier
	// vocabulary — same character class the predicate AST's
	// `propertyRefSchema.property` enforces. The wire emitter
	// interpolates this verbatim into XPath fragments (the per-mode
	// derivations in `buildSimpleArmClause`); a value containing
	// quotes / parentheses / angle brackets would emit malformed
	// XPath. Keeping the constraint symmetric with the AST's
	// reference shape closes the SearchInputDef-vs-Term asymmetry the
	// predicate validator can't catch (the simple arm derives the
	// predicate at wire-emit, not at validate-time). Empty string is
	// the "row added, not yet picked" transient editor state —
	// `searchInputModeMatchesPropertyType`'s
	// `CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY` surfaces it at
	// validate-time.
	property: z
		.string()
		.refine((v) => v === "" || CASE_PROPERTY_PATTERN.test(v), {
			message:
				"Search input `property` must name a case property — a string starting with a letter and made of letters, digits, underscores, or hyphens. The wire layer interpolates the name verbatim into the XPath fragment built from the input's (property, mode) shape, so characters outside that class would emit malformed XPath.",
		}),
	via: relationPathSchema.optional(),
	mode: searchInputModeSchema.optional(),
});

/**
 * Advanced search input — the `predicate` arm. The slot's body is a
 * full `Predicate` AST that replaces the (property, mode)-derived
 * predicate. The editor surfaces a `PredicateCardEditor` against
 * this slot.
 */
const advancedSearchInputSchema = searchInputCommon.extend({
	kind: z.literal("advanced"),
	predicate: predicateSchema,
});

export const searchInputDefSchema = z.discriminatedUnion("kind", [
	simpleSearchInputSchema,
	advancedSearchInputSchema,
]);
export type SearchInputDef = z.infer<typeof searchInputDefSchema>;
export type SimpleSearchInputDef = Extract<SearchInputDef, { kind: "simple" }>;
export type AdvancedSearchInputDef = Extract<
	SearchInputDef,
	{ kind: "advanced" }
>;

// ── SearchInputMode builders ──────────────────────────────────────
//
// Thin per-arm constructors. Mirror the per-arm column / sort
// builder pattern: every SearchInputMode-producing call site routes
// through one of these so the constructed shape stays in lockstep
// with `searchInputModeSchema`.

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

/** Date-permutation match — text or temporal. Validator gates
 *  against the per-mode property-type allow-list. */
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

// ── SearchInputDef builders ───────────────────────────────────────
//
// Per-arm constructors. The two arms have distinct required slots —
// `simple` carries `property`, `advanced` carries `predicate` — so
// per-arm builders pin the discriminator and the per-arm required
// shape. Optional slots are passed via a `slots` object; the
// builders OMIT keys whose values are absent-equivalent so the
// constructed shape round-trips through the schema's strip-mode
// parse cleanly.
//
// `via` has an extra rule: `selfPath()` is the schema's canonical
// "no walk" shape and `via: undefined` is structurally equivalent.
// The builder treats both as omit so a saved doc that omitted the
// slot round-trips equal to a freshly-built one.

/** Shared optional slot — both SearchInputDef arms accept a
 *  `default` value expression that seeds the input's initial state
 *  (e.g. `today()` for date-typed inputs). */
interface SearchInputCommonSlots {
	readonly default?: ValueExpression;
}

interface SimpleSearchInputSlots extends SearchInputCommonSlots {
	/** Optional relation walk to a destination case type. `selfPath()`
	 *  is structurally equivalent to absent and the builder omits the
	 *  key in that case. */
	readonly via?: RelationPath;
	/** Optional explicit search mode. When absent, the wire layer
	 *  picks the per-`type` default (text → exact, date-range → range,
	 *  etc.). */
	readonly mode?: SearchInputMode;
}

/**
 * Spreads the shared `default` slot onto a search-input object only
 * when present — mirrors `withCommonSlots` for columns. Avoids
 * leaking `default: undefined` shapes that would fail `toEqual`
 * round-trip assertions.
 */
function withSearchInputCommonSlots<T extends Record<string, unknown>>(
	base: T,
	slots: SearchInputCommonSlots,
): T & SearchInputCommonSlots {
	const out: T & { default?: ValueExpression } = { ...base };
	if (slots.default !== undefined) out.default = slots.default;
	return out;
}

/**
 * Constructs a simple search input. `property` is required (no
 * escape hatch — a property-less input belongs on the `advanced`
 * arm). The builder OMITS optional slots whose values are absent-
 * equivalent so round-trip equality against persisted documents
 * stays clean:
 *
 *   - `via === undefined` OR `via.kind === "self"` → omitted.
 *   - `mode === undefined` → omitted.
 *   - `default === undefined` → omitted.
 */
export function simpleSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	property: string,
	slots: SimpleSearchInputSlots = {},
): SimpleSearchInputDef {
	const out: SimpleSearchInputDef = {
		uuid,
		kind: "simple",
		name,
		label,
		type,
		property,
	};
	if (slots.default !== undefined) out.default = slots.default;
	if (slots.via !== undefined && slots.via.kind !== "self") out.via = slots.via;
	if (slots.mode !== undefined) out.mode = slots.mode;
	return out;
}

/**
 * Constructs an advanced search input. The `predicate` body
 * replaces the simple-arm `(property, mode, via)` derivation; the
 * wire layer emits the predicate verbatim. The optional `default`
 * slot seeds the input's initial value and is omitted when absent.
 */
export function advancedSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	predicate: Predicate,
	slots: SearchInputCommonSlots = {},
): AdvancedSearchInputDef {
	return withSearchInputCommonSlots(
		{ uuid, kind: "advanced" as const, name, label, type, predicate },
		slots,
	);
}

// ── Per-type / per-mode applicability ─────────────────────────────
//
// The matrix authoring surfaces use to gate available modes per
// input type AND to surface type-coupling validation errors when
// the targeted property's `data_type` doesn't satisfy the picked
// `(type, mode)` pair. Centralized here so the editor's mode
// picker, the validator's per-input rule, and the SA tool surface
// all read from one source of truth.

/**
 * Modes admitted by each `SearchInputType`. The wire layer's
 * default-mode contract selects the first entry of each tuple when
 * the slot is absent: text → exact, select → exact, date → exact,
 * date-range → range, barcode → exact.
 *
 * The order also drives the editor's picker — the first entry is
 * the default; subsequent entries surface as alternatives the
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
 *   - The editor's per-row mode picker (filters menu items).
 *   - The validator's per-input rule (rejects `(type, mode)` pairs
 *     not in this table at parse time).
 *
 * Never falls through — every `SEARCH_INPUT_TYPES` entry has an
 * explicit row (the readonly mapping is keyed on the full tuple, so
 * adding a new type without adding its row is a compile error).
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
 * un-annotated properties resolve to `"text"`, matching the type-
 * checker's fallback convention.
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
	// `fuzzy-date` widens to text + temporal — recovers from
	// transposed date input against typed dates AND free-form date
	// text. Mirrors the type-checker's `MATCH_PROPERTY_TYPES_FUZZY_DATE`
	// allow-list at `lib/domain/predicate/typeChecker.ts`.
	"fuzzy-date": ["text", "single_select", "multi_select", "date", "datetime"],
	// `range` requires totally-ordered types — numeric or temporal.
	range: ["int", "decimal", "date", "datetime", "time"],
	// `multi-select-contains` admits `multi_select` (the canonical
	// JSONB membership match) AND `single_select` — the SQL emitter
	// normalizes a single-select value to a singleton array so the
	// containment operator's semantics carry over.
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

/**
 * The resolved type each `SearchInputType` widget expects its
 * `default` value-expression to produce. Used by the validator's
 * per-input default type-check (`searchInputDefaultTypeCheck`)
 * to gate the seed expression's resolution against the widget's
 * shape.
 *
 *   - `text` → `"text"` — text widget admits any text-typed seed.
 *   - `select` → `"text"` — `typesCompatible(text, single_select)`
 *     and `typesCompatible(text, multi_select)` both hold per the
 *     predicate AST type checker, so a `text`-typed seed coerces
 *     cleanly into a select widget at runtime.
 *   - `date` → `"date"` — calendar widget expects a date-shaped
 *     seed. `typesCompatible` does NOT widen `datetime` to `date`,
 *     so authors needing a datetime seed for a date widget must
 *     coerce explicitly via `dateCoerce(...)`.
 *   - `date-range` → `"date"` — same as `date`. The single
 *     value-expression default seeds the range's start (or both
 *     ends, runtime-composed); per CCHQ, `daterange` widgets
 *     render a calendar picker (not datetime).
 *   - `barcode` → `"text"` — barcode-scanned values surface as
 *     plain strings.
 *
 * Single source of truth — the editor's per-widget default
 * authoring surface, the SA tool surface, and the validator all
 * read from this table.
 */
export const SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES: Readonly<
	Record<SearchInputType, CasePropertyDataType>
> = {
	text: "text",
	select: "text",
	date: "date",
	"date-range": "date",
	barcode: "text",
};

/**
 * The `SearchInputMode["kind"]` arms that can drive a per-input
 * default — i.e. the modes the runtime-bindings / wire-emission
 * pipelines can pick without additional configuration. `"multi-
 * select-contains"` requires a `quantifier` slot that no default-
 * mode table can supply (and no widget defaults to it anyway), so
 * the type excludes it.
 */
export type DefaultableModeKind = Exclude<
	SearchInputMode["kind"],
	"multi-select-contains"
>;

/**
 * Per-`SearchInputType` default search-mode kind. Single source of
 * truth across three consumers: the runtime-bindings layer
 * (`lib/preview/engine/runtimeBindings.ts::defaultModeFor`), the
 * wire-emission simple-arm derivation
 * (`lib/commcare/suite/case-search/simpleArmDerivation.ts`), and
 * the validator's mode-resolution helper
 * (`lib/commcare/validator/rules/case-list/searchInputViaModeCompatibility.ts`).
 *
 * A new `SearchInputType` arm fails to compile in this `Record`
 * before reaching any consumer — adding a widget type without
 * picking its default mode is a structural error.
 */
export const DEFAULT_SEARCH_MODE_KIND: Readonly<
	Record<SearchInputType, DefaultableModeKind>
> = {
	text: "exact",
	select: "exact",
	date: "exact",
	"date-range": "range",
	barcode: "exact",
};

// ── CaseListConfig ───────────────────────────────────────────────
//
// The structured case-list configuration. Three slots:
//
//   - `columns` — display + sort + calc + visibility, all here.
//   - `filter?` — optional always-on predicate.
//   - `searchInputs` — discriminated `simple` / `advanced` union.
//
// A module without a case list (survey-only modules) omits the slot
// entirely; a module with a case list always carries every required
// sub-field, even if `columns` / `searchInputs` are empty arrays.

export const caseListConfigSchema = z
	.object({
		columns: z.array(columnSchema),
		filter: predicateSchema.optional(),
		searchInputs: z.array(searchInputDefSchema),
		/**
		 * Image shown on the "Open case list" affordance — the menu
		 * link from the module's home screen that opens the case
		 * list.
		 */
		icon: assetIdSchema.optional(),
		/**
		 * Audio prompt paired with the case-list link, for
		 * audio-prompt playback. Menu affordances carry image + audio
		 * only — there is no video slot here (unlike a question
		 * message, which can carry all three).
		 */
		audioLabel: assetIdSchema.optional(),
	})
	.strict();
export type CaseListConfig = z.infer<typeof caseListConfigSchema>;

// ── CaseSearchConfig ─────────────────────────────────────────────
//
// The structured case-search configuration. Carries two
// search-only authoring concerns:
//
//   - The display cluster — the search-screen labels (title /
//     subtitle / button labels / empty state) and the optional
//     `searchButtonDisplayCondition` predicate that gates the search
//     button.
//   - The advanced cluster — niche search-side filters. The cluster
//     carries `excludedOwnerIds`, a `ValueExpression` that evaluates
//     to a space-separated list of owner ids whose cases are excluded
//     from the search-results scope. Framed abstractly so the cluster
//     name describes its role (niche filters), not its contents.
//
// The runtime case-claim step (which fires when an author picks a
// case from search results) runs unconditionally on the CCHQ
// runtime — there is no authoring affordance for it. Display sort,
// the always-on filter, and search inputs are not duplicated here;
// they live on `caseListConfig` as the single source for both
// screens.

export const caseSearchConfigSchema = z
	.object({
		// Advanced cluster.
		// `excludedOwnerIds` evaluates to a space-separated list of
		// owner ids whose cases are excluded from the search-results
		// scope. Rare in practice; the case-search-config UI collapses
		// this affordance into a dedicated "Advanced" section that
		// hosts niche search-side filters.
		//
		// Wire-name continuity: at suite-XML emission time the slot
		// translates to CCHQ's literal wire field
		// `commcare_blacklisted_owner_ids` per
		// `commcare-hq/corehq/apps/case_search/models.py::CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY`.
		// The wire token is a CCHQ-controlled vocabulary; Nova's
		// authoring vocabulary is `excludedOwnerIds`. The translation
		// lives at `lib/commcare/suite/case-search/searchSession.ts`.
		excludedOwnerIds: valueExpressionSchema.optional(),

		// Display labels for the search screen. The runtime renders the
		// subtitle through a markdown formatter; the others are plain
		// text. `searchButtonDisplayCondition` hides the search button
		// when the predicate evaluates false (used for "search" buttons
		// that should disappear once the form has executed once).
		//
		// Empty strings are rejected — every text input on the editor
		// drops the slot to `undefined` when the user clears it, so
		// "presence with empty body" is a structurally invalid state.
		// The two wire emitters (local suite-XML, HQ JSON) diverge on
		// empty: the suite-XML emitter falls back to a case-type /
		// CCHQ-default; the HQ JSON projection writes `{ en: "" }` and
		// the runtime renders blank text. Rejecting empty at the
		// schema collapses both surfaces onto the same shape — present
		// means non-empty.
		searchScreenTitle: z.string().min(1).optional(),
		searchScreenSubtitle: z.string().min(1).optional(),
		searchButtonLabel: z.string().min(1).optional(),
		searchButtonDisplayCondition: predicateSchema.optional(),
	})
	.strict();
export type CaseSearchConfig = z.infer<typeof caseSearchConfigSchema>;

// ── Module ───────────────────────────────────────────────────────

export const moduleSchema = z
	.object({
		uuid: uuidSchema,
		id: z.string(), // semantic id (snake_case display slug)
		name: z.string(),
		caseType: z.string().optional(),
		caseListOnly: z.boolean().optional(),
		purpose: z.string().optional(),
		caseListConfig: caseListConfigSchema.optional(),
		caseSearchConfig: caseSearchConfigSchema.optional(),
		/** Image shown on the module's home-screen tile. */
		icon: assetIdSchema.optional(),
		/**
		 * Audio version of the module's home-screen label, played by
		 * audio-prompt mode — an accessibility affordance for
		 * low-literacy field workers. Menu affordances carry image +
		 * audio only; there is no video slot here.
		 */
		audioLabel: assetIdSchema.optional(),
	})
	.strict();
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
