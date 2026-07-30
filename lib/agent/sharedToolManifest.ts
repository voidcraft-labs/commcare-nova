/**
 * One inventory for every tool shared by the chat Solutions Architect and MCP.
 *
 * The tool module owns its schema, description, and execution. This manifest
 * owns only the cross-surface facts: the camelCase chat name, snake_case MCP
 * name, envelope kind, and minimum Project capability. MCP registration, the
 * chat agent, schema-governance tests, and the paid provider-schema probe all
 * consume this array, so adding a shared tool cannot silently omit one surface.
 *
 * `askQuestions` is chat-only and remains beside the chat agent. MCP-only
 * account/app/upload tools remain in `lib/mcp/tools`; they do not execute
 * against the shared `(ToolExecutionContext, BlueprintDoc)` contract.
 */

import type { z } from "zod";
import type { AppCapability } from "@/lib/auth/projectRoles";
import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "./toolExecutionContext";
import { addFieldsTool } from "./tools/addFields";
import { addCaseListColumnsTool } from "./tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "./tools/case-list-config/addSearchInputs";
import { removeCaseListColumnTool } from "./tools/case-list-config/removeCaseListColumn";
import { removeSearchInputTool } from "./tools/case-list-config/removeSearchInput";
import { reorderCaseListColumnsTool } from "./tools/case-list-config/reorderCaseListColumns";
import { reorderSearchInputsTool } from "./tools/case-list-config/reorderSearchInputs";
import { setCaseListFilterTool } from "./tools/case-list-config/setCaseListFilter";
import { setCaseListTileTool } from "./tools/case-list-config/setCaseListTile";
import { updateCaseListColumnTool } from "./tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "./tools/case-list-config/updateSearchInput";
import { addCaseOperationsTool } from "./tools/case-operations/addCaseOperations";
import { getCaseOperationsTool } from "./tools/case-operations/getCaseOperations";
import { moveCaseOperationTool } from "./tools/case-operations/moveCaseOperation";
import { removeCaseOperationTool } from "./tools/case-operations/removeCaseOperation";
import { updateCaseOperationTool } from "./tools/case-operations/updateCaseOperation";
import { setCaseSearchAdvancedTool } from "./tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "./tools/case-search-config/setCaseSearchDisplay";
import type { MutatingToolResult, ReadToolResult } from "./tools/common";
import { createFormTool } from "./tools/createForm";
import { createModuleTool } from "./tools/createModule";
import { editFieldTool } from "./tools/editField";
import { generateSchemaTool } from "./tools/generateSchema";
import { getFieldTool } from "./tools/getField";
import { getFormTool } from "./tools/getForm";
import { getLookupTablesTool } from "./tools/getLookupTables";
import { getModuleTool } from "./tools/getModule";
import { attachFieldMediaTool } from "./tools/media/attachFieldMedia";
import { attachOptionMediaTool } from "./tools/media/attachOptionMedia";
import { listMediaAssetsTool } from "./tools/media/listMediaAssets";
import { removeMediaAssetTool } from "./tools/media/removeMediaAsset";
import { setAppLogoTool } from "./tools/media/setAppLogo";
import { setMenuMediaTool } from "./tools/media/setMenuMedia";
import { moveFieldTool } from "./tools/moveField";
import { removeFieldTool } from "./tools/removeField";
import { removeFormTool } from "./tools/removeForm";
import { removeModuleTool } from "./tools/removeModule";
import { searchBlueprintTool } from "./tools/searchBlueprint";
import { setFieldOptionsSourceTool } from "./tools/setFieldOptionsSource";
import { updateAppTool } from "./tools/updateApp";
import { updateFormTool } from "./tools/updateForm";
import { updateModuleTool } from "./tools/updateModule";
import {
	addPersonasTool,
	addUserPropertiesTool,
	addUserTypesTool,
	getUsersTool,
	removePersonaTool,
	removeUserPropertyTool,
	removeUserTypeTool,
	updatePersonaTool,
	updateUserPropertyTool,
	updateUserTypeTool,
} from "./tools/users";

interface SharedToolModuleBase {
	readonly description: string;
	readonly inputSchema: z.ZodObject<z.ZodRawShape>;
}

export interface SharedReadToolModule extends SharedToolModuleBase {
	execute(
		input: unknown,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<ReadToolResult<unknown>>;
}

export interface SharedMutatingToolModule extends SharedToolModuleBase {
	execute(
		input: unknown,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<unknown>>;
}

export type SharedToolModule = SharedReadToolModule | SharedMutatingToolModule;

interface SharedToolManifestEntryBase {
	/** Camel-case name registered on the chat Solutions Architect. */
	readonly chatName: string;
	/** Snake-case name registered on the MCP server. */
	readonly mcpName: string;
	/** Minimum app capability the caller's Project role must grant. */
	readonly requires: AppCapability;
}

export type SharedToolManifestEntry =
	| (SharedToolManifestEntryBase & {
			readonly kind: "read";
			readonly tool: SharedReadToolModule;
	  })
	| (SharedToolManifestEntryBase & {
			readonly kind: "mutate";
			readonly tool: SharedMutatingToolModule;
	  });

const read = (
	chatName: string,
	mcpName: string,
	tool: SharedReadToolModule,
	requires: AppCapability = "view",
): SharedToolManifestEntry => ({
	chatName,
	mcpName,
	kind: "read",
	requires,
	tool,
});

const mutate = (
	chatName: string,
	mcpName: string,
	tool: SharedMutatingToolModule,
): SharedToolManifestEntry => ({
	chatName,
	mcpName,
	kind: "mutate",
	requires: "edit",
	tool,
});

export const SHARED_TOOL_MANIFEST = [
	mutate("addFields", "add_fields", addFieldsTool),
	mutate("createForm", "create_form", createFormTool),
	mutate("createModule", "create_module", createModuleTool),
	mutate("editField", "edit_field", editFieldTool),
	mutate("generateSchema", "generate_schema", generateSchemaTool),
	read("getField", "get_field", getFieldTool),
	read("getForm", "get_form", getFormTool),
	read("getLookupTables", "get_lookup_tables", getLookupTablesTool),
	read("getModule", "get_module", getModuleTool),
	read("getCaseOperations", "get_case_operations", getCaseOperationsTool),
	mutate("moveField", "move_field", moveFieldTool),
	mutate(
		"setFieldOptionsSource",
		"set_field_options_source",
		setFieldOptionsSourceTool,
	),
	mutate("removeField", "remove_field", removeFieldTool),
	mutate("removeForm", "remove_form", removeFormTool),
	mutate("removeModule", "remove_module", removeModuleTool),
	read("searchBlueprint", "search_blueprint", searchBlueprintTool),
	mutate("addCaseOperations", "add_case_operations", addCaseOperationsTool),
	mutate(
		"updateCaseOperation",
		"update_case_operation",
		updateCaseOperationTool,
	),
	mutate(
		"removeCaseOperation",
		"remove_case_operation",
		removeCaseOperationTool,
	),
	mutate("moveCaseOperation", "move_case_operation", moveCaseOperationTool),
	mutate("addCaseListColumns", "add_case_list_columns", addCaseListColumnsTool),
	mutate("addSearchInputs", "add_search_inputs", addSearchInputsTool),
	mutate(
		"removeCaseListColumn",
		"remove_case_list_column",
		removeCaseListColumnTool,
	),
	mutate("removeSearchInput", "remove_search_input", removeSearchInputTool),
	mutate(
		"reorderCaseListColumns",
		"reorder_case_list_columns",
		reorderCaseListColumnsTool,
	),
	mutate(
		"reorderSearchInputs",
		"reorder_search_inputs",
		reorderSearchInputsTool,
	),
	mutate("setCaseListFilter", "set_case_list_filter", setCaseListFilterTool),
	mutate("setCaseListTile", "set_case_list_tile", setCaseListTileTool),
	mutate(
		"updateCaseListColumn",
		"update_case_list_column",
		updateCaseListColumnTool,
	),
	mutate("updateSearchInput", "update_search_input", updateSearchInputTool),
	mutate(
		"setCaseSearchAdvanced",
		"set_case_search_advanced",
		setCaseSearchAdvancedTool,
	),
	mutate(
		"setCaseSearchDisplay",
		"set_case_search_display",
		setCaseSearchDisplayTool,
	),
	mutate("attachFieldMedia", "attach_field_media", attachFieldMediaTool),
	mutate("attachOptionMedia", "attach_option_media", attachOptionMediaTool),
	mutate("setMenuMedia", "set_menu_media", setMenuMediaTool),
	mutate("setAppLogo", "set_app_logo", setAppLogoTool),
	read("listMediaAssets", "list_media_assets", listMediaAssetsTool),
	// This tool uses the read envelope because it does not mutate BlueprintDoc,
	// though its Project-media deletion is externally fenced as an edit.
	read("removeMediaAsset", "remove_media_asset", removeMediaAssetTool, "edit"),
	read("getUsers", "get_users", getUsersTool),
	mutate("addUserProperties", "add_user_properties", addUserPropertiesTool),
	mutate("updateUserProperty", "update_user_property", updateUserPropertyTool),
	mutate("removeUserProperty", "remove_user_property", removeUserPropertyTool),
	mutate("addUserTypes", "add_user_types", addUserTypesTool),
	mutate("updateUserType", "update_user_type", updateUserTypeTool),
	mutate("removeUserType", "remove_user_type", removeUserTypeTool),
	mutate("addPersonas", "add_personas", addPersonasTool),
	mutate("updatePersona", "update_persona", updatePersonaTool),
	mutate("removePersona", "remove_persona", removePersonaTool),
	mutate("updateApp", "update_app", updateAppTool),
	mutate("updateForm", "update_form", updateFormTool),
	mutate("updateModule", "update_module", updateModuleTool),
] as const satisfies readonly SharedToolManifestEntry[];
