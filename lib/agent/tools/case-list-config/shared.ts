/**
 * Shared input schemas + uuid helpers for the case-list-config SA
 * tools.
 *
 * The case-list config has four slots — `columns`, `filter?`,
 * `searchInputs`, `tile?`. `configureCaseList` is the preferred resource-level
 * call when several known changes belong together; it lowers to the same
 * granular mutations described below and commits once. The granular surface
 * remains available for focused edits:
 *
 *   - One wholesale tool for `filter` (`setCaseListFilter`) — a filter
 *     is one Predicate, so the wholesale shape fits.
 *   - Op tools for the two arrays — a list-add (`addCaseListColumns` /
 *     `addSearchInputs`) plus update / remove / reorder for each of
 *     `columns` and `searchInputs`. The add tools take a list (one item is
 *     a length-1 array); the rest keep each call's payload small + the SA's
 *     working memory of authored uuids tractable.
 *   - One layout tool for `tile` (`setCaseListTile`), which also carries
 *     the per-field placements. Placement lives with the layout rather than
 *     on the column ops because the two are judged together: while the tile
 *     is on, every field shown in Results needs a place, and no two fields
 *     may share a square — so turning the tile on, and every later
 *     rearrangement, has to land as one batch.
 *
 * The ops route their array-walk + error-shaping through the
 * `addColumnsMutation` / `addSearchInputsMutation` family in
 * `lib/agent/blueprintHelpers.ts` — the same builders any non-SA
 * caller (UI mutation) reuses. This file owns the SA-boundary inputs:
 *
 *   - `columnInputSchema` / `columnUpdateInputSchema` /
 *     `searchInputDefInputSchema` — the exact union shapes the SA
 *     passes when adding or updating an entry. `uuid` is omitted from each
 *     arm; the tool mints it on `add` and looks it up on `update`.
 *   - `tileCellInputSchema` / `caseTileLayoutInputSchema` /
 *     `tilePlacementInputSchema` — the tile-layout shapes.
 *   - `newUuid` — uuid mint helper.
 *
 * The `moduleNotFoundResult` helper is consumed by every case-list-
 * config tool; its definition lives at `tools/shared/` because more
 * than one SA tool family uses it. The re-export below preserves the
 * existing import path inside this family.
 */

import { z } from "zod";
import {
	advancedDateRangeSearchInputSchema,
	advancedScalarSearchInputSchema,
	advancedSelectSearchInputSchema,
	asUuid,
	type Column,
	caseTileGroupingSchema,
	caseTileLayoutSchema,
	columnSchema,
	hiddenSearchInputSchema,
	SEARCH_INPUT_TYPES,
	type SearchInputDef,
	type SearchInputType,
	searchInputRequiredSchema,
	searchInputValidationSchema,
	simpleDateRangeSearchInputSchema,
	simpleScalarSearchInputSchema,
	simpleSelectSearchInputSchema,
	TILE_GRID_COLUMNS,
	TILE_GRID_ROWS,
	tileCellSchema,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import {
	expressionReadsCaseData,
	expressionReferencesAnySearchInput,
	type Predicate,
	predicateReadsCaseData,
	predicateSchema,
	type ValueExpression,
	valueExpressionSchema,
} from "@/lib/domain/predicate";

/**
 * Statically canonical views of the authoring schemas.
 *
 * SA, MCP, builder, and document storage all speak this same UUID-backed AST.
 */
const predicateInputSchema = predicateSchema as z.ZodType<Predicate>;
const valueExpressionInputSchema =
	valueExpressionSchema as z.ZodType<ValueExpression>;

// ── Tool input schemas — column + search-input shapes without uuid ──
//
// `addCaseListColumns` mints a fresh uuid per column; `updateCaseListColumn`
// preserves the existing uuid keyed by `columnUuid`. Both accept the same
// kind-discriminated body — built from one set of arms, with the replace
// surface dropping the tile cell as well (see `columnUpdateInputSchema`).
// The search-input tools share one schema across both surfaces.
//
// Each arm comes from `columnSchema.options` / `searchInputDefSchema.options`.
// Column identity is minted/carried by the tool. Sequence lives only in the
// case-list config's Results and Details UUID arrays and is authored through
// `reorderCaseListColumns`, never as a member property supplied by the SA.
// Destructuring per-arm preserves the TS-inferred per-arm shape so the
// discriminated union retypes cleanly — the
// `Iterable<ZodObject>.map(...)` form drops the per-arm narrowing into
// a non-callable union TS can't dispatch through `omit`.

// Positional destructure of the domain `columnSchema` arms — the order
// MUST track `columnSchema`'s `z.discriminatedUnion([...])` member order
// in `lib/domain/modules.ts`. Adding a column kind there requires adding it
// here, and to both column-input unions below, in the same position.
const [
	plainColumnArm,
	dateColumnArm,
	phoneColumnArm,
	idMappingColumnArm,
	imageMapColumnArm,
	intervalColumnArm,
	linkColumnArm,
	calculatedColumnArm,
] = columnSchema.options;

/**
 * Per-arm `Column` schema with identity omitted — the surface the SA passes
 * when adding or updating a column. The uuid is the tool's (minted on add,
 * looked up by `columnUuid` on update), and position is not the column's to
 * carry at all: it lives in the config's two ordering arrays.
 */
const columnToolOwnedSlots = { uuid: true } as const;

/* The per-arm omits are bound to named consts rather than mapped over
 * `columnSchema.options`, for the same reason the positional destructure above
 * exists: `Iterable<ZodObject>.map(...)` collapses the per-arm narrowing into a
 * union `omit` can't dispatch through. Binding them also lets the update-path
 * union below drop one more slot from the SAME arms without restating them. */
const newColumnIdentity = {
	columnUuid: uuidSchema
		.optional()
		.describe(
			"Stable UUID for this new column. Supply it when another item in the call references the column; otherwise Nova mints it.",
		),
};
const plainColumnInputArm = plainColumnArm
	.omit(columnToolOwnedSlots)
	.extend(newColumnIdentity);
const dateColumnInputArm = dateColumnArm
	.omit(columnToolOwnedSlots)
	.extend(newColumnIdentity);
const phoneColumnInputArm = phoneColumnArm
	.omit(columnToolOwnedSlots)
	.extend(newColumnIdentity);
const idMappingColumnInputArm = idMappingColumnArm
	.omit(columnToolOwnedSlots)
	.extend(newColumnIdentity);
const imageMapColumnInputArm = imageMapColumnArm
	.omit(columnToolOwnedSlots)
	.extend(newColumnIdentity);
const intervalColumnInputArm = intervalColumnArm
	.omit(columnToolOwnedSlots)
	.extend(newColumnIdentity);
/* `linkText` is described here rather than left to the prompt: it is the
 * one column slot whose two CommCare limits decide whether an author
 * wants the kind at all, and a slot's own description travels with the
 * tool schema on every call. */
const linkColumnInputArm = linkColumnArm.omit(columnToolOwnedSlots).extend({
	...newColumnIdentity,
	linkText: linkColumnArm.shape.linkText.describe(
		'What every row\'s link says, the same wording down the whole column ("View photo"). Reach for a `link` column when the property holds an address rather than a value a person reads, which is most often the property an attachment question saves to. Two CommCare limits to tell the user about: this wording is ONE string for every app language, because the wire has nowhere to carry a translated one, and the cell is a real link in CommCare Web Apps only, while the Android app shows the address as plain text.',
	),
});
const calculatedColumnInputArm = calculatedColumnArm
	.omit(columnToolOwnedSlots)
	.extend({
		...newColumnIdentity,
		expression: valueExpressionInputSchema,
	});

export const CALCULATED_SEARCH_EXPRESSION_GUIDANCE =
	"When the module uses Search, a calculated column can use the current case or show one parent property by itself. Do not wrap the parent property in another calculation.";

export const columnInputSchema = z.discriminatedUnion("kind", [
	plainColumnInputArm,
	dateColumnInputArm,
	phoneColumnInputArm,
	idMappingColumnInputArm,
	imageMapColumnInputArm,
	intervalColumnInputArm,
	linkColumnInputArm,
	calculatedColumnInputArm,
]);
export type ColumnInput = z.infer<typeof columnInputSchema>;

/**
 * The same column body with the tile cell dropped as well — the shape the
 * REPLACE surface (`updateCaseListColumn`) takes.
 *
 * A column's tile placement is preserved across every content replacement (the
 * `updateColumn` reducer carries the current cell onto the incoming body
 * unconditionally because content and placement are independent merge units).
 * A `tile` supplied here would therefore be read, echoed back in the
 * message, and silently discarded. Placement is authored through
 * `setCaseListTile`, which is also the only shape that can move two fields at
 * once — and a swap has to land in one batch, since no two cells may share a
 * square. The ADD surface keeps `tile` because a column joining a case list that
 * is ALREADY laid out as a tile has to be born placed, or the commit gate
 * rejects the add for a field with nowhere to sit.
 */
export const columnUpdateInputSchema = z.discriminatedUnion("kind", [
	plainColumnInputArm.omit({ tile: true, columnUuid: true }),
	dateColumnInputArm.omit({ tile: true, columnUuid: true }),
	phoneColumnInputArm.omit({ tile: true, columnUuid: true }),
	idMappingColumnInputArm.omit({ tile: true, columnUuid: true }),
	imageMapColumnInputArm.omit({ tile: true, columnUuid: true }),
	intervalColumnInputArm.omit({ tile: true, columnUuid: true }),
	linkColumnInputArm.omit({ tile: true, columnUuid: true }),
	calculatedColumnInputArm.omit({ tile: true, columnUuid: true }),
]);
export type ColumnUpdateInput = z.infer<typeof columnUpdateInputSchema>;

// ── Tile layout input shapes ────────────────────────────────────────
//
// The tile is the case list's OTHER layout: instead of a row of columns,
// each Results field occupies a rectangle on a fixed grid. Two things are
// authored, and `setCaseListTile` takes both in one call because the commit
// gate judges them together — while the tile layout is on, every field shown
// in Results must have a place, so turning it on and placing the fields is
// one act.
//
// The five presentation slots live INSIDE the cell and nowhere else. CommCare
// cannot spell alignment, text size, border, or shading for a field that has
// no rectangle (`<style>` is invalid without a complete `<grid>` child —
// `lib/commcare/suite/case-list/tileStyle.ts`), so an unplaced field carrying
// presentation is a state with no wire form. Keeping them in the cell object
// is what makes it unrepresentable.

/**
 * One field's rectangle on the tile grid — the domain `TileCell` with
 * SA-facing descriptions layered on.
 *
 * Grid BOUNDS are deliberately not restated as schema maxima. A cell can leave
 * the grid two ways (origin or span), overlap is a second geometry failure, and
 * `lib/commcare/validator/rules/case-list/caseTileLayout.ts` already owns one
 * message for each that names the offending field by its header. A partial
 * parse-time bound would answer the same mistake in a second, worse voice.
 */
export const tileCellInputSchema = tileCellSchema.extend({
	x: tileCellSchema.shape.x.describe(
		`Column the field starts in, counting from 0 at the left edge. The grid is ${TILE_GRID_COLUMNS} columns wide, so x + width may not pass ${TILE_GRID_COLUMNS}.`,
	),
	y: tileCellSchema.shape.y.describe(
		`Row the field starts in, counting from 0 at the top. The grid is ${TILE_GRID_ROWS} rows tall, so y + height may not pass ${TILE_GRID_ROWS}.`,
	),
	width: tileCellSchema.shape.width.describe(
		"How many columns the field spans. No two fields may cover the same square.",
	),
	height: tileCellSchema.shape.height.describe(
		"How many rows the field spans. No two fields may cover the same square.",
	),
	horizontalAlign: tileCellSchema.shape.horizontalAlign.describe(
		"Where the text sits across the field's own rectangle. Leave it out unless the field should sit somewhere other than the start of its rectangle.",
	),
	verticalAlign: tileCellSchema.shape.verticalAlign.describe(
		"Where the text sits down the field's own rectangle. Leave it out unless the field should sit somewhere other than the top.",
	),
	fontSize: tileCellSchema.shape.fontSize.describe(
		"Text size for this field. Leave it out and the field reads at the same size as the rest of the list — there is no default size that gets filled in, so only set it where a field should stand out or recede.",
	),
	showBorder: tileCellSchema.shape.showBorder.describe(
		"Draw a box around this field. Turning it on for ANY field puts the WHOLE tile into boxed layout, which re-spaces every other field on the tile too — so decide it for the tile, not for one field.",
	),
	showShading: tileCellSchema.shape.showShading.describe(
		"Shade this field's box. Tile-wide in the same way `showBorder` is: one shaded field re-spaces the whole tile.",
	),
});

/**
 * The tile layout itself — the domain `CaseTileLayout` with an SA-facing
 * description. PRESENCE is the switch, so the object carries only the extra
 * choices a tile offers; an empty object is a perfectly ordinary tile.
 */
export const caseTileLayoutInputSchema = caseTileLayoutSchema.extend({
	persistOnForms: caseTileLayoutSchema.shape.persistOnForms.describe(
		"Keep the tile on screen above every form in this module, so the worker can see which case they are filling the form in for. Leave it out for a tile that shows only on the case list.",
	),
	grouping: z
		.object({
			identifier: caseTileGroupingSchema.shape.identifier.describe(
				"The name of the case connection to group by, almost always `parent`. Grouping is by a CONNECTION, never by a property value: the heading is drawn from the first case in each group, which is only honest when every case in the group shares it.",
			),
			headerRows: caseTileGroupingSchema.shape.headerRows.describe(
				`How many of the tile's top rows form the group heading. Rows above the line are drawn ONCE per group, from the group's first case; the rows below are drawn for every case. The line must be a clean cut: at least one field above it, at least one below it, and no field crossing it (a crossing field is drawn wholly in the heading, so every other case's value in it disappears). The grid is ${TILE_GRID_ROWS} rows tall.`,
			),
		})
		.strict()
		.optional()
		.describe(
			"Show the cases that share a connection together, under one heading. Leave it out for an ordinary tile list, one tile per case. Two consequences worth telling the user about: choosing a group opens its FIRST case (the rows beneath the heading cannot be chosen), and every case with no such connection lands together in one group. The list also pages by group, so a page holds whole groups and however many cases they carry.",
		),
});

/* `tilePlacementInputSchema` pairs a cell with the uuid it belongs to; it is
 * declared beside `uuidInputSchema` at the foot of this file, which is where
 * that shared addressing schema lives. */

/**
 * The widget kinds the SA, MCP, builder, and persisted document all author.
 */
export const SA_SEARCH_INPUT_TYPES = SEARCH_INPUT_TYPES;

/**
 * The Search-screen boundary the commit gate also enforces, said at the
 * tool boundary so the model reads the reason beside its own call. Every
 * slot here evaluates before any case is selected: a case read can never
 * hold. A hidden value additionally fires before anyone types, so it may
 * not read another input either.
 */
function refineSearchInputBoundary(
	input:
		| {
				kind: "simple" | "advanced";
				type: SearchInputType;
				default?: ValueExpression;
				required?: { when?: Predicate };
				validation?: { rule: Predicate };
		  }
		| { kind: "hidden"; value: ValueExpression },
	ctx: z.RefinementCtx,
): void {
	if (input.kind === "hidden") {
		if (expressionReadsCaseData(input.value)) {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message:
					"A hidden search value is worked out when the Search screen opens, before any case is selected, so it cannot read case properties or relationships. Use a fixed value, `now()`, `today()`, or a current-user/session value.",
			});
		}
		if (expressionReferencesAnySearchInput(input.value)) {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message:
					"A hidden search value is worked out before anyone answers the Search screen, so it cannot read another search input. Use a fixed value, `now()`, `today()`, or a current-user/session value.",
			});
		}
		return;
	}
	if (input.default !== undefined && expressionReadsCaseData(input.default)) {
		ctx.addIssue({
			code: "custom",
			path: ["default"],
			message:
				"A search input's starting value is evaluated before any case is selected, so it cannot read case properties or relationships. Use a fixed value, `today()`, or a current-user/session value — or leave `default` out to start the input empty.",
		});
	}
	if (
		input.required?.when !== undefined &&
		predicateReadsCaseData(input.required.when)
	) {
		ctx.addIssue({
			code: "custom",
			path: ["required", "when"],
			message:
				'A required condition runs on the Search screen before any case is selected, so it cannot read case properties or relationships. Compare the other search inputs (`{kind: "input", searchInputUuid}`), fixed values, or current-user/session values.',
		});
	}
	if (
		input.validation !== undefined &&
		predicateReadsCaseData(input.validation.rule)
	) {
		ctx.addIssue({
			code: "custom",
			path: ["validation", "rule"],
			message:
				"A check runs on the Search screen before any case is selected, so it cannot read case properties or relationships. Test the answer itself and the other search inputs, fixed values, or current-user/session values.",
		});
	}
}

/**
 * The three prompt slots every visible arm shares. The descriptions are
 * deliberately terse: the seven arms inline them on three tools, so every
 * word here is paid twenty-one times per request. The semantics (Search
 * screen scope, browser-app-only enforcement, one check per input,
 * `matches-pattern` admitted only here) live in the SA prompt and the tool
 * descriptions, which are sent once.
 */
const visibleSearchInputSlots = {
	hint: z
		.string()
		.min(1)
		.optional()
		.describe("Helper text under the input on the Search screen."),
	required: searchInputRequiredSchema
		.optional()
		.describe("`{}` always; `when` conditional on sibling inputs."),
	validation: searchInputValidationSchema
		.optional()
		.describe("One rule a nonblank answer must pass, with its message."),
};

const searchInputUuidSlot = {
	searchInputUuid: uuidSchema
		.optional()
		.describe(
			"Supply when another item in the call references this input; otherwise minted.",
		),
};

/**
 * Per-arm `SearchInputDef` schema with `uuid` omitted. It exposes the domain's
 * exact seven final arms to both the SA and MCP surfaces.
 * Mirrors `columnInputSchema` for the search-input add / update tools.
 */
export const searchInputDefInputSchema = z
	.union([
		simpleScalarSearchInputSchema.omit({ uuid: true }).extend({
			...searchInputUuidSlot,
			...visibleSearchInputSlots,
			default: valueExpressionInputSchema.optional(),
		}),
		simpleDateRangeSearchInputSchema.omit({ uuid: true }).extend({
			...searchInputUuidSlot,
			...visibleSearchInputSlots,
		}),
		simpleSelectSearchInputSchema.omit({ uuid: true }).extend({
			...searchInputUuidSlot,
			...visibleSearchInputSlots,
			default: valueExpressionInputSchema.optional(),
		}),
		advancedScalarSearchInputSchema.omit({ uuid: true }).extend({
			...searchInputUuidSlot,
			...visibleSearchInputSlots,
			default: valueExpressionInputSchema.optional(),
			predicate: predicateInputSchema,
		}),
		advancedDateRangeSearchInputSchema.omit({ uuid: true }).extend({
			...searchInputUuidSlot,
			...visibleSearchInputSlots,
			predicate: predicateInputSchema,
		}),
		advancedSelectSearchInputSchema.omit({ uuid: true }).extend({
			...searchInputUuidSlot,
			...visibleSearchInputSlots,
			default: valueExpressionInputSchema.optional(),
			predicate: predicateInputSchema,
		}),
		hiddenSearchInputSchema.omit({ uuid: true }).extend({
			...searchInputUuidSlot,
			/* The bare AST node, so the wire projection keeps it a `$ref`; a
			 * `.describe()` here would clone the node past the projection's
			 * identity map and inline the whole ValueExpression family. */
			value: valueExpressionInputSchema,
		}),
	])
	.superRefine(refineSearchInputBoundary);
export type SearchInputDefInput = z.infer<typeof searchInputDefInputSchema>;

/** Full replacement body for an existing Search input; identity is addressed
 * by the enclosing tool and cannot be changed by the body. */
export const searchInputUpdateInputSchema = z
	.union([
		simpleScalarSearchInputSchema.omit({ uuid: true }).extend({
			...visibleSearchInputSlots,
			default: valueExpressionInputSchema.optional(),
		}),
		simpleDateRangeSearchInputSchema.omit({ uuid: true }).extend({
			...visibleSearchInputSlots,
		}),
		simpleSelectSearchInputSchema.omit({ uuid: true }).extend({
			...visibleSearchInputSlots,
			default: valueExpressionInputSchema.optional(),
		}),
		advancedScalarSearchInputSchema.omit({ uuid: true }).extend({
			...visibleSearchInputSlots,
			default: valueExpressionInputSchema.optional(),
			predicate: predicateInputSchema,
		}),
		advancedDateRangeSearchInputSchema.omit({ uuid: true }).extend({
			...visibleSearchInputSlots,
			predicate: predicateInputSchema,
		}),
		advancedSelectSearchInputSchema.omit({ uuid: true }).extend({
			...visibleSearchInputSlots,
			default: valueExpressionInputSchema.optional(),
			predicate: predicateInputSchema,
		}),
		hiddenSearchInputSchema.omit({ uuid: true }).extend({
			value: valueExpressionInputSchema,
		}),
	])
	.superRefine(refineSearchInputBoundary);
export type SearchInputUpdateInput = z.infer<
	typeof searchInputUpdateInputSchema
>;

// ── Uuid stamp helpers ──────────────────────────────────────────────
//
// The two stamp helpers below finalize an SA create/update command as the
// canonical domain shape (`Column`, `SearchInputDef`) by spreading the newly
// minted or addressed UUID into the object. Their cast lives
// adjacent to the per-arm-omit machinery that makes the cast necessary
// — keeping the rationale and the workaround in one place.

/**
 * Stamp the supplied uuid onto a kind-discriminated input column. The
 * cast is required because TS does not preserve per-arm narrowing
 * across a spread on a discriminated union — the structural identity
 * of each arm is preserved at runtime, but the resulting object's
 * static type widens to `Record<string, unknown>` after the spread.
 * The cast funnels back through `Column`, which is exactly the shape
 * the spread produces (every arm of `Column` carries `uuid` plus the
 * arm's discriminator + per-kind fields, all of which `column` already
 * supplies).
 *
 * Used by `addCaseListColumns` (uuid minted via `newUuid`) and
 * `updateCaseListColumn` (uuid carried through from `columnUuid`).
 */
export function stampColumnUuid(
	column: ColumnInput | ColumnUpdateInput,
	uuid: Uuid,
): Column {
	const { columnUuid: _declaredUuid, ...body } = column as ColumnInput;
	return { ...body, uuid } as Column;
}

/**
 * Stamp the supplied uuid onto a kind-discriminated input search
 * input. Same per-arm-narrowing reasoning as `stampColumnUuid` —
 * spread on a discriminated union widens to `Record<string, unknown>`
 * statically, and the cast funnels back through `SearchInputDef`.
 *
 * Used by `addSearchInputs` (uuid minted via `newUuid`) and
 * `updateSearchInput` (uuid carried through from `searchInputUuid`).
 */
export function stampSearchInputUuid(
	input: SearchInputDefInput | SearchInputUpdateInput,
	uuid: Uuid,
): SearchInputDef {
	const { searchInputUuid: _declaredUuid, ...body } =
		input as SearchInputDefInput;
	return { ...body, uuid } as SearchInputDef;
}

// ── Uuid generation ─────────────────────────────────────────────────

/**
 * Mint a fresh `Uuid` for a freshly-authored column or search input.
 * Wraps `crypto.randomUUID()` so call sites stay typed against the
 * branded `Uuid` shape rather than reaching for `asUuid` inline at
 * every add path.
 */
export function newUuid(): Uuid {
	return asUuid(crypto.randomUUID());
}

// ── Uuid input schema ───────────────────────────────────────────────
//
// Tool-addressing UUIDs deliberately stay plain strings at this wire boundary.
// Tool bodies narrow the parsed value with `asUuid(...)` before handing it to
// the blueprintHelpers atomic builders. Keeping the provider input type
// unbranded also makes that boundary's string-in / branded-domain transition
// explicit even though the shared domain `uuidSchema` is itself now
// transform-free and JSON-Schema-safe.
//
// Used by every atomic-op tool that addresses an existing column /
// search input by uuid (`updateCaseListColumn`, `removeCaseListColumn`,
// `reorderCaseListColumns`, and the search-input parallels).

/**
 * JSON-Schema-safe Uuid wire schema. Accepts a non-empty string at the
 * SA boundary; tool bodies parse through `asUuid` before threading the
 * value into the branded `Uuid`-typed mutation builders.
 */
export const uuidInputSchema = uuidSchema;

/**
 * One field's placement instruction for `setCaseListTile`. `cell` is
 * required-and-nullable: naming a field means deciding where it sits, and
 * `null` is how a field comes off the tile. A field the call does not name
 * keeps the place it already has.
 */
export const tilePlacementInputSchema = z
	.object({
		columnUuid: uuidInputSchema.describe(
			"Uuid of the case-list field to place. Look at getModule's projection or run searchBlueprint to surface the current uuids.",
		),
		cell: tileCellInputSchema
			.nullable()
			.describe(
				"Where this field sits on the grid, or null to take it off the tile entirely (it keeps its place in the case list, it just has no rectangle).",
			),
	})
	.strict();

export type TilePlacementInput = z.infer<typeof tilePlacementInputSchema>;

// ── Uuid-keyed array helpers ────────────────────────────────────────
//
// Pure generic primitives over `{ uuid: Uuid }[]` arrays — the same
// shape every case-list-config slot's op walks (columns, search-inputs,
// any other case-list-shaped array). Reused by the
// `addColumnsMutation` / `addSearchInputsMutation` family in
// `lib/agent/blueprintHelpers.ts` and available to non-SA consumers
// (UI mutations, test fixtures) that operate on the same `{ uuid }[]`
// shape.
//
// Each helper returns a tagged result the caller destructures: success
// → `{ ok: true, items }` carrying the post-mutation array; failure →
// `{ error }` with an Elm-style message naming the missing / unknown
// uuid plus a recovery hint. The agent layer forwards the error string
// verbatim to the SA; the UI layer surfaces its own affordance against
// the same predicate.

/**
 * Tagged result of a uuid-keyed array operation. `ok` carries the
 * post-mutation array as a fresh copy; `error` carries a single
 * human-readable error string the caller forwards.
 */
export type ArrayOpResult<T> = { ok: true; items: T[] } | { error: string };

/**
 * Replace the entry whose `uuid` matches `targetUuid` with `replacement`.
 * Returns a fresh array on success; returns an Elm-style error naming
 * the missing uuid + a recovery hint on failure. `entityLabel` is the
 * human-readable noun the caller wants in error text (e.g. `"case list
 * column"`, `"search input"`).
 */
export function replaceByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	targetUuid: Uuid,
	replacement: T,
	entityLabel: string,
): ArrayOpResult<T> {
	const index = items.findIndex((item) => item.uuid === targetUuid);
	if (index < 0) {
		return {
			error: `Tried to update ${entityLabel} ${targetUuid}. Found no entry with that uuid in the module's case list. Look at getModule's projection or run searchBlueprint to surface the current uuids.`,
		};
	}
	const next = items.slice();
	next[index] = replacement;
	return { ok: true, items: next };
}

/**
 * Drop the entry whose `uuid` matches `targetUuid`. Returns a fresh
 * array on success; returns an Elm-style error naming the missing uuid
 * + a recovery hint on failure.
 */
export function removeByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	targetUuid: Uuid,
	entityLabel: string,
): ArrayOpResult<T> {
	const index = items.findIndex((item) => item.uuid === targetUuid);
	if (index < 0) {
		return {
			error: `Tried to remove ${entityLabel} ${targetUuid}. Found no entry with that uuid in the module's case list. Look at getModule's projection or run searchBlueprint to surface the current uuids.`,
		};
	}
	const next = items.slice();
	next.splice(index, 1);
	return { ok: true, items: next };
}

/**
 * Reorder the array to match `requestedOrder`. The sequence must be a
 * permutation of the current uuids — every existing uuid present, no
 * duplicates, no unknowns. Three failure arms surface predictably so
 * the caller can repair its request:
 *
 *   - Length mismatch (different cardinality) — names expected vs
 *     actual count.
 *   - Duplicate uuid in the request — names the duplicate.
 *   - Unknown uuid (not in the source array) — names the unknown uuid.
 */
export function reorderByUuid<T extends { uuid: Uuid }>(
	items: readonly T[],
	requestedOrder: readonly Uuid[],
	entityLabel: string,
): ArrayOpResult<T> {
	if (requestedOrder.length !== items.length) {
		return {
			error: `Tried to reorder ${entityLabel}s. Found ${items.length} entries on the module but the request supplied ${requestedOrder.length} uuids. Try a uuid array that contains every existing uuid exactly once.`,
		};
	}
	const seen = new Set<Uuid>();
	for (const uuid of requestedOrder) {
		if (seen.has(uuid)) {
			return {
				error: `Tried to reorder ${entityLabel}s. Found duplicate uuid ${uuid} in the requested order. Try a uuid array with each existing uuid listed exactly once.`,
			};
		}
		seen.add(uuid);
	}
	const byUuid = new Map<Uuid, T>();
	for (const item of items) {
		byUuid.set(item.uuid, item);
	}
	const next: T[] = [];
	for (const uuid of requestedOrder) {
		const item = byUuid.get(uuid);
		if (item === undefined) {
			return {
				error: `Tried to reorder ${entityLabel}s. Found unknown uuid ${uuid} in the requested order — that uuid is not present on the module. Look at getModule's projection for the current uuids.`,
			};
		}
		next.push(item);
	}
	return { ok: true, items: next };
}
