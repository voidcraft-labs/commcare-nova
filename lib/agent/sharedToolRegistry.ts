/**
 * The complete shared Solutions Architect / MCP tool registry.
 *
 * Tool modules own their schemas and behavior. This manifest owns only the two
 * public names (camelCase for the SA, snake_case for MCP) and the minimum app
 * capability. Identity-schema inventory and parity tests derive from this same
 * array, so adding a shared tool cannot silently omit its UUID-bearing paths.
 */

import { addFieldsTool } from "@/lib/agent/tools/addFields";
import { addCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "@/lib/agent/tools/case-list-config/addSearchInputs";
import { removeCaseListColumnTool } from "@/lib/agent/tools/case-list-config/removeCaseListColumn";
import { removeSearchInputTool } from "@/lib/agent/tools/case-list-config/removeSearchInput";
import { reorderCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/reorderCaseListColumns";
import { reorderSearchInputsTool } from "@/lib/agent/tools/case-list-config/reorderSearchInputs";
import { setCaseListFilterTool } from "@/lib/agent/tools/case-list-config/setCaseListFilter";
import { setCaseListTileTool } from "@/lib/agent/tools/case-list-config/setCaseListTile";
import { updateCaseListColumnTool } from "@/lib/agent/tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "@/lib/agent/tools/case-list-config/updateSearchInput";
import { addCaseOperationsTool } from "@/lib/agent/tools/case-operations/addCaseOperations";
import { getCaseOperationsTool } from "@/lib/agent/tools/case-operations/getCaseOperations";
import { moveCaseOperationTool } from "@/lib/agent/tools/case-operations/moveCaseOperation";
import { removeCaseOperationTool } from "@/lib/agent/tools/case-operations/removeCaseOperation";
import { updateCaseOperationTool } from "@/lib/agent/tools/case-operations/updateCaseOperation";
import { setCaseSearchAdvancedTool } from "@/lib/agent/tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "@/lib/agent/tools/case-search-config/setCaseSearchDisplay";
import { createFormTool } from "@/lib/agent/tools/createForm";
import { createModuleTool } from "@/lib/agent/tools/createModule";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { generateSchemaTool } from "@/lib/agent/tools/generateSchema";
import { getFieldTool } from "@/lib/agent/tools/getField";
import { getFormTool } from "@/lib/agent/tools/getForm";
import { getModuleTool } from "@/lib/agent/tools/getModule";
import { attachFieldMediaTool } from "@/lib/agent/tools/media/attachFieldMedia";
import { attachOptionMediaTool } from "@/lib/agent/tools/media/attachOptionMedia";
import { listMediaAssetsTool } from "@/lib/agent/tools/media/listMediaAssets";
import { removeMediaAssetTool } from "@/lib/agent/tools/media/removeMediaAsset";
import { setAppLogoTool } from "@/lib/agent/tools/media/setAppLogo";
import { setMenuMediaTool } from "@/lib/agent/tools/media/setMenuMedia";
import { moveFieldTool } from "@/lib/agent/tools/moveField";
import { removeFieldTool } from "@/lib/agent/tools/removeField";
import { removeFormTool } from "@/lib/agent/tools/removeForm";
import { removeModuleTool } from "@/lib/agent/tools/removeModule";
import { searchBlueprintTool } from "@/lib/agent/tools/searchBlueprint";
import { updateAppTool } from "@/lib/agent/tools/updateApp";
import { updateFormTool } from "@/lib/agent/tools/updateForm";
import { updateModuleTool } from "@/lib/agent/tools/updateModule";
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
} from "@/lib/agent/tools/users";
import type { AppCapability } from "@/lib/auth/projectRoles";
import type { SharedToolModule } from "@/lib/mcp/adapters/sharedToolAdapter";

export interface SharedToolRegistryEntry {
	readonly saName: string;
	readonly mcpName: string;
	readonly tool: SharedToolModule;
	readonly requires: AppCapability;
}

export const SHARED_TOOL_REGISTRY = [
	{
		saName: "addFields",
		mcpName: "add_fields",
		tool: addFieldsTool,
		requires: "edit",
	},
	{
		saName: "createForm",
		mcpName: "create_form",
		tool: createFormTool,
		requires: "edit",
	},
	{
		saName: "createModule",
		mcpName: "create_module",
		tool: createModuleTool,
		requires: "edit",
	},
	{
		saName: "editField",
		mcpName: "edit_field",
		tool: editFieldTool,
		requires: "edit",
	},
	{
		saName: "generateSchema",
		mcpName: "generate_schema",
		tool: generateSchemaTool,
		requires: "edit",
	},
	{
		saName: "getField",
		mcpName: "get_field",
		tool: getFieldTool,
		requires: "view",
	},
	{
		saName: "getForm",
		mcpName: "get_form",
		tool: getFormTool,
		requires: "view",
	},
	{
		saName: "getModule",
		mcpName: "get_module",
		tool: getModuleTool,
		requires: "view",
	},
	{
		saName: "getCaseOperations",
		mcpName: "get_case_operations",
		tool: getCaseOperationsTool,
		requires: "view",
	},
	{
		saName: "moveField",
		mcpName: "move_field",
		tool: moveFieldTool,
		requires: "edit",
	},
	{
		saName: "removeField",
		mcpName: "remove_field",
		tool: removeFieldTool,
		requires: "edit",
	},
	{
		saName: "removeForm",
		mcpName: "remove_form",
		tool: removeFormTool,
		requires: "edit",
	},
	{
		saName: "removeModule",
		mcpName: "remove_module",
		tool: removeModuleTool,
		requires: "edit",
	},
	{
		saName: "searchBlueprint",
		mcpName: "search_blueprint",
		tool: searchBlueprintTool,
		requires: "view",
	},
	{
		saName: "addCaseOperations",
		mcpName: "add_case_operations",
		tool: addCaseOperationsTool,
		requires: "edit",
	},
	{
		saName: "updateCaseOperation",
		mcpName: "update_case_operation",
		tool: updateCaseOperationTool,
		requires: "edit",
	},
	{
		saName: "removeCaseOperation",
		mcpName: "remove_case_operation",
		tool: removeCaseOperationTool,
		requires: "edit",
	},
	{
		saName: "moveCaseOperation",
		mcpName: "move_case_operation",
		tool: moveCaseOperationTool,
		requires: "edit",
	},
	{
		saName: "addCaseListColumns",
		mcpName: "add_case_list_columns",
		tool: addCaseListColumnsTool,
		requires: "edit",
	},
	{
		saName: "addSearchInputs",
		mcpName: "add_search_inputs",
		tool: addSearchInputsTool,
		requires: "edit",
	},
	{
		saName: "removeCaseListColumn",
		mcpName: "remove_case_list_column",
		tool: removeCaseListColumnTool,
		requires: "edit",
	},
	{
		saName: "removeSearchInput",
		mcpName: "remove_search_input",
		tool: removeSearchInputTool,
		requires: "edit",
	},
	{
		saName: "reorderCaseListColumns",
		mcpName: "reorder_case_list_columns",
		tool: reorderCaseListColumnsTool,
		requires: "edit",
	},
	{
		saName: "reorderSearchInputs",
		mcpName: "reorder_search_inputs",
		tool: reorderSearchInputsTool,
		requires: "edit",
	},
	{
		saName: "setCaseListFilter",
		mcpName: "set_case_list_filter",
		tool: setCaseListFilterTool,
		requires: "edit",
	},
	{
		saName: "setCaseListTile",
		mcpName: "set_case_list_tile",
		tool: setCaseListTileTool,
		requires: "edit",
	},
	{
		saName: "updateCaseListColumn",
		mcpName: "update_case_list_column",
		tool: updateCaseListColumnTool,
		requires: "edit",
	},
	{
		saName: "updateSearchInput",
		mcpName: "update_search_input",
		tool: updateSearchInputTool,
		requires: "edit",
	},
	{
		saName: "setCaseSearchAdvanced",
		mcpName: "set_case_search_advanced",
		tool: setCaseSearchAdvancedTool,
		requires: "edit",
	},
	{
		saName: "setCaseSearchDisplay",
		mcpName: "set_case_search_display",
		tool: setCaseSearchDisplayTool,
		requires: "edit",
	},
	{
		saName: "attachFieldMedia",
		mcpName: "attach_field_media",
		tool: attachFieldMediaTool,
		requires: "edit",
	},
	{
		saName: "attachOptionMedia",
		mcpName: "attach_option_media",
		tool: attachOptionMediaTool,
		requires: "edit",
	},
	{
		saName: "setMenuMedia",
		mcpName: "set_menu_media",
		tool: setMenuMediaTool,
		requires: "edit",
	},
	{
		saName: "setAppLogo",
		mcpName: "set_app_logo",
		tool: setAppLogoTool,
		requires: "edit",
	},
	{
		saName: "listMediaAssets",
		mcpName: "list_media_assets",
		tool: listMediaAssetsTool,
		requires: "view",
	},
	{
		saName: "removeMediaAsset",
		mcpName: "remove_media_asset",
		tool: removeMediaAssetTool,
		requires: "edit",
	},
	{
		saName: "getUsers",
		mcpName: "get_users",
		tool: getUsersTool,
		requires: "view",
	},
	{
		saName: "addUserProperties",
		mcpName: "add_user_properties",
		tool: addUserPropertiesTool,
		requires: "edit",
	},
	{
		saName: "updateUserProperty",
		mcpName: "update_user_property",
		tool: updateUserPropertyTool,
		requires: "edit",
	},
	{
		saName: "removeUserProperty",
		mcpName: "remove_user_property",
		tool: removeUserPropertyTool,
		requires: "edit",
	},
	{
		saName: "addUserTypes",
		mcpName: "add_user_types",
		tool: addUserTypesTool,
		requires: "edit",
	},
	{
		saName: "updateUserType",
		mcpName: "update_user_type",
		tool: updateUserTypeTool,
		requires: "edit",
	},
	{
		saName: "removeUserType",
		mcpName: "remove_user_type",
		tool: removeUserTypeTool,
		requires: "edit",
	},
	{
		saName: "addPersonas",
		mcpName: "add_personas",
		tool: addPersonasTool,
		requires: "edit",
	},
	{
		saName: "updatePersona",
		mcpName: "update_persona",
		tool: updatePersonaTool,
		requires: "edit",
	},
	{
		saName: "removePersona",
		mcpName: "remove_persona",
		tool: removePersonaTool,
		requires: "edit",
	},
	{
		saName: "updateApp",
		mcpName: "update_app",
		tool: updateAppTool,
		requires: "edit",
	},
	{
		saName: "updateForm",
		mcpName: "update_form",
		tool: updateFormTool,
		requires: "edit",
	},
	{
		saName: "updateModule",
		mcpName: "update_module",
		tool: updateModuleTool,
		requires: "edit",
	},
] as const satisfies readonly SharedToolRegistryEntry[];
