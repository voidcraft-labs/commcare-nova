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
//   - `filter?: Expression` — single optional always-on predicate
//     applied to every row before display.
//   - `searchInputs: SearchInputDef[]` — discriminated union of
//     simple `(property, mode, via)` inputs and advanced inputs
//     whose body is a free-form `predicate`.
//   - `selection?: { kind: "multiple"; maximum: number }` — absence keeps the
//     ordinary one-case flow; presence makes selection an explicitly bounded
//     ordered collection.
//
// `Expression`, `Expression`, and `RelationPath` come from
// `@/lib/domain/expression` — the AST primitives the filter,
// calculated-column expression, search-input default, and search-
// input advanced predicate slots reference. Importing them here
// (rather than redefining the shapes) keeps the AST cycles
// consolidated in one package and keeps every authoring surface
// bound against the same Zod schemas.

import { z } from "zod";
import { formIconRefSchema, moduleIconRefSchema } from "./builtinIcons";
import { caseFormContextSchema } from "./caseFormContext";
import { uniqueCaseMappingRows } from "./caseMappingRows";
import {
	authoredCasePropertyNameSchema,
	readCasePropertyNameSchema,
} from "./casePropertyName";
import type { CasePropertyDataType } from "./casePropertyTypes";
import { COMMCARE_DATE_PATTERN_REGEX } from "./commCareDatePattern";
import { detailTabSpans, detailTabsSchema } from "./detailTabSchema";
import { entryPointSchema } from "./entryPoints";
import type {
	Expression,
	RelationPath,
	RelationStep,
} from "./expression/types";
import {
	caseTypeNameSchema,
	conditionSchema,
	relationPathSchema,
	relationStepSchema,
	valueSchema,
	XML_ELEMENT_NAME_PATTERN,
} from "./expression/types";
import {
	persistableJsonIntegerSchema,
	persistableJsonNonnegativeIntegerSchema,
	persistableJsonPositiveIntegerSchema,
} from "./jsonNumber";
import { lookupOptionsSourceSchema } from "./lookupCarriers";
import { lookupReadSchema, sameLookupRead } from "./lookupRead";
import { menuBadgeSchema } from "./menuBadge";
import { type MediaAssetId, mediaAssetIdSchema } from "./multimedia";
import {
	formerNavigationMediaSchema,
	navigationMediaSchema,
} from "./navigationMedia";
import { CASE_NODE_ATTRIBUTE_PROPERTIES } from "./standardCaseProperties";
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
// A rule follows the value’s type unless the author selects another
// comparison. A display format with its own key still decides its comparison.

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

/** Where a sort rule puts the cases with no value. */
export const SORT_BLANKS = ["first", "last"] as const;
export type SortBlanks = (typeof SORT_BLANKS)[number];

/** Where a rule of this direction puts blank values when it says nothing:
 *  first ascending, last descending. */
export function defaultSortBlanks(direction: SortDirection): SortBlanks {
	return direction === "asc" ? "first" : "last";
}

/** A rule's keys with no rule between them: what a tool input takes before
 *  `columnSort` stores it. */
export const SORT_COMPARISONS = [
	"text",
	"integer",
	"decimal",
	"distance",
] as const;
export type SortComparison = (typeof SORT_COMPARISONS)[number];

export const columnSortShape = {
	/** Earlier positions name hidden choices before those that follow the default order. */
	menuPosition: persistableJsonNonnegativeIntegerSchema
		.optional()
		.describe(
			"Position among the extra choices workers can pick in Sort by, starting at 0. Leave it out to follow the default case order. Displayed fields already follow their Results positions.",
		),
	comparator: z
		.enum(SORT_COMPARISONS)
		.optional()
		.describe(
			"How to compare the values. Leave it out to use the field’s usual order. Text orders 10 before 2. A whole-number or decimal comparison orders 2 before 10. Distance orders locations from the worker’s position on Android.",
		),
	direction: z.enum(SORT_DIRECTIONS),
	priority: persistableJsonNonnegativeIntegerSchema,
	/** Where cases with no value sort. Stored only where it differs from the
	 *  direction's own. */
	blanks: z
		.enum(SORT_BLANKS)
		.optional()
		.describe(
			'Where cases with no value sort: "first" or "last". Leave it out to follow the direction: first when ascending, last when descending.',
		),
	/** The name a worker picks this rule by in the list's Sort by menu, on a
	 *  column hidden from Results. A shown column is offered there under its
	 *  header already. */
	label: z
		.string()
		.optional()
		.describe(
			"The name workers pick this column by in the list's Sort by menu, for a column hidden from Results (visibleInList false). A column shown on Results is offered there under its header, so leave it out there. Android lists it; Web Apps lists it only in a case tile's Sort By.",
		),
};

/**
 * Per-column sort directive: direction, priority, and where blanks sort
 * where that differs from the direction's own. The field supplies its ordinary comparator.
 * An explicit comparator chooses another reading.
 *
 * `priority` is a non-negative integer; tie-break to Results display
 * order is uniform across saga / preview / wire layers (no layer
 * assumes uniqueness). One meaning has one stored form: an ascending rule
 * with blanks first is the rule with no `blanks`, so every writer builds a
 * rule through `columnSort`. `label` is the source-language name of the rule
 * in the list's Sort by menu, held on a column hidden from Results
 * (`columnSortLabelShows`).
 */
export const columnSortSchema = z
	.strictObject(columnSortShape)
	.superRefine((sort, ctx) => {
		if (
			sort.blanks !== undefined &&
			sort.blanks === defaultSortBlanks(sort.direction)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["blanks"],
				message:
					"An ascending rule already puts blank values first, and a descending rule last, so blanks is kept only when it says the other one.",
			});
		}
		// A name of nothing but characters up to U+0020, which a device trims
		// away, names nothing; the gate refuses one CommCare HQ reads as blank.
		if (
			sort.label !== undefined &&
			[...sort.label].every((char) => (char.codePointAt(0) ?? 0) <= 0x20)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["label"],
				message:
					"A name in Sort by needs some text a worker can read. Leave label out where the column needs no name there.",
			});
		}
	});
export type ColumnSort = z.infer<typeof columnSortSchema>;

/** Where the rule puts blank values. The one reader. */
export function sortBlanks(sort: ColumnSort): SortBlanks {
	return sort.blanks ?? defaultSortBlanks(sort.direction);
}

/** A rule in its one stored form: `blanks` left out where it is the
 *  direction's own, and `label` where it names nothing. */
export function columnSort(
	direction: SortDirection,
	priority: number,
	blanks?: SortBlanks,
	label?: string,
	comparator?: SortComparison,
	menuPosition?: number,
): ColumnSort {
	return {
		direction,
		priority,
		...(blanks !== undefined &&
			blanks !== defaultSortBlanks(direction) && { blanks }),
		...(label !== undefined && { label }),
		...(comparator !== undefined && { comparator }),
		...(menuPosition !== undefined && { menuPosition }),
	};
}

/**
 * Whether a column's sort rule names it in the list's Sort by menu: a rule
 * with a label on a column on the list and hidden from Results. A shown
 * column is offered under its header already (the gate refuses a label
 * there, `CASE_LIST_SORT_LABEL_NOT_SHOWN`), and a column that is not on
 * the list holds no rule. The one reader of where a label reaches a screen.
 */
export function columnSortLabelShows(column: Column): boolean {
	return (
		column.sort?.label !== undefined &&
		column.visibleInList === false &&
		column.notOnList !== true
	);
}

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
const columnCommonSlots = z.strictObject({
	sort: columnSortSchema.optional(),
	visibleInList: z.boolean().optional(),
	visibleInDetail: z.boolean().optional(),
	/** Present when the column is no field of the case list at all: the
	 *  case's detail alone holds it. The list does not show it, match it in
	 *  its filter or sort by it. A column that holds it holds
	 *  `visibleInList: false` and no `sort`
	 *  (`CASE_LIST_COLUMN_NOT_ON_LIST_INVALID`). */
	notOnList: z.literal(true).optional(),
});

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
 * The fewest rows a tile offers. Neither runtime bounds a tile's rows:
 * both size the grid from the cells it holds (Core's
 * `Detail.getMaxWidthHeight`, Android's `EntityViewTile.getMaxRows`). The
 * bound is CommCare HQ's own Case List and Case Detail pages, which offer
 * a cell's start row and height from `max(columns + 1, 7)`, the columns
 * being the screen's own non-filter columns, a long detail's tabs among
 * them (`static/app_manager/js/details/bootstrap5/screen.js`,
 * `caseTileRowMax`; `column.js`, `tileRowOptions` and `tileHeightOptions`).
 * Each select binds Knockout's `value` with `options` and no
 * `valueAllowUnset`, so a stored start row the page does not offer comes
 * back as the first row, and a height it does not offer as one row, and
 * the page's next save writes that: observed on HQ's own pages by proof 4
 * over `targeted-tile-row-bound`. So a cell's bottom edge may reach
 * `max(fields, 6)` rows, and a tile holding more than twelve fields may
 * be taller than twelve rows (`tileRowLimit`).
 */
export const TILE_MIN_ROWS = 6;

/**
 * The rows a tile of `fields` fields offers: the bottom edge a cell may
 * reach (`TILE_MIN_ROWS` says where the number comes from). The fields are
 * the columns HQ's page shows for that screen: a Results tile's
 * (`resultsTileFieldCount`) or a Details tile's
 * (`detailsTileFieldCount`).
 */
export function tileRowLimit(fields: number): number {
	return Math.max(fields, TILE_MIN_ROWS);
}

/**
 * The fields of a custom Results tile's short detail, which are the
 * columns HQ's Case List page counts: every column on the list that the
 * tile shows (`lib/domain/caseListOrder.ts`, rule 1: a column hidden from
 * Results is no field of a tile list, and a column that is not on the
 * list is no field of any). Counted as the tile would hold them whether
 * or not the layout is on, so a placement kept while tiles are off still
 * fits when they come back on.
 */
export function resultsTileFieldCount(
	config: Pick<CaseListConfig, "columns">,
): number {
	return config.columns.filter(
		(column) => columnOnList(column) && column.visibleInList !== false,
	).length;
}

/**
 * The columns HQ's Case Detail page counts for a Details tile: every field
 * shown in Details and each tab, which the page holds as a column of its
 * own (`screen.js`, the tabs spliced into the columns before the filters
 * are dropped). Observed: a Details tile of six fields and two tabs keeps a
 * cell ending on the eighth row.
 */
export function detailsTileFieldCount(
	config: Pick<CaseListConfig, "columns" | "detailTabs">,
): number {
	return (
		config.columns.filter((column) => column.visibleInDetail !== false).length +
		(config.detailTabs?.length ?? 0)
	);
}

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
 * Every cell states its size (`tileCellSchema`): HQ's Case List save writes
 * `medium` into a cell that holds none, so an absent size is a state an app
 * cannot keep. A tile's text does not follow the list's own size on either
 * runtime: Android reads `medium` as 17 against an unstyled cell's 18
 * (`views/EntityViewTile.java::getView`), and Web Apps reads it as 16px
 * against the list's 12px (`views.js::buildCellLayout`).
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
 * Alignment and size are required on every cell. HQ's Case List save
 * writes `horizontal_align`, `vertical_align` and `font_size` into a cell
 * that holds none (`static/app_manager/js/details/bootstrap5/column.js`,
 * defaults `left`, `start`, `medium`), so a cell without them changes on
 * the first save. `tileCell()` fills `left`, `top` and `medium` when a
 * caller gives none. `showBorder` and `showShading` stay optional and stay
 * off the wire when unset.
 */
export const tileCellSchema = z.strictObject({
	androidOnly: z.literal(true).optional(),
	x: persistableJsonNonnegativeIntegerSchema,
	y: persistableJsonNonnegativeIntegerSchema,
	width: persistableJsonPositiveIntegerSchema,
	height: persistableJsonPositiveIntegerSchema,
	horizontalAlign: z.enum(TILE_HORIZONTAL_ALIGNS),
	verticalAlign: z.enum(TILE_VERTICAL_ALIGNS),
	fontSize: z.enum(TILE_FONT_SIZES),
	showBorder: z.boolean().optional(),
	showShading: z.boolean().optional(),
});
export type TileCell = z.infer<typeof tileCellSchema>;
export const detailTileSchema = z.strictObject({
	cells: z.record(uuidSchema, tileCellSchema),
});

/** The alignment and size a cell takes when its maker states none: HQ's own
 *  defaults, which its first Case List save would write. */
export const TILE_CELL_DEFAULTS = {
	horizontalAlign: "left",
	verticalAlign: "top",
	fontSize: "medium",
} as const satisfies Pick<
	TileCell,
	"horizontalAlign" | "verticalAlign" | "fontSize"
>;

/** The presentation a caller may state for a cell; any of the three
 *  required slots left out takes `TILE_CELL_DEFAULTS`. */
export type TileCellPresentation = Partial<
	Omit<TileCell, "x" | "y" | "width" | "height">
>;

/** Constructs a tile cell. Alignment and size fill from
 *  `TILE_CELL_DEFAULTS` where the caller gives none; the optional
 *  border and shading slots are omitted when absent so a constructed cell
 *  round-trips equal to a stored one under the schema's strip-mode parse. */
export function tileCell(
	x: number,
	y: number,
	width: number,
	height: number,
	presentation: TileCellPresentation = {},
): TileCell {
	const out: TileCell = {
		x,
		y,
		width,
		height,
		horizontalAlign:
			presentation.horizontalAlign ?? TILE_CELL_DEFAULTS.horizontalAlign,
		verticalAlign:
			presentation.verticalAlign ?? TILE_CELL_DEFAULTS.verticalAlign,
		fontSize: presentation.fontSize ?? TILE_CELL_DEFAULTS.fontSize,
	};
	if (presentation.androidOnly) out.androidOnly = true;
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
 *     hidden. It is no field of a tile's short detail at all
 *     (`lib/domain/caseListOrder.ts`, rule 1): an order rule on it rides as
 *     a sort row with no stored column, for which CommCare appends its own
 *     zero-width carrier (`util.py::create_temp_sort_column`), and no save
 *     can give that carrier a cell. A stored hidden column would take one
 *     from HQ's Case List save (`column.js::serialize`), and a complete
 *     `<grid>` makes a field a tile field by `DetailField::isCaseTileField`,
 *     where it claims a real `grid-area` and enlarges the extent
 *     `Detail.java::getMaxWidthHeight` computes across ALL fields.
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
	column: Pick<Column, "tile" | "visibleInList"> & { uuid?: Uuid },
	layout: CaseTileLayout | undefined,
): TileCell | undefined {
	if (layout === undefined) return undefined;
	if (column.visibleInList === false) return undefined;
	if (layout.namedSlots) {
		const slot = NAMED_TILE_SLOTS.find(
			(slot) => layout.namedSlots?.[slot] === column.uuid,
		);
		return slot ? namedTileCell(slot) : undefined;
	}
	return column.tile;
}

/**
 * Whether a Results tile cell draws only on Android. HQ writes an
 * `invisible` field (a cell marked `androidOnly`) and an `address` (a map
 * location) with a zero template width (`detail_screen.py::HideShortColumn`):
 * Web Apps hides a zero-width tile field (`tile_item.html`), and Android
 * draws its stored value at its cell (`EntityViewTile.addFieldView`).
 */
export function tileCellOnlyOnAndroid(
	column: Pick<Column, "kind">,
	cell: TileCell | undefined,
): boolean {
	return (
		cell !== undefined &&
		(cell.androidOnly === true || column.kind === "map-location")
	);
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
 *  required configuration on top. The base is a `z.strictObject`, and
 *  strictness propagates through every `columnBase.extend({...})` chain
 *  below, so per-kind schemas reject unknown keys without restating it
 *  on each arm.
 *
 *  `tile` is the column's placement on the case list's tile grid. It
 *  sits here rather than in `columnCommonSlots` only because
 *  `tileCellSchema` is declared below that object; it is an ordinary
 *  optional common slot in every other respect, and
 *  `ColumnCommonSlots` carries it for the builders. */
const columnBase = z
	.strictObject({
		uuid: uuidSchema,
		tile: tileCellSchema.optional(),
	})
	.extend(columnCommonSlots.shape);

// ── Column kinds ─────────────────────────────────────────────────
//
// Eight discriminated arms. The `kind` discriminant routes the column
// through the matching wire emitter and editor body. Calculated
// columns have no `field` slot — the expression is the source.

/**
 * The indices a property column walks from the list's case to the case
 * whose property it shows, each step the one a `prop` read's `ancestor` arm
 * takes: `parent` reaches the catalog's parent type, and any other index
 * names the type it reaches (`throughCaseType`). Absent: the list's own
 * case. The column's `field` is a property of the case the walk reaches,
 * so the column's identity is that `(case type, property)` pair.
 */
export const columnViaSchema = z.tuple(
	[relationStepSchema],
	relationStepSchema,
);
export type ColumnVia = [RelationStep, ...RelationStep[]];

/** The slot every property-backed column kind carries beside its `field`. */
const propertyColumnSlots = {
	workerPropertyUuid: uuidSchema
		.optional()
		.describe(
			"The worker information this field reads, when it is defined in the app.",
		),
	readFrom: z
		.literal("worker-record")
		.optional()
		.describe("Use the signed-in worker’s case record for this field."),
	showOwner: z
		.literal("name")
		.optional()
		.describe(
			"Show the name of the group or worker who owns this case. Choose the owner ID field.",
		),
	field: readCasePropertyNameSchema,
	/** Shows `field` of the case these indices reach rather than the list's own. */
	via: columnViaSchema.optional(),
};

/**
 * Plain text column — renders the property value as a string.
 * Default kind for any displayed column.
 */
const plainColumnSchema = columnBase.extend({
	kind: z.literal("plain"),
	...propertyColumnSlots,
	showChoice: z
		.literal("saved-value")
		.optional()
		.describe(
			"Show the saved choice value in this column. Leave this out to show the choice label.",
		),
	header: z.string(),
});

/**
 * Date-formatted column — renders the property value through a
 * preset date format. The property must resolve to a date-shaped
 * `data_type` (validator rule); the runtime formatter consumes
 * `pattern` to produce the displayed string.
 *
 * `pattern` rejects empty strings and unsupported JavaRosa escapes — symmetric
 * with `formatDateSchema.pattern` on the Expression side. Backed at the
 * editor by inline validation in the shared `CustomDatePatternInput`.
 */
const dateColumnSchema = columnBase.extend({
	kind: z.literal("date"),
	...propertyColumnSlots,
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
export const DATE_COUNT_PERIODS = [
	"years-since",
	"months-since",
	"weeks-since",
	"days-since",
	"days-until",
	"weeks-until",
	"months-until",
] as const;
export type DateCountPeriod = (typeof DATE_COUNT_PERIODS)[number];

/** A count is the signed number of whole periods separating two local calendar dates. */
export const DATE_COUNT_DAYS: Readonly<Record<DateCountPeriod, number>> = {
	"years-since": TIME_SINCE_UNIT_DAYS.years,
	"months-since": TIME_SINCE_UNIT_DAYS.months,
	"weeks-since": TIME_SINCE_UNIT_DAYS.weeks,
	"days-since": 1,
	"days-until": -1,
	"weeks-until": -TIME_SINCE_UNIT_DAYS.weeks,
	"months-until": -TIME_SINCE_UNIT_DAYS.months,
};
const dateCountColumnSchema = columnBase.extend({
	kind: z.literal("date-count"),
	...propertyColumnSlots,
	header: z.string(),
	period: z.enum(DATE_COUNT_PERIODS),
});

export const CASE_MAP_LAYER_KINDS = [
	"boundary",
	"boundary-color",
	"points",
	"point-colors",
] as const;
export type CaseMapLayerKind = (typeof CASE_MAP_LAYER_KINDS)[number];
const workerDistanceColumnSchema = columnBase.extend({
	kind: z.literal("worker-distance"),
	...propertyColumnSlots,
	header: z.string(),
});
const mapLocationColumnSchema = columnBase.extend({
	kind: z.literal("map-location"),
	...propertyColumnSlots,
	header: z.string(),
});
const mapLayerColumnSchema = columnBase.extend({
	kind: z.literal("map-layer"),
	...propertyColumnSlots,
	header: z.string(),
	layer: z.enum(CASE_MAP_LAYER_KINDS),
});

const formattedTextColumnSchema = columnBase.extend({
	kind: z.literal("formatted-text"),
	...propertyColumnSlots,
	header: z.string(),
});

const overdueMarkerColumnSchema = columnBase.extend({
	kind: z.literal("overdue-marker"),
	...propertyColumnSlots,
	header: z.string(),
	afterDays: persistableJsonIntegerSchema,
});

const phoneColumnSchema = columnBase.extend({
	kind: z.literal("phone"),
	...propertyColumnSlots,
	header: z.string(),
});

/**
 * ID-mapping column — renders a lookup table from property value
 * to display label (e.g. region code → human-readable region
 * name). The mapping is authored explicitly; values not in the
 * table render no mapped text. The entry order is the order the list
 * sorts the column by (`lib/domain/caseListOrder.ts`, the
 * `mapping-position` key), which is CommCare HQ's `enum` sort.
 */
// Old literal rows may have no identity. Every newly saved row gets one at
// creation. A condition binds a row in its own record expression slot.
const mappingSource = {
	uuid: uuidSchema.optional(),
	value: z
		.string()
		.optional()
		.describe(
			"The exact saved value, including spaces or an empty string. Omit when the row has a condition.",
		),
	when: conditionSchema
		.optional()
		.describe(
			"Show this row when the case meets this condition. Omit for a literal saved value.",
		),
};
const oneMappingSource = (row: { value?: string; when?: Expression }) =>
	(row.value !== undefined) !== (row.when !== undefined);
const mappingSourceIssue = "Choose a saved value or a condition for this row.";
const idMappingEntrySchema = z
	.strictObject({
		...mappingSource,
		label: z.string(),
	})
	.refine(oneMappingSource, { error: mappingSourceIssue });

/** The characters CommCare HQ's ID mapping cannot hold in a key: its build
 *  writes a key unescaped inside an XPath string literal, and its mapping
 *  dialog refuses one as bad XML (`CASE_LIST_ID_MAPPING_KEY_CHARACTERS`). */
const ID_MAPPING_KEY_FORBIDDEN: ReadonlySet<string> = new Set([
	"&",
	"<",
	">",
	'"',
	"'",
]);

/** Whether an ID-mapping value holds a character HQ's mapping cannot store. */
export function idMappingValueHoldsForbiddenCharacter(value: string): boolean {
	for (const character of value) {
		if (ID_MAPPING_KEY_FORBIDDEN.has(character)) return true;
	}
	return false;
}

const idMappingColumnSchema = columnBase.extend({
	kind: z.literal("id-mapping"),
	behavior: z
		.literal("first-match")
		.optional()
		.describe(
			"Show the first matching label and sort by that label in the worker’s language. Without this setting, show each matching choice label and sort by mapping position.",
		),
	...propertyColumnSlots,
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
	mapping: z.array(idMappingEntrySchema).refine(uniqueCaseMappingRows, {
		error:
			"Mapping values are not unique within this column. Two or more entries share the same `value`. The wire layer matches one row against every entry with a matching value, so duplicates would produce a cell that concatenates each matching label. Keep one entry per value and merge any duplicate labels into that entry's `label` slot.",
	}),
});

/**
 * Single image-map entry — pairs a case-property value with the image
 * `MediaAssetId` shown for that value. The image-map analogue of
 * `idMappingEntrySchema`: the same one-word `value` (matched on the wire
 * by `selected()`, which looks for the trimmed value whole among the
 * property's tokens), but the cell renders the mapped IMAGE instead of a
 * text label. The entry order is the order the list sorts the column by
 * (`lib/domain/caseListOrder.ts`, the `mapping-position` key).
 */
const imageMapEntrySchema = z
	.strictObject({
		...mappingSource,
		/** With no comparison the image looks for the value among the worker's selected choices. */
		match: z.literal("exact").optional(),
		altText: z.string().optional(),
		assetId: mediaAssetIdSchema.optional(),
	})
	.refine(oneMappingSource, { error: mappingSourceIssue })
	.refine((row) => !(row.when && row.match), {
		error: "A condition supplies its own comparison.",
	});
const imageMapColumnSchema = columnBase.extend({
	kind: z.literal("image-map"),
	/** On Results, the deep link of the form a worker's tap on the image
	 * submits for the tapped case (CommCare's clickable icon). The image stays
	 * an image on the case detail. `lib/commcare/listIconAction.ts` decides
	 * which entry points qualify. */
	entryPointUuid: uuidSchema.optional(),
	...propertyColumnSlots,
	header: z.string(),
	// The table may be empty: that is the complete "show no mapped images"
	// display. Rows, when present, must have unique values — same rationale
	// as id-mapping: the wire emits one `if(selected(field, '<value>'), …)`
	// arm per entry, so two entries sharing a value both match the same
	// row and the cell concatenates their image paths into one
	// unrenderable string.
	mapping: z.array(imageMapEntrySchema).refine(uniqueCaseMappingRows, {
		error:
			"This image table repeats the same comparison and saved value. Give each rule a distinct comparison or value.",
	}),
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
	...propertyColumnSlots,
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
 * How a phone loads a column's value: kept between visits (`cache`), worked
 * out after the list first shows (`defer`), or both. HQ writes each on the
 * column's field and promotes it to the detail
 * (`detail_screen.py::FormattedDetailColumn._set_case_list_optimizations`,
 * `suite_xml/sections/details.py::_add_detail_optimizations`), only for a
 * column HQ reads through an expression in the address, date, markdown,
 * phone, plain or enum format (`models/case_list.py::DetailColumn.supports_optimizations`).
 * Android keeps each per field (`AsyncNodeEntityFactory`); Web Apps loads the
 * whole list later and keeps nothing.
 */
export const columnLoadBehaviorSchema = z
	.enum(["cache", "defer", "cache-and-defer"])
	.describe(
		"How a phone loads this value: cache keeps it between visits, defer works it out after the list shows, cache-and-defer does both. Needs the case list's faster loading turned on.",
	);
export type ColumnLoadBehavior = z.infer<typeof columnLoadBehaviorSchema>;

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
	...propertyColumnSlots,
	header: z.string(),
	linkText: z
		.string()
		.min(1, "Give the link something to say")
		.regex(
			// biome-ignore lint/complexity/noUselessEscapeInRegex: this pattern is published in tool schemas, where regex engines other than JavaScript's read a bare [ inside a class as the start of a nested class and refuse the schema
			/^[^\[\]]+$/,
			"Link text can't contain square brackets. The cell is rendered as markdown, where a bracket ends the link's label early and the row shows the raw text instead of a link.",
		),
	loadBehavior: columnLoadBehaviorSchema.optional(),
});

/**
 * Calculated column — author-defined `Expression` that yields
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
	/** An individual value picked from the tab's records. An authored calculation
	 * over a record uses the ordinary calculation control. */
	rowField: z.literal(true).optional(),
	kind: z.literal("calculated"),
	header: z.string(),
	texts: z
		.array(z.strictObject({ uuid: uuidSchema, label: z.string() }))
		.refine(
			(entries) =>
				new Set(entries.map((entry) => entry.uuid)).size === entries.length,
			{ error: "Each piece of translated text needs its own identity." },
		)
		.optional(),

	showAs: z
		.literal("formatted-text")
		.optional()
		.describe(
			"Show this calculation as formatted text. Workers on Web Apps can follow Markdown links in a case result.",
		),
	expression: valueSchema,
	loadBehavior: columnLoadBehaviorSchema.optional(),
});

export const columnSchema = z.discriminatedUnion("kind", [
	plainColumnSchema,
	dateColumnSchema,
	dateCountColumnSchema,
	overdueMarkerColumnSchema,
	formattedTextColumnSchema,
	workerDistanceColumnSchema,
	mapLocationColumnSchema,
	mapLayerColumnSchema,
	phoneColumnSchema,
	idMappingColumnSchema,
	imageMapColumnSchema,
	intervalColumnSchema,
	linkColumnSchema,
	calculatedColumnSchema,
]);
export type Column = z.infer<typeof columnSchema>;
export type ColumnKind = Column["kind"];

/** A column over a property: every kind but `calculated`. */
export type PropertyColumn = Exclude<Column, { kind: "calculated" }>;

/** The walk a property column reads through, as a `prop` read's relation;
 *  undefined where it shows a property of the list's own case. */
export function columnRelationPath(
	column: Pick<PropertyColumn, "via">,
): RelationPath | undefined {
	return column.via === undefined
		? undefined
		: { kind: "ancestor", via: column.via };
}

/** A translated value ordered by distance needs a physical location field.
 * The property arm reads one saved value directly. A calculation with its
 * own conditions or a type-restricted walk cannot use this representation. */
export function translatedDistanceProperty(
	column: Column,
): Pick<PropertyColumn, "field" | "via" | "uuid"> | undefined {
	if (
		column.kind !== "calculated" ||
		column.texts === undefined ||
		column.sort?.comparator !== "distance" ||
		column.visibleInList === false ||
		column.expression.kind !== "term"
	)
		return undefined;
	const source = column.expression.term;
	if (source.kind !== "prop" || source.property === "case_id") return undefined;
	if (
		source.via &&
		source.via.kind !== "self" &&
		(source.via.kind !== "ancestor" ||
			source.via.via.some((step) => step.throughCaseType !== undefined))
	)
		return undefined;
	return {
		uuid: column.uuid,
		field: source.property,
		...(source.via?.kind === "ancestor" && { via: source.via.via }),
	};
}
/**
 * The text CommCare HQ's case list stores as a property column's `field`:
 * each index of the column's walk, then the property, joined by `/`, which
 * `detail_screen.py::PropertyXpathGenerator.xpath` splits there and walks
 * index by index. A step's case type is Nova's alone and no part of it.
 */
export function columnFieldText(
	column: Pick<PropertyColumn, "field" | "via" | "readFrom" | "showOwner">,
): string {
	const field = column.showOwner === "name" ? "#owner_name" : column.field;
	if (column.readFrom === "worker-record") return `user/${field}`;
	return column.via === undefined
		? field
		: [...column.via.map((step) => step.identifier), field].join("/");
}

/** Whether two column walks are one walk: the same indices, each naming the
 *  same case type or none. */
export function sameColumnVia(
	a: readonly RelationStep[] | undefined,
	b: readonly RelationStep[] | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return (
		a.length === b.length &&
		a.every(
			(step, index) =>
				step.identifier === b[index].identifier &&
				step.throughCaseType === b[index].throughCaseType,
		)
	);
}

/** Whether the column is a field of the list: shown, or hidden and still carried. */
export function columnOnList(column: Pick<Column, "notOnList">): boolean {
	return column.notOnList !== true;
}

/**
 * Whether a runtime evaluates the column's value: every column on the list
 * of a list with no tile layout, since each is a field of the short detail
 * on both export paths, a column hidden from Results included as HQ's
 * `invisible` field (`lib/domain/caseListOrder.ts`, rule 1); in a tile list,
 * a column shown on Results or on Details, since a column hidden from both is
 * no field there and its order rule rides as a sort row with no stored
 * column; and a column that is not on the list (`columnOnList`) where
 * Details shows it, since only the case's detail holds it.
 *
 * Admission never consults this projection: a column hidden from both
 * screens is legitimate reversible authoring state and is validated as
 * completely as a visible one. The compiler's instance and search walks
 * and Preview read it to decide which already-valid definitions execute.
 */
export function caseListColumnRuns(
	column: Column,
	config: Pick<CaseListConfig, "tile">,
): boolean {
	if (!columnOnList(column)) return column.visibleInDetail !== false;
	if (config.tile === undefined) return true;
	return column.visibleInList !== false || column.visibleInDetail !== false;
}

/**
 * Whether the column's header, labels or images reach a screen: it is
 * shown on Results or on Details. A column hidden from both has no header
 * unit and no media of its own on the wire, whatever order rule it
 * carries: a hidden field's header is empty on every path
 * (`detail_screen.py::Invisible.header`). Read by the translation inventory
 * and the media walks.
 */
export function caseListColumnTextShows(column: Column): boolean {
	return column.visibleInList !== false || column.visibleInDetail !== false;
}

/**
 * Whether an image map is written as its image column: in an export that
 * carries a media manifest, and, for a map with no entries, in every export,
 * since a map with no entries names no file and so reads no manifest. A map
 * with entries in an export with no manifest is a plain column over the raw
 * value, which no production export writes. Both emitters and the order
 * plan read this one predicate, so an export never decides the column by
 * whether a manifest was passed.
 */
export function imageMapShowsImages(
	column: Extract<Column, { kind: "image-map" }>,
	mediaOn: boolean,
): boolean {
	return mediaOn || column.mapping.every((row) => row.assetId === undefined);
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
	/** The column is no field of the list: the case's detail alone holds it. */
	readonly notOnList?: true;
	/** Placement on the case list's tile grid. Independent of the two
	 *  surface membership sequences — a cell is where the column sits on
	 *  the tile, while the owning config arrays hold sequence. */
	readonly tile?: TileCell;
}

/** The slots a property column's builder takes: the common ones and the
 *  walk to the case whose property it shows (`columnViaSchema`). */
export interface ColumnRecordSource {
	readonly workerPropertyUuid?: Uuid;
	readonly readFrom?: "worker-record";
	readonly showOwner?: "name";
}

export interface PropertyColumnSlots
	extends ColumnCommonSlots,
		ColumnRecordSource {
	readonly via?: ColumnVia;
}

/** `withCommonSlots`, then the walk where the slots name one. */
function withPropertySlots<T extends Record<string, unknown>>(
	base: T,
	slots: PropertyColumnSlots,
): T & PropertyColumnSlots {
	return {
		...withCommonSlots(base, slots),
		...(slots.via && { via: slots.via }),
		...(slots.readFrom && { readFrom: slots.readFrom }),
		...(slots.workerPropertyUuid && {
			workerPropertyUuid: slots.workerPropertyUuid,
		}),
		...(slots.showOwner && { showOwner: slots.showOwner }),
	};
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
		notOnList?: true;
		tile?: TileCell;
	} = { ...base };
	if (slots.sort !== undefined) out.sort = slots.sort;
	if (slots.visibleInList !== undefined)
		out.visibleInList = slots.visibleInList;
	if (slots.visibleInDetail !== undefined)
		out.visibleInDetail = slots.visibleInDetail;
	if (slots.notOnList !== undefined) out.notOnList = slots.notOnList;
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
	slots: PropertyColumnSlots & { showChoice?: "saved-value" } = {},
): Extract<Column, { kind: "plain" }> {
	return withPropertySlots(
		{
			uuid,
			kind: "plain" as const,
			field,
			header,
			...(slots.showChoice && { showChoice: slots.showChoice }),
		},
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
 * on the Expression side). The editor's `CustomDatePatternInput`
 * primitive surfaces the rejection inline before save.
 */
export function dateColumn(
	uuid: Uuid,
	field: string,
	header: string,
	pattern: string,
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "date" }> {
	return withPropertySlots(
		{ uuid, kind: "date" as const, field, header, pattern },
		slots,
	);
}

/**
 * Constructs a phone-number column. The runtime renders the
 * referenced property as a tappable telephone link; static
 * contexts fall back to plain text.
 */
export function dateCountColumn(
	uuid: Uuid,
	field: string,
	header: string,
	period: DateCountPeriod,
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "date-count" }> {
	return withPropertySlots(
		{ uuid, kind: "date-count" as const, field, header, period },
		slots,
	);
}

export function workerDistanceColumn(
	uuid: Uuid,
	field: string,
	header: string,
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "worker-distance" }> {
	return withPropertySlots(
		{ uuid, kind: "worker-distance" as const, field, header },
		slots,
	);
}
export function workerDistanceValueId(uuid: Uuid): string {
	return `km:${uuid}`;
}

export function mapLocationColumn(
	uuid: Uuid,
	field: string,
	header: string,
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "map-location" }> {
	return withPropertySlots(
		{ uuid, kind: "map-location" as const, field, header },
		slots,
	);
}

export function mapLayerColumn(
	uuid: Uuid,
	field: string,
	header: string,
	layer: CaseMapLayerKind,
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "map-layer" }> {
	return withPropertySlots(
		{ uuid, kind: "map-layer" as const, field, header, layer },
		{ visibleInDetail: false, ...slots },
	);
}

export function formattedTextColumn(
	uuid: Uuid,
	field: string,
	header: string,
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "formatted-text" }> {
	return withPropertySlots(
		{ uuid, kind: "formatted-text" as const, field, header },
		slots,
	);
}

export function overdueMarkerColumn(
	uuid: Uuid,
	field: string,
	header: string,
	afterDays: number,
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "overdue-marker" }> {
	return withPropertySlots(
		{ uuid, kind: "overdue-marker" as const, field, header, afterDays },
		slots,
	);
}

export function phoneColumn(
	uuid: Uuid,
	field: string,
	header: string,
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "phone" }> {
	return withPropertySlots(
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
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "link" }> {
	return withPropertySlots(
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
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "id-mapping" }> {
	return withPropertySlots(
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
	slots: PropertyColumnSlots & { readonly entryPointUuid?: Uuid } = {},
): Extract<Column, { kind: "image-map" }> {
	return withPropertySlots(
		{
			uuid,
			kind: "image-map" as const,
			...(slots.entryPointUuid && { entryPointUuid: slots.entryPointUuid }),
			field,
			header,
			mapping: [...mapping],
		},
		slots,
	);
}

/** Constructs a single image-map entry. Routes every entry through one
 *  helper so ad-hoc literals can't drift out of the schema shape. */
export function imageMapEntry(
	value: string,
	assetId?: MediaAssetId,
): ImageMapEntry {
	return { value, ...(assetId !== undefined && { assetId }) };
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
	slots: PropertyColumnSlots = {},
): Extract<Column, { kind: "interval" }> {
	return withPropertySlots(
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
	expression: Expression,
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
//   - `advanced` — free-form `predicate` (a `Expression` AST). The
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
/**
 * The separator CommCare puts between a multiple-choice search answer's
 * chosen tokens, both in the search-input instance a condition reads and in
 * the value the runtime later splits into repeated query parameters
 * (`commcare-core session/RemoteQuerySessionManager.java::ANSWER_DELIMITER`;
 * Web Apps' `cloudcare/js/formplayer/menus/views/query.js::selectDelimiter`
 * is the same three characters). Not a space: a lookup value may itself hold
 * one, and the device would read a space-joined answer as a single unknown
 * choice.
 */
export const MULTI_SELECT_SEARCH_ANSWER_DELIMITER = "#,#";

/** The chosen tokens of a multiple-choice search answer, blank ones dropped. */
export function splitMultiSelectSearchAnswer(answer: string): string[] {
	return answer
		.split(MULTI_SELECT_SEARCH_ANSWER_DELIMITER)
		.filter((token) => token !== "");
}

/** One multiple-choice search answer from its chosen tokens. */
export function joinMultiSelectSearchAnswer(tokens: readonly string[]): string {
	return tokens.join(MULTI_SELECT_SEARCH_ANSWER_DELIMITER);
}

export const SEARCH_INPUT_TYPES = [
	"text",
	"date",
	"date-range",
	"barcode",
	"select",
	"multi-select",
	"checkboxes",
] as const;
export type SearchInputType = (typeof SEARCH_INPUT_TYPES)[number];
export const SCALAR_SEARCH_INPUT_TYPES = ["text", "date", "barcode"] as const;
export type ScalarSearchInputType = (typeof SCALAR_SEARCH_INPUT_TYPES)[number];
/**
 * Choice widgets. All are lookup-backed: the CommCare query prompt reads
 * its choices only from an `<itemset>` over a fixture
 * (`commcare-core/.../org/commcare/xml/QueryPromptParser.java` reads no inline
 * items), so a choice input always names a Project lookup table.
 *
 *   - `select` — one choice; wire `input="select1"`.
 *   - `multi-select` — several choices in a Web Apps list; wire `input="select"`.
 *   - `checkboxes` — several choices on either platform; wire `input="checkbox"`. The runtime
 *     splits the `#,#`-joined answer into repeated query parameters
 *     (`RemoteQuerySessionManager.getRawQueryParams` →
 *     `extractMultipleChoices`), and HQ's exact match over a list is any-of
 *     (`corehq/apps/es/case_search.py::exact_case_property_text_query`), so a
 *     simple multi-select input means "the property equals any chosen value".
 */
export const SELECT_SEARCH_INPUT_TYPES = [
	"select",
	"multi-select",
	"checkboxes",
] as const;
export type SelectSearchInputType = (typeof SELECT_SEARCH_INPUT_TYPES)[number];

/** Several choices in item order, sent as repeated values of the same parameter. */
export function takesMultipleSearchChoices(
	type: string,
): type is "multi-select" | "checkboxes" {
	return type === "multi-select" || type === "checkboxes";
}

/** Whether a widget type reads its answers from a lookup-backed choice list. */
export function isSelectSearchInputType(
	type: SearchInputType,
): type is SelectSearchInputType {
	return (SELECT_SEARCH_INPUT_TYPES as readonly string[]).includes(type);
}

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
	z.strictObject({ kind: z.literal("exact") }),
	z.strictObject({ kind: z.literal("fuzzy") }),
	z.strictObject({ kind: z.literal("starts-with") }),
	z.strictObject({ kind: z.literal("phonetic") }),
	z.strictObject({ kind: z.literal("fuzzy-date") }),
]);
const rangeSearchInputModeSchema = z.strictObject({ kind: z.literal("range") });
export const searchInputModeSchema = z.union([
	scalarSearchInputModeSchema,
	rangeSearchInputModeSchema,
]);
export type SearchInputMode = z.infer<typeof searchInputModeSchema>;
export type ScalarSearchInputMode = z.infer<typeof scalarSearchInputModeSchema>;

/** A Search field's name: the key CommCare sends its answer under. */
export const SEARCH_INPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The sentence a Search field's name outside the pattern is refused with. */
export const SEARCH_INPUT_NAME_REJECTION =
	"A Search field's name starts with a letter or an underscore, then holds only letters, digits, underscores and hyphens. CommCare sends the field's answer under this name, and a rule reads it back by it.";

/** The sentence `name` is refused with as a Search field's name, or `undefined` where it is one. */
export function searchInputNameRefusal(name: string): string | undefined {
	return SEARCH_INPUT_NAME_PATTERN.test(name)
		? undefined
		: SEARCH_INPUT_NAME_REJECTION;
}

export const SEARCH_ADDRESS_PARTS = [
	"full",
	"geopoint",
	"street",
	"city",
	"district",
	"county",
	"zipcode",
	"postcode",
	"region",
	"state_long",
	"state_short",
	"us_state",
	"us_state_short",
	"country",
	"country_short",
] as const;

export const searchAddressReceiverSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("address"),
		source: uuidSchema,
		parts: z.array(z.enum(SEARCH_ADDRESS_PARTS)).min(1),
	}),
	z.strictObject({
		kind: z.literal("unsubscribed"),
		topic: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		fields: z
			.string()
			.regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\|\|[A-Za-z_][A-Za-z0-9_]*)*$/),
	}),
]);
export type SearchAddressReceiver = z.infer<typeof searchAddressReceiverSchema>;

// Common slots present on every SearchInputDef arm.
//
// `name` is written as an attribute value (`<prompt key="X">`), a string
// literal (`instance('search-input:results')/input/field[@name='X']`),
// the last segment of a locale id (`search_property.m<N>.X`) and a
// hashtag segment (`#search/X`), each of which takes a hyphen, so a name
// can equal any case property's name. CommCare HQ checks no grammar on a
// search property's name (`views/modules.py::_update_search_properties`).
const searchInputBase = z.strictObject({
	uuid: uuidSchema,
	name: z
		.string()
		.regex(SEARCH_INPUT_NAME_PATTERN, SEARCH_INPUT_NAME_REJECTION),
	label: z.string(),
	group: uuidSchema.optional(),
});

/**
 * Localized heading for an ordered set of Search fields. Its placement and
 * members are independent of a project's wire identifiers.
 */
export const searchInputGroupSchema = z.strictObject({
	uuid: uuidSchema,
	label: z.string().trim().min(1),
});
export type SearchInputGroup = z.infer<typeof searchInputGroupSchema>;

/**
 * Whether a worker must answer a prompt before Search runs. `{}` is
 * "always required"; `when` makes it conditional on the Search screen's
 * own state (other answers, session values, literals). `message` is the
 * author's sentence; without one the worker reads Nova's
 * (`SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE`).
 *
 * `noMessage` is a requirement with no message at all, as CommCare HQ
 * builds one whose text is blank in every language: its build writes the
 * requirement's text blank (`remote_requests.py::build_query_prompts`,
 * `app_strings.py`: `clean_trans` of an empty map), so Core reports a blank
 * message for it (`QueryPrompt.getRequiredMessage`). The blank is a no-break
 * space in the language table (`localeFile.ts::hqLocaleFileValue`, HQ's
 * `commcare_translations.dumps`), which Core's line trim keeps, so Web Apps
 * reads a message (`query.js::getError`): it draws the field invalid with no
 * words under it, names it among the fields to check, and sends no search
 * (`inputsHaveErrors`), so the search waits for the answer. It never stands beside a `message`
 * (`searchCheckMessageRefusal`).
 *
 * Evaluated on the Search screen where the worker's answers ARE loaded
 * (`RemoteQuerySessionManager.validateUserAnswers` runs `<required test>`
 * against the search-input instance), so `when` may read sibling inputs
 * directly — unlike a prompt `default`, which fires before anyone types.
 * Web Apps enforces this; Android never enforces prompt validation.
 */
export const searchInputRequiredSchema = z.strictObject({
	when: conditionSchema.optional(),
	message: z.string().min(1).optional(),
	noMessage: z.literal(true).optional(),
});
export type SearchInputRequired = z.infer<typeof searchInputRequiredSchema>;

/**
 * One check a nonblank answer must pass. Exactly one per input: the
 * runtime keeps only the last `<validation>` it parses
 * (`QueryPromptParser.parse` assigns a single `validation` slot), so a list
 * here would silently drop every rule but one. `rule` evaluates in the same
 * Search-screen scope as `required.when`; `message` is what the worker reads
 * when the rule is false. A check with no message of its own shows
 * CommCare's sentence (`COMMCARE_SEARCH_INVALID_MESSAGE`): CommCare HQ
 * builds no text for a validation whose text is blank in every language
 * (`remote_requests.py`, `validation.has_text`), and Core then reports its
 * own (`QueryPrompt.getValidationMessage`).
 */
export const searchInputValidationSchema = z.strictObject({
	rule: conditionSchema,
	message: z.string().min(1).optional(),
});
export type SearchInputValidation = z.infer<typeof searchInputValidationSchema>;

/**
 * Slots every prompt a worker can see may carry. The hidden arm sits on the
 * bare `searchInputBase`: a prompt nobody sees cannot be hinted, required, or
 * checked, so those states are unrepresentable rather than validated away.
 */
const visibleSearchInputBase = searchInputBase
	.extend({
		addressReceiver: searchAddressReceiverSchema.optional(),
		hint: z.string().min(1).optional(),
		required: searchInputRequiredSchema.optional(),
		validation: searchInputValidationSchema.optional(),
		/**
		 * The worker may also ask for cases whose property is blank. Web Apps
		 * draws a checkbox under the field and, where it is ticked, sends a
		 * blank value before the answer (`query.js::encodeValue` joins them with
		 * `#,#`), so the Search screen's own value of the field holds both.
		 * CommCare HQ's match of the field's own key reads that blank as "the
		 * property is blank, or matches" (`case_search/utils.py`,
		 * `_get_case_property_query`); a condition reading the field reads the
		 * value as it stands. Android shows the field alone. A simple field
		 * carries it only where CommCare HQ matches it by its own key
		 * (`searchForBlankRefusal`). Absent is no.
		 */
		allowBlank: z.literal(true).optional(),
		/**
		 * Web Apps does not draw the field, and searches with its starting value
		 * as it stands (`query.js` hides a hidden prompt's row whole with
		 * `d-none`). Neither Core nor Android reads the attribute, so Android
		 * draws the field like any other, where the worker can change it, and
		 * draws none of a widget its Search screen does not show. A hidden field
		 * carries no hint, requirement, check or search for blank, since nobody
		 * in Web Apps can see them (`hiddenSearchFieldRefusal`). Absent is
		 * shown. A value the search never matches is the `hidden` arm.
		 */
		hidden: z.literal(true).optional(),
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
	/** The key of this field chooses the project space's native matcher. */
	matching: z.literal("project-space").optional(),
	// `property` is constrained to CommCare's case-property identifier
	// vocabulary — same character class the predicate AST's
	// `propertyRefSchema.property` enforces. The wire emitter
	// interpolates this verbatim into XPath fragments (the per-mode
	// derivations in `buildSimpleArmClause`); a value containing
	// quotes / parentheses / angle brackets would emit malformed
	// XPath. Keeping the constraint symmetric with the AST's
	// reference shape closes the SearchInputDef-vs-Expression asymmetry the
	// predicate validator can't catch (the simple arm derives the
	// predicate at wire-emit, not at validate-time).
	property: authoredCasePropertyNameSchema,
	via: relationPathSchema.optional(),
};

export const simpleScalarSearchInputSchema = visibleSearchInputBase
	.extend({
		...simpleSearchInputSlots,
		type: z.enum(SCALAR_SEARCH_INPUT_TYPES),
		default: valueSchema.optional(),
		mode: scalarSearchInputModeSchema.optional(),
	})
	.strict();

/** Fixed inclusive dates chosen together by a person in any editor. */
export const searchStartingDatesSchema = z
	.object({ from: z.iso.date(), to: z.iso.date() })
	.strict()
	.refine(
		(dates) => dates.from <= dates.to,
		"The end date comes before the start date.",
	);

export const simpleDateRangeSearchInputSchema = visibleSearchInputBase
	.extend({
		...simpleSearchInputSlots,
		type: z.literal("date-range"),
		default: valueSchema.optional(),
		mode: rangeSearchInputModeSchema,
	})
	.strict();

/**
 * The lookup choices of a Search question: a form select's source, whose
 * `sortColumnId` reads differently here. Absent, it means the label column,
 * and the reducer stores a sort column equal to the label column as absent,
 * so one order has one spelling: HQ's Case List save refuses a lookup prompt
 * without a sort (`views/modules.py::_update_search_properties`). A form
 * select's absent sort keeps the table's row order instead.
 */
export const searchInputLookupOptionsSchema = lookupOptionsSourceSchema
	.extend({ sortColumnId: lookupReadSchema.optional() })
	.strict();
export type SearchInputLookupOptions = z.infer<
	typeof searchInputLookupOptionsSchema
>;
z.globalRegistry.add(searchInputLookupOptionsSchema, {
	id: "SearchInputLookupOptions",
});

/** The column whose text orders a Search question's lookup choices. */
export function searchInputLookupSortColumnId(
	options: SearchInputLookupOptions,
): SearchInputLookupOptions["labelColumnId"] {
	return options.sortColumnId ?? options.labelColumnId;
}

/**
 * The input with its one spelling of the choice order: a sort column equal
 * to the label column is stored as absent. Every input the document writes
 * passes through this, so a later label change that meets the sort column
 * drops it too.
 */
export function withCanonicalSearchInputOptions<T extends SearchInputDef>(
	input: T,
): T {
	if (!isSelectSearchInput(input)) return input;
	const { sortColumnId, ...options } = input.options;
	if (
		sortColumnId === undefined ||
		!sameLookupRead(sortColumnId, options.labelColumnId)
	) {
		return input;
	}
	return { ...input, options };
}

/** The sole mode a choice widget admits: its value IS the exact token. */
const selectSearchInputModeSchema = z.strictObject({
	kind: z.literal("exact"),
});

/**
 * Simple choice input. `options` names the Project lookup table and the
 * label / value columns the prompt's `<itemset>` reads, in the same
 * vocabulary a lookup-backed form select uses. The stored answer is the
 * value column's token (`#,#`-joined for `multi-select`), so the property
 * it matches must hold plain text or single-select tokens.
 */
export const simpleSelectSearchInputSchema = visibleSearchInputBase
	.extend({
		...simpleSearchInputSlots,
		type: z.enum(SELECT_SEARCH_INPUT_TYPES),
		options: searchInputLookupOptionsSchema,
		default: valueSchema.optional(),
		mode: selectSearchInputModeSchema.optional(),
	})
	.strict();

/**
 * Advanced search input — the `predicate` arm. The slot's body is a
 * full `Expression` AST that replaces the (property, mode)-derived
 * predicate. The editor surfaces a `PredicateCardEditor` against
 * this slot.
 */
export const advancedScalarSearchInputSchema = visibleSearchInputBase
	.extend({
		kind: z.literal("advanced"),
		type: z.enum(SCALAR_SEARCH_INPUT_TYPES),
		default: valueSchema.optional(),
		predicate: conditionSchema,
	})
	.strict();

export const advancedDateRangeSearchInputSchema = visibleSearchInputBase
	.extend({
		kind: z.literal("advanced"),
		type: z.literal("date-range"),
		default: valueSchema.optional(),
		predicate: conditionSchema,
	})
	.strict();

export const advancedSelectSearchInputSchema = visibleSearchInputBase
	.extend({
		kind: z.literal("advanced"),
		type: z.enum(SELECT_SEARCH_INPUT_TYPES),
		options: searchInputLookupOptionsSchema,
		default: valueSchema.optional(),
		predicate: conditionSchema,
	})
	.strict();

/** A project search defines what each answer means. The field can send its
 * answer under its name or only supply another parameter's expression. */
const projectParameter = {
	kind: z.literal("parameter"),
	sendAnswer: z.boolean(),
};
export const projectScalarSearchInput = visibleSearchInputBase
	.extend({
		...projectParameter,
		type: z.enum(SCALAR_SEARCH_INPUT_TYPES),
		default: valueSchema.optional(),
	})
	.strict();
export const projectRangeSearchInput = visibleSearchInputBase
	.extend({
		...projectParameter,
		type: z.literal("date-range"),
	})
	.strict();
export const projectChoiceSearchInput = visibleSearchInputBase
	.extend({
		...projectParameter,
		type: z.enum(SELECT_SEARCH_INPUT_TYPES),
		options: searchInputLookupOptionsSchema,
		default: valueSchema.optional(),
	})
	.strict();
export type ProjectParameterSearchInput =
	| z.infer<typeof projectScalarSearchInput>
	| z.infer<typeof projectRangeSearchInput>
	| z.infer<typeof projectChoiceSearchInput>;

/**
 * Hidden search input — a value Nova computes when the Search screen opens
 * and carries with the completed search, never shown and never a filter.
 * Its purpose is provenance: a registration form offered after an empty
 * search reads it (the search time, say) and saves it on the new case.
 *
 * `value` resolves in the global scope (session / current-user values,
 * literals, `now`, `today`); it may not read case data or other inputs.
 * On the wire this is `<prompt hidden="true" default="…" exclude="true()">`
 * with a `<display>` label HQ still requires. The `default` attribute needs
 * HQ's advanced case search on the target project space, the same
 * requirement a visible prompt with a starting value already carries.
 *
 * Absent `value` is a hidden field with no starting value: Web Apps holds it
 * blank and sends nothing for it, and Android, which shows every hidden
 * field, shows it empty for the worker to fill in
 * (`RemoteQuerySessionManager.initUserAnswers` seeds an answer only from a
 * starting value). It is still never a filter: what the worker types there
 * reaches only a condition that reads it.
 */
export const hiddenSearchInputSchema = searchInputBase
	.extend({
		kind: z.literal("hidden"),
		/** Send the computed value to the search supplied by the project space. */
		sendAnswer: z.literal(true).optional(),
		value: valueSchema.optional(),
	})
	.strict();

/** A Web Apps search for a place supplies other prompts by identity. It
 * does not bind an ordinary search answer. */
export const addressSearchInputSchema = searchInputBase.extend({
	name: z
		.string()
		.regex(
			/^[A-Za-z_][A-Za-z0-9_]*$/,
			"Use letters, numbers or underscores in an address field name.",
		),
	kind: z.literal("address"),
	type: z.literal("address"),
	excludeFromRequest: z.literal(true).optional(),
	// Match the optional slots read by shared prompt projections without
	// allowing expressions or answer-entry settings on an address picker.
	required: z.never().optional(),
	validation: z.never().optional(),
	default: z.never().optional(),
	hidden: z.never().optional(),
	addressReceiver: z.never().optional(),
	hint: z.string().min(1).optional(),
	allowBlank: z.never().optional(),
});
export type AddressSearchInput = z.infer<typeof addressSearchInputSchema>;

/**
 * Exact seven-arm union over two authoring dimensions:
 *
 * - `kind`: simple, advanced, or hidden;
 * - widget shape: scalar, date-range, or select (the hidden arm has no widget).
 *
 * This cannot be a Zod `discriminatedUnion("kind", ...)`: simple and advanced
 * each appear in three arms. Keeping the widget split structural is what makes
 * a scalar range mode, a choice input without a table, or a
 * required hidden value unrepresentable.
 */
export const searchInputDefSchema = z.union([
	simpleScalarSearchInputSchema,
	simpleDateRangeSearchInputSchema,
	simpleSelectSearchInputSchema,
	advancedScalarSearchInputSchema,
	advancedDateRangeSearchInputSchema,
	advancedSelectSearchInputSchema,
	projectScalarSearchInput,
	projectRangeSearchInput,
	projectChoiceSearchInput,
	addressSearchInputSchema,
	hiddenSearchInputSchema,
]);
export type SimpleScalarSearchInputDef = z.infer<
	typeof simpleScalarSearchInputSchema
>;
export type SimpleDateRangeSearchInputDef = z.infer<
	typeof simpleDateRangeSearchInputSchema
>;
export type SimpleSelectSearchInputDef = z.infer<
	typeof simpleSelectSearchInputSchema
>;
export type AdvancedScalarSearchInputDef = z.infer<
	typeof advancedScalarSearchInputSchema
>;
export type AdvancedDateRangeSearchInputDef = z.infer<
	typeof advancedDateRangeSearchInputSchema
>;
export type AdvancedSelectSearchInputDef = z.infer<
	typeof advancedSelectSearchInputSchema
>;
export type HiddenSearchInputDef = z.infer<typeof hiddenSearchInputSchema>;
export type SearchInputDef = z.infer<typeof searchInputDefSchema>;
export type SimpleSearchInputDef =
	| SimpleScalarSearchInputDef
	| SimpleDateRangeSearchInputDef
	| SimpleSelectSearchInputDef;
export type AdvancedSearchInputDef =
	| AdvancedScalarSearchInputDef
	| AdvancedDateRangeSearchInputDef
	| AdvancedSelectSearchInputDef;
/** Every arm a worker can see and answer. */
export type VisibleSearchInputDef =
	| ProjectParameterSearchInput
	| SimpleSearchInputDef
	| AdvancedSearchInputDef;
/** Every arm that names a lookup table for its choices. */
export type SelectSearchInputDef =
	| z.infer<typeof projectChoiceSearchInput>
	| SimpleSelectSearchInputDef
	| AdvancedSelectSearchInputDef;

export function isHiddenSearchInput(
	input: SearchInputDef,
): input is HiddenSearchInputDef {
	return input.kind === "hidden";
}

export function isVisibleSearchInput(
	input: SearchInputDef,
): input is VisibleSearchInputDef {
	return input.kind !== "hidden" && input.kind !== "address";
}

export type SearchAnswerInput = Exclude<SearchInputDef, { kind: "address" }>;

export function isSearchAnswerInput(
	input: SearchInputDef,
): input is SearchAnswerInput {
	return input.kind !== "address";
}

export function isSelectSearchInput(
	input: SearchInputDef,
): input is SelectSearchInputDef {
	return "options" in input;
}

/** The inputs a worker sees on the Search screen, in authored order. */
export function visibleSearchInputs(
	inputs: readonly SearchInputDef[],
): Exclude<SearchInputDef, { kind: "hidden" }>[] {
	return inputs.filter((input) => input.kind !== "hidden");
}

/** The device expression that supplies a visible prompt’s starting value. */
export function searchInputDefault(
	input: SearchInputDef,
): Expression | undefined {
	return "default" in input ? input.default : undefined;
}

/**
 * The scalar type an `input(name)` read of this input produces at runtime.
 * Widget-bearing arms read `SEARCH_INPUT_RUNTIME_VALUE_TYPES`; a hidden
 * input binds whatever text its expression printed.
 */
export function searchInputRuntimeValueType(
	input: SearchAnswerInput,
): CasePropertyDataType {
	return input.kind === "hidden"
		? "text"
		: SEARCH_INPUT_RUNTIME_VALUE_TYPES[input.type];
}

/**
 * The sentence every runtime shows when a required prompt is left blank and
 * the author wrote no message of their own. Nova supplies it on every wire
 * path so Preview, the local `.ccz`, and the HQ-regenerated suite agree; an
 * absent wire message would fall back to each runtime's own default.
 */
export const SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE =
	"Fill in this answer before searching.";

/**
 * The message shown when this input is required and left blank: the author's
 * own sentence, `""` for a requirement with no message (`noMessage`), else
 * Nova's default. `undefined` when the input is never required.
 */
export function searchInputRequiredMessage(
	input: SearchInputDef,
): string | undefined {
	if (!isVisibleSearchInput(input) || input.required === undefined)
		return undefined;
	if (input.required.noMessage === true) return "";
	return input.required.message ?? SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE;
}

/**
 * The sentence Core reports for a Search field check with no message of its
 * own (`QueryPrompt.DEFAULT_VALIDATION_ERROR`). Core asks the app strings for
 * `case.search.answer.invalid` first, which no CommCare app string table
 * defines, so a worker reads these words in every language.
 */
export const COMMCARE_SEARCH_INVALID_MESSAGE =
	"Sorry, this response is invalid!";

/**
 * The message shown when this input's answer fails its check: the author's
 * own sentence, else CommCare's (`COMMCARE_SEARCH_INVALID_MESSAGE`).
 * `undefined` when the input has no check.
 */
export function searchInputValidationMessage(
	input: SearchInputDef,
): string | undefined {
	if (!isVisibleSearchInput(input) || input.validation === undefined)
		return undefined;
	return input.validation.message ?? COMMCARE_SEARCH_INVALID_MESSAGE;
}

/**
 * Why a Search field's requirement can't carry the message settings it has,
 * or `undefined` where it can: a requirement either has no message at all or
 * may have one of its own, never both. Shared by the commit gate and the
 * builder.
 */
export function searchCheckMessageRefusal(
	input: SearchInputDef,
): string | undefined {
	if (
		isVisibleSearchInput(input) &&
		input.required?.noMessage === true &&
		input.required.message !== undefined
	)
		return "A requirement with no message can't have a message of its own too. Remove the message, or let it show one.";
	return undefined;
}

/** The lookup options source of a choice input; absent on every other arm. */
export function searchInputOptions(
	input: SearchInputDef,
): SearchInputLookupOptions | undefined {
	return isSelectSearchInput(input) ? input.options : undefined;
}

/**
 * Which search-screen slot a predicate on this input occupies. The two slots
 * evaluate in the same scope (globals plus the module's own answers), so
 * every consumer that type-checks or emits one handles both through this
 * list.
 */
export type SearchInputScreenPredicateSlot = "required" | "validation";

/** Every predicate slot a visible search input can carry: the custom match
 *  (the advanced arm's predicate) plus the two Search-screen predicates. */
export type SearchInputConditionSlot = "match" | SearchInputScreenPredicateSlot;

export interface SearchInputScreenPredicate {
	readonly slot: SearchInputScreenPredicateSlot;
	readonly predicate: Expression;
}

/**
 * The search-screen predicates a visible input carries: its conditional
 * required test (an always-required input has none) and its validation rule.
 * Hidden inputs carry neither.
 */
export function searchInputScreenExpressions(
	input: SearchInputDef,
): readonly SearchInputScreenPredicate[] {
	if (!isVisibleSearchInput(input)) return [];
	const out: SearchInputScreenPredicate[] = [];
	if (input.required?.when !== undefined) {
		out.push({ slot: "required", predicate: input.required.when });
	}
	if (input.validation !== undefined) {
		out.push({ slot: "validation", predicate: input.validation.rule });
	}
	return out;
}

/**
 * Every value expression this input evaluates on the search screen: a
 * visible input's seed, or a hidden input's system-generated value. The
 * instance walkers and the type checkers consume both through this one
 * list.
 */
export function searchInputExpressions(
	input: SearchInputDef,
): readonly Expression[] {
	if (input.kind === "hidden")
		return input.value === undefined ? [] : [input.value];
	const seed = searchInputDefault(input);
	return seed === undefined ? [] : [seed];
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

/** Slots every visible prompt may carry beside its widget-specific ones. */
interface SearchInputVisibleSlots {
	readonly addressReceiver?: SearchAddressReceiver;
	readonly hint?: string;
	readonly required?: SearchInputRequired;
	readonly validation?: SearchInputValidation;
	readonly allowBlank?: true;
	readonly hidden?: true;
}

/** The slot that seeds a visible input's initial state. */
interface SearchInputCommonSlots extends SearchInputVisibleSlots {
	readonly default?: Expression;
}

interface SimpleScalarSearchInputSlots extends SearchInputCommonSlots {
	readonly matching?: "project-space";
	/** Optional relation walk to a destination case type. `selfPath()`
	 *  is structurally equivalent to absent and the builder omits the
	 *  key in that case. */
	readonly via?: RelationPath;
	/** Optional explicit scalar search mode. */
	readonly mode?: ScalarSearchInputMode;
}

interface SimpleDateRangeSearchInputSlots extends SearchInputCommonSlots {
	readonly matching?: "project-space";
	readonly via?: RelationPath;
	/** The builder writes the sole valid stored mode when omitted. */
	readonly mode?: Extract<SearchInputMode, { kind: "range" }>;
}

interface SimpleSelectSearchInputSlots extends SearchInputCommonSlots {
	readonly matching?: "project-space";
	readonly via?: RelationPath;
	/** The lookup table and columns the prompt's choices come from. */
	readonly options: SearchInputLookupOptions;
	/** A choice widget admits only exact matching; omitted when absent. */
	readonly mode?: Extract<SearchInputMode, { kind: "exact" }>;
}

/**
 * Spreads the shared optional slots onto a search-input object only
 * when present — mirrors `withCommonSlots` for columns. Avoids
 * leaking `default: undefined` shapes that would fail `toEqual`
 * round-trip assertions.
 */
function withSearchInputCommonSlots<T extends Record<string, unknown>>(
	base: T,
	slots: SearchInputCommonSlots,
): T & SearchInputCommonSlots {
	const out: T & {
		addressReceiver?: SearchAddressReceiver;
		default?: Expression;
		hint?: string;
		required?: SearchInputRequired;
		validation?: SearchInputValidation;
		allowBlank?: true;
		hidden?: true;
	} = { ...base };
	if (slots.addressReceiver !== undefined)
		out.addressReceiver = slots.addressReceiver;
	if (slots.default !== undefined) out.default = slots.default;
	if (slots.hint !== undefined) out.hint = slots.hint;
	if (slots.required !== undefined) out.required = slots.required;
	if (slots.validation !== undefined) out.validation = slots.validation;
	if (slots.allowBlank === true) out.allowBlank = true;
	if (slots.hidden === true) out.hidden = true;
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
	type: SelectSearchInputType,
	property: string,
	slots: SimpleSelectSearchInputSlots,
): SimpleSelectSearchInputDef;
export function simpleSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	property: string,
	slots?:
		| SimpleScalarSearchInputSlots
		| SimpleDateRangeSearchInputSlots
		| SimpleSelectSearchInputSlots,
): SimpleSearchInputDef;
export function simpleSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	property: string,
	slots:
		| SimpleScalarSearchInputSlots
		| SimpleDateRangeSearchInputSlots
		| SimpleSelectSearchInputSlots = {},
): SimpleSearchInputDef {
	const candidate: Record<string, unknown> = {
		...withSearchInputCommonSlots(
			{ uuid, kind: "simple", name, label, type, property },
			slots,
		),
	};
	if (slots.matching) candidate.matching = slots.matching;
	if ("options" in slots) candidate.options = slots.options;
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
	predicate: Expression,
	slots?: SearchInputCommonSlots,
): AdvancedScalarSearchInputDef;
export function advancedSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: "date-range",
	predicate: Expression,
	slots?: SearchInputCommonSlots,
): AdvancedDateRangeSearchInputDef;
export function advancedSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SelectSearchInputType,
	predicate: Expression,
	slots: SearchInputCommonSlots & {
		readonly options: SearchInputLookupOptions;
	},
): AdvancedSelectSearchInputDef;
export function advancedSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	predicate: Expression,
	slots?: SearchInputCommonSlots & {
		readonly options?: SearchInputLookupOptions;
	},
): AdvancedSearchInputDef;
export function advancedSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	type: SearchInputType,
	predicate: Expression,
	slots: SearchInputCommonSlots & {
		readonly options?: SearchInputLookupOptions;
	} = {},
): AdvancedSearchInputDef {
	const candidate: Record<string, unknown> = {
		...withSearchInputCommonSlots(
			{ uuid, kind: "advanced" as const, name, label, type, predicate },
			slots,
		),
	};
	if (slots.options !== undefined) candidate.options = slots.options;
	return searchInputDefSchema.parse(candidate) as AdvancedSearchInputDef;
}

/**
 * Constructs a hidden search input. `value` is the global-scope expression
 * Nova evaluates when the Search screen opens, or absent for a hidden field
 * with no starting value; the input never filters.
 */
export function hiddenSearchInputDef(
	uuid: Uuid,
	name: string,
	label: string,
	value: Expression | undefined,
): HiddenSearchInputDef {
	return hiddenSearchInputSchema.parse({
		uuid,
		kind: "hidden",
		name,
		label,
		...(value !== undefined && { value }),
	});
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
	select: ["exact"],
	"multi-select": ["exact"],
	checkboxes: ["exact"],
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
	// allow-list at `lib/domain/expression/typeChecker.ts`.
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
	// A choice answer is the value column's token. `multi_select` properties
	// are excluded: the bare prompt compares whole stored values, and simple
	// multi-select containment is not part of the stored Search union.
	select: ["text", "single_select"],
	"multi-select": ["text", "single_select"],
	checkboxes: ["text", "single_select"],
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
	Record<SearchInputType, CasePropertyDataType>
> = {
	text: "text",
	date: "date",
	"date-range": "text",
	barcode: "text",
	select: "text",
	"multi-select": "text",
	checkboxes: "text",
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
	// A choice binds its value token; several choices bind the `#,#`-joined tokens.
	select: "text",
	"multi-select": "text",
	checkboxes: "text",
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
	select: "exact",
	"multi-select": "exact",
	checkboxes: "exact",
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

/**
 * Whether a simple field can take the project space's own matching
 * (`matching: "project-space"`): its prompt rides the bare key CommCare HQ
 * matches by its own rule, so it searches this case's own property under the
 * property's name (`name` is the case's name), with exact matching or a date
 * range. HQ then matches the answer whatever the property's type, so a field
 * whose widget doesn't fit the property's type can still search it there.
 * Shared by the commit gate and the builder so the builder offers the
 * matching, and the widgets it admits, exactly where the gate does.
 */
export function projectSpaceMatchingFits(
	input: Pick<
		SimpleSearchInputDef,
		"name" | "property" | "via" | "type" | "mode"
	>,
): boolean {
	return (
		(input.via === undefined || input.via.kind === "self") &&
		(input.name === "name" ? "case_name" : input.name) === input.property &&
		(input.mode === undefined ||
			input.mode.kind === "exact" ||
			(input.type === "date-range" && input.mode.kind === "range"))
	);
}

/**
 * Whether a simple field can let the worker search for blank. The blank rides
 * beside the answer as one more value of the prompt's own request key
 * (`query.js::encodeValue` joins `#,#` before the answer), and only CommCare
 * HQ's match of that key against the property it names reads a blank value
 * as "the property is blank" (`case_search/utils.py::_get_case_property_query`).
 * So the field rides the bare prompt: it searches this case's own property,
 * under the property's own name, with exact matching or a date range, or with
 * the project space's matching. A field Nova matches through a condition reads
 * the blank as part of its answer and finds nothing.
 *
 * A field with the project space's matching already rides the bare prompt key
 * on its own property (`nativeSearchFilters.ts` holds it to that), including
 * the keys HQ matches by its own rule: `name` is the case's name, `case_id` its
 * id and `status` a property of that name (`case_search/utils.py::_apply_filter`).
 * The owner is the exception: HQ refuses any second value beside it
 * (`SearchCriteria._validate_multiple_terms`), so a blank sent with an owner
 * stops the search.
 *
 * Returns the reason a shape is refused, or `undefined` when it can. Shared
 * by the commit gate and the builder so the builder never offers a choice the
 * gate refuses.
 */
export function searchForBlankRefusal(
	input: Pick<
		SimpleSearchInputDef,
		"name" | "property" | "via" | "type" | "mode" | "matching"
	>,
): string | undefined {
	if (input.via !== undefined && input.via.kind !== "self")
		return "Searching for blank works on this case's own properties, not a linked case's.";
	if (input.matching === "project-space")
		return input.name === "owner_id"
			? "CommCare HQ stops a search that sends a blank beside the case owner, so searching for blank doesn't work on the owner."
			: undefined;
	if (input.name !== input.property)
		return "Searching for blank needs the field's name to be the property it searches.";
	if (CASE_NODE_ATTRIBUTE_PROPERTIES.has(input.property))
		return "Searching for blank works on ordinary properties, not on case information the device stores differently.";
	const mode = input.mode?.kind ?? DEFAULT_SEARCH_MODE_KIND[input.type];
	if (mode === "exact" && input.type === "date")
		return "A single date searches a whole day, so searching for blank needs the project space's own date matching.";
	if (mode !== "exact" && mode !== "range")
		return "Searching for blank works with exact matching or a date range.";
	return undefined;
}

/**
 * Why a Search field Web Apps does not draw (`hidden: true`) cannot be one,
 * or `undefined` where it can. Shared by the commit gate and the builder so
 * the builder never offers a choice the gate refuses.
 *
 * Web Apps hides the prompt's row whole, so nobody there reads a hint,
 * answers a requirement, fixes a failed check or ticks the box to search for
 * blank, and CommCare HQ's Case List page blanks a hidden prompt's
 * requirement and checks on a save.
 *
 * A hidden prompt with no widget that leaves its key out of the request
 * (`exclude`) is a value the search never matches by its name, the `hidden`
 * arm. So a hidden text field rides the bare prompt CommCare HQ matches by
 * its own key: a simple field over its own case's property of its name,
 * matched exactly, or by the project space's own rule. Any other match runs
 * through `_xpath_query`, which writes `exclude` on the prompt
 * (`suite/case-search/simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission`).
 */
export function hiddenSearchFieldRefusal(
	input: VisibleSearchInputDef,
): string | undefined {
	if (input.hint !== undefined)
		return "A field Web Apps hides can't show a hint. Remove the hint, or leave the field shown.";
	if (input.required !== undefined || input.validation !== undefined)
		return "Nobody in Web Apps can answer a field it hides, so a hidden field can't be required or checked. Remove the requirement and the check, or leave the field shown.";
	if (input.allowBlank === true)
		return "Nobody in Web Apps can tick the box to also find blank on a field it hides. Turn off Also find blank, or leave the field shown.";
	if (input.type === "text" && !textRidesItsOwnName(input))
		return "A hidden text field can only search the property of its own name exactly. Change how it matches, or use a hidden value that a condition reads.";
	return undefined;
}

/** Whether a text field rides the bare prompt CommCare HQ matches by its own key. */
function textRidesItsOwnName(input: VisibleSearchInputDef): boolean {
	if (input.kind !== "simple") return false;
	if (input.matching === "project-space") return true;
	return (
		(input.via === undefined || input.via.kind === "self") &&
		input.name === input.property &&
		effectiveSimpleSearchModeKind(input) === "exact" &&
		!CASE_NODE_ATTRIBUTE_PROPERTIES.has(input.property)
	);
}

/**
 * Whether a simple multiple-choice field can match at all. A multi-select
 * answer is one `#,#`-joined string of chosen tokens, and CommCare splits
 * it into an any-of match only on the BARE prompt route: the prompt key names
 * the case property directly, on the case being searched, with no rewritten
 * spelling. Anything else (a parent-case walk, a reference name that differs
 * from the property, or metadata the device stores as a case attribute) needs
 * the query route, which treats the string as one value and matches nothing.
 *
 * Returns the reason a shape is refused, or `undefined` when the field rides
 * the bare prompt. Shared by the commit gate and the builder so a choice the
 * gate refuses is never offered.
 */
export function multiSelectSearchInputRefusal(
	input: Pick<SimpleSearchInputDef, "name" | "property" | "via">,
): string | undefined {
	if (input.via !== undefined && input.via.kind !== "self") {
		return "A multiple-choice field can only search this case, not a linked case.";
	}
	if (input.name !== input.property) {
		return "A multiple-choice field must keep the name used in other conditions equal to the property it searches.";
	}
	if (CASE_NODE_ATTRIBUTE_PROPERTIES.has(input.property)) {
		return "A multiple-choice field can't search this case information, because the device stores it differently from ordinary properties.";
	}
	return undefined;
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
export const caseTileGroupingSchema = z.strictObject({
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
	 * The constraint is layout-relative (strictly less than the tile's
	 * occupied row extent, and never splitting a cell) and lives in
	 * `lib/commcare/validator/rules/case-list/caseTileGrouping.ts`; a
	 * tile's rows follow its fields (`tileRowLimit`), so no fixed bound
	 * stands here.
	 */
	headerRows: persistableJsonPositiveIntegerSchema,
});
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

export const NAMED_TILE_SLOTS = [
	"topLeftImage",
	"topLeftText",
	"topRightImage",
	"topRightText",
	"middleLeftImage",
	"middleLeftText",
	"middleRightImage",
	"middleRightText",
	"bottomLeftImage",
	"bottomLeftText",
] as const;
export type NamedTileSlot = (typeof NAMED_TILE_SLOTS)[number];
export const namedTileSlotsSchema = z.record(
	z
		.enum(NAMED_TILE_SLOTS)
		.describe(
			"a named tile position: topLeftImage, topLeftText, topRightImage, topRightText, middleLeftImage, middleLeftText, middleRightImage, middleRightText, bottomLeftImage or bottomLeftText, each holding the field placed there",
		),
	uuidSchema,
);

export function namedTileCell(slot: NamedTileSlot): TileCell {
	const i = NAMED_TILE_SLOTS.indexOf(slot);
	const image = i % 2 === 0;
	const x = (Math.floor(i / 2) % 2) * 6;
	return tileCell(
		x + (image ? 0 : 1),
		Math.floor(i / 4),
		image ? 1 : 5,
		1,
		image
			? { fontSize: "small", horizontalAlign: "center", verticalAlign: "top" }
			: {
					fontSize: "medium",
					horizontalAlign: "left",
					verticalAlign: "middle",
				},
	);
}
export const caseTileLayoutSchema = z.strictObject({
	namedSlots: namedTileSlotsSchema.optional(),
	rawSlots: z.array(z.enum(NAMED_TILE_SLOTS)).min(1).optional(),
	/**
	 * Keep the tile on screen once a case is chosen from this list: above
	 * the menu its case opens, the forms and every screen after it while the
	 * session holds the case (`lib/preview/pinnedCaseTile.ts` says which).
	 *
	 * Emits as `detail-persistent="m{N}_case_short"` on each datum the list
	 * chooses; Web Apps renders it in the sticky
	 * `#persistent-case-tile` region above the screen
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
});
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
export const caseSelectionSchema = z.strictObject({
	kind: z.literal("multiple"),
	maximum: persistableJsonPositiveIntegerSchema.max(100),
	autoSelect: z.literal(true).optional(),
});
export type CaseSelection = z.infer<typeof caseSelectionSchema>;

export type CaseSelectionCardinality = "single" | "multiple";

/** The text an empty case list shows where the list holds none of its own,
 *  HQ's model default (`models/case_list.py::Detail.no_items_text`). */
export const CASE_LIST_EMPTY_TEXT_DEFAULT = "List is empty.";

/** The label of the button that carries chosen cases forward where the list
 *  holds none of its own, HQ's model default
 *  (`models/case_list.py::Detail.select_text`). */
export const CASE_LIST_SELECT_TEXT_DEFAULT = "Continue";

/** A case list's own wording: a worker-facing text with no blank spelling. */
export const caseListWordingSchema = z.string().trim().min(1);

/** An independent rule of Default order. Its value never becomes a Results
 * or Details column. Its optional name is the entry workers can choose in Sort by. */
export const calculatedSortSchema = z
	.strictObject({
		uuid: uuidSchema,
		expression: valueSchema,
		direction: columnSortShape.direction,
		priority: columnSortShape.priority,
		comparator: z
			.enum(["text", "integer", "decimal"])
			.optional()
			.describe(
				"How to compare the values. Leave it out to use the calculation’s own type. Text orders 10 before 2. A whole-number or decimal comparison orders 2 before 10.",
			),
		blanks: columnSortShape.blanks,
		label: columnSortShape.label,
	})
	.superRefine((rule, ctx) => {
		if (
			rule.label !== undefined &&
			(rule.label.trim() === "" ||
				[...rule.label].every((char) => (char.codePointAt(0) ?? 0) <= 32))
		) {
			ctx.addIssue({
				code: "custom",
				path: ["label"],
				message:
					"Give the calculation a name workers can read, or leave it unnamed.",
			});
		}
		if (rule.blanks === defaultSortBlanks(rule.direction)) {
			ctx.addIssue({
				code: "custom",
				path: ["blanks"],
				message: "Leave out the ordinary blank placement for this direction.",
			});
		}
	});
export type CalculatedSort = z.infer<typeof calculatedSortSchema>;

/** A request evaluated on the Search screen before any record is chosen. */
export const searchFilterTargetSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("property"),
		property: authoredCasePropertyNameSchema,
		ancestors: z.tuple([relationStepSchema], relationStepSchema).optional(),
	}),
	z.strictObject({ kind: z.literal("record-id") }),
	z.strictObject({ kind: z.literal("include-related-records") }),
	z.strictObject({
		kind: z.literal("record-name"),
		ancestors: z.tuple([relationStepSchema], relationStepSchema).optional(),
	}),
	z.strictObject({
		kind: z.literal("attribute"),
		attribute: z.enum(["id", "type", "owner", "status"]),
		ancestors: z.tuple([relationStepSchema], relationStepSchema).optional(),
	}),
	z.strictObject({ kind: z.literal("owner") }),
	/**
	 * Owners whose records the online search leaves out, named by the space
	 * separated value (HQ's `commcare_blacklisted_owner_ids` request key,
	 * `case_search/utils.py::CaseSearchQueryBuilder._apply_filter`). It applies
	 * to the server search alone, never to the device list. `search-setting`
	 * is the dedicated Case Search setting HQ's editor saves as
	 * `blacklisted_owner_ids_expression`; without it the rule is one of the
	 * default filters, in their order. Both send the same request key, so a
	 * search holds one.
	 */
	z.strictObject({
		kind: z.literal("excluded-owners"),
		placement: z.literal("search-setting").optional(),
	}),
	z.strictObject({ kind: z.literal("project-space") }),
	z.strictObject({
		kind: z.literal("link"),
		identifier: z.string().regex(XML_ELEMENT_NAME_PATTERN),
	}),
]);
export type SearchFilterTarget = z.infer<typeof searchFilterTargetSchema>;

/**
 * The order the server chooses its matches in before it caps them: each term
 * a property, how its indexed value compares (text, number or date) and a
 * direction, the later terms breaking ties of the earlier
 * (`case_search/utils.py::CaseSearchQueryBuilder._apply_sort`). The device
 * list may still show the returned records in its own order.
 */
export const searchRequestOrderSchema = z
	.array(
		z
			.strictObject({
				property: authoredCasePropertyNameSchema,
				/** The record name read by HQ's `name` key rather than `case_name`. */
				recordName: z.literal(true).optional(),
				comparison: z.enum(["text", "number", "date"]),
				direction: z.enum(["ascending", "descending"]),
				/** A default filter brought in from HQ that left these to HQ's
				 *  defaults (text, ascending) keeps leaving them. */
				implicitComparison: z.literal(true).optional(),
				implicitDirection: z.literal(true).optional(),
			})
			.refine((term) => !term.recordName || term.property === "case_name", {
				error: "Choose the record name.",
			})
			.refine(
				(term) => !term.implicitComparison || term.comparison === "text",
				{
					error: "Choose a comparison for this property.",
				},
			)
			.refine(
				(term) => !term.implicitDirection || term.direction === "ascending",
				{ error: "Choose a direction for this property." },
			),
	)
	.min(1);
export type SearchRequestOrder = z.infer<typeof searchRequestOrderSchema>;

export const searchValueFilterSchema = z.strictObject({
	uuid: uuidSchema,
	target: searchFilterTargetSchema,
	value: valueSchema,
});
/** An order among the default filters: HQ's `commcare_sort` request key, sent
 *  in the filters' order and before the dedicated `requestOrder`. */
export const searchOrderFilterSchema = z.strictObject({
	uuid: uuidSchema,
	kind: z.literal("order"),
	order: searchRequestOrderSchema,
});
export const searchRecordTypeRowSchema = z.strictObject({
	uuid: uuidSchema,
	kind: z.literal("request-record-type"),
	caseType: caseTypeNameSchema,
});
export const searchRelatedIdRowSchema = z.strictObject({
	uuid: uuidSchema,
	kind: z.literal("related-record-id"),
	property: authoredCasePropertyNameSchema,
});

export const searchFilterSchema = z.union([
	searchValueFilterSchema,
	searchOrderFilterSchema,
	searchRecordTypeRowSchema,
	searchRelatedIdRowSchema,
]);
export type SearchFilter = z.infer<typeof searchFilterSchema>;
export type SearchValueFilter = z.infer<typeof searchValueFilterSchema>;
export function searchFilterUsesValue(
	filter: SearchFilter,
): filter is SearchValueFilter {
	return "target" in filter;
}

/** Case type names are identities in the app catalog. HQ reads the menu
 * roster as a set. Retain request-only types separately: their primary hits
 * consume the search limit and can be read by a form without being choices. */
export const otherRecordTypesSchema = z
	.array(caseTypeNameSchema)
	.min(1)
	.refine(
		(types) => new Set(types).size === types.length,
		"Choose each record type once.",
	);

export function menuRecordTypes(
	primary: string,
	config?: Pick<CaseListConfig, "additionalCaseTypes">,
): string[] {
	return [
		primary,
		...[...new Set(config?.additionalCaseTypes)]
			.filter((type) => type !== primary)
			.sort(),
	];
}

/** Primary hits sent by search, including those a form can read even when the
 * menu offers no choice of that type. */
export function requestedRecordTypes(
	primary: string,
	config?: CaseListConfig,
): string[] {
	return [
		...new Set([
			...menuRecordTypes(primary, config),
			...(config?.searchFilters ?? []).flatMap((filter) =>
				"kind" in filter && filter.kind === "request-record-type"
					? [filter.caseType]
					: [],
			),
		]),
	];
}

/** Whether the selected physical record can supply an ordinary menu datum. */
export function menuOffersRecordType(
	module: Pick<Module, "caseType" | "caseListConfig"> | undefined,
	type: string,
): boolean {
	return (
		!!module?.caseType &&
		(module.caseType === type ||
			!!module.caseListConfig?.additionalCaseTypes?.includes(type))
	);
}

/** A case list can open a companion on Android and use its returned text to search. */
const deviceLookupName = z.string().trim().min(1);
const deviceLookupExtraName = deviceLookupName.refine(
	(name) => name !== "force_xpath_parsing",
);
export const CASE_LIST_LOOKUP_WORKER_FIELDS = ["username", "userid"] as const;
export type CaseListLookupWorkerField =
	(typeof CASE_LIST_LOOKUP_WORKER_FIELDS)[number];
const deviceLookupExtraSchema = z.union([
	z.strictObject({ name: deviceLookupExtraName, value: z.string() }),
	z.strictObject({
		name: deviceLookupExtraName,
		expression: z.strictObject({
			kind: z.literal("term"),
			term: z.strictObject({
				kind: z.literal("session-context"),
				field: z.enum(CASE_LIST_LOOKUP_WORKER_FIELDS),
			}),
		}),
	}),
]);
export type DeviceLookupExtra = z.infer<typeof deviceLookupExtraSchema>;
export const caseListDeviceLookupSchema = z
	.strictObject({
		action: deviceLookupName,
		label: deviceLookupName,
		icon: mediaAssetIdSchema.optional(),
		resultHeading: caseListWordingSchema.optional(),
		automatic: z.literal(true).optional(),
		extras: z.array(deviceLookupExtraSchema).min(1),
		responses: z.array(deviceLookupName).min(1),
	})
	.superRefine(({ extras, responses }, ctx) => {
		const names = extras.map(({ name }) => name);
		if (new Set(names).size !== names.length)
			ctx.addIssue({
				code: "custom",
				path: ["extras"],
				message: "Give each value sent to the app a different name.",
			});
		if (new Set(responses).size !== responses.length)
			ctx.addIssue({
				code: "custom",
				path: ["responses"],
				message: "Use each response name once.",
			});
	});
export type CaseListDeviceLookup = z.infer<typeof caseListDeviceLookupSchema>;

export function searchAddressReceiverProblem(
	input: VisibleSearchInputDef,
	inputs: readonly SearchInputDef[],
): string | undefined {
	const receiver = input.addressReceiver;
	if (receiver === undefined) return undefined;
	if (
		input.hidden === true ||
		(input.type !== "text" &&
			input.type !== "select" &&
			input.type !== "multi-select")
	)
		return "An address can fill a visible text or multiple-choice field.";
	if (input.type === "select" && receiver.kind === "address")
		return "Web Apps can select a different lookup value when an address fills a single-choice Search field. Link a text or multiple-choice field instead.";
	const active = inputs.some(
		(source) =>
			source.kind === "address" &&
			(receiver.kind === "address"
				? source.uuid === receiver.source
				: source.name === receiver.topic),
	);
	if (active !== (receiver.kind === "address"))
		return "Choose an address field from this Search screen or clear the link.";
	if (receiver.kind === "address") {
		const parts = receiver.parts.join("||");
		if (
			inputs.some(
				(other) =>
					other.uuid !== input.uuid &&
					isVisibleSearchInput(other) &&
					other.hidden !== true &&
					(other.type === "text" ||
						other.type === "select" ||
						other.type === "multi-select") &&
					other.addressReceiver?.kind === "address" &&
					other.addressReceiver.source === receiver.source &&
					other.addressReceiver.parts.join("||") === parts &&
					(input.type !== "text" || other.type !== "text"),
			)
		)
			return "Choose different address parts or a different address field for each linked choice field.";
	}
	return undefined;
}

export const caseListConfigSchema = z
	.strictObject({
		/**
		 * The columns themselves — a SET, keyed by uuid. Its array position
		 * carries no meaning, because Results and Details are two independent
		 * sequences over these same columns and one array cannot hold both.
		 */
		columns: z.array(columnSchema),
		calculatedSorts: z.array(calculatedSortSchema).min(1).optional(),
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
		detailTabs: detailTabsSchema.optional(),
		detailTile: detailTileSchema.optional(),
		contextAboveForm: caseFormContextSchema.optional(),
		filter: conditionSchema.optional(),
		searchCondition: conditionSchema.optional(),
		additionalCaseTypes: otherRecordTypesSchema.optional(),
		searchFilters: z.array(searchFilterSchema).min(1).optional(),
		searchInputs: z.array(searchInputDefSchema),
		searchInputGroups: z.array(searchInputGroupSchema).min(1).optional(),
		/**
		 * How many cases a worker can carry forward from Results. Absence is the
		 * ordinary single-case flow; the stored arm is multiple-only so one intent
		 * has one canonical representation.
		 */
		selection: caseSelectionSchema.optional(),
		/**
		 * What Results says when it holds no case, in the source language;
		 * absent is `CASE_LIST_EMPTY_TEXT_DEFAULT`. Its other languages are the
		 * translations of its unit (`module:<uuid>:list-empty-text`). Web Apps
		 * shows it; Android keeps its own empty-list wording.
		 */
		emptyText: caseListWordingSchema.optional(),
		/**
		 * The label of the button that carries a worker's chosen cases forward
		 * from Results, in the source language; absent is
		 * `CASE_LIST_SELECT_TEXT_DEFAULT`. Its other languages are the
		 * translations of its unit (`module:<uuid>:list-select-text`). Web Apps
		 * labels only its several-case Continue with it; Android keeps its own.
		 */
		selectButtonText: caseListWordingSchema.optional(),
		/**
		 * Faster loading is on: a calculated or link column may say how a
		 * phone loads its value (`loadBehavior`). HQ's
		 * `Module.show_case_list_optimization_options`, which the project
		 * space's `CASE_LIST_OPTIMIZATIONS` gates.
		 */
		optimizations: z.literal(true).optional(),
		deviceLookup: caseListDeviceLookupSchema.optional(),
		/**
		 * Tile layout for the Results surface. Absent ≡ the ordinary row
		 * layout. See `caseTileLayoutSchema`.
		 */
		tile: caseTileLayoutSchema.optional(),
	})
	.superRefine((config, ctx) => {
		for (const [index, input] of config.searchInputs.entries()) {
			if (!isVisibleSearchInput(input)) continue;
			const problem = searchAddressReceiverProblem(input, config.searchInputs);
			if (problem !== undefined)
				ctx.addIssue({
					code: "custom",
					path: ["searchInputs", index, "addressReceiver"],
					message: problem,
				});
		}
		if (config.searchInputGroups && !config.searchInputs.length)
			ctx.addIssue({
				code: "custom",
				path: ["searchInputGroups"],
				message: "Add a Search field before adding headings.",
			});
		const groupOrder = new Map<Uuid, number>();
		for (const [index, group] of (config.searchInputGroups ?? []).entries()) {
			if (groupOrder.has(group.uuid)) {
				ctx.addIssue({
					code: "custom",
					path: ["searchInputGroups", index, "uuid"],
					message: "Each Search heading needs its own identity.",
				});
			}
			groupOrder.set(group.uuid, index);
		}
		let lastGroup = -1;
		for (const [index, input] of config.searchInputs.entries()) {
			if (!groupOrder.size && input.group === undefined) continue;
			const position =
				input.group === undefined ? undefined : groupOrder.get(input.group);
			if (position === undefined || position < lastGroup) {
				ctx.addIssue({
					code: "custom",
					path: ["searchInputs", index, "group"],
					message:
						position === undefined
							? "Choose a heading in this Search for every field."
							: "Keep each heading's fields together and in heading order.",
				});
			} else {
				lastGroup = position;
			}
		}
		if (
			config.deviceLookup?.resultHeading !== undefined &&
			config.tile !== undefined
		)
			ctx.addIssue({
				code: "custom",
				path: ["deviceLookup", "resultHeading"],
				message: "Show lookup confidence in a case list with rows.",
			});
		if (config.deviceLookup && config.tile?.namedSlots)
			ctx.addIssue({
				code: "custom",
				path: ["deviceLookup"],
				message:
					"Use a list or a custom case tile to look up cases with an Android app.",
			});
		if (
			config.tile?.rawSlots &&
			(!config.tile.namedSlots ||
				new Set(config.tile.rawSlots).size !== config.tile.rawSlots.length)
		)
			ctx.addIssue({
				code: "custom",
				path: ["tile", "rawSlots"],
				message: "Choose a raw value only once for a named tile position.",
			});
		for (const [index, column] of config.columns.entries())
			if ("loadBehavior" in column && column.loadBehavior !== undefined) {
				if (!columnSupportsLoadBehavior(column))
					ctx.addIssue({
						code: "custom",
						path: ["columns", index, "loadBehavior"],
						message:
							"Only a calculated value or a link can choose how a phone loads it. Clear its loading choice first.",
					});
				else if (config.optimizations !== true)
					ctx.addIssue({
						code: "custom",
						path: ["columns", index, "loadBehavior"],
						message:
							"Turn on faster loading for this case list before choosing how a phone loads a value.",
					});
			}
		const columnUuids = config.columns.map((column) => column.uuid);
		const columnSet = new Set(columnUuids);
		if (columnSet.size !== columnUuids.length) {
			ctx.addIssue({
				code: "custom",
				path: ["columns"],
				message: "Case-list column UUIDs must be unique.",
			});
		}
		const memberIds = new Set(columnUuids);
		for (const [index, rule] of (config.calculatedSorts ?? []).entries()) {
			if (memberIds.has(rule.uuid))
				ctx.addIssue({
					code: "custom",
					path: ["calculatedSorts", index, "uuid"],
					message: "Each default order rule needs its own identity.",
				});
			memberIds.add(rule.uuid);
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
		if (config.tile?.namedSlots) {
			const assignments = Object.values(config.tile.namedSlots);
			const eligible = new Set(
				config.columns
					.filter(
						(column) =>
							column.visibleInList !== false && column.notOnList !== true,
					)
					.map((column) => column.uuid),
			);
			if (
				new Set(assignments).size !== assignments.length ||
				assignments.some((id) => !eligible.has(id))
			)
				ctx.addIssue({
					code: "custom",
					path: ["tile", "namedSlots"],
					message:
						"Choose a different Results field for each image and text position.",
				});
		}
		if (config.detailTile) {
			const shown = config.columns.filter(
				(column) => column.visibleInDetail !== false,
			);
			const printed = new Set(shown.map((column) => column.uuid));
			const cells = Object.keys(config.detailTile.cells) as Uuid[];
			if (
				!cells.length ||
				cells.length !== shown.length ||
				cells.some((id) => !printed.has(id))
			)
				ctx.addIssue({
					code: "custom",
					path: ["detailTile", "cells"],
					message: "Give each field shown in Details a place on its tile.",
				});
		}
		if (config.detailTabs) {
			const shown = new Set(
				config.columns
					.filter((col) => col.visibleInDetail !== false)
					.map((col) => col.uuid),
			);
			const fields = config.detailColumnOrder
				.filter((uuid) => shown.has(uuid))
				.map((uuid) => ({ uuid }));
			const spans = detailTabSpans(config.detailTabs, fields);
			if (!spans)
				ctx.addIssue({
					code: "custom",
					path: ["detailTabs"],
					message:
						"Each tab needs a different first field in Details order, starting with the first field shown.",
				});
			for (const { tab, start, end } of spans ?? []) {
				if (!tab.orderFields) continue;
				const own = fields
					.slice(start, end)
					.filter(({ uuid }) => tab.orderFields?.includes(uuid));
				if (
					!tab.rowSource ||
					own.length !== tab.orderFields.length ||
					own.some((field, i) => field.uuid !== tab.orderFields?.[i]) ||
					own.some(
						({ uuid }) =>
							!config.columns.some(
								(c) =>
									c.uuid === uuid &&
									(c.kind === "plain" || c.kind === "calculated"),
							),
					)
				)
					ctx.addIssue({
						code: "custom",
						path: ["detailTabs"],
						message:
							"A tab of records can order its rows by text or calculated fields in that tab, in Details order.",
					});
			}
		}
	});
export type CaseListConfig = z.infer<typeof caseListConfigSchema>;

/** Group definitions and their fields in Search display order. */
export function searchInputGroupsWithMembers(config: {
	searchInputGroups?: readonly SearchInputGroup[];
	searchInputs: readonly SearchInputDef[];
}): Array<SearchInputGroup & { inputs: SearchInputDef[] }> {
	const groups = (config.searchInputGroups ?? []).map((group) => ({
		...group,
		inputs: [] as SearchInputDef[],
	}));
	const byUuid = new Map(groups.map((group) => [group.uuid, group]));
	for (const input of config.searchInputs)
		if (input.group !== undefined) byUuid.get(input.group)?.inputs.push(input);
	return groups;
}

/** Whether HQ keeps a load behavior on this column: one it reads through an
 *  expression as plain text or markdown (a calculation without translated
 *  text, or a link), `DetailColumn.supports_optimizations`. */
export function columnSupportsLoadBehavior(column: Column): boolean {
	return (
		(column.kind === "calculated" &&
			column.texts === undefined &&
			column.rowField !== true) ||
		column.kind === "link"
	);
}

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
		sourceModule.caseType !== targetModule.caseType ||
		!menuRecordTypes(sourceModule.caseType, sourceModule.caseListConfig).every(
			(type) => menuOffersRecordType(targetModule, type),
		)
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
//     subtitle / empty state) and the optional
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
/**
 * The text of every search button, in every language, on both wire paths and
 * in Preview. It has no authored slot: HQ's Case List save keeps no other
 * label (`views/modules.py::_gather_and_update_search_properties` builds a new
 * `CaseSearch`, whose `search_button_label` default is this text).
 */
export const CASE_SEARCH_BUTTON_LABEL = "Search All Cases";

/** The stored title of a search with no title: a worker sees no heading. */
export const NO_SEARCH_SCREEN_TITLE = { kind: "none" } as const;
/** A search's title: authored text, or the `none` arm for no title at all.
 *  Absent is `DEFAULT_CASE_SEARCH_TITLE`. */
export const searchScreenTitleSchema = z.union([
	z.string().min(1),
	z.strictObject({ kind: z.literal("none") }),
]);
export type SearchScreenTitle = z.infer<typeof searchScreenTitleSchema>;

// The runtime case-claim step (which fires when an author picks a
// case from search results) runs unconditionally on the CCHQ
// runtime — there is no authoring affordance for it. Display sort,
// the always-on filter, and search inputs are not duplicated here;
// they live on `caseListConfig` as the single source for both
// screens.

export const ordinaryCaseSearchConfigSchema = z
	.strictObject({
		/** Uses the search supplied by this connected project space. The extra
		 * inputs are named values, evaluated when the worker submits the search. */
		projectSearch: z
			.strictObject({
				searchUuid: uuidSchema,
				defaults: z.array(
					z.strictObject({
						uuid: uuidSchema,
						name: z.string().min(1),
						value: valueSchema,
					}),
				),
			})
			.optional(),
		/** One additional record whose ID each match carries. */
		relatedRecordIdProperty: authoredCasePropertyNameSchema.optional(),
		/** Absent follows the information displayed by the list. */
		relatedRecords: z.enum(["hierarchy", "details"]).optional(),

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
		excludedOwnerIds: valueSchema.optional(),
		requestOrder: searchRequestOrderSchema.optional(),

		// Display labels for the search screen. The runtime renders the
		// subtitle through a markdown formatter; the title is plain text.
		// The search button's text is `CASE_SEARCH_BUTTON_LABEL`, never
		// authored. `searchButtonDisplayCondition` controls whether the case
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
		// A search with no title holds the `none` arm; absent is
		// `DEFAULT_CASE_SEARCH_TITLE`. `searchScreenTitleText` is the one reader.
		searchScreenTitle: searchScreenTitleSchema.optional(),
		searchScreenSubtitle: z.string().min(1).optional(),
		searchButtonDisplayCondition: conditionSchema.optional(),

		/**
		 * What a worker sees first when this menu searches. Absent is search
		 * first: the Search screen in Web Apps, which Android ignores and opens
		 * the case list. `skipToResults` runs the search as the menu opens and
		 * shows its matches; `listFirst` shows the worker's case list with a
		 * Search action, admitted only where Web Apps is not declared
		 * (`platforms.ts`, `list-first`). `listFirstWithDefaultResults` also
		 * requests default results for the Search action. Android opens its
		 * prompts and waits for submission with either list-first setting.
		 */
		workflow: z
			.enum(["listFirst", "listFirstWithDefaultResults", "skipToResults"])
			.optional(),
		/**
		 * The search runs as each case form of the menu opens, so the forms read
		 * what the worker searched for (`#search/`) and what it found
		 * (`results:inline`). CommCare's inline search. Presence is the switch.
		 * Only with search first or skip to results; unavailable on Android
		 * (`forms-read-search`). `moduleFormsReadSearch` is the one reader.
		 */
		formsReadSearch: z.literal(true).optional(),
		/** Clearing the search on a wide Web Apps screen requests its cleared answers. */
		searchOnClear: z.literal(true).optional(),
	})
	.refine(
		(config) =>
			!(searchOpensOnList(config.workflow) && config.formsReadSearch === true),
		{
			path: ["formsReadSearch"],
			error:
				"A menu that opens on its case list can't have its forms read the search. Choose Search first or Results first, or turn off Forms read the search.",
		},
	);

export const ownerOnlyCaseSearchConfigSchema = z.strictObject({
	/**
	 * Private provenance for assigned-case availability without a Search
	 * action. This is an exact stored arm: it requires the owner expression
	 * and structurally forbids all ordinary Search screen/action settings.
	 */
	searchActionEnabled: z.literal(false),
	excludedOwnerIds: valueSchema,
});

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
		config.requestOrder !== undefined ||
		config.relatedRecordIdProperty !== undefined ||
		config.relatedRecords !== undefined ||
		config.searchScreenTitle !== undefined ||
		config.searchScreenSubtitle !== undefined ||
		config.searchButtonDisplayCondition !== undefined ||
		config.workflow !== undefined ||
		config.formsReadSearch !== undefined ||
		config.searchOnClear !== undefined ||
		config.projectSearch !== undefined
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
 * The search's own owner exclusion, which replaces `excludedOwnerIds` for the
 * online search alone: the assigned list keeps that rule. A search sends one
 * `commcare_blacklisted_owner_ids` value, so one rule wins.
 */
export function searchOwnerOverride(
	config: Pick<CaseListConfig, "searchFilters"> | undefined,
): SearchValueFilter | undefined {
	return config?.searchFilters?.find(
		(row): row is SearchValueFilter =>
			searchFilterUsesValue(row) && row.target.kind === "excluded-owners",
	);
}

/** The owner exclusion HQ's editor holds as `blacklisted_owner_ids_expression`. */
export function isDedicatedOwnerFilter(filter: SearchFilter): boolean {
	return (
		searchFilterUsesValue(filter) &&
		filter.target.kind === "excluded-owners" &&
		filter.target.placement === "search-setting"
	);
}

/** The connected project space runs this menu’s search. */
export function projectSearchOf(
	module: Pick<Module, "caseSearchConfig"> | undefined,
) {
	const config = module?.caseSearchConfig;
	return isOrdinaryCaseSearchConfig(config) ? config.projectSearch : undefined;
}

/** The title a worker reads: the authored text, "Search" where none is
 *  authored, or null for a search with no title. The one reader. */
export function searchScreenTitleText(
	config: CaseSearchConfig | undefined,
): string | null {
	const title = isOrdinaryCaseSearchConfig(config)
		? config.searchScreenTitle
		: undefined;
	if (title === undefined) return DEFAULT_CASE_SEARCH_TITLE;
	return typeof title === "string" ? title : null;
}

/**
 * Project Search configuration after its final input is removed.
 *
 * Title and subtitle belong to the input screen and therefore disappear with
 * that screen. Action settings remain valid on a zero-input manual action, and
 * search content that remains (`searchConditions.ts::searchContentWithoutInputs`:
 * an effective search condition or a search filter) retains the action for
 * automatic Results. Assigned-case availability alone remains independent and
 * carries the internal no-action marker instead of manufacturing Search.
 */
export function caseSearchConfigAfterFinalInputRemoval(
	config: CaseSearchConfig | undefined,
	searchContentRemains: boolean,
): CaseSearchConfig | undefined {
	if (config === undefined) return undefined;
	if (isOwnerOnlyCaseSearchConfig(config)) return config;
	const {
		searchScreenTitle: _title,
		searchScreenSubtitle: _subtitle,
		...action
	} = config;
	// The workflow and Forms read the search survive the last input: the
	// menu keeps opening as the author chose.
	const hasSearchActionSetting =
		action.requestOrder !== undefined ||
		action.searchButtonDisplayCondition !== undefined ||
		action.workflow !== undefined ||
		action.formsReadSearch !== undefined ||
		action.searchOnClear !== undefined ||
		action.projectSearch !== undefined;
	if (searchContentRemains || hasSearchActionSetting) return action;
	if (action.excludedOwnerIds !== undefined) {
		return { ...action, searchActionEnabled: false };
	}
	return undefined;
}

// ── Module ───────────────────────────────────────────────────────

/** The module's case list as a menu entry of its own. */
export const caseListMenuItemSchema = z.strictObject({
	/** The entry's label. Absent is the module's name, with its translations. */
	label: z.string().min(1).optional(),
	/** The entry's image in the menu. */
	icon: moduleIconRefSchema.optional(),
	mediaByLanguage: navigationMediaSchema(moduleIconRefSchema).optional(),
	mediaByFormerCode:
		formerNavigationMediaSchema(moduleIconRefSchema).optional(),
	/** The entry's spoken label, played in audio-prompt mode. */
	audioLabel: mediaAssetIdSchema.optional(),
});
export type CaseListMenuItem = z.infer<typeof caseListMenuItemSchema>;

/** Where a worker goes after registering from the case list. */
export const CASE_LIST_REGISTRATION_RETURNS = [
	"case-list",
	"new-case",
] as const;
export type CaseListRegistrationReturn =
	(typeof CASE_LIST_REGISTRATION_RETURNS)[number];

const afterEmptySearchRegistrationSchema = z.strictObject({
	kind: z.literal("after-empty-search"),
	/** Continue in the menu with the newly registered case. Absent returns to the list. */
	afterSubmit: z.literal("new-case").optional(),
	/** A registration form of this module, on no menu. */
	formUuid: uuidSchema,
	/** The Register action's label. Absent is the form's name. */
	label: z.string().min(1).optional(),
});

export const caseListActionTargetSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("created-case"),
		operationUuid: uuidSchema,
	}),
	z.strictObject({ kind: z.literal("chosen-parent"), moduleUuid: uuidSchema }),
]);
export type CaseListActionTarget = z.infer<typeof caseListActionTargetSchema>;

export const caseListActionVisibilitySchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("empty-search") }),
	z.strictObject({ kind: z.literal("condition"), condition: conditionSchema }),
]);

const alwaysOfferedRegistrationSchema = z.strictObject({
	kind: z.literal("always"),
	/** A form held in its own menu, also offered on this list. */
	formUuid: uuidSchema,
	/** Absent registers the form's own case. Other targets name the created case
	 * or the menu which supplies the selected parent, independently of their names. */
	target: caseListActionTargetSchema.optional(),
	/** The action is offered whenever the list opens unless the list narrows it. */
	showWhen: caseListActionVisibilitySchema.optional(),
	/** The Register action's label. Absent is the form's name. */
	label: z.string().min(1).optional(),
	/** The action's image. Web Apps shows the label alone. */
	icon: formIconRefSchema.optional(),
	mediaByLanguage: navigationMediaSchema(formIconRefSchema).optional(),
	mediaByFormerCode: formerNavigationMediaSchema(formIconRefSchema).optional(),
	/** The action's spoken label, played in audio-prompt mode. */
	audioLabel: mediaAssetIdSchema.optional(),
	/** Back to the list, or on to this menu with the new case chosen. Applies
	 *  while the form's own after-submit is Home (`caseListRegistrationReturnOf`). */
	afterSubmit: z.enum(CASE_LIST_REGISTRATION_RETURNS),
});

/** A registration form the module's case list offers: its own, on no menu,
 *  after a search finds nothing; or another menu's, always. */
export const caseListRegistrationFormSchema = z.discriminatedUnion("kind", [
	afterEmptySearchRegistrationSchema,
	alwaysOfferedRegistrationSchema,
]);
export type CaseListRegistrationForm = z.infer<
	typeof caseListRegistrationFormSchema
>;
export type AfterEmptySearchRegistration = z.infer<
	typeof afterEmptySearchRegistrationSchema
>;
export type AlwaysOfferedRegistration = z.infer<
	typeof alwaysOfferedRegistrationSchema
>;

const menuFormSourceSchema = z.strictObject({
	menuUuid: uuidSchema,
	excludedFormUuids: z.array(uuidSchema).min(1).optional(),
	entryPoints: z
		.array(
			z.strictObject({ formUuid: uuidSchema, entryPoint: entryPointSchema }),
		)
		.min(1)
		.optional(),
});
export type MenuFormSource = z.infer<typeof menuFormSourceSchema>;
/** HQ's Case List editor accepts an ASCII initial letter followed by Python word
 * characters (letters, numbers and underscore). Its suite loader recognizes
 * certain built-in instances by substring and cannot host them as search names. */
export const searchResultsNameSchema = z
	.string()
	.refine(
		(name) => /^[A-Za-z][\p{L}\p{N}_]*$/u.test(name),
		"Choose a name that starts with A to Z or a to z. The rest can use letters, numbers and underscores.",
	)
	.refine(
		(name) =>
			!["casedb", "ledgerdb", "fixture", "session"].some((word) =>
				name.includes(word),
			),
		"This name overlaps a reserved name. You can use another name, such as FamilySearch.",
	);

export const moduleSchema = z.strictObject({
	/** A second route to the source menu's actual forms. The menu owns its appearance,
	 * case views and links. Its source owns each form and its XForm namespace. */
	formsFromMenu: menuFormSourceSchema.optional(),
	/** A manual choice from this list continues automatically when exactly one row is available. */
	autoSelectSingle: z.literal(true).optional(),
	entryPoint: entryPointSchema.optional(),
	caseListEntryPoint: entryPointSchema.optional(),
	uuid: uuidSchema,
	id: z.string(), // semantic id (snake_case display slug)
	name: z.string(),
	/** Optional parent menu. Omission is a top-level module. */
	parentModuleUuid: uuidSchema.optional(),
	/** Select a parent record from this module before selecting this module's records. */
	parentCaseModuleUuid: uuidSchema.optional(),
	caseType: z.string().optional(),
	/**
	 * The module's case list as its own menu entry, after its forms (HQ's
	 * order), opening the case list without a form. Presence is the switch.
	 * A module with a case type and no forms holds it; beside forms it is
	 * the author's choice.
	 */
	caseListMenuItem: caseListMenuItemSchema.optional(),
	/**
	 * A registration form the module's case list offers: its own, on no menu,
	 * after a search finds nothing; or another menu's, always. The
	 * `after-empty-search` form stays in the module's `formOrder`; the
	 * `always` form stays in its own menu's.
	 */
	caseListRegistrationForm: caseListRegistrationFormSchema.optional(),
	purpose: z.string().optional(),
	/**
	 * Optional home-menu visibility rule. Module navigation has no current
	 * case row, so validator context rules admit only global/session terms.
	 */
	displayCondition: conditionSchema.optional(),
	badge: menuBadgeSchema.optional(),
	/**
	 * Present when the module is off the menu: no menu lists it or any of
	 * its forms, whatever `displayCondition` says. The condition keeps
	 * applying once the module is back on the menu. A child module of a
	 * module off the menu is not itself off the menu, but no menu reaches it,
	 * unless that module shows its forms in the menu above: then a child that
	 * keeps its screen lists on the app's first menu by its own condition
	 * alone.
	 */
	hiddenFromMenu: z.literal(true).optional(),
	/**
	 * Present when the module's forms, and its case list entry, are listed in the
	 * menu above (the app's first menu for a top-level module, its parent for a
	 * submenu) and the module has no entry and no screen of its own. Its name,
	 * icon and spoken label stay stored and are shown nowhere while this is set.
	 * `menuScreens.ts` is the one reader of what lists where.
	 */
	formsInMenuAbove: z.literal(true).optional(),
	/** The menu contributes a grid when form menus use individual layouts. */
	menuLayout: z.literal("grid").optional(),
	caseListConfig: caseListConfigSchema.optional(),
	/** Which set of answers this menu keeps when a worker runs more than one search. */
	searchResultsName: searchResultsNameSchema.optional(),
	caseSearchConfig: caseSearchConfigSchema.optional(),
	/** Image shown on the module's home-screen tile. */
	icon: moduleIconRefSchema.optional(),
	mediaByLanguage: navigationMediaSchema(moduleIconRefSchema).optional(),
	mediaByFormerCode:
		formerNavigationMediaSchema(moduleIconRefSchema).optional(),
	/**
	 * Audio version of the module's home-screen label, played by
	 * audio-prompt mode — an accessibility affordance for
	 * low-literacy field workers. Menu affordances carry image +
	 * audio only; there is no video slot here.
	 */
	audioLabel: mediaAssetIdSchema.optional(),
	/**
	 * Present once a publish or the cutover recorded that CommCare HQ holds
	 * this menu as an advanced module. Written only by `holdPlacements`; an
	 * editor clears it only where a blocker leaves it unable to express the
	 * module (`advancedModule.ts::heldKindExpresses`), or restores it in the
	 * undo of that move. No mutation payload, tool schema or builder control
	 * carries it.
	 */
	heldKind: z.literal("advanced").optional(),
});
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
	const hasInputs = Boolean(
		module.caseListConfig?.searchInputs.length ||
			module.caseListConfig?.searchFilters?.length,
	);
	const stored = module.caseSearchConfig;
	if (stored === undefined) return hasInputs ? {} : undefined;
	if (!isOwnerOnlyCaseSearchConfig(stored)) return stored;
	if (!hasInputs) return undefined;
	throw new Error(
		"Owner-only case-search provenance reached runtime with Search inputs.",
	);
}

export const SEARCH_WORKFLOWS = [
	"listFirst",
	"listFirstWithDefaultResults",
	"searchFirst",
	"skipToResults",
] as const;
export type SearchWorkflow = (typeof SEARCH_WORKFLOWS)[number];

/** The two workflows that open on the worker's own case list. They differ
 * in the saved default-results preference for the separate Search action. */
export function searchOpensOnList(
	workflow: SearchWorkflow | undefined,
): workflow is "listFirst" | "listFirstWithDefaultResults" {
	return workflow === "listFirst" || workflow === "listFirstWithDefaultResults";
}

/** The authored workflow of this search; absent is search first. */
export function searchWorkflow(
	config: OrdinaryCaseSearchConfig,
): SearchWorkflow {
	return config.workflow ?? "searchFirst";
}

/** The module's workflow, or undefined where it has no effective ordinary search. */
export function moduleSearchWorkflow(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
): SearchWorkflow | undefined {
	const config = effectiveCaseSearchConfig(module);
	return config === undefined ? undefined : searchWorkflow(config);
}

/** The menu's forms read the search: CommCare's inline search. */
export function moduleFormsReadSearch(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
): boolean {
	return effectiveCaseSearchConfig(module)?.formsReadSearch === true;
}

/** The module shows its forms in the menu above (`formsInMenuAbove`). */
export function moduleShowsFormsInMenuAbove(
	module: Pick<Module, "formsInMenuAbove"> | undefined,
): boolean {
	return module?.formsInMenuAbove === true;
}

/** The menu lists the case list as its own entry. */
export function moduleHasCaseListMenuItem(
	module: Pick<Module, "caseListMenuItem">,
): boolean {
	return module.caseListMenuItem !== undefined;
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
