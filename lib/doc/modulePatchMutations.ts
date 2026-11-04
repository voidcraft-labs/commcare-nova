/** Shared generic module-patch planner for builder and SA/MCP surfaces. */

import { updateModuleMutation } from "@/lib/doc/addModuleMutation";
import { deepEqual } from "@/lib/doc/deepEqual";
import { diffModuleConfigMutations } from "@/lib/doc/diffDocsToMutations";
import type { Mutation } from "@/lib/doc/types";
import type { Module } from "@/lib/domain";

export type ModuleAuthoringPatch = Omit<
	Partial<Omit<Module, "uuid">>,
	| "id"
	| "parentModuleUuid"
	| "icon"
	| "audioLabel"
	| "caseListConfig"
	| "caseSearchConfig"
	| "caseListMenuItem"
> & {
	caseListConfig?: Module["caseListConfig"] | null;
	caseSearchConfig?: Module["caseSearchConfig"] | null;
	/** The whole case list menu entry, or `null` / `undefined` to take it off;
	 * committed as one `setCaseListMenuItem` where it differs. */
	caseListMenuItem?: Module["caseListMenuItem"] | null;
};

/**
 * Split a generic module edit into its metadata patch, the case list menu
 * entry's own kind, and a direct Search teardown operation. Whole Search
 * snapshots are not part of the final module patch schema; setting edits use
 * the dedicated per-setting planners.
 */
export function modulePatchMutations(
	mod: Module,
	patch: ModuleAuthoringPatch,
	_options: { readonly nullCaseSearchConfig?: "replace" | "settings" } = {},
): Mutation[] {
	const {
		name,
		caseListConfig: _caseListConfig,
		caseSearchConfig: _caseSearchConfig,
		caseListMenuItem,
		...metadata
	} = patch;
	const mutations: Mutation[] = [];
	if (name !== undefined && name !== mod.name) {
		mutations.push({ kind: "renameModule", uuid: mod.uuid, newId: name });
	}
	const finalPatch: Extract<Mutation, { kind: "updateModule" }>["patch"] = {};
	for (const [key, value] of Object.entries(metadata)) {
		(finalPatch as Record<string, unknown>)[key] = value ?? null;
	}
	if (Object.keys(finalPatch).length > 0) {
		mutations.push(updateModuleMutation(mod.uuid, finalPatch));
	}
	if (
		Object.hasOwn(patch, "caseListMenuItem") &&
		!deepEqual(caseListMenuItem ?? undefined, mod.caseListMenuItem)
	) {
		mutations.push({
			kind: "setCaseListMenuItem",
			uuid: mod.uuid,
			item: caseListMenuItem == null ? null : structuredClone(caseListMenuItem),
		});
	}

	const changesCaseList = Object.hasOwn(patch, "caseListConfig");
	const changesCaseSearch = Object.hasOwn(patch, "caseSearchConfig");
	if (changesCaseList || changesCaseSearch) {
		const next = structuredClone(mod);
		if (changesCaseList) {
			if (patch.caseListConfig == null) delete next.caseListConfig;
			else next.caseListConfig = structuredClone(patch.caseListConfig);
		}
		if (changesCaseSearch) {
			if (patch.caseSearchConfig == null) delete next.caseSearchConfig;
			else next.caseSearchConfig = structuredClone(patch.caseSearchConfig);
		}
		mutations.push(...diffModuleConfigMutations(mod, next));
	}
	return mutations;
}
