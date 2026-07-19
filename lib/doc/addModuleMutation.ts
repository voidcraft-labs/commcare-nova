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

function legacyCompatibleCaseListConfig(
	config: CaseListConfig,
): CaseListConfig {
	return {
		...config,
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
	return {
		kind: "updateModule",
		uuid,
		patch: {
			...patch,
			caseListConfig: legacyCompatibleCaseListConfig(config),
		},
		...(surfaceOrders.length > 0 && { columnSurfaceOrders: surfaceOrders }),
	};
}

export function addModuleMutation(
	module: Module,
	index?: number,
): AddModuleMutation {
	const columns = module.caseListConfig?.columns ?? [];
	const surfaceOrders = columnSurfaceOrders(columns);

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
		...(desiredOwnerOnly !== undefined && {
			caseSearchConfigValue: desiredOwnerOnly,
		}),
	};
}
