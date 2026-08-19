/**
 * SA tool: `setCaseListTile` — lay a module's case list out as a tile, and
 * place its fields on the grid.
 *
 * A case list has two layouts. The ordinary one is a row of columns per case.
 * The other is a TILE: a 12 x 12 grid where each field shown in Results
 * occupies a rectangle, which is what lets a list read like a card — a name
 * across the top, a status in the corner, a date underneath. The layout drives
 * every surface the Results screen drives: the case list, the search-results
 * list, and (when asked) a copy pinned above every form in the module.
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
 *   5. Success → `{ message, layout, unplacedColumnUuids }` plus the persisted
 *      mutations, tagged `module:M:caseList:tile`.
 */

import { z } from "zod";
import { columnTileMutations } from "@/lib/doc/caseListColumnMutations";
import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type CaseTileLayout,
	type Column,
	type Uuid,
} from "@/lib/domain";
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
import { caseTileLayoutInputSchema, tilePlacementInputSchema } from "./shared";

export const setCaseListTileInputSchema = moduleAddressSchema
	.extend({
		tile: caseTileLayoutInputSchema
			.nullable()
			.optional()
			.describe(
				"The layout itself. An object lays the case list out as a tile — `{}` for a plain tile. null goes back to a row of columns, keeping every placement so the tile can be turned back on later. Leave it out to keep the current layout and only move fields.",
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
}

export type SetCaseListTileResult = SetCaseListTileSuccess | { error: string };

export const setCaseListTileTool = {
	description:
		"Lay a module's case list out as a tile — a 12x12 grid where each field shown in Results occupies a rectangle — instead of a row of columns, and place its fields on that grid. Pass `tile` to turn the layout on or off (null turns it off and keeps the placements), `placements` to move fields, or both in one call. Every field shown in Results needs a place while the tile is on, and no two fields may share a square, so place the whole layout in one call. `tile.grouping` additionally shows the cases that share a connection together under one heading drawn from the first of them.",
	inputSchema: setCaseListTileInputSchema,
	async execute(
		input: SetCaseListTileInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<SetCaseListTileResult>> {
		const doc = ctx.snapshot.doc;
		const { tile, placements } = input;
		try {
			const address = resolveModuleAddress(doc, input);
			if (!address.ok) return errorResult(address.error);
			const { moduleUuid, module: mod } = address;

			if (tile === undefined && placements === undefined) {
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
				const cell = placement.cell ?? undefined;
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
			// rule's own scope: a field hidden from Results emits as the zero-width
			// sort carrier and renders nothing, so ordering by something a worker
			// can't see keeps working on a tile.
			const unplacedColumnUuids = committedConfig.columns
				.filter(
					(column) =>
						column.tile === undefined && column.visibleInList !== false,
				)
				.map((column) => column.uuid);

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: describeOutcome({
						moduleName: mod.name,
						moduleUuid,
						tile,
						nextLayout: committedConfig.tile,
						placementCount: named.size,
						unplacedColumnUuids,
					}),
					layout: committedConfig.tile === undefined ? "rows" : "tile",
					unplacedColumnUuids,
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

/**
 * Compose the prose the model reads: what the layout is now, how many fields
 * moved, and — while the list is on rows — which fields would need a place
 * before the tile could be turned on.
 *
 * `tile` is what the CALL asked for (so the prose names the act); `nextLayout`
 * is what the committed doc holds (so the prose never claims a state a peer's
 * concurrent edit changed).
 */
function describeOutcome(facts: {
	moduleName: string;
	moduleUuid: Uuid;
	tile: CaseTileLayout | null | undefined;
	nextLayout: CaseTileLayout | undefined;
	placementCount: number;
	unplacedColumnUuids: readonly Uuid[];
}): string {
	const where = `module "${facts.moduleName}" (${facts.moduleUuid})`;
	const parts: string[] = [];
	if (facts.tile === null) {
		parts.push(
			`Turned the case tile off on ${where}; the case list is a row of columns again. Every field kept its place on the grid, so turning the tile back on restores this layout.`,
		);
	} else if (facts.tile !== undefined) {
		parts.push(
			facts.tile.persistOnForms === true
				? `Laid the case list on ${where} out as a tile, kept on screen above every form in the module.`
				: `Laid the case list on ${where} out as a tile.`,
		);
		const grouping = facts.tile.grouping;
		if (grouping !== undefined) {
			// The two consequences a model cannot see from the layout, said on
			// the read surface as well as in the schema: the SA reports back to
			// the user from this text.
			parts.push(
				`Cases sharing a \`${grouping.identifier}\` connection are shown together, with the top ${grouping.headerRows === 1 ? "row" : `${grouping.headerRows} rows`} drawn once per group from the group's first case. Choosing a group opens that first case, and every case with no \`${grouping.identifier}\` connection is shown together in one group.`,
			);
		}
	}
	if (facts.placementCount > 0) {
		parts.push(
			`Placed ${facts.placementCount} field${facts.placementCount === 1 ? "" : "s"}${parts.length > 0 ? "" : ` on the case tile for ${where}`}.`,
		);
	}
	if (facts.nextLayout === undefined && facts.unplacedColumnUuids.length > 0) {
		parts.push(
			`${facts.unplacedColumnUuids.length} field${facts.unplacedColumnUuids.length === 1 ? " shown in Results still has" : "s shown in Results still have"} no place on the grid: ${facts.unplacedColumnUuids.join(", ")}. Place ${facts.unplacedColumnUuids.length === 1 ? "it" : "them"} in the same call that turns the tile on.`,
		);
	}
	return parts.join(" ");
}
