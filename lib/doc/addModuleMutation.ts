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
import type { CaseListConfig, Column, Module, Uuid } from "@/lib/domain";

type AddModuleMutation = Extract<Mutation, { kind: "addModule" }>;
type UpdateModuleMutation = Extract<Mutation, { kind: "updateModule" }>;

function columnTileCells(
	columns: readonly Column[],
): NonNullable<AddModuleMutation["columnTileCells"]> {
	return columns.flatMap((column) =>
		column.tile === undefined ? [] : [{ uuid: column.uuid, tile: column.tile }],
	);
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
	const tileCells = columnTileCells(config.columns);
	return {
		kind: "updateModule",
		uuid,
		patch: {
			...patch,
			caseListConfig: legacyCompatibleCaseListConfig(config),
		},
		...(tileCells.length > 0 && { columnTileCells: tileCells }),
		...(config.tile !== undefined && { caseListTile: config.tile }),
	};
}

export function addModuleMutation(
	module: Module,
	after?: Uuid | null,
): AddModuleMutation {
	const columns = module.caseListConfig?.columns ?? [];
	const tileCells = columnTileCells(columns);
	const caseListTile = module.caseListConfig?.tile;

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
		...(after !== undefined && { after }),
		...(tileCells.length > 0 && { columnTileCells: tileCells }),
		...(caseListTile !== undefined && { caseListTile }),
		...(desiredOwnerOnly !== undefined && {
			caseSearchConfigValue: desiredOwnerOnly,
		}),
	};
}
