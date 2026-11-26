/**
 * A short detail's tile: its template, its persistence, its grouping, and
 * each placed column's cell. Only a custom tile on the case list reads; the
 * cells of a list that is no tile, and of a column hidden from Results in a
 * tile list, are no part of any wire Nova writes, so they are claimed and
 * dropped (`modules.ts::tileCellFor`).
 */

import {
	type BlueprintDoc,
	type Column,
	makeTranslationUnitId,
	NAMED_TILE_SLOTS,
	type NamedTileSlot,
	orderedColumns,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	type CaseListConfig,
	caseTileGroupingIdentifierSchema,
	caseTileGroupingSchema,
	rawTileTextShowsInGroupedWebBody,
	TILE_FONT_SIZES,
	TILE_GRID_COLUMNS,
	TILE_HORIZONTAL_ALIGNS,
	type TileCell,
	type TileVerticalAlign,
	tileCellBottomEdge,
	tileCellsOverlap,
	tileRowLimit,
} from "@/lib/domain/modules";
import { recordFromEntries } from "@/lib/domain/records";
import { readNamedTileSlot } from "../../suite/case-list/namedTile";
import { TILE_VERTICAL_ALIGN_WIRE } from "../../suite/case-list/tileStyle";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { withCandidate } from "../candidate";
import { type Claim, defineClaims, drop, refuse, take } from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { externalKey } from "../identity";
import { reReadUuidOf } from "../identityMap";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { storedColumnKind } from "./columnIdentity";
import { type JoinedDetails, persistHeldByExternalPullDown } from "./details";
import { claimRestUnderFinding } from "./refusedWhole";

const A = "menus-and-case-lists/";

const CELL_KEYS = [
	"grid_x",
	"grid_y",
	"width",
	"height",
	"horizontal_align",
	"vertical_align",
	"font_size",
	"show_border",
	"show_shading",
] as const;

export const TILE_CLAIMS = defineClaims("caseList.tile", {
	custom: take(
		`${A}detail-case-tile-template-custom`,
		"schema:Detail.case_tile_template",
	),
	iconTextGrid: take(
		`${A}detail-case-tile-template-icon-text-grid`,
		"schema:Detail.case_tile_template",
	),
	namedSlot: take(
		`${A}case-tile-field-template-slot-on-icon-text-grid`,
		"schema:DetailColumn.case_tile_field",
	),
	incompleteNamedTile: refuse(
		`${A}named-case-tile-missing-a-required-slot`,
		"schema:Detail.case_tile_template",
	),
	inactiveNamedSlot: drop(
		`${A}unused-slot-of-a-named-case-tile`,
		"schema:DetailColumn.case_tile_field",
	),
	personSimple: refuse(
		`${A}detail-case-tile-template-person-simple`,
		"schema:Detail.case_tile_template",
	),
	otherTemplate: refuse(
		`${A}detail-case-tile-template-other-than-custom-person-simple-or`,
		"schema:Detail.case_tile_template",
	),
	longCustom: take(
		`${A}long-detail-custom-tile-case-detail-laid-out-as-a-tile`,
		"schema:Detail.case_tile_template",
	),
	longOther: refuse(
		`${A}long-detail-non-custom-tile`,
		"schema:Detail.case_tile_template",
	),
	persist: take(
		`${A}detail-persist-tile-on-forms`,
		"schema:Detail.persist_tile_on_forms",
	),
	group: take(
		`${A}detail-case-tile-group-index-identifier-header-rows`,
		"schema:Detail.case_tile_group",
	),
	groupIdentifier: take(
		`${A}detail-case-tile-group-index-identifier-header-rows`,
		"schema:CaseTileGroupConfig.index_identifier",
	),
	groupRows: take(
		`${A}detail-case-tile-group-index-identifier-header-rows`,
		"schema:CaseTileGroupConfig.header_rows",
	),
	groupWithoutBody: refuse(
		`${A}case-tile-group-header-covers-all-cells`,
		"schema:Detail.case_tile_group",
	),
	groupIdentifierOutside: refuse(
		`${A}case-tile-group-identifier-outside-an-xml-element-name`,
		"schema:CaseTileGroupConfig.index_identifier",
	),
	gridX: take(
		`${A}grid-x-grid-y-width-height-custom-tile`,
		"schema:DetailColumn.grid_x",
	),
	gridY: take(
		`${A}grid-x-grid-y-width-height-custom-tile`,
		"schema:DetailColumn.grid_y",
	),
	width: take(
		`${A}grid-x-grid-y-width-height-custom-tile`,
		"schema:DetailColumn.width",
	),
	height: take(
		`${A}grid-x-grid-y-width-height-custom-tile`,
		"schema:DetailColumn.height",
	),
	horizontal: take(
		`${A}horizontal-align-vertical-align`,
		"schema:DetailColumn.horizontal_align",
	),
	vertical: take(
		`${A}horizontal-align-vertical-align`,
		"schema:DetailColumn.vertical_align",
	),
	fontSize: take(`${A}font-size`, "schema:DetailColumn.font_size"),
	border: take(
		`${A}show-border-show-shading`,
		"schema:DetailColumn.show_border",
	),
	shading: take(
		`${A}show-border-show-shading`,
		"schema:DetailColumn.show_shading",
	),
	unplaced: refuse(
		`${A}custom-tile-column-with-grid-null-unplaced`,
		"schema:DetailColumn.grid_x",
	),
	alignNull: refuse(
		`${A}horizontal-align-null-on-a-placed-custom-tile-column`,
		"schema:DetailColumn.horizontal_align",
	),
	fontNull: refuse(
		`${A}custom-tile-font-size-null`,
		"schema:DetailColumn.font_size",
	),
	overlapping: refuse(
		`${A}custom-tile-cells-covering-the-same-square`,
		"schema:DetailColumn.grid_x",
	),
	outsideGrid: refuse(
		`${A}custom-tile-cell-outside-the-grid`,
		"schema:DetailColumn.grid_x",
	),
	pastOfferedRows: refuse(
		`${A}custom-tile-cell-below-the-rows-hq-s-page-offers`,
		"schema:DetailColumn.grid_y",
	),
	tallX: take(
		`${A}custom-tile-cell-below-the-twelfth-row`,
		"schema:DetailColumn.grid_x",
	),
	tallY: take(
		`${A}custom-tile-cell-below-the-twelfth-row`,
		"schema:DetailColumn.grid_y",
	),
	tallWidth: take(
		`${A}custom-tile-cell-below-the-twelfth-row`,
		"schema:DetailColumn.width",
	),
	tallHeight: take(
		`${A}custom-tile-cell-below-the-twelfth-row`,
		"schema:DetailColumn.height",
	),
});

const T = TILE_CLAIMS;

const OFF_TILE = defineClaims(
	"caseList.tile.off",
	recordFromEntries(
		CELL_KEYS.map((key) => [
			key,
			drop(
				`${A}tile-cell-keys-on-a-list-that-is-not-a-tile`,
				`schema:DetailColumn.${key}`,
			),
		]),
	) as Record<(typeof CELL_KEYS)[number], ReturnType<typeof drop>>,
);

/** What the tile reading gives the case list and its comparison. */
export interface TileReading {
	readonly ok: boolean;
	readonly config?: NonNullable<CaseListConfig["tile"]>;
	/** Each placed column's cell, by its index in the join. */
	readonly cells: ReadonlyMap<number, TileCell>;
	readonly detailCells?: ReadonlyMap<number, TileCell>;
	readonly slots?: ReadonlyMap<NamedTileSlot, number>;
}

/** HQ's vertical words read back to Nova's, by the table the projection writes them with. */
const VERTICAL_FROM_WIRE = new Map(
	Object.entries(TILE_VERTICAL_ALIGN_WIRE).map(([nova, wire]) => [
		wire,
		nova as TileVerticalAlign,
	]),
);

function dropCells(column: JsonCursor): void {
	for (const key of CELL_KEYS) column.drop(key, OFF_TILE[key]);
}

/** Whether a column's key is one of its tile cell's. */
function isCellKey(key: string): boolean {
	return (CELL_KEYS as readonly string[]).includes(key);
}

/**
 * One placed column's cell, or a finding. A word outside the page's three is `unrecognized`. A
 * cell that is a finding is refused whole: each of its keys is claimed under that finding. The
 * refusal is a class of the column and of the custom tile it stands in, so it stands at the
 * column's keys and at the detail's `case_tile_template` (`template`) too.
 */
function readCell(
	ctx: ReadContext,
	column: JsonCursor,
	template: string,
	rows: number,
	overlapping = false,
): TileCell | "finding" {
	const refused = (claim: Claim<"refuse">): "finding" => {
		ctx.accounting.findingAt(claim, column.place, column.pointer);
		ctx.accounting.findingAt(claim, column.place, template);
		claimRestUnderFinding(
			ctx,
			column,
			{ code: claim.entry, place: column.place },
			isCellKey,
		);
		return "finding";
	};
	const x = column.peek("grid_x");
	const y = column.peek("grid_y");
	if (typeof x !== "number" || typeof y !== "number")
		return refused(T.unplaced);
	const horizontal = column.peek("horizontal_align");
	const vertical = column.peek("vertical_align");
	const font = column.peek("font_size");
	if (
		horizontal === null ||
		horizontal === undefined ||
		vertical === null ||
		vertical === undefined
	)
		return refused(T.alignNull);
	if (font === null || font === undefined) return refused(T.fontNull);
	const grid = gridFit(column, rows);
	if (grid === "outside") return refused(T.outsideGrid);
	if (grid === "past-offered-rows") return refused(T.pastOfferedRows);
	if (overlapping) return refused(T.overlapping);
	const verticalWord =
		typeof vertical === "string" ? VERTICAL_FROM_WIRE.get(vertical) : undefined;
	if (
		!(TILE_HORIZONTAL_ALIGNS as readonly unknown[]).includes(horizontal) ||
		verticalWord === undefined ||
		!(TILE_FONT_SIZES as readonly unknown[]).includes(font)
	) {
		const name = !(TILE_HORIZONTAL_ALIGNS as readonly unknown[]).includes(
			horizontal,
		)
			? "schema:DetailColumn.horizontal_align"
			: verticalWord === undefined
				? "schema:DetailColumn.vertical_align"
				: "schema:DetailColumn.font_size";
		ctx.accounting.circumstance("unrecognized", column.place, { name });
		claimRestUnderFinding(
			ctx,
			column,
			{ code: "unrecognized", place: column.place, name },
			isCellKey,
		);
		return "finding";
	}
	column.take("vertical_align", T.vertical, String).value;
	const tall = grid === "below-the-twelfth-row";
	const cell: TileCell = {
		x: column.take("grid_x", tall ? T.tallX : T.gridX, Number).value,
		y: column.take("grid_y", tall ? T.tallY : T.gridY, Number).value,
		width: column.take("width", tall ? T.tallWidth : T.width, Number).value,
		height: column.take("height", tall ? T.tallHeight : T.height, Number).value,
		horizontalAlign: column.take("horizontal_align", T.horizontal, String)
			.value as TileCell["horizontalAlign"],
		verticalAlign: verticalWord,
		fontSize: column.take("font_size", T.fontSize, String)
			.value as TileCell["fontSize"],
	};
	const border = column.peek("show_border");
	const shading = column.peek("show_shading");
	if (typeof border === "boolean")
		cell.showBorder = column.take("show_border", T.border, Boolean).value;
	if (typeof shading === "boolean")
		cell.showShading = column.take("show_shading", T.shading, Boolean).value;
	return cell;
}

/**
 * Where a stored cell stands against the grid of the screen that holds it, of `rows` rows
 * (`screenTileRows`). `outside`: a cell starting left of or above the grid, spanning less than one
 * square, or running past the twelfth column. HQ's Case List page bounds its pickers to the twelve
 * columns (`details/bootstrap5/column.js`, `tileColumnMax`), so only an imported app holds one, and
 * Android does not draw it: a cell past the twelfth column stops the list
 * (`views/EntityViewTile.java::coordinatesInvalid`, "grid coordinates out of bounds"), one left of
 * or above the grid is skipped, and a span of none has no size (`getLayoutParamsForField`).
 * `past-offered-rows`: a cell inside those columns whose bottom edge passes the rows HQ's page
 * offers that screen, `max(columns, 6)` (`lib/domain/modules.ts::TILE_MIN_ROWS`): the page's next
 * save moves it to the first row or makes it one row tall (observed by proof 4 over
 * `targeted-tile-row-bound`), and Nova's gate refuses it. `below-the-twelfth-row`: a cell inside
 * the offered rows that runs past the twelfth, which a screen of more than twelve columns offers
 * and both runtimes size the tile to (Core's `Detail.getMaxWidthHeight`, Android's `getMaxRows`).
 * `fits` otherwise, and where a number is not there to judge.
 */
function gridFit(
	column: JsonCursor,
	rows: number,
): "fits" | "outside" | "past-offered-rows" | "below-the-twelfth-row" {
	const box = storedBox(column);
	if (box === undefined) return "fits";
	if (
		box.x < 0 ||
		box.y < 0 ||
		box.width < 1 ||
		box.height < 1 ||
		box.x + box.width > TILE_GRID_COLUMNS
	)
		return "outside";
	const bottom = box.y + box.height;
	if (bottom > rows) return "past-offered-rows";
	return bottom > TWELVE_ROWS ? "below-the-twelfth-row" : "fits";
}

/** The row past which a held cell is the class `custom-tile-cell-below-the-twelfth-row`: the
 *  twelve rows Nova's grid held before it followed HQ's page, kept as the class's edge. */
const TWELVE_ROWS = 12;

/**
 * The rows HQ's Case List or Case Detail page offers one detail's tile: `max(n, 6)`, n its
 * non-filter columns and, on a long detail, its tabs, which the page holds as columns
 * (`details/bootstrap5/screen.js`, `caseTileRowMax`, the tabs spliced into the columns before the
 * filters are dropped). The same count as `lib/domain/modules.ts::tileRowLimit` over the
 * document the reading gives.
 */
function screenTileRows(detail: JsonCursor, withTabs: boolean): number {
	const columns = detail.peek("columns");
	const tabs = detail.peek("tabs");
	const counted =
		(Array.isArray(columns) ? columns : []).filter(
			(column) => !isJsonObject(column) || column.format !== "filter",
		).length + (withTabs && Array.isArray(tabs) ? tabs.length : 0);
	return tileRowLimit(counted);
}

/** A stored cell's square, where its four numbers are all there. */
function storedBox(column: JsonCursor): TileCell | undefined {
	const [x, y, width, height] = (
		["grid_x", "grid_y", "width", "height"] as const
	).map((key) => column.peek(key));
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof width !== "number" ||
		typeof height !== "number"
	)
		return undefined;
	return { x, y, width, height } as TileCell;
}

/** Body placement of an ordinary invisible field in a custom Web Apps tile. */
export function invisibleTileTextShowsInWebApps(
	short: JsonCursor,
	column: JsonCursor,
): boolean {
	const group = short.peek("case_tile_group");
	if (
		short.peek("case_tile_template") !== "custom" ||
		column.peek("format") !== "invisible" ||
		!isJsonObject(group)
	)
		return false;
	// An omitted header is the two rows HQ's CaseTileGroupConfig supplies.
	const grouping = caseTileGroupingSchema.safeParse({
		identifier: group.index_identifier,
		headerRows: group.header_rows === undefined ? 2 : group.header_rows,
	});
	if (!grouping.success) return false;
	const cell = storedBox(column);
	if (cell === undefined || !Object.values(cell).every(Number.isSafeInteger))
		return false;
	const fit = gridFit(column, screenTileRows(short, false));
	return (
		(fit === "fits" || fit === "below-the-twelfth-row") &&
		rawTileTextShowsInGroupedWebBody(
			{ y: cell.y, androidOnly: true },
			grouping.data.headerRows,
		)
	);
}

/**
 * The columns among `group` whose stored cell covers a square another one of the group covers.
 * CommCare HQ saves such a tile as it is, and the device draws one field over the other, while
 * Nova's tile gives every shown field a square of its own
 * (`validator/rules/case-list/caseTileLayout.ts`), so each such cell is a finding the person can
 * resolve in HQ's Case List page by moving one of the fields.
 */
function overlappingCells(group: readonly JsonCursor[]): Set<JsonCursor> {
	const boxes = group.flatMap((cursor) => {
		const box = storedBox(cursor);
		return box === undefined ? [] : [{ cursor, box }];
	});
	const found = new Set<JsonCursor>();
	for (let a = 0; a < boxes.length; a++)
		for (let b = a + 1; b < boxes.length; b++)
			if (tileCellsOverlap(boxes[a].box, boxes[b].box)) {
				found.add(boxes[a].cursor);
				found.add(boxes[b].cursor);
			}
	return found;
}

/** Each long column's tab, by the first column of each tab (`DetailTab.starting_index`); one
 *  group where the detail holds no tab whose start is a number. */
function tabGroupOf(long: JsonCursor): (index: number) => number {
	const tabs = long.peek("tabs");
	const starts = (Array.isArray(tabs) ? tabs : [])
		.map((tab) => (isJsonObject(tab) ? tab.starting_index : undefined))
		.filter((start): start is number => typeof start === "number")
		.sort((a, b) => a - b);
	return (index) => starts.filter((start) => start <= index).length;
}

/**
 * Reads the short detail's tile into the case list's `tile` and each placed column's cell, and
 * claims the cell keys no wire writes. A tile on the long detail is a finding.
 */
export function readTile(
	ctx: ReadContext,
	module: DraftModule,
	short: JsonCursor,
	long: JsonCursor,
	joined: JoinedDetails,
	shortColumns: readonly JsonCursor[],
	longColumns: readonly JsonCursor[],
	dropped: ReadonlySet<number> = new Set(),
): TileReading {
	let ok = true;
	const cells = new Map<number, TileCell>();
	const longTemplate = long.peek("case_tile_template");
	let detailCells: Map<number, TileCell> | undefined;
	if (longTemplate === "custom") {
		long.take("case_tile_template", T.longCustom, String).value;
		detailCells = new Map();
		const groupOf = tabGroupOf(long);
		const placedLong = new Map<number, JsonCursor[]>();
		for (const column of joined.columns) {
			if (column.long === undefined) continue;
			const group = groupOf(column.long);
			placedLong.set(group, [
				...(placedLong.get(group) ?? []),
				longColumns[column.long],
			]);
		}
		const longRows = screenTileRows(long, true);
		const overlapsLong = new Set(
			[...placedLong.values()].flatMap((group) => [...overlappingCells(group)]),
		);
		for (const [index, column] of joined.columns.entries()) {
			if (column.long === undefined) continue;
			const cursor = longColumns[column.long];
			const cell = readCell(
				ctx,
				cursor,
				`${long.pointer}/case_tile_template`,
				longRows,
				overlapsLong.has(cursor),
			);
			if (cell === "finding") ok = false;
			else detailCells.set(index, cell);
		}
	} else {
		if (typeof longTemplate === "string" && longTemplate !== "") {
			long.refuse("case_tile_template", T.longOther);
			ok = false;
		}
		for (const column of longColumns) dropCells(column);
	}
	const template = short.peek("case_tile_template");
	if (template === null || template === undefined || template === "") {
		for (const column of shortColumns) dropCells(column);
		return { ok, cells, detailCells };
	}
	if (template !== "custom" && template !== "icon_text_grid") {
		short.refuse(
			"case_tile_template",
			template === "person_simple" ? T.personSimple : T.otherTemplate,
		);
		for (const column of shortColumns) dropCells(column);
		return { ok: false, cells, detailCells };
	}
	const named = template === "icon_text_grid";
	const slots = new Map<NamedTileSlot, number>();
	if (named) {
		const assignments = new Map<NamedTileSlot, number>();
		shortColumns.forEach((cursor, i) => {
			const slot = readNamedTileSlot(cursor.peek("case_tile_field"));
			if (slot) assignments.set(slot, i);
		});
		shortColumns.forEach((cursor, i) => {
			if (!cursor.used("case_tile_field")) return;
			const slot = readNamedTileSlot(cursor.peek("case_tile_field"));
			if (slot && assignments.get(slot) === i)
				cursor.take("case_tile_field", T.namedSlot, String).value;
			else cursor.drop("case_tile_field", T.inactiveNamedSlot);
		});
		for (const [i, col] of joined.columns.entries()) {
			if (col.short === undefined) continue;
			const slot = readNamedTileSlot(
				shortColumns[col.short].peek("case_tile_field"),
			);
			if (slot && assignments.get(slot) === col.short) slots.set(slot, i);
		}
		if (assignments.size !== NAMED_TILE_SLOTS.length) {
			short.refuse("case_tile_template", T.incompleteNamedTile);
			ok = false;
		} else short.take("case_tile_template", T.iconTextGrid, String).value;
	} else short.take("case_tile_template", T.custom, String).value;
	const config: NonNullable<CaseListConfig["tile"]> = {};
	const rawSlots = [...slots]
		.filter(([, i]) => {
			const key = joined.columns[i]?.short;
			return (
				key !== undefined && shortColumns[key].peek("format") === "invisible"
			);
		})
		.map(([slot]) => slot);
	if (rawSlots.length) config.rawSlots = rawSlots;
	// Beside another menu's tile expanded above the forms, the switch is that source's setting
	// (`details.ts::persistHeldByExternalPullDown`), read there, never this tile persisting.
	if (
		short.peek("persist_tile_on_forms") === true &&
		!persistHeldByExternalPullDown(ctx, module, short)
	) {
		short.take("persist_tile_on_forms", T.persist, Boolean).value;
		config.persistOnForms = true;
	}
	const placesCell = (column: JoinedDetails["columns"][number]) => {
		const cursor =
			column.short === undefined ? undefined : shortColumns[column.short];
		return cursor !== undefined &&
			!named &&
			!(column.visibleInList === false && cursor.peek("format") !== "invisible")
			? cursor
			: undefined;
	};
	const shortRows = screenTileRows(short, false);
	const overlapsShort = overlappingCells(
		joined.columns.flatMap((column) => placesCell(column) ?? []),
	);
	joined.columns.forEach((column, index) => {
		if (column.short === undefined) return;
		const cursor = shortColumns[column.short];
		if (cursor === undefined) return;
		if (placesCell(column) === undefined) {
			dropCells(cursor);
			return;
		}
		const cell = readCell(
			ctx,
			cursor,
			`${short.pointer}/case_tile_template`,
			shortRows,
			overlapsShort.has(cursor),
		);
		if (cell === "finding") ok = false;
		else
			cells.set(
				index,
				cursor.peek("format") === "invisible"
					? { ...cell, androidOnly: true }
					: cell,
			);
	});
	// A column an inert row dropped writes no field, so no cell (`detail_screen.py::Filter`).
	for (const index of dropped) {
		const cursor = shortColumns[index];
		if (cursor !== undefined) dropCells(cursor);
	}
	const group = short.peek("case_tile_group");
	if (
		isJsonObject(group) &&
		typeof group.index_identifier === "string" &&
		group.index_identifier !== ""
	) {
		const identifier = group.index_identifier;
		const validIdentifier =
			caseTileGroupingIdentifierSchema.safeParse(identifier).success;
		const headerRows = group.header_rows ?? 2;
		// The source's placed geometry remains known when a column's style
		// or format is independently refused.
		let occupiedRows = 0;
		for (const column of shortColumns) {
			if (column.peek("format") === "filter") continue;
			const box = storedBox(column);
			if (box === undefined) continue;
			const fit = gridFit(column, shortRows);
			if (fit === "fits" || fit === "below-the-twelfth-row")
				occupiedRows = Math.max(occupiedRows, tileCellBottomEdge(box));
		}
		if (
			validIdentifier &&
			!named &&
			occupiedRows > 0 &&
			typeof headerRows === "number" &&
			Number.isSafeInteger(headerRows) &&
			headerRows >= occupiedRows
		) {
			// The header is relative to the tile's cells, and its default is
			// omitted from use accounting. Refuse the active group as a whole.
			short.refuse("case_tile_group", T.groupWithoutBody, {
				reason: "Leave at least one tile row below the group heading.",
			});
			ok = false;
		} else {
			const cursor = short.object(
				"case_tile_group",
				"CaseTileGroupConfig",
				T.group,
			);
			if (!validIdentifier) {
				cursor.refuse("index_identifier", T.groupIdentifierOutside, {
					name: identifier,
				});
				claimRestUnderFinding(
					ctx,
					cursor,
					{ code: T.groupIdentifierOutside.entry, place: cursor.place },
					(key) => key === "header_rows",
				);
				ok = false;
			} else {
				config.grouping = {
					identifier: cursor.take("index_identifier", T.groupIdentifier, String)
						.value,
					headerRows: cursor.take("header_rows", T.groupRows, Number).value,
				};
			}
		}
	}

	return {
		ok,
		config,
		cells,
		detailCells,
		...(named && slots.size === NAMED_TILE_SLOTS.length && { slots }),
	};
}

/**
 * The reader's canonical choice `tile-columns-shown-nowhere-are-as-read`. In a tile list a column
 * hidden from Results and from Details is no field of either detail (`caseListOrder.ts`, rule 2),
 * so nothing of it is in any export but the order rule it holds: a plain column's header, and its
 * place in the list's order, are written nowhere (the rule's name in Sort by, where it holds one,
 * is the header the reader returns), and a column whose rule is written nowhere (an
 * unsorted one, a calculated one, one over `case_id`) leaves no trace at all. The reader returns a
 * plain such column with no header, after the list's other columns in the order of its rule
 * (`order.ts::readSortElements` adds it there), and no column for one that leaves no trace. A
 * sorted column of another kind (a date, a phone number, an id mapping and so on) is written the
 * same element a plain column over its property writes, since the element's comparator is the
 * property's type and not the column's kind (`caseListOrder.ts::caseListOrderPlan`), so the reader
 * returns it as that plain column too, with nothing but its field, its order rule and its two
 * hidden flags. Its identity is then the one a re-read gives a plain column at its place in the
 * list's order: the identity of the document's own plain column under that key where it holds
 * one, else the UUID a re-read gives a key the document lacks (`identityMap.ts::reReadUuidOf`).
 * It reads the rules where `order-rules-on-the-columns-they-land-on` puts them.
 */
export function tileColumnsShownNowhereAsRead(doc: BlueprintDoc): BlueprintDoc {
	const changed = doc.moduleOrder.filter((uuid) => {
		const config = doc.modules[uuid]?.caseListConfig;
		return (
			config?.tile !== undefined &&
			config.columns.some((column) => shownNowhere(column))
		);
	});
	if (changed.length === 0) return doc;
	const effectiveTypes = effectiveCaseTypes(doc);
	const reRead = reReadUuidOf(doc, DERIVED_WIRE_IDENTITY);
	return withCandidate(doc, (draft) => {
		for (const uuid of changed) {
			const config = draft.modules[uuid]?.caseListConfig;
			if (config === undefined) continue;
			const traceless = new Set(
				config.columns
					.filter((column) => shownNowhere(column) && !ruleWritten(column))
					.map((column) => column.uuid),
			);
			config.columns = config.columns.filter(
				(column) => !traceless.has(column.uuid),
			);
			config.detailColumnOrder = config.detailColumnOrder.filter(
				(one) => !traceless.has(one),
			);
			const carried = config.columns
				.filter((column) => shownNowhere(column))
				.sort((a, b) => (a.sort?.priority ?? 0) - (b.sort?.priority ?? 0));
			// A rule that names its column in Sort by prints that name, the appended column's header
			// (`util.py::create_temp_sort_column`), so the reader returns it as the header.
			for (const column of carried)
				if (column.kind === "plain") column.header = column.sort?.label ?? "";
			const last = new Set(carried.map((column) => column.uuid));
			config.listColumnOrder = [
				...config.listColumnOrder.filter(
					(one) => !traceless.has(one) && !last.has(one),
				),
				...carried.map((column) => column.uuid),
			];
			const source = doc.modules[uuid]?.caseListConfig;
			if (source === undefined) continue;
			const kinds = new Map(
				source.columns.map((c) => [
					c.uuid,
					storedColumnKind(c, doc.modules[uuid]?.caseType, effectiveTypes),
				]),
			);
			const raw = (id: Uuid) => kinds.get(id) !== "choice-label";
			const renamed = carriersAsPlainColumns(
				config,
				plainColumnKeys(source, raw),
				raw,
				(field, n) =>
					reRead(
						externalKey.caseListColumn(
							DERIVED_WIRE_IDENTITY.moduleUniqueId(uuid),
							"plain",
							field,
							n,
						),
					),
			);
			// A renamed column's name in Sort by keeps its translations under its new identity.
			for (const entries of Object.values(
				draft.localization?.translations ?? {},
			))
				for (const [from, to] of renamed) {
					const was = makeTranslationUnitId("column", from, "sort-label");
					const entry = entries[was];
					if (entry === undefined) continue;
					delete entries[was];
					entries[makeTranslationUnitId("column", to, "sort-label")] = entry;
				}
		}
	});
}

/** The identity of each plain column of `config`, by its field and its ordinal among plain
 *  columns of that field in the list's order: the key a reading claims a plain column under. */
function plainColumnKeys(
	config: CaseListConfig,
	raw: (id: Uuid) => boolean,
): ReadonlyMap<string, Uuid> {
	const keys = new Map<string, Uuid>();
	const counts = new Map<string, number>();
	for (const column of orderedColumns(config, "list")) {
		if (column.kind !== "plain" || !raw(column.uuid)) continue;
		const n = counts.get(column.field) ?? 0;
		counts.set(column.field, n + 1);
		keys.set(JSON.stringify([column.field, n]), column.uuid);
	}
	return keys;
}

/**
 * Each sorted column shown nowhere of `config` that is not plain, written as the plain column a
 * reading gives it: its field, its rule and its two hidden flags, under the identity the reading
 * claims for it, which is `known`'s for its key where no other column holds that identity, else
 * `mint`'s. `config` holds its final order.
 */
function carriersAsPlainColumns(
	config: CaseListConfig,
	known: ReadonlyMap<string, Uuid>,
	raw: (id: Uuid) => boolean,
	mint: (field: string, n: number) => Uuid,
): ReadonlyMap<Uuid, Uuid> {
	const byUuid = new Map(config.columns.map((column) => [column.uuid, column]));
	const counts = new Map<string, number>();
	const renamed = new Map<Uuid, Uuid>();
	for (const uuid of config.listColumnOrder) {
		const column = byUuid.get(uuid);
		if (column === undefined || column.kind === "calculated") continue;
		const plain =
			(column.kind === "plain" && raw(column.uuid)) || shownNowhere(column);
		if (!plain) continue;
		const n = counts.get(column.field) ?? 0;
		counts.set(column.field, n + 1);
		if (column.kind === "plain") continue;
		const held = known.get(JSON.stringify([column.field, n]));
		renamed.set(
			uuid,
			held !== undefined && !byUuid.has(held) ? held : mint(column.field, n),
		);
	}
	if (renamed.size === 0) return renamed;
	config.columns = config.columns.map((column) => {
		const next = renamed.get(column.uuid);
		if (next === undefined || column.kind === "calculated") return column;
		return {
			...plainColumn(next, column.field, column.sort?.label ?? ""),
			visibleInList: false,
			visibleInDetail: false,
			...(column.sort !== undefined && { sort: column.sort }),
		};
	});
	const rename = (one: Uuid) => renamed.get(one) ?? one;
	config.listColumnOrder = config.listColumnOrder.map(rename);
	config.detailColumnOrder = config.detailColumnOrder.map(rename);
	for (const tab of config.detailTabs ?? [])
		tab.startColumnUuid = rename(tab.startColumnUuid);
	return renamed;
}

/** A column hidden from Results and from Details. */
function shownNowhere(column: Column): boolean {
	return column.visibleInList === false && column.visibleInDetail === false;
}

/** Whether a tile list writes a column's own order rule, which in a tile list hidden from Results
 *  is a sort element over its property (`caseListOrder.ts`, rule 4, exception iii). */
function ruleWritten(column: Column): boolean {
	return (
		column.sort !== undefined &&
		column.kind !== "calculated" &&
		column.field !== "case_id"
	);
}
