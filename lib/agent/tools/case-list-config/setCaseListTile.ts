/**
 * SA tool: `setCaseListTile` — lay a module's case list out as a tile, and
 * place its fields on the grid.
 *
 * A case list has two layouts. The ordinary one is a row of columns per case.
 * The other is a TILE: a 12 x 12 grid where each field shown in Results
 * occupies a rectangle, which is what lets a list read like a card — a name
 * across the top, a status in the corner, a date underneath. The layout drives
 * every surface the Results screen drives: the case list, the search-results
 * list, and (when asked) a copy pinned on screen once a case is chosen from
 * the list, above the menu, lists and forms the session goes on to.
 *
 * ONE tool owns both the layout switch and every placement, because the commit
 * gate judges them together:
 *
 *   - While the tile is on, every Results-visible field needs a cell
 *     (`CASE_LIST_TILE_COLUMN_NOT_PLACED`), so turning it on and placing the
 *     fields is a single act — a switch-only call on an unplaced list is
 *     rejected, and a place-one-field-at-a-time sequence never gets there.
 *   - No two cells may cover the same square (`CASE_LIST_TILE_CELLS_OVERLAP`),
 *     so swapping two fields has to land in one batch: either half alone
 *     overlaps.
 *
 * Splitting the switch and the placements into separate tools would make both
 * of those a dead end. There is deliberately no per-cell tool for the same
 * reason, and no preset vocabulary: Nova emits only CommCare's `custom` tile,
 * where every cell carries its own placement, so a preset could only ever be an
 * input shorthand that expands to the same per-field cells — the builder's
 * layout gestures do that expansion, and nothing persists a template name.
 *
 * The slot contract follows the family's law. `tile` omitted keeps the current
 * layout, an object turns the tile on, `null` turns it off — and turning it off
 * KEEPS every placement, so an author who tries a tile and goes back to columns
 * does not lose the layout they drew. Inside `placements`, a field the call
 * does not name keeps its current cell and `cell: null` takes a field off the
 * tile.
 *
 * Both the SA chat factory and the MCP adapter call this through the shared
 * `ToolInvocationContext` interface. Five exit branches:
 *
 *   1. Module UUID address does not resolve → `{ error }`, no mutations.
 *   2. Module has no case list at all → `{ error }`, no mutations. There is
 *      nothing to lay out, and the metadata reducer would no-op silently.
 *   3. The call named neither `tile` nor `placements` → `{ error }`.
 *   4. A placement names an unknown field, or names one field twice →
 *      `{ error }`, no mutations.
 *   5. Success → `{ ok, layout, unplacedColumnUuids }` plus the persisted
 *      mutations, tagged `module:M:caseList:tile`.
 */

import { z } from "zod";
import { retireCaseFormContextTile } from "@/lib/doc/caseFormContextMutations";
import { columnTileMutations } from "@/lib/doc/caseListColumnMutations";
import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type Column, type Uuid } from "@/lib/domain";
import {
	type CaseFormContextChoice,
	caseFormContextChoiceSchema,
	formContextPatch,
	presentFormContext,
} from "@/lib/domain/caseFormContext";
import { tileCellFor } from "@/lib/domain/modules";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "../shared/entityAddresses";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	caseTileLayoutInputSchema,
	tileCellFromInput,
	tilePlacementInputSchema,
} from "./shared";

export const setCaseListTileInputSchema = moduleAddressSchema
	.extend({
		tile: caseTileLayoutInputSchema
			.nullable()
			.optional()
			.describe(
				"The layout itself. An object lays the case list out as a tile — `{}` for a plain tile. null goes back to a row of columns, keeping every placement so the tile can be turned back on later. Leave it out to keep the current layout and only move fields.",
			),
		contextAboveForm: caseFormContextChoiceSchema
			.nullable()
			.optional()
			.describe(
				"What to keep above a form once a case is chosen. Choose a line from that case, this menu’s Results tile, or another menu’s tile for the same case type. A tile can expand its details. A menu tile may carry a fallback line. null clears context.",
			),
		detailPlacements: z
			.array(tilePlacementInputSchema)
			.min(1)
			.nullable()
			.optional()
			.describe(
				"The complete independent Web Apps layout after a case is opened. Give each Details field its columnUuid and cell; null returns to ordinary rows. Android uses ordinary rows in Details.",
			),
		placements: z
			.array(tilePlacementInputSchema)
			.min(1)
			.optional()
			.describe(
				"Where fields sit on the grid. A field this call does not name keeps the place it already has. Every field shown in Results needs a place while the tile is on, so name them all in the same call that turns it on; and name both fields when you swap two, since no two fields may ever share a square.",
			),
	})
	.strict();

export type SetCaseListTileInput = z.infer<typeof setCaseListTileInputSchema>;

/**
 * The case list's layout AFTER the call — the structured outcome the SA reads
 * without parsing prose, mirroring `setCaseListFilter`'s `kind`.
 */
export type CaseListLayout = "tile" | "rows";

/**
 * Success result.
 *
 * `unplacedColumnUuids` names the Results-visible fields that still have no
 * rectangle. On a call that leaves the tile on it is always empty — the gate
 * would have rejected otherwise — so it earns its place on the rows branch,
 * where it is exactly the list of fields to place before the tile can be turned
 * on.
 */
export interface SetCaseListTileSuccess extends MutationSuccess {
	layout: CaseListLayout;
	unplacedColumnUuids: Uuid[];
	persistOnForms: boolean;
	contextAboveForm: CaseFormContextChoice | null;
	grouping?: {
		identifier: string;
		headerRows: number;
		selection: "first-case";
		unlinkedCases: "one-group";
	};
}

export type SetCaseListTileResult = SetCaseListTileSuccess | { error: string };

export const setCaseListTileTool = {
	description:
		"Lay a module's case list out as a tile — a 12x12 grid where each field shown in Results occupies a rectangle — instead of a row of columns, and place its fields on that grid. Pass `tile` to turn the layout on or off (null turns it off and keeps the placements), `placements` to move fields, or both in one call. Every field shown in Results needs a place while the tile is on, and no two fields may share a square, so place the whole layout in one call. `tile.grouping` additionally shows the cases that share a connection together under one heading drawn from the first of them. Pass detailPlacements for the separate Web Apps Details tile. Use contextAboveForm to keep the selected case in view on a form.",
	inputSchema: setCaseListTileInputSchema,
	async execute(
		input: SetCaseListTileInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<SetCaseListTileResult>> {
		const doc = ctx.snapshot.doc;
		const { tile, placements, detailPlacements, contextAboveForm } = input;
		try {
			const address = resolveModuleAddress(doc, input);
			if (!address.ok) return errorResult(address.error);
			const { moduleUuid, module: mod } = address;

			if (
				tile === undefined &&
				placements === undefined &&
				detailPlacements === undefined &&
				contextAboveForm === undefined
			) {
				return errorResult(
					`Tried to lay out the case list on module "${mod.name}" (${moduleUuid}). The call named neither \`tile\` nor \`placements\`, so there was nothing to change. Pass \`tile\` to turn the tile layout on or off, \`placements\` to place fields on the grid, or both together.`,
				);
			}

			const config = mod.caseListConfig;
			if (!config) {
				return errorResult(
					`Tried to lay out the case list on module "${mod.name}" (${moduleUuid}). That module has no case list, so there is nothing to lay out. Give the module a case list first — a module that shows cases is created with one — or lay out a module that already has one.`,
				);
			}

			const columnsByUuid = new Map<Uuid, Column>(
				config.columns.map((column) => [column.uuid, column]),
			);
			const mutations: Mutation[] = [];
			if (detailPlacements !== undefined) {
				const cells: NonNullable<typeof config.detailTile>["cells"] = {};
				for (const placed of detailPlacements ?? []) {
					const uuid = asUuid(placed.columnUuid);
					if (!placed.cell || !columnsByUuid.has(uuid) || cells[uuid])
						return errorResult(
							"Each Details field needs its own placement. Read the menu again to check the fields shown.",
						);
					cells[uuid] = tileCellFromInput(placed.cell);
				}
				mutations.push({
					kind: "setCaseListMeta",
					uuid: moduleUuid,
					patch: { detailTile: detailPlacements === null ? null : { cells } },
				});
			}
			if (tile === null)
				mutations.push(...retireCaseFormContextTile(doc, moduleUuid));
			const named = new Set<Uuid>();
			for (const placement of placements ?? []) {
				const columnUuid = asUuid(placement.columnUuid);
				const current = columnsByUuid.get(columnUuid);
				if (!current) {
					return errorResult(
						`Tried to place field ${columnUuid} on the case tile for module "${mod.name}". Found no field with that uuid in the module's case list. Look at getModule's projection or run searchBlueprint to surface the current uuids.`,
					);
				}
				if (named.has(columnUuid)) {
					return errorResult(
						`Tried to place field ${columnUuid} on the case tile for module "${mod.name}" twice in one call. A field sits in one place, so name each field at most once and give it the rectangle it should end up in.`,
					);
				}
				named.add(columnUuid);
				const cell =
					placement.cell === null
						? undefined
						: tileCellFromInput(placement.cell);
				mutations.push(
					...columnTileMutations(current, { ...current, tile: cell }, mod.uuid),
				);
			}

			if (tile !== undefined && !deepEqual(config.tile, tile ?? undefined)) {
				// The layout rides the granular `setCaseListMeta` kind, so it does
				// not clobber a concurrent column edit on guarded re-apply.
				mutations.push({
					kind: "setCaseListMeta",
					uuid: mod.uuid,
					patch: { tile },
				});
			}

			if (contextAboveForm !== undefined) {
				const nextConfig =
					tile === undefined ? config : { ...config, tile: tile ?? undefined };
				const plan = formContextPatch(nextConfig, contextAboveForm);
				if ("error" in plan && plan.error) return errorResult(plan.error);
				if (plan.patch)
					mutations.push({
						kind: "setCaseListMeta",
						uuid: moduleUuid,
						patch: plan.patch,
					});
			}
			const commit = await guardedMutate(
				ctx,
				mutations,
				`module:${moduleUuid}:caseList:tile`,
			);
			if (!commit.ok) {
				return errorResult(commit.error);
			}

			// Report against the COMMITTED doc, not the tool's own candidate: the
			// guarded writer re-applies onto fresh stored state, so a peer's
			// concurrent column add or layout change is already merged in and is
			// what the SA continues against.
			const committedConfig =
				commit.newDoc.modules[moduleUuid]?.caseListConfig ?? config;
			// Only a field the tile SHOWS needs a place, which is the coverage
			// rule's own scope: a field hidden from Results is no field of the
			// tile, and one that orders the list rides as a sort row for which
			// CommCare appends a zero-width carrier that renders nothing, so
			// ordering by something a worker can't see keeps working on a tile.
			const unplacedColumnUuids = committedConfig.columns
				.filter(
					(column) =>
						column.visibleInList !== false &&
						(committedConfig.tile
							? !committedConfig.tile.namedSlots &&
								!tileCellFor(column, committedConfig.tile)
							: !column.tile),
				)
				.map((column) => column.uuid);

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					ok: true,
					layout: committedConfig.tile === undefined ? "rows" : "tile",
					unplacedColumnUuids,
					persistOnForms: committedConfig.tile?.persistOnForms === true,
					contextAboveForm: presentFormContext(committedConfig),
					...(committedConfig.tile?.grouping && {
						grouping: {
							...committedConfig.tile.grouping,
							selection: "first-case" as const,
							unlinkedCases: "one-group" as const,
						},
					}),
					summary: {
						location: mod.name,
						...(named.size > 0 && { count: named.size }),
					},
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};

/** No-op failure result — every rejection branch leaves the doc untouched. */
function errorResult(error: string): MutatingToolResult<SetCaseListTileResult> {
	return {
		kind: "mutate" as const,
		mutations: [],
		result: { error },
	};
}
