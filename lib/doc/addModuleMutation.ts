/**
 * Rolling-deploy-safe `addModule` construction.
 *
 * Origin/main parses the established discriminator with strict nested module,
 * case-list-column, and Search schemas. Current-only nested slots therefore
 * travel in optional top-level extensions that an old parser can strip whole;
 * the nested module remains a valid, behavior-safe fallback for its reducer.
 */

import { legacyCompatibleColumnSnapshot } from "@/lib/doc/caseListColumnMutations";
import { legacyCompatibleCaseSearchConfig } from "@/lib/doc/caseSearchConfigMutations";
import type { Mutation } from "@/lib/doc/types";
import type {
	CaseListConfig,
	CaseTileGrouping,
	CaseTileLayout,
	CaseTileLayoutPatch,
	Column,
	Module,
	Uuid,
} from "@/lib/domain";

type AddModuleMutation = Extract<Mutation, { kind: "addModule" }>;
type UpdateModuleMutation = Extract<Mutation, { kind: "updateModule" }>;

function columnSurfaceOrders(
	columns: readonly Column[],
): NonNullable<AddModuleMutation["columnSurfaceOrders"]> {
	return columns.flatMap((column) => {
		if (column.listOrder === undefined && column.detailOrder === undefined) {
			return [];
		}
		return [
			{
				uuid: column.uuid,
				...(column.listOrder !== undefined && {
					listOrder: column.listOrder,
				}),
				...(column.detailOrder !== undefined && {
					detailOrder: column.detailOrder,
				}),
			},
		];
	});
}

function columnTileCells(
	columns: readonly Column[],
): NonNullable<AddModuleMutation["columnTileCells"]> {
	return columns.flatMap((column) =>
		column.tile === undefined ? [] : [{ uuid: column.uuid, tile: column.tile }],
	);
}

/**
 * Split a tile layout into the two top-level slots a wholesale module write
 * carries.
 *
 * `caseListTile` is grouping-free because a pre-grouping receiver parses it
 * with a `.strict()` layout schema; grouping travels beside it in
 * `caseListTileGrouping`. Both are top-level extensions, so an older parser
 * strips whichever it does not know and applies a row-layout case list.
 */
function tileHydration(tile: CaseTileLayout | undefined): {
	caseListTile?: CaseTileLayoutPatch;
	caseListTileGrouping?: CaseTileGrouping;
} {
	if (tile === undefined) return {};
	const { grouping, ...layout } = tile;
	return {
		caseListTile: layout,
		...(grouping === undefined ? {} : { caseListTileGrouping: grouping }),
	};
}

function legacyCompatibleCaseListConfig(
	config: CaseListConfig,
): CaseListConfig {
	const { tile: _tile, ...withoutTile } = config;
	return {
		...withoutTile,
		columns: config.columns.map(legacyCompatibleColumnSnapshot),
	};
}

/** Encode a generic module patch whose case-list config may carry new keys. */
export function updateModuleMutation(
	uuid: Uuid,
	patch: UpdateModuleMutation["patch"],
): UpdateModuleMutation {
	const config = patch.caseListConfig;
	if (config === null || config === undefined) {
		return { kind: "updateModule", uuid, patch };
	}
	const surfaceOrders = columnSurfaceOrders(config.columns);
	const tileCells = columnTileCells(config.columns);
	return {
		kind: "updateModule",
		uuid,
		patch: {
			...patch,
			caseListConfig: legacyCompatibleCaseListConfig(config),
		},
		...(surfaceOrders.length > 0 && { columnSurfaceOrders: surfaceOrders }),
		...(tileCells.length > 0 && { columnTileCells: tileCells }),
		...tileHydration(config.tile),
	};
}

export function addModuleMutation(
	module: Module,
	index?: number,
): AddModuleMutation {
	const columns = module.caseListConfig?.columns ?? [];
	const surfaceOrders = columnSurfaceOrders(columns);
	const tileCells = columnTileCells(columns);
	const tileSlots = tileHydration(module.caseListConfig?.tile);

	const desiredOwnerOnly =
		module.caseSearchConfig?.searchActionEnabled === false
			? module.caseSearchConfig
			: undefined;
	const fallbackModule: Module = {
		...module,
		...(module.caseListConfig !== undefined && {
			caseListConfig: legacyCompatibleCaseListConfig(module.caseListConfig),
		}),
		...(desiredOwnerOnly !== undefined && {
			caseSearchConfig: legacyCompatibleCaseSearchConfig(desiredOwnerOnly),
		}),
	};

	return {
		kind: "addModule",
		module: fallbackModule,
		...(index !== undefined && { index }),
		...(surfaceOrders.length > 0 && { columnSurfaceOrders: surfaceOrders }),
		...(tileCells.length > 0 && { columnTileCells: tileCells }),
		...tileSlots,
		...(desiredOwnerOnly !== undefined && {
			caseSearchConfigValue: desiredOwnerOnly,
		}),
	};
}
