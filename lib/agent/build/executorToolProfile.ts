/** Slice-local authorization policy for the private authoring surface.
 *
 * The accepted plan names Blueprint areas, not tools. This is the single
 * exhaustive lowering table from those semantic areas to the read and
 * mutation operations the server admits for that slice. Correction operations
 * live in the same area as creation. The provider-facing tool grammar stays
 * immutable across slices; this profile remains the execution brief and hard
 * dispatch allowlist.
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
	"lookup-references": ["getField"],
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
		"createModule",
		"createForm",
		"updateModule",
		"updateForm",
		"moveModule",
		"removeModule",
		"removeForm",
	],
	"case-list": [
		"createModule",
		"updateModule",
		"configureCaseList",
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

/* Reviewed construction has no Design Contract carrier for a complete
 * CommCare Connect target. Keep the shared operation mounted in the immutable
 * grammar, but do not authorize it from the generic forms area: a future
 * accepted Connect shape must opt its exact target into a slice explicitly. */

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

/** One immutable provider-facing executor grammar. A slice's derived profile
 * remains the server-enforced authorization policy and brief vocabulary; it
 * never changes which operation arms are sent to the model. */
export const STABLE_EXECUTOR_TOOL_PROFILE: ExecutorToolProfile = {
	blueprintAreas: Object.keys(READS_BY_AREA) as BlueprintArea[],
	readTools: Array.from(CHANGE_SET_TOOL_REGISTRY.entries())
		.filter(([, entry]) => entry.policy.effect === "read-blueprint")
		.map(([name]) => name),
	mutationTools: Array.from(CHANGE_SET_TOOL_REGISTRY.entries())
		.filter(([, entry]) => entry.policy.effect === "mutate-blueprint")
		.map(([name]) => name),
};
