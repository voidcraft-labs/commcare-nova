// lib/domain/modules.ts
//
// Module schema. Owns the structured `caseListConfig` shape that
// drives every case-list authoring surface. The shape is the single
// source of truth the validator, wire emitters, SA tools, and case-
// list-config UI all read from.
//
// `caseListConfig` collapses to the case-list definition plus its selection
// behavior:
//
//   - `columns: Column[]` — display + sort + calc + visibility, all
//     here. Each column carries its own `uuid` (UI identity, drag /
//     reorder handle, AST references), an optional `sort` (per-
//     column direction + priority on the column itself), and optional
//     `visibleInList` / `visibleInDetail` flags (absent ≡ visible),
//     plus independent `listColumnOrder` / `detailColumnOrder` UUID
//     sequences on the containing config.
//   - `filter?: Predicate` — single optional always-on predicate
//     applied to every row before display.
//   - `searchInputs: SearchInputDef[]` — discriminated union of
//     simple `(property, mode, via)` inputs and advanced inputs
//     whose body is a free-form `predicate`.
//   - `selection?: { kind: "multiple"; maximum: number }` — absence keeps the
//     ordinary one-case flow; presence makes selection an explicitly bounded
//     ordered collection.
//
// `Predicate`, `ValueExpression`, and `RelationPath` come from
// `@/lib/domain/predicate` — the AST primitives the filter,
// calculated-column expression, search-input default, and search-
// input advanced predicate slots reference. Importing them here
// (rather than redefining the shapes) keeps the AST cycles
// consolidated in one package and keeps every authoring surface
// bound against the same Zod schemas.

import { z } from "zod";
import { moduleIconRefSchema } from "./builtinIcons";
import { authoredCasePropertyNameSchema } from "./casePropertyName";
import type { CasePropertyDataType } from "./casePropertyTypes";
import { COMMCARE_DATE_PATTERN_REGEX } from "./commCareDatePattern";
import {
	persistableJsonNonnegativeIntegerSchema,
	persistableJsonPositiveIntegerSchema,
} from "./jsonNumber";
import { type MediaAssetId, mediaAssetIdSchema } from "./multimedia";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "./predicate/types";
import {
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
// tie-break to Results display order (`listColumnOrder`) — that
// rule binds at the saga, preview, and wire-emission layers; the
// whole-document admission enforces uniqueness. The positional tie-break keeps
// the pure projection deterministic without weakening that stored invariant.
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
 * `priority` is a non-negative integer; tie-break to Results display
 * order is uniform across saga / preview / wire layers (no layer
 * assumes uniqueness).
 */
export const columnSortSchema = z
	.object({
		direction: z.enum(SORT_DIRECTIONS),
		priority: persistableJsonNonnegativeIntegerSchema,
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
 * Days-equivalent divisor used by CommCare's time-ago and late-flag formats.
 * CCHQ defines a year as 365.25 days, a month as one twelfth of that, and a
 * week as seven days. Keeping this beside `TimeSinceUnit` makes the domain
 * unit mean the same thing in Preview, suite.xml, and HQ JSON emission.
 */
export const TIME_SINCE_UNIT_DAYS: Readonly<Record<TimeSinceUnit, number>> = {
	days: 1,
	weeks: 7,
	months: 365.25 / 12,
	years: 365.25,
};

/**
 * Display dispatch for `interval` columns:
 *
 *   - `"always"` — show the whole number of authored units until the
 *     threshold is crossed, then replace it with `text`.
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
// optional `visibleInList` / `visibleInDetail` for surface filtering.
// Independent Results / Details sequencing belongs to the containing
// `CaseListConfig`, not to a column. Centralized here so every per-kind
// schema below extends the same base.

/**
 * Optional surface-visibility and sort slots shared by every column kind.
 * Absent visibility defaults to "visible" at the wire layer.
 */
const columnCommonSlots = z
	.object({
		sort: columnSortSchema.optional(),
		visibleInList: z.boolean().optional(),
		visibleInDetail: z.boolean().optional(),
	})
	.strict();

// ── Case-tile cells ──────────────────────────────────────────────
//
// A tile-laid-out case list places each Results column on a grid
// instead of stacking it in a row. The cell is PLACEMENT, entirely
// separate from `listColumnOrder` / `detailColumnOrder`, which remain the
// column's position in the Results / Details sequences: moving a
// column in the Results sequence never moves its tile cell, and
// vice versa.
//
// The wire shape is one `<style horz-align vert-align font-size
// show-border show-shading><grid grid-x grid-y grid-width
// grid-height/></style>` child on the column's `<field>`. All four
// grid attributes are mandatory once `<style>` exists — CommCare's
// `commcare-core/.../org/commcare/xml/GridParser.java::GridParser.parse`
// runs an UNGUARDED `Integer.parseInt` on each of the four, and
// `commcare-core/.../org/commcare/xml/DetailFieldParser.java::DetailFieldParser.parseStyle`
// always runs `GridParser` after `StyleParser`, so a `<style>` without a
// complete `<grid>` is an install-time parse failure. A field counts as a
// tile cell only when all four are set
// (`commcare-core/.../org/commcare/suite/model/DetailField.java::DetailField.isCaseTileField`,
// which tests each against the `-1` unset sentinel). Modelling the four
// as one required object is what makes the partial state unrepresentable.

/**
 * Columns in one tile row. The cap is CommCare HQ's own parity
 * assertion — `commcare-hq/corehq/apps/app_manager/tests/test_suite_case_tiles.py::SuiteCaseTilesTest.test_case_tile_column_count`
 * fails any built-in template whose `x + width` exceeds 12, with the
 * comment "Keeps the number of columns in parity with what mobile
 * allows". CommCare Core carries no column-count constant of its own
 * (the Web Apps renderer sizes its grid from the actual extent), so
 * Nova enforces the 12 itself rather than inheriting it.
 */
export const TILE_GRID_COLUMNS = 12;

/**
 * Rows in one tile. CommCare bounds the row extent nowhere — the
 * renderer sizes the grid from whatever the fields occupy — so this
 * is declared Nova policy: a tile is a 12 x 12 grid, which keeps the
 * layout editor a fixed, learnable surface and keeps a tile visually
 * comparable to the row it replaces.
 */
export const TILE_GRID_ROWS = 12;

// Alignment vocabulary is constrained by what the Web Apps renderer
// HONORS, not by what the suite parser accepts.
// `commcare-core/.../org/commcare/xml/StyleParser.java::StyleParser.parse`
// stores `horz-align` / `vert-align` as raw unvalidated strings, but
// `commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::getValidFieldAlignment`
// silently rewrites anything outside
// `commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/constants.js::ALLOWED_FIELD_ALIGNMENTS`
// (`start`, `end`, `center`, `left`, `right`) to `start`. HQ's own
// shipped `icon_text_grid` template emits `vert-align="top"` and Web
// Apps therefore renders it as `start` — an authored value that does
// not survive. Nova emits only values the renderer honors, so what an
// author picks is what a worker sees.

/**
 * Horizontal cell alignment. Nova's authoring word and the wire value
 * coincide here — `left` / `center` / `right` are all in Web Apps'
 * honored set and read the same way to an author.
 */
export const TILE_HORIZONTAL_ALIGNS = ["left", "center", "right"] as const;
export type TileHorizontalAlign = (typeof TILE_HORIZONTAL_ALIGNS)[number];

/**
 * Vertical cell alignment, in Nova's authoring words. These project
 * onto the honored wire values at emission
 * (`lib/commcare/suite/case-list/tileStyle.ts::TILE_VERTICAL_ALIGN_WIRE`):
 * `top` → `start`, `middle` → `center`, `bottom` → `end`. The wire
 * spelling is a flex/grid alignment vocabulary; the authoring words
 * are the ones an author would say about a cell.
 */
export const TILE_VERTICAL_ALIGNS = ["top", "middle", "bottom"] as const;
export type TileVerticalAlign = (typeof TILE_VERTICAL_ALIGNS)[number];

/**
 * Cell text size. Emits verbatim as `<style font-size>`, which Web
 * Apps interpolates straight into a CSS `font-size` declaration
 * (`views.js::buildCellLayout` → the `cell_layout_style.html`
 * template). These three are the CSS absolute-size keywords, and are
 * the sizes CommCare's own shipped tile templates use
 * (`commcare-hq/corehq/apps/app_manager/suite_xml/case_tile_templates/person_simple.xml`
 * carries `small` and `medium`;
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_persistent_case_context_detail`
 * emits `large`).
 *
 * Absent is a real, distinct state: the renderer emits an empty
 * `font-size: ;` declaration the browser discards, so the cell
 * INHERITS the list's size. There is no `medium` default at runtime —
 * that default exists only in HQ's authoring UI — so Nova's own
 * renderer must inherit too rather than substituting a size.
 */
export const TILE_FONT_SIZES = ["small", "medium", "large"] as const;
export type TileFontSize = (typeof TILE_FONT_SIZES)[number];

/**
 * One column's placement and presentation inside the tile grid.
 *
 * `x` / `y` are zero-based grid coordinates; `width` / `height` are
 * spans in cells. The schema keeps only the bounds that have no
 * repair ambiguity — non-negative origin, positive span — so an
 * imported document with an out-of-grid or overlapping cell still
 * LOADS and can be repaired. The grid contract itself (the 12-column
 * cap, the row cap, no two cells overlapping, and every Results
 * column carrying a cell) lives in
 * `lib/commcare/validator/rules/case-list/caseTileLayout.ts`, where
 * one rule owns every geometry message.
 *
 * The five presentation slots are all optional; each maps 1:1 onto a
 * `<style>` attribute and is omitted from the wire when absent.
 */
export const tileCellSchema = z
	.object({
		x: persistableJsonNonnegativeIntegerSchema,
		y: persistableJsonNonnegativeIntegerSchema,
		width: persistableJsonPositiveIntegerSchema,
		height: persistableJsonPositiveIntegerSchema,
		horizontalAlign: z.enum(TILE_HORIZONTAL_ALIGNS).optional(),
		verticalAlign: z.enum(TILE_VERTICAL_ALIGNS).optional(),
		fontSize: z.enum(TILE_FONT_SIZES).optional(),
		showBorder: z.boolean().optional(),
		showShading: z.boolean().optional(),
	})
	.strict();
export type TileCell = z.infer<typeof tileCellSchema>;

/** Constructs a tile cell. Optional presentation slots are omitted
 *  when absent so a constructed cell round-trips equal to a stored
 *  one under the schema's strip-mode parse. */
export function tileCell(
	x: number,
	y: number,
	width: number,
	height: number,
	presentation: Omit<TileCell, "x" | "y" | "width" | "height"> = {},
): TileCell {
	const out: TileCell = { x, y, width, height };
	if (presentation.horizontalAlign !== undefined)
		out.horizontalAlign = presentation.horizontalAlign;
	if (presentation.verticalAlign !== undefined)
		out.verticalAlign = presentation.verticalAlign;
	if (presentation.fontSize !== undefined) out.fontSize = presentation.fontSize;
	if (presentation.showBorder !== undefined)
		out.showBorder = presentation.showBorder;
	if (presentation.showShading !== undefined)
		out.showShading = presentation.showShading;
	return out;
}

/** The half-open column span a cell occupies. */
export function tileCellRightEdge(cell: TileCell): number {
	return cell.x + cell.width;
}

/** The half-open row span a cell occupies. */
export function tileCellBottomEdge(cell: TileCell): number {
	return cell.y + cell.height;
}

/** Whether two cells cover any common grid square. */
export function tileCellsOverlap(a: TileCell, b: TileCell): boolean {
	return (
		a.x < tileCellRightEdge(b) &&
		b.x < tileCellRightEdge(a) &&
		a.y < tileCellBottomEdge(b) &&
		b.y < tileCellBottomEdge(a)
	);
}

/**
 * THE tile-cell admission decision: the cell a column contributes to a
 * tile, or `undefined` when it contributes none.
 *
 * Every surface that turns a column into a tile cell reads this and
 * nothing else — the suite emitter, the HQ JSON writer, and the preview
 * renderer. It exists because three paths each deciding independently is
 * how they diverge: each of the three answered this question separately
 * at some point, and the HQ JSON path — the PRIMARY delivery path —
 * answered it wrongly while the other two were right, so an uploaded app
 * drew a different tile from the one the author arranged. A fourth
 * delivery path or a fourth renderer must not be able to reintroduce
 * that, so the decision has exactly one home.
 *
 * Two conditions, and each is load-bearing:
 *
 *   - **The case list has a tile layout.** Cells persist while the layout
 *     is off so switching back restores the drawing, but they describe
 *     nothing until it is on.
 *   - **The column is shown in Results.** A column hidden from Results
 *     holds no square, even when it kept a placement from before it was
 *     hidden. It still reaches the wire when it drives Default order —
 *     as CommCare's own zero-width carrier — and that carrier must stay
 *     cell-less: a complete `<grid>` makes it a tile field by
 *     `DetailField::isCaseTileField`, at which point it claims a real
 *     `grid-area`, enlarges the extent
 *     `Detail.java::getMaxWidthHeight` computes across ALL fields, and
 *     joins the tile-wide border/shading switch — while its content
 *     renders inside a `d-none` wrapper. An invisible column would move
 *     the layout.
 *
 * This is also what makes the validator's overlap rule sound: that rule
 * walks only Results-visible columns, which is correct precisely because
 * no emission path gives a hidden column a cell.
 *
 * Which detail SURFACE is being composed is a separate axis and stays
 * with the emitter — tiles apply to the short detail, and the
 * case-detail screen is a plain field list whatever the case list does.
 */
export function tileCellFor(
	column: Pick<Column, "tile" | "visibleInList">,
	layout: CaseTileLayout | undefined,
): TileCell | undefined {
	if (layout === undefined) return undefined;
	if (column.visibleInList === false) return undefined;
	return column.tile;
}

/**
 * The grid a set of cells actually occupies, in columns x rows.
 *
 * This is DERIVED, never authored, and every renderer must derive it
 * the same way: the runtime sizes the tile's CSS grid from the
 * occupied extent, not from the 12-column authoring canvas. CommCare
 * Core computes it in
 * `commcare-core/.../org/commcare/suite/model/Detail.java::Detail.getMaxWidthHeight`
 * (`max(gridX + gridWidth)`, `max(gridY + gridHeight)`), Formplayer
 * ships it as `maxWidth` / `maxHeight`
 * (`formplayer/.../beans/menus/EntityListResponse.java::EntityListResponse.processCaseTiles`),
 * and Web Apps turns it into
 * `grid-template-columns: repeat(maxWidth, 1fr)` /
 * `grid-template-rows: repeat(maxHeight, …)`
 * (`cloudcare/.../formplayer/menus/views.js::buildCellGridStyle`). A
 * tile whose widest cell ends at column 6 therefore renders six
 * equal columns, not six twelfths of the canvas — so a renderer that
 * assumed 12 would draw every such tile at half width.
 *
 * An empty set has zero extent.
 */
export function tileGridExtent(cells: readonly TileCell[]): {
	readonly columns: number;
	readonly rows: number;
} {
	let columns = 0;
	let rows = 0;
	for (const cell of cells) {
		columns = Math.max(columns, tileCellRightEdge(cell));
		rows = Math.max(rows, tileCellBottomEdge(cell));
	}
	return { columns, rows };
}

/**
 * Whether any cell in the tile asks for a border or shading.
 *
 * The flag is TILE-WIDE at the runtime, not per cell: Web Apps'
 * `views.js::buildCellLayout` computes one `borderInTile` /
 * `shadingInTile` across every style in the tile and switches the
 * WHOLE tile into boxed layout when either is set. In boxed layout a
 * cell that carries border or shading stretches
 * (`justify-self: stretch`) inside a padded rounded box, while a cell
 * that carries neither keeps its own alignment with a flat 7px
 * margin. A renderer that treated the flags per cell would place
 * every plain cell differently from the device.
 */
export function tileHasBoxedCells(cells: readonly TileCell[]): boolean {
	return cells.some(
		(cell) => cell.showBorder === true || cell.showShading === true,
	);
}

/** Base shape every column kind extends — uuid + the common
 *  optional slots (sort, visibility). Per-kind schemas add their
 *  required configuration on top. The `.strict()` on the base
 *  propagates through every `columnBase.extend({...})` chain below,
 *  so per-kind schemas reject unknown keys without restating
 *  `.strict()` on each arm.
 *
 *  `tile` is the column's placement on the case list's tile grid. It
 *  sits here rather than in `columnCommonSlots` only because
 *  `tileCellSchema` is declared below that object; it is an ordinary
 *  optional common slot in every other respect, and
 *  `ColumnCommonSlots` carries it for the builders. */
const columnBase = z
	.object({
		uuid: uuidSchema,
		tile: tileCellSchema.optional(),
	})
	.extend(columnCommonSlots.shape)
	.strict();

// ── Column kinds ─────────────────────────────────────────────────
//
// Eight discriminated arms. The `kind` discriminant routes the column
// through the matching wire emitter and editor body. Calculated
// columns have no `field` slot — the expression is the source.

/**
 * Plain text column — renders the property value as a string.
 * Default kind for any displayed column.
 */
const plainColumnSchema = columnBase.extend({
	kind: z.literal("plain"),
	field: authoredCasePropertyNameSchema,
	header: z.string(),
});

/**
 * Date-formatted column — renders the property value through a
 * preset date format. The property must resolve to a date-shaped
 * `data_type` (validator rule); the runtime formatter consumes
 * `pattern` to produce the displayed string.
 *
 * `pattern` rejects empty strings and unsupported JavaRosa escapes — symmetric
 * with `formatDateSchema.pattern` on the ValueExpression side. Backed at the
 * editor by inline validation in the shared `CustomDatePatternInput`.
 */
const dateColumnSchema = columnBase.extend({
	kind: z.literal("date"),
	field: authoredCasePropertyNameSchema,
	header: z.string(),
	pattern: z
		.string()
		.min(1)
		.regex(COMMCARE_DATE_PATTERN_REGEX, "Use a supported date format"),
});

/**
 * Phone-number column — renders the property as a tappable phone
 * link in the running app. Plain text in static contexts.
 */
const phoneColumnSchema = columnBase.extend({
	kind: z.literal("phone"),
	field: authoredCasePropertyNameSchema,
	header: z.string(),
});

/**
 * ID-mapping column — renders a lookup table from property value
 * to display label (e.g. region code → human-readable region
 * name). The mapping is authored explicitly; values not in the
 * table render no mapped text.
 */
const idMappingEntrySchema = z
	.object({
		// Nonempty whitespace-free token. A blank new-row control is local
		// component state and is never a persisted mapping entry. The wire
		// emits the entry as `selected(field, '<value>')`; CommCare's
		// `selected()` is the XPath 1.0 space-tokenized membership
		// predicate (it splits the property value on whitespace and
		// checks set membership), so a `value` carrying whitespace
		// would never match any case row — silent runtime failure.
		// Reject blank/whitespace at the schema layer where the final row is
		// constructed.
		value: z
			.string()
			.regex(
				/^\S+$/,
				"ID-mapping value must be a single whitespace-free token, the wire layer matches it via XPath's space-tokenized `selected()` predicate, which splits both sides on whitespace before testing set membership. A value with spaces would never match any property and the cell would silently fall through to the raw property value.",
			),
		label: z.string(),
	})
	.strict();
const idMappingColumnSchema = columnBase.extend({
	kind: z.literal("id-mapping"),
	field: authoredCasePropertyNameSchema,
	header: z.string(),
	// The table may be empty: that is the complete "show no mapped labels"
	// display and emits the same empty-string XPath as any unmatched value.
	// Rows, when present, must be complete and unique. The wire emitter
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
					"Mapping values are not unique within this column. Two or more entries share the same `value`. The wire layer matches one row against every entry with a matching value, so duplicates would produce a cell that concatenates each matching label. Keep one entry per value and merge any duplicate labels into that entry's `label` slot.",
			},
		),
});

/**
 * Single image-map entry — pairs a case-property value with the image
 * `MediaAssetId` shown for that value. The image-map analogue of
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
				/^\S+$/,
				"Image-map value must be a single whitespace-free token, the wire layer matches it via XPath's space-tokenized `selected()` predicate, which splits both sides on whitespace before testing set membership. A value with spaces would never match any property and the cell would render no image.",
			),
		assetId: mediaAssetIdSchema,
	})
	.strict();
const imageMapColumnSchema = columnBase.extend({
	kind: z.literal("image-map"),
	field: authoredCasePropertyNameSchema,
	header: z.string(),
	// The table may be empty: that is the complete "show no mapped images"
	// display. Rows, when present, must have unique values — same rationale
	// as id-mapping: the wire emits one `if(selected(field, '<value>'), …)`
	// arm per entry, so two entries sharing a value both match the same
	// row and the cell concatenates their image paths into one
	// unrenderable string.
	mapping: z
		.array(imageMapEntrySchema)
		.refine(
			(entries) => new Set(entries.map((e) => e.value)).size === entries.length,
			{
				message:
					"Mapping values are not unique within this image-map column. Two or more entries share the same `value`. The wire layer matches one row against every entry with a matching value, so duplicates would concatenate each matching image path into one unrenderable cell. Keep one entry per value.",
			},
		),
});

/**
 * Interval column — renders a whole-unit interval against the
 * property's date value. The `display` slot dispatches the cell
 * shape:
 *
 *   - `"always"` — show the whole-unit count until the threshold is crossed,
 *     then replace it with `text`.
 *   - `"flag"` — only show `text` when the threshold is exceeded;
 *     otherwise the cell renders empty.
 *
 * The threshold + unit drive the per-row "is this overdue?"
 * decision in both arms.
 */
const intervalColumnSchema = columnBase.extend({
	kind: z.literal("interval"),
	field: authoredCasePropertyNameSchema,
	header: z.string(),
	// Positive integer count of `unit`s. A negative or zero threshold
	// would flag every non-empty cell in the `flag` arm (the wire
	// emits `if(today() - date(field) > <threshold>, '*', '')`) and
	// would show "X days ago" with a negative count in the `always`
	// arm — both shapes are structurally authoring errors masquerading
	// as working configuration, not legitimate authorings to admit.
	threshold: persistableJsonPositiveIntegerSchema,
	unit: z.enum(TIME_SINCE_UNITS),
	display: z.enum(INTERVAL_DISPLAYS),
	text: z.string(),
});

/**
 * Link column — renders the property's value as a tappable link
 * labelled with `linkText`, for a property holding an address rather
 * than a value a person reads (an attachment link, say).
 *
 * `linkText` is ONE string for every app language, and that is a
 * CommCare limit rather than a Nova choice. The cell is emitted as
 * `<template form="markdown">`, and CommCare HQ builds a column's
 * locale variables only for its `Enum` format subclasses
 * (`detail_screen.py::Enum.variables`); `Markdown` inherits the base
 * `FormattedDetailColumn.variables`, which supplies `$lang` and
 * nothing else. So an HQ-imported app has nowhere to put a translated
 * label, and emitting one into the `.ccz` alone would make the same
 * authored app read differently depending on how it was exported.
 * The label is inlined as an XPath literal on both paths instead.
 *
 * Square brackets are refused because the emitted cell is
 * `[<linkText>](<value>)` and a bracket inside the label closes it
 * early, leaving the row showing raw markdown instead of a link.
 */
const linkColumnSchema = columnBase.extend({
	kind: z.literal("link"),
	field: authoredCasePropertyNameSchema,
	header: z.string(),
	linkText: z
		.string()
		.min(1, "Give the link something to say")
		.regex(
			/^[^[\]]+$/,
			"Link text can't contain square brackets. The cell is rendered as markdown, where a bracket ends the link's label early and the row shows the raw text instead of a link.",
		),
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
	linkColumnSchema,
	calculatedColumnSchema,
]);
export type Column = z.infer<typeof columnSchema>;
export type ColumnKind = Column["kind"];

/**
 * Whether a valid saved column contributes to the emitted/running app.
 *
 * Admission must never consult this projection: fully hidden, unsorted
 * definitions are legitimate reversible authoring state and are validated as
 * completely as visible definitions. Only compiler/preview/reference walks use
 * this predicate to decide which already-valid definitions execute.
 */
export function caseListColumnIsEmitted(column: Column): boolean {
	return (
		column.visibleInList !== false ||
		column.visibleInDetail !== false ||
		column.sort !== undefined
	);
}

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
// Common optional slots (`sort`, visibility, and tile placement) are passed via
// a `slots` object. Builders OMIT keys whose values
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
	/** Placement on the case list's tile grid. Independent of the two
	 *  surface membership sequences — a cell is where the column sits on
	 *  the tile, while the owning config arrays hold sequence. */
	readonly tile?: TileCell;
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
		tile?: TileCell;
	} = { ...base };
	if (slots.sort !== undefined) out.sort = slots.sort;
	if (slots.visibleInList !== undefined)
		out.visibleInList = slots.visibleInList;
	if (slots.visibleInDetail !== undefined)
		out.visibleInDetail = slots.visibleInDetail;
	if (slots.tile !== undefined) out.tile = slots.tile;
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
 * Constructs a link column. `linkText` is what the cell says; the
 * property's value is where it goes.
 */
export function linkColumn(
	uuid: Uuid,
	field: string,
	header: string,
	linkText: string,
	slots: ColumnCommonSlots = {},
): Extract<Column, { kind: "link" }> {
	return withCommonSlots(
		{ uuid, kind: "link" as const, field, header, linkText },
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

/** Single image-map entry — value-to-image-`MediaAssetId` pair surfaced by
 *  an image-map column's lookup. Constructing through the matching
 *  builder pins the key order against schema drift. */
export type ImageMapEntry = z.infer<typeof imageMapEntrySchema>;

/**
 * Constructs an image-map column. `mapping` is the lookup table from
 * raw property value to image `MediaAssetId`; the runtime renders the
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
export function imageMapEntry(
	value: string,
	assetId: MediaAssetId,
): ImageMapEntry {
	return { value, assetId };
}

/**
 * Constructs an interval column. `display` selects between the two
 * cell shapes:
 *
 *   - `"always"` — show the whole-unit count until the threshold is crossed,
 *     then replace it with `text`.
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
// Common identity/name/label slots appear on every arm. Widget shape is a
// second structural discriminator: scalar widgets may own a scalar default
// and never range mode; a date-range widget owns explicit range mode and can
// never carry a scalar default. Partial editor rows live outside this schema.

/**
 * Search-input authoring widget kinds. Single source of truth for
 * the editor's type picker, the SA tools' tool-schema enum, and the
 * validator's per-type / per-mode applicability gate.
 */
export const SEARCH_INPUT_TYPES = [
	"text",
	"date",
	"date-range",
	"barcode",
] as const;
export type SearchInputType = (typeof SEARCH_INPUT_TYPES)[number];
export const SCALAR_SEARCH_INPUT_TYPES = ["text", "date", "barcode"] as const;
export type ScalarSearchInputType = (typeof SCALAR_SEARCH_INPUT_TYPES)[number];

/**
 * Discriminated union of search-input modes. Each mode targets a
 * specific case-property `data_type` (validator-enforced):
 *
 *   - `exact` — equality match (text/date/barcode default).
 *   - `fuzzy` — pg_trgm `%` similarity (text only).
 *   - `starts-with` — pg_trgm-backed prefix match (text only).
 *   - `phonetic` — fuzzystrmatch dmetaphone (text only).
 *   - `fuzzy-date` — date permutation match (text or temporal).
 *   - `range` — one paired date-range answer, stored only on the
 *     date-range Search-input arm.
 */
const scalarSearchInputModeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("exact") }).strict(),
	z.object({ kind: z.literal("fuzzy") }).strict(),
	z.object({ kind: z.literal("starts-with") }).strict(),
	z.object({ kind: z.literal("phonetic") }).strict(),
	z.object({ kind: z.literal("fuzzy-date") }).strict(),
]);
const rangeSearchInputModeSchema = z
	.object({ kind: z.literal("range") })
	.strict();
export const searchInputModeSchema = z.union([
	scalarSearchInputModeSchema,
	rangeSearchInputModeSchema,
]);
export type SearchInputMode = z.infer<typeof searchInputModeSchema>;
export type ScalarSearchInputMode = z.infer<typeof scalarSearchInputModeSchema>;

// Common slots present on every SearchInputDef arm.
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
const searchInputBase = z
	.object({
		uuid: uuidSchema,
		name: z
			.string()
			.regex(
				XML_ELEMENT_NAME_PATTERN,
				"Search input `name` must start with a letter or underscore and contain only letters, digits, or underscores. The name is interpolated both as an XML attribute value on the wire `<prompt>` and as an XPath token in the CSQL `instance('search-input:results')/input/field[@name='…']` reference; characters outside that class break one or both bindings.",
			),
		label: z.string(),
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
const simpleSearchInputSlots = {
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
	// predicate at wire-emit, not at validate-time).
	property: authoredCasePropertyNameSchema,
	via: relationPathSchema.optional(),
};

export const simpleScalarSearchInputSchema = searchInputBase
	.extend({
		...simpleSearchInputSlots,
		type: z.enum(SCALAR_SEARCH_INPUT_TYPES),
		default: valueExpressionSchema.optional(),
		mode: scalarSearchInputModeSchema.optional(),
	})
	.strict();

export const simpleDateRangeSearchInputSchema = searchInputBase
	.extend({
		...simpleSearchInputSlots,
		type: z.literal("date-range"),
		mode: rangeSearchInputModeSchema,
	})
	.strict();

/**
 * Advanced search input — the `predicate` arm. The slot's body is a
 * full `Predicate` AST that replaces the (property, mode)-derived
 * predicate. The editor surfaces a `PredicateCardEditor` against
 * this slot.
 */
export const advancedScalarSearchInputSchema = searchInputBase
	.extend({
		kind: z.literal("advanced"),
		type: z.enum(SCALAR_SEARCH_INPUT_TYPES),
		default: valueExpressionSchema.optional(),
		predicate: predicateSchema,
	})
	.strict();

export const advancedDateRangeSearchInputSchema = searchInputBase
	.extend({
		kind: z.literal("advanced"),
		type: z.literal("date-range"),
		predicate: predicateSchema,
	})
	.strict();

/**
 * Exact four-arm union over two authoring dimensions:
 *
 * - `kind`: simple or advanced;
 * - widget shape: scalar or date-range.
 *
 * This cannot be a Zod `discriminatedUnion("kind", ...)`: each kind appears
 * in two arms. Keeping the scalar/date-range split structural is what makes a
 * range default or a scalar range mode unrepresentable.
 */
export const searchInputDefSchema = z.union([
	simpleScalarSearchInputSchema,
	simpleDateRangeSearchInputSchema,
	advancedScalarSearchInputSchema,
	advancedDateRangeSearchInputSchema,
]);
export type SimpleScalarSearchInputDef = z.infer<
	typeof simpleScalarSearchInputSchema
>;
export type SimpleDateRangeSearchInputDef = z.infer<
	typeof simpleDateRangeSearchInputSchema
>;
export type AdvancedScalarSearchInputDef = z.infer<
	typeof advancedScalarSearchInputSchema
>;
export type AdvancedDateRangeSearchInputDef = z.infer<
	typeof advancedDateRangeSearchInputSchema
>;
export type SearchInputDef = z.infer<typeof searchInputDefSchema>;
export type SimpleSearchInputDef =
	| SimpleScalarSearchInputDef
	| SimpleDateRangeSearchInputDef;
export type AdvancedSearchInputDef =
	| AdvancedScalarSearchInputDef
	| AdvancedDateRangeSearchInputDef;

/** Scalar prompt seed, absent by construction on both date-range arms. */
export function searchInputDefault(
	input: SearchInputDef,
): ValueExpression | undefined {
	return "default" in input ? input.default : undefined;
}

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

/** Scalar-widget slot that seeds the input's initial state. */
interface SearchInputCommonSlots {
	readonly default?: ValueExpression;
}

interface SimpleScalarSearchInputSlots extends SearchInputCommonSlots {
	/** Optional relation walk to a destination case type. `selfPath()`
	 *  is structurally equivalent to absent and the builder omits the
	 *  key in that case. */
	readonly via?: RelationPath;
	/** Optional explicit scalar search mode. */
	readonly mode?: ScalarSearchInputMode;
}

interface SimpleDateRangeSearchInputSlots {
	readonly via?: RelationPath;
	/** The builder writes the sole valid stored mode when omitted. */
	readonly mode?: Extract<SearchInputMode, { kind: "range" }>;
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
 *   - scalar `mode === undefined` → omitted.
 *   - date-range `mode === undefined` → the sole valid `{ kind: "range" }`.
 *   - `default === undefined` → omitted.
 */
export function simpleSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: ScalarSearchInputType,
	property: string,
	slots?: SimpleScalarSearchInputSlots,
): SimpleScalarSearchInputDef;
export function simpleSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: "date-range",
	property: string,
	slots?: SimpleDateRangeSearchInputSlots,
): SimpleDateRangeSearchInputDef;
export function simpleSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	property: string,
	slots?: SimpleScalarSearchInputSlots | SimpleDateRangeSearchInputSlots,
): SimpleSearchInputDef;
export function simpleSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	property: string,
	slots: SimpleScalarSearchInputSlots | SimpleDateRangeSearchInputSlots = {},
): SimpleSearchInputDef {
	const out = {
		uuid,
		kind: "simple",
		name,
		label,
		type,
		property,
	};
	const candidate: Record<string, unknown> = { ...out };
	if ("default" in slots && slots.default !== undefined)
		candidate.default = slots.default;
	if (slots.via !== undefined && slots.via.kind !== "self")
		candidate.via = slots.via;
	if (type === "date-range") {
		candidate.mode = slots.mode ?? rangeMode();
	} else if (slots.mode !== undefined) {
		candidate.mode = slots.mode;
	}
	return searchInputDefSchema.parse(candidate) as SimpleSearchInputDef;
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
	type: ScalarSearchInputType,
	predicate: Predicate,
	slots?: SearchInputCommonSlots,
): AdvancedScalarSearchInputDef;
export function advancedSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: "date-range",
	predicate: Predicate,
): AdvancedDateRangeSearchInputDef;
export function advancedSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	predicate: Predicate,
	slots?: SearchInputCommonSlots,
): AdvancedSearchInputDef;
export function advancedSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	predicate: Predicate,
	slots: SearchInputCommonSlots = {},
): AdvancedSearchInputDef {
	return searchInputDefSchema.parse(
		withSearchInputCommonSlots(
			{ uuid, kind: "advanced" as const, name, label, type, predicate },
			slots,
		),
	) as AdvancedSearchInputDef;
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
 * scalar default-mode contract selects the first entry when mode is
 * absent. A stored date-range arm always carries its sole `range` mode.
 *
 * The order also drives the editor's picker — the first entry is
 * the default; subsequent entries surface as alternatives the
 * author can pick when their semantics fit.
 */
export const APPLICABLE_SEARCH_MODES: Readonly<
	Record<SearchInputType, readonly SearchInputMode["kind"][]>
> = {
	text: ["exact", "fuzzy", "starts-with", "phonetic", "fuzzy-date"],
	date: ["exact"],
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
	// `range` is the date-range widget's paired calendar match.
	range: ["int", "decimal", "date", "datetime", "time"],
};

/**
 * The data types admitted by each `SearchInputType`'s widget kind.
 * Used by the editor's type-coupling check to flip `valid: false`
 * when the picked widget kind doesn't match the targeted property's
 * `data_type`:
 *
 *   - `text` — admits every type; the input always serializes as a
 *     string and the wire layer handles the cast at evaluation.
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
	date: ["date", "datetime"],
	"date-range": ["date", "datetime"],
	barcode: ["text"],
};

/**
 * The resolved type each scalar-default-capable widget expects its
 * `default` value-expression to produce. Used by the validator's
 * per-input default type-check (`searchInputDefaultTypeCheck`)
 * to gate the seed expression's resolution against the widget's
 * shape.
 *
 *   - `text` → `"text"` — text widget admits any text-typed seed.
 *   - `date` → `"date"` — calendar widget expects a date-shaped
 *     seed. `typesCompatible` does NOT widen `datetime` to `date`,
 *     so authors needing a datetime seed for a date widget must
 *     coerce explicitly via `dateCoerce(...)`.
 * Date-range is intentionally absent. CommCare's daterange answer is one
 * paired value, while this contract has no paired-default slot.
 *   - `barcode` → `"text"` — barcode-scanned values surface as
 *     plain strings.
 *
 * Single source of truth — the editor's per-widget default
 * authoring surface, the SA tool surface, and the validator all
 * read from this table.
 */
export const SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES: Readonly<
	Record<Exclude<SearchInputType, "date-range">, CasePropertyDataType>
> = {
	text: "text",
	date: "date",
	barcode: "text",
};

/**
 * The scalar type produced by each search widget at runtime when an
 * `input(name)` term reads its bound value.
 *
 * This is deliberately separate from both the target property's type and
 * `SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES`: those describe what the widget
 * may search and what may seed it, while this table describes the actual wire
 * value downstream predicates consume.
 *
 *   - Text and barcode prompts bind strings.
 *   - A date prompt binds one calendar date, even when its simple arm targets
 *     a datetime property.
 *   - A date-range prompt binds CCHQ's encoded
 *     `__range__<from>__<to>` scalar, not one of its date endpoints, so the
 *     bare `input(name)` value is text. Consumers needing either endpoint must
 *     decode the range rather than treating the whole binding as a date.
 *
 * Both simple and advanced inputs use this map. Advanced inputs have no target
 * property, and a simple input's target cannot change what its widget emits.
 */
export const SEARCH_INPUT_RUNTIME_VALUE_TYPES: Readonly<
	Record<SearchInputType, CasePropertyDataType>
> = {
	text: "text",
	date: "date",
	"date-range": "text",
	barcode: "text",
};

/**
 * The `SearchInputMode["kind"]` arms that can drive a per-input default.
 */
export type DefaultableModeKind = SearchInputMode["kind"];

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
	date: "exact",
	"date-range": "range",
	barcode: "exact",
};

/** The effective mode for a simple input after applying its widget default. */
export function effectiveSimpleSearchModeKind(
	input: SimpleSearchInputDef,
): SearchInputMode["kind"] {
	return input.mode?.kind ?? DEFAULT_SEARCH_MODE_KIND[input.type];
}

/**
 * Whether a simple input's widget can collect the value its mode consumes.
 * The final schema makes incoherence impossible; this remains a useful
 * type-narrowing assertion for consumers.
 */
export function simpleSearchInputHasCoherentRangeWidget(
	input: SimpleSearchInputDef,
): boolean {
	return (
		(effectiveSimpleSearchModeKind(input) === "range") ===
		(input.type === "date-range")
	);
}

// ── CaseListConfig ───────────────────────────────────────────────
//
// The structured case-list configuration:
//
//   - `columns` — display + sort + calc + visibility, all here.
//   - `filter?` — optional always-on predicate.
//   - `searchInputs` — discriminated `simple` / `advanced` union.
//   - `selection?` — bounded multi-case selection. Absence is single-case.
//
// A module without a case list (survey-only modules) omits the slot
// entirely; a module with a case list always carries every required
// sub-field, even if `columns` / `searchInputs` are empty arrays.

// ── Case-tile layout ─────────────────────────────────────────────

/**
 * The case list's tile layout. PRESENCE is the switch: a config
 * carrying this slot renders its Results rows as a grid of cells
 * instead of a row of columns, on every surface the short detail
 * drives — the case list, the search-results list, and the
 * persistent tile. A config without it keeps the row layout.
 *
 * There is no template slug here, and there never will be. CommCare
 * HQ ships two named tile templates (`person_simple`,
 * `icon_text_grid` —
 * `commcare-hq/corehq/apps/app_manager/suite_xml/features/case_tiles.py::CaseTileTemplates`)
 * whose slots an author fills by name; Nova emits only HQ's `custom`
 * vocabulary, where every cell carries its own placement. That
 * sidesteps `person_simple`'s hardcoded profile-image slot and its
 * literal non-parameterized `m0-f0` registration action, and HQ's
 * per-template slot-mapping validators
 * (`case_tiles.py::CaseTileHelper._get_matched_detail_column` raises
 * a build error for any unmapped template slot). Nova's layout
 * presets are builder gestures that fill per-column placement; they
 * are never persisted as a template name, so a preset and a
 * hand-drawn layout take exactly the same wire path.
 *
 * Two runtime tile controls are deliberately absent. CommCare Core
 * reads `fit-across` (tiles per row) and `uniform-units` (square
 * cells) off `<detail>`
 * (`commcare-core/.../org/commcare/xml/DetailParser.java::DetailParser.parse`),
 * but HQ models neither — there is no `Detail` field for either and
 * HQ never emits the attributes — so an app carrying them would lose
 * them silently on the primary HQ delivery path. Because they are
 * absent, Nova's renderer pins what the runtime assumes without
 * them: one tile per row and non-uniform (`min-content`) row
 * heights.
 */
/**
 * How a grouped case list clusters its rows.
 *
 * **Nova narrows the group key to a case index. That is Nova's choice,
 * not the platform's rule.**
 * `commcare-core/.../org/commcare/xml/DetailGroupParser.java::DetailGroupParser.parse`
 * validates the group function with `XPathParseTool.parseXPath` and
 * nothing else, the runtime keeps the result as an opaque string
 * (`cases/entity/NodeEntityFactory::getEntity` evaluates it to a
 * `String` that only ever gets compared and used as a map key), and a
 * shipped fixture groups by `string(case_name)`. The narrowing exists
 * because the group header is drawn from the group's FIRST case, so a
 * header cell is honest only when its value is invariant across every
 * member — and a case index is the only key Nova can statically prove
 * invariant. Grouping by a plain property would make exactly one value
 * shared and turn every other header cell into a guess taken from an
 * arbitrary member. Do not write "CommCare requires an index"
 * anywhere; property-keyed grouping is out of scope, not impossible.
 *
 * The empty key is the sharpest hazard and the runtime has no answer
 * for it: `string(./index/parent)` on a case carrying no such index
 * evaluates to `""`, which the clustering map accepts as an ordinary
 * key, so every such case collapses into ONE group headed by whichever
 * of them sorts first. There is no "ungrouped" concept in the engine,
 * so Nova must not invent one — the authoring surface measures and
 * states the consequence instead.
 */
export const caseTileGroupingSchema = z
	.object({
		/**
		 * The case-index identifier whose target is the group key —
		 * `parent` for the relationship a `CaseType.parent_type`
		 * declares (`lib/commcare/xform/caseBlocks.ts` emits that
		 * identifier literally), or the identifier an advanced case
		 * operation's link carries.
		 *
		 * Drawn from the same XML-element-name vocabulary
		 * `RelationStep.identifier` uses, for the same reason: it is
		 * written straight into the emitted `string(./index/<id>)` path
		 * step, so anything outside that class would emit an expression
		 * the runtime cannot parse. Constraining it here is what makes
		 * the emitter total — there is no escaping step anywhere.
		 */
		identifier: z
			.string()
			.regex(
				XML_ELEMENT_NAME_PATTERN,
				"A grouping connection name must start with a letter or underscore and contain only letters, digits, or underscores. It is written straight into the group's `string(./index/…)` path step, so characters outside that class emit an expression the runtime cannot parse.",
			),
		/**
		 * Rows of the tile that form the group header, counted from the
		 * top. Always stored and always emitted: the two sides default
		 * `header-rows` differently — the CLIENT falls back to `1`
		 * (`DetailGroupParser::parse`) while HQ's model defaults to `2`
		 * (`commcare-hq/.../models/case_list.py::CaseTileGroupConfig.header_rows`)
		 * — so an omitted attribute silently halves or doubles the
		 * header depending on which side reads it.
		 *
		 * The bound here is the grid; the real constraint is
		 * layout-relative (strictly less than the tile's occupied row
		 * extent, and never splitting a cell) and lives in
		 * `lib/commcare/validator/rules/case-list/caseTileGrouping.ts`.
		 */
		headerRows: persistableJsonPositiveIntegerSchema.max(TILE_GRID_ROWS - 1),
	})
	.strict();
export type CaseTileGrouping = z.infer<typeof caseTileGroupingSchema>;

/**
 * Whether a tile cell belongs to the group header rather than the
 * group's body rows.
 *
 * START ROW ONLY — the cell's height is deliberately ignored, because
 * `commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::CaseTileGroupedListView.initialize`
 * classifies with `const isHeaderRow = (y) => y < groupHeaderRows` and
 * the client never splits a cell across the boundary. A cell that
 * straddles is therefore drawn entirely in the header, from the
 * group's first case; the validator refuses that state rather than
 * letting per-case content silently become group content.
 *
 * One home, called by the validator, the preview projection, and the
 * builder canvas — the same discipline `tileCellFor` carries, and for
 * the same reason: paths agreeing by hand is a coincidence with a
 * short half-life.
 */
export function tileCellIsGroupHeader(
	cell: TileCell,
	headerRows: number,
): boolean {
	return cell.y < headerRows;
}

/**
 * Every header depth that cuts THIS tile cleanly, ascending.
 *
 * A clean cut is one an author could actually have meant: something in
 * the header, something below it, and no field split across the
 * boundary. Those are exactly the three states
 * `lib/commcare/validator/rules/case-list/caseTileGrouping.ts` refuses,
 * so the builder offers this list and an author never reaches a
 * rejected commit to learn a depth was unavailable. A test pins the two
 * against each other in both directions.
 *
 * `cells` is the SHOWN cells — what `tileCellFor` admits, never the
 * stored placements. A hidden, order-driving column keeps its cell but
 * emits no `<style>`, so it is not on the tile and must not widen this
 * arithmetic either.
 *
 * Empty when the tile has no shown cell, and empty for a one-row tile:
 * a single row has no room for both a header and a body.
 */
export function tileGroupHeaderRowChoices(
	cells: readonly TileCell[],
): readonly number[] {
	if (cells.length === 0) return [];
	const occupiedRows = Math.max(...cells.map(tileCellBottomEdge));
	const choices: number[] = [];
	for (let headerRows = 1; headerRows < occupiedRows; headerRows += 1) {
		const straddles = cells.some(
			(cell) =>
				tileCellIsGroupHeader(cell, headerRows) &&
				tileCellBottomEdge(cell) > headerRows,
		);
		if (straddles) continue;
		if (!cells.some((cell) => tileCellIsGroupHeader(cell, headerRows)))
			continue;
		choices.push(headerRows);
	}
	return choices;
}

export const caseTileLayoutSchema = z
	.object({
		/**
		 * Keep the tile on screen above every form in this module.
		 *
		 * Emits as `detail-persistent="m{N}_case_short"` on the entry's
		 * case datum; Web Apps renders it in the sticky
		 * `#persistent-case-tile` region above the form
		 * (`cloudcare/.../formplayer/menus/views.js::PersistentCaseTileView`,
		 * stickiness from `.case-tile-container` in
		 * `hqwebapp/static/cloudcare/scss/formplayer-webapp/case-tile.scss`).
		 * The one surface that suppresses it is HQ's App Preview pane
		 * (`menus/controller.js::showMenu` gates on
		 * `displayOptions.singleAppMode`), which Nova does not target.
		 *
		 * `true` is the only stored value; absence is off, matching the
		 * "visibility true is canonicalized as absence" convention the
		 * column slots already follow.
		 */
		persistOnForms: z.literal(true).optional(),
		/**
		 * Cluster the list's rows under a shared connected case, drawing
		 * the top `headerRows` rows of this same tile once per group from
		 * the group's first case. Absent is ungrouped.
		 *
		 * Grouping lives INSIDE the layout rather than beside it, which
		 * is what makes a `<group>` on a detail with no tile
		 * unrepresentable instead of merely rejected. That state is
		 * reachable in the wire and is silently broken: Formplayer sets
		 * `groupHeaderRows` from the `<group>` whether or not tiles exist
		 * (`EntityListResponse`'s constructor), so the list still
		 * clusters and still pages by group, while
		 * `cloudcare/.../formplayer/menus/utils.js::getCaseListView`
		 * routes to `CaseTileGroupedListView` only when `tiles` is
		 * present and therefore renders it flat. Nesting also means
		 * turning the tile off clears the grouping in the same write.
		 */
		grouping: caseTileGroupingSchema.optional(),
	})
	.strict();
export type CaseTileLayout = z.infer<typeof caseTileLayoutSchema>;

/**
 * A case list either keeps Nova's ordinary one-case flow (the slot is absent)
 * or lets the worker choose a bounded set. Only the non-default state is
 * stored, so legacy documents remain byte-identical and there is no second
 * spelling such as `{ kind: "single" }`.
 *
 * The upper bound is a Nova product invariant shared by Builder, Preview,
 * submission, and both export paths. The runtime still defends the received
 * set, but an authored app can never request a larger batch.
 */
export const caseSelectionSchema = z
	.object({
		kind: z.literal("multiple"),
		maximum: persistableJsonPositiveIntegerSchema.max(100),
	})
	.strict();
export type CaseSelection = z.infer<typeof caseSelectionSchema>;

export type CaseSelectionCardinality = "single" | "multiple";

export const caseListConfigSchema = z
	.object({
		/**
		 * The columns themselves — a SET, keyed by uuid. Its array position
		 * carries no meaning, because Results and Details are two independent
		 * sequences over these same columns and one array cannot hold both.
		 */
		columns: z.array(columnSchema),
		/**
		 * The Results sequence, and the Details sequence — each a complete
		 * permutation of `columns` by uuid.
		 *
		 * Every column appears in BOTH exactly once regardless of visibility, so
		 * hiding a column and showing it again restores its place rather than
		 * appending it. This is the one collection whose sequence cannot be the
		 * membership array, which is why it gets two arrays of its own instead.
		 */
		listColumnOrder: z.array(uuidSchema),
		detailColumnOrder: z.array(uuidSchema),
		filter: predicateSchema.optional(),
		searchInputs: z.array(searchInputDefSchema),
		/**
		 * How many cases a worker can carry forward from Results. Absence is the
		 * ordinary single-case flow; the stored arm is multiple-only so one intent
		 * has one canonical representation.
		 */
		selection: caseSelectionSchema.optional(),
		/**
		 * Tile layout for the Results surface. Absent ≡ the ordinary row
		 * layout. See `caseTileLayoutSchema`.
		 */
		tile: caseTileLayoutSchema.optional(),
		/**
		 * Image for the "Open case list" affordance — the menu link from
		 * the module's home screen that opens the case list. Emits ONLY on
		 * `caseListOnly` modules: that's the one shape where a standalone
		 * case-list command exists to host the icon (the local `.ccz`
		 * command `<display>`, the HQ `case_list.media_image` dict). On a
		 * module with forms there's no standalone case-list command, so the
		 * slot is a no-op there. The bytes are collected by the
		 * `mediaRefs.ts` walk under the same `caseListOnly` gate.
		 */
		icon: moduleIconRefSchema.optional(),
		/**
		 * Audio prompt for the case-list link. Same `caseListOnly`-only
		 * emission shape as `icon` above (local command `<display>` +
		 * HQ `case_list.media_audio`). Menu affordances carry image +
		 * audio only — there is no video slot (unlike a question
		 * message, which can carry all three).
		 */
		audioLabel: mediaAssetIdSchema.optional(),
	})
	.strict()
	.superRefine((config, ctx) => {
		const columnUuids = config.columns.map((column) => column.uuid);
		const columnSet = new Set(columnUuids);
		if (columnSet.size !== columnUuids.length) {
			ctx.addIssue({
				code: "custom",
				path: ["columns"],
				message: "Case-list column UUIDs must be unique.",
			});
		}
		const checkOrder = (
			order: readonly Uuid[],
			key: "listColumnOrder" | "detailColumnOrder",
		): void => {
			const seen = new Set<Uuid>();
			for (const [index, uuid] of order.entries()) {
				if (seen.has(uuid)) {
					ctx.addIssue({
						code: "custom",
						path: [key, index],
						message: `${key} contains a duplicate column UUID.`,
					});
				}
				seen.add(uuid);
				if (!columnSet.has(uuid)) {
					ctx.addIssue({
						code: "custom",
						path: [key, index],
						message: `${key} names a UUID that is not a column in this case list.`,
					});
				}
			}
			for (const uuid of columnUuids) {
				if (!seen.has(uuid)) {
					ctx.addIssue({
						code: "custom",
						path: [key],
						message: `${key} must contain every case-list column exactly once.`,
					});
				}
			}
		};
		checkOrder(config.listColumnOrder, "listColumnOrder");
		checkOrder(config.detailColumnOrder, "detailColumnOrder");
	});
export type CaseListConfig = z.infer<typeof caseListConfigSchema>;

/**
 * A case list with no columns and no search — the shape a config is BORN with.
 *
 * A factory rather than a shared constant because the two ordering arrays are
 * mutable and a shared literal would let one module's config alias another's.
 * Both arrays are written even when empty: an ordering array that is merely
 * absent would mean "derive it somehow", which is the ambiguity array position
 * exists to remove.
 */
export function emptyCaseListConfig(): CaseListConfig {
	return {
		columns: [],
		listColumnOrder: [],
		detailColumnOrder: [],
		searchInputs: [],
	};
}

/**
 * Effective selection cardinality without coupling it to module navigation.
 * `isCaseFirstModule` answers which screen comes first; this answers whether
 * the case datum on a case-loading entry is scalar or collection-shaped.
 */
export function caseSelectionCardinality(
	module: Pick<Module, "caseListConfig">,
): CaseSelectionCardinality {
	return module.caseListConfig?.selection?.kind ?? "single";
}

/**
 * Effective number of selectable cases. The absent single-case state has a
 * real maximum of one, while the authored multiple state carries its bound.
 */
export function caseSelectionMaximum(
	module: Pick<Module, "caseListConfig">,
): number {
	return module.caseListConfig?.selection?.maximum ?? 1;
}

/**
 * Whether a structural child can inherit the exact case selection its parent
 * authored. Runtime selection size is deliberately irrelevant: a parent that
 * promises as many as ten cases cannot flow into a child authored for five
 * merely because this particular worker happened to choose three.
 *
 * Keeping this projection in the domain makes Preview, nested-menu suite
 * alignment, direct-link admission, and whole-document validation prove the
 * same shape: same case type, same scalar/set cardinality, and enough authored
 * room at the destination for every set the source permits.
 */
export function caseSelectionCanFlowBetweenModules(
	sourceModule: Pick<Module, "caseListConfig" | "caseType">,
	targetModule: Pick<Module, "caseListConfig" | "caseType">,
): boolean {
	if (
		sourceModule.caseType === undefined ||
		sourceModule.caseType !== targetModule.caseType
	) {
		return false;
	}
	if (
		caseSelectionCardinality(sourceModule) !==
		caseSelectionCardinality(targetModule)
	) {
		return false;
	}
	return (
		caseSelectionMaximum(targetModule) >= caseSelectionMaximum(sourceModule)
	);
}

/**
 * Whether one case-loading form can open another without losing or
 * reinterpreting its selected cases. The ordinary scalar flow remains
 * compatible across modules: existing form links already carry their one
 * required case datum explicitly when the case types differ. Once either
 * side is collection-shaped, both sides must describe the same collection,
 * and an authored datum map cannot stand in for that collection.
 *
 * Both the form-link choice planner and whole-document validation ask this
 * projection, so a destination the Builder offers cannot be refused later by
 * the commit gate for selection cardinality.
 */
export function formLinkSelectionIsCompatible(args: {
	readonly sourceModule: Pick<Module, "caseListConfig" | "caseType">;
	readonly targetModule: Pick<Module, "caseListConfig" | "caseType">;
	readonly sourceLoadsCase: boolean;
	readonly targetLoadsCase: boolean;
	readonly hasAuthoredDatums: boolean;
}): boolean {
	if (!args.sourceLoadsCase || !args.targetLoadsCase) return true;

	const sourceCardinality = caseSelectionCardinality(args.sourceModule);
	const targetCardinality = caseSelectionCardinality(args.targetModule);
	if (sourceCardinality === "single" && targetCardinality === "single") {
		return true;
	}

	return (
		caseSelectionCanFlowBetweenModules(args.sourceModule, args.targetModule) &&
		!args.hasAuthoredDatums
	);
}

/**
 * The case list's columns in one surface's order.
 *
 * Results and Details are two sequences over one set of columns, so reading
 * either means resolving that surface's array against the set. Every consumer —
 * the wire emitters, the authoring canvases, the running preview — goes through
 * here so no two of them can order the same screen differently.
 *
 * The final schema proves this permutation. A mismatch here means a caller
 * bypassed the domain boundary, so the helper asserts instead of silently
 * dropping, appending, or reordering anything.
 */
export function orderedColumns(
	config: CaseListConfig,
	surface: "list" | "detail",
): Column[] {
	const sequence =
		surface === "list" ? config.listColumnOrder : config.detailColumnOrder;
	const byUuid = new Map(config.columns.map((column) => [column.uuid, column]));
	if (
		byUuid.size !== config.columns.length ||
		sequence.length !== config.columns.length ||
		new Set(sequence).size !== sequence.length
	) {
		throw new Error(
			`Invalid ${surface} case-list column permutation reached orderedColumns.`,
		);
	}
	return sequence.map((uuid) => {
		const column = byUuid.get(uuid);
		if (column === undefined) {
			throw new Error(
				`Invalid ${surface} case-list column permutation reached orderedColumns.`,
			);
		}
		return column;
	});
}

// ── CaseSearchConfig ─────────────────────────────────────────────
//
// Search-action configuration plus one owner-availability slot:
//
//   - The display cluster — the search-screen labels (title /
//     subtitle / button labels / empty state) and the optional
//     `searchButtonDisplayCondition` predicate that gates the search
//     button.
//   - `excludedOwnerIds` — a rare availability rule that evaluates to a
//     space-separated list of owner ids. It constrains ordinary Results,
//     Preview, direct suite case-loading, and remote Search alike; its storage
//     remains here because CCHQ persists the corresponding wire expression on
//     CaseSearch.
//
/** Friendly Nova defaults shared by authoring, flipbook, and both wire paths. */
export const DEFAULT_CASE_SEARCH_TITLE = "Search";
export const DEFAULT_CASE_SEARCH_BUTTON_LABEL = "Search";

// The runtime case-claim step (which fires when an author picks a
// case from search results) runs unconditionally on the CCHQ
// runtime — there is no authoring affordance for it. Display sort,
// the always-on filter, and search inputs are not duplicated here;
// they live on `caseListConfig` as the single source for both
// screens.

export const ordinaryCaseSearchConfigSchema = z
	.object({
		// Owner-availability slot.
		// `excludedOwnerIds` evaluates ONCE, before a case is selected, to a
		// space-separated list of owner ids whose cases are excluded from every
		// Results path. It may use literals, session/current-user values, Search
		// answers, and pure calculations over those values. It cannot read a case
		// property or relationship because no case row exists in this global
		// evaluation context. The document-aware gate checks that semantic scope.
		// Rare in practice; the builder owns it beside Cases available.
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
		// text. `searchButtonDisplayCondition` controls whether the case
		// list's Search action is relevant. When the web wire auto-launches
		// an input-free filtered search, an irrelevant action cannot launch;
		// otherwise the same predicate simply hides the manual Search action.
		// It never filters Results rows itself.
		//
		// Empty strings are rejected — every text input on the editor
		// drops the slot to `undefined` when the user clears it, so
		// "presence with empty body" is a structurally invalid state.
		// Both wire emitters and preview share Nova's friendly defaults.
		// Rejecting empty keeps the contract simple: present means useful
		// authored copy; clearing a control removes the override.
		searchScreenTitle: z.string().min(1).optional(),
		searchScreenSubtitle: z.string().min(1).optional(),
		searchButtonLabel: z.string().min(1).optional(),
		searchButtonDisplayCondition: predicateSchema.optional(),
	})
	.strict();

export const ownerOnlyCaseSearchConfigSchema = z
	.object({
		/**
		 * Private provenance for assigned-case availability without a Search
		 * action. This is an exact stored arm: it requires the owner expression
		 * and structurally forbids all ordinary Search screen/action settings.
		 */
		searchActionEnabled: z.literal(false),
		excludedOwnerIds: valueExpressionSchema,
	})
	.strict();

export const caseSearchConfigSchema = z.union([
	ordinaryCaseSearchConfigSchema,
	ownerOnlyCaseSearchConfigSchema,
]);
export type OrdinaryCaseSearchConfig = z.infer<
	typeof ordinaryCaseSearchConfigSchema
>;
export type OwnerOnlyCaseSearchConfig = z.infer<
	typeof ownerOnlyCaseSearchConfigSchema
>;
export type CaseSearchConfig = z.infer<typeof caseSearchConfigSchema>;

/** Whether the optional search-settings bag contains a real authored
 * override. Explicit `undefined` keys can survive editor objects, so
 * `Object.keys(config).length` is not a semantic emptiness check. */
export function caseSearchConfigHasAuthoredSettings(
	config: CaseSearchConfig | undefined,
): boolean {
	if (config === undefined) return false;
	if (isOwnerOnlyCaseSearchConfig(config)) return true;
	return (
		config.excludedOwnerIds !== undefined ||
		config.searchScreenTitle !== undefined ||
		config.searchScreenSubtitle !== undefined ||
		config.searchButtonLabel !== undefined ||
		config.searchButtonDisplayCondition !== undefined
	);
}

/** Whether the shared bag explicitly carries Nova's owner-only provenance.
 *
 * Only the private `searchActionEnabled:false` bit proves this intent. A
 * `match-none` button condition is valid authoring in its own right, so it must
 * never be reinterpreted or stripped merely because an owner rule is present.
 */
export function isOwnerOnlyCaseSearchConfig(
	config: CaseSearchConfig | undefined,
): config is OwnerOnlyCaseSearchConfig {
	return config !== undefined && "searchActionEnabled" in config;
}

/** The ordinary Search-screen/action arm, excluding absence and the private
 * owner-only availability arm. */
export function isOrdinaryCaseSearchConfig(
	config: CaseSearchConfig | undefined,
): config is OrdinaryCaseSearchConfig {
	return config !== undefined && !isOwnerOnlyCaseSearchConfig(config);
}

/**
 * Project Search configuration after its final input is removed.
 *
 * Title and subtitle belong to the input screen and therefore disappear with
 * that screen. Action settings remain valid on a zero-input manual action, and
 * an effective Cases available rule retains the action for automatic Results.
 * Assigned-case availability alone remains independent and carries the
 * internal no-action marker instead of manufacturing Search.
 */
export function caseSearchConfigAfterFinalInputRemoval(
	config: CaseSearchConfig | undefined,
	hasCasesAvailableCondition: boolean,
): CaseSearchConfig | undefined {
	if (config === undefined) return undefined;
	if (isOwnerOnlyCaseSearchConfig(config)) return config;
	const {
		searchScreenTitle: _title,
		searchScreenSubtitle: _subtitle,
		...action
	} = config;
	const hasSearchActionSetting =
		action.searchButtonLabel !== undefined ||
		action.searchButtonDisplayCondition !== undefined;
	if (hasCasesAvailableCondition || hasSearchActionSetting) return action;
	if (action.excludedOwnerIds !== undefined) {
		return { ...action, searchActionEnabled: false };
	}
	return undefined;
}

// ── Module ───────────────────────────────────────────────────────

export const moduleSchema = z
	.object({
		uuid: uuidSchema,
		id: z.string(), // semantic id (snake_case display slug)
		name: z.string(),
		/** Optional parent menu. Omission is a top-level module. */
		parentModuleUuid: uuidSchema.optional(),
		caseType: z.string().optional(),
		caseListOnly: z.boolean().optional(),
		purpose: z.string().optional(),
		/**
		 * Optional home-menu visibility rule. Module navigation has no current
		 * case row, so validator context rules admit only global/session terms.
		 */
		displayCondition: predicateSchema.optional(),
		caseListConfig: caseListConfigSchema.optional(),
		caseSearchConfig: caseSearchConfigSchema.optional(),
		/** Image shown on the module's home-screen tile. */
		icon: moduleIconRefSchema.optional(),
		/**
		 * Audio version of the module's home-screen label, played by
		 * audio-prompt mode — an accessibility affordance for
		 * low-literacy field workers. Menu affordances carry image +
		 * audio only; there is no video slot here.
		 */
		audioLabel: mediaAssetIdSchema.optional(),
	})
	.strict();
export type Module = z.infer<typeof moduleSchema>;

/**
 * The search configuration that governs the running app and both wire paths.
 *
 * A stored `caseSearchConfig` normally enables search, including an intentional
 * zero-input action. The internal false marker is the one exception: it records
 * that the shared bag exists only for assigned-case availability. Search inputs
 * also make search unambiguous, so a module with inputs and no separate config
 * receives Nova's friendly defaults. A case-list filter by itself does NOT turn
 * on search; it remains the always-on "Cases available" rule.
 */
export function effectiveCaseSearchConfig(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
): OrdinaryCaseSearchConfig | undefined {
	const hasInputs = (module.caseListConfig?.searchInputs.length ?? 0) > 0;
	const stored = module.caseSearchConfig;
	if (stored === undefined) return hasInputs ? {} : undefined;
	if (!isOwnerOnlyCaseSearchConfig(stored)) return stored;
	if (!hasInputs) return undefined;
	throw new Error(
		"Owner-only case-search provenance reached runtime with Search inputs.",
	);
}

export type ModuleKindMetadata = {
	icon: string;
	saDocs: string;
};
export const moduleMetadata: ModuleKindMetadata = {
	icon: "tabler:stack",
	saDocs:
		"A module is a top-level menu in the CommCare app. It groups related forms under one case type.",
};
