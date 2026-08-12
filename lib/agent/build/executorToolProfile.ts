/** Slice-local projection of the private authoring surface.
 *
 * The accepted plan names Blueprint areas, not tools. This is the single
 * exhaustive lowering table from those semantic areas to the read and
 * mutation operations the executor may see. Correction operations live in
 * the same area as creation, so a slice can repair its own work without
 * receiving unrelated lookup, media, organization, or automation families.
 */

import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import type { BlueprintArea, BuildSlice } from "@/lib/agent/design/buildPlan";

export interface ExecutorToolProfile {
	readonly blueprintAreas: readonly BlueprintArea[];
	readonly readTools: readonly string[];
	readonly mutationTools: readonly string[];
}

const READS_BY_AREA = {
	app: ["searchBlueprint"],
	"case-catalog": ["searchBlueprint"],
	users: ["getUsers"],
	"organization-shape": ["getOrganization"],
	navigation: ["getModule", "getForm", "searchBlueprint"],
	"case-list": ["getModule", "searchBlueprint"],
	forms: ["getModule", "getForm", "getField", "searchBlueprint"],
	"case-operations": ["getForm", "getCaseOperations"],
	"lookup-references": ["getLookupTables", "getField"],
	"media-references": ["listMediaAssets", "getField", "getForm", "getModule"],
	automations: ["getAutomations", "getOrganization"],
} as const satisfies Readonly<Record<BlueprintArea, readonly string[]>>;

const MUTATIONS_BY_AREA = {
	app: ["updateApp"],
	"case-catalog": ["generateSchema", "renameCaseProperties"],
	users: [
		"addUserProperties",
		"updateUserProperty",
		"removeUserProperty",
		"addUserTypes",
		"updateUserType",
		"removeUserType",
		"addPersonas",
		"updatePersona",
		"removePersona",
	],
	"organization-shape": [
		"addOrganizationLevels",
		"updateOrganizationLevel",
		"removeOrganizationLevel",
		"addLocationProperties",
		"updateLocationProperty",
		"removeLocationProperty",
	],
	navigation: [
		"stageModule",
		"stageForm",
		"createModule",
		"createForm",
		"updateModule",
		"updateForm",
		"moveModule",
		"removeModule",
		"removeForm",
	],
	"case-list": [
		"stageModule",
		"createModule",
		"updateModule",
		"addCaseListColumns",
		"addSearchInputs",
		"removeCaseListColumn",
		"removeSearchInput",
		"reorderCaseListColumns",
		"reorderSearchInputs",
		"setCaseListFilter",
		"setCaseListTile",
		"updateCaseListColumn",
		"updateSearchInput",
		"setCaseSearchAdvanced",
		"setCaseSearchDisplay",
	],
	forms: [
		"stageModule",
		"stageForm",
		"createModule",
		"createForm",
		"updateModule",
		"updateForm",
		"addFields",
		"editField",
		"moveField",
		"moveModule",
		"removeField",
		"removeForm",
		"removeModule",
		"configureConnect",
	],
	"case-operations": [
		"addCaseOperations",
		"updateCaseOperation",
		"removeCaseOperation",
		"moveCaseOperation",
	],
	"lookup-references": ["setFieldOptionsSource"],
	"media-references": [
		"attachFieldMedia",
		"attachOptionMedia",
		"setMenuMedia",
		"setAppLogo",
	],
	automations: ["addAutomations", "updateAutomation", "removeAutomation"],
} as const satisfies Readonly<Record<BlueprintArea, readonly string[]>>;

function uniqueInRegistryOrder(names: ReadonlySet<string>): string[] {
	return Array.from(CHANGE_SET_TOOL_REGISTRY.keys()).filter((name) =>
		names.has(name),
	);
}

export function deriveExecutorToolProfile(
	slice: Pick<BuildSlice, "constructionGroups">,
): ExecutorToolProfile {
	const areas = new Set<BlueprintArea>();
	for (const group of slice.constructionGroups) {
		for (const area of group.blueprintAreas) areas.add(area);
	}
	const reads = new Set<string>();
	const mutations = new Set<string>();
	for (const area of areas) {
		for (const name of READS_BY_AREA[area]) {
			if (!CHANGE_SET_TOOL_REGISTRY.has(name))
				throw new Error(
					`Executor tool profile references unknown tool ${name}.`,
				);
			reads.add(name);
		}
		for (const name of MUTATIONS_BY_AREA[area]) {
			if (!CHANGE_SET_TOOL_REGISTRY.has(name))
				throw new Error(
					`Executor tool profile references unknown tool ${name}.`,
				);
			mutations.add(name);
		}
	}
	const readTools = uniqueInRegistryOrder(reads);
	const mutationTools = uniqueInRegistryOrder(mutations);
	return {
		blueprintAreas: [...areas],
		readTools,
		mutationTools,
	};
}
