/**
 * The complete shared Solutions Architect / MCP tool registry.
 *
 * Tool modules own their schemas and behavior. This manifest owns only the two
 * public names (camelCase for the SA, snake_case for MCP) and the minimum app
 * capability. Identity-schema inventory and parity tests derive from this same
 * array, so adding a shared tool cannot silently omit its UUID-bearing paths.
 */

import { addFieldsTool } from "@/lib/agent/tools/addFields";
import {
	addAutomationsTool,
	getAutomationsTool,
	removeAutomationTool,
	updateAutomationTool,
} from "@/lib/agent/tools/automations";
import { addCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "@/lib/agent/tools/case-list-config/addSearchInputs";
import { configureCaseListTool } from "@/lib/agent/tools/case-list-config/configureCaseList";
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
import { configureConnectTool } from "@/lib/agent/tools/configureConnect";
import { createFormTool } from "@/lib/agent/tools/createForm";
import { createModuleTool } from "@/lib/agent/tools/createModule";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { addFormLinksTool } from "@/lib/agent/tools/form-links/addFormLinks";
import { moveFormLinkTool } from "@/lib/agent/tools/form-links/moveFormLink";
import { removeFormLinkTool } from "@/lib/agent/tools/form-links/removeFormLink";
import { updateFormLinkTool } from "@/lib/agent/tools/form-links/updateFormLink";
import { generateSchemaTool } from "@/lib/agent/tools/generateSchema";
import { getFieldTool } from "@/lib/agent/tools/getField";
import { getFormTool } from "@/lib/agent/tools/getForm";
import { getLookupTablesTool } from "@/lib/agent/tools/getLookupTables";
import { getModuleTool } from "@/lib/agent/tools/getModule";
import {
	addLanguageTool,
	getLanguagesTool,
	getTranslatableContentTool,
	removeLanguageTool,
	updateLanguageTool,
	updateTranslationsTool,
} from "@/lib/agent/tools/localization";
import { attachFieldMediaTool } from "@/lib/agent/tools/media/attachFieldMedia";
import { attachOptionMediaTool } from "@/lib/agent/tools/media/attachOptionMedia";
import { listMediaAssetsTool } from "@/lib/agent/tools/media/listMediaAssets";
import { removeMediaAssetTool } from "@/lib/agent/tools/media/removeMediaAsset";
import { setAppLogoTool } from "@/lib/agent/tools/media/setAppLogo";
import { setMenuMediaTool } from "@/lib/agent/tools/media/setMenuMedia";
import { moveFieldTool } from "@/lib/agent/tools/moveField";
import { moveModuleTool } from "@/lib/agent/tools/moveModule";
import {
	addLocationPropertiesTool,
	addOrganizationLevelsTool,
	createLocationTool,
	getOrganizationTool,
	moveLocationTool,
	removeLocationPropertyTool,
	removeOrganizationLevelTool,
	setLocationArchivedTool,
	updateLocationPropertyTool,
	updateLocationTool,
	updateOrganizationLevelTool,
} from "@/lib/agent/tools/organization";
import { removeFieldTool } from "@/lib/agent/tools/removeField";
import { removeFormTool } from "@/lib/agent/tools/removeForm";
import { removeModuleTool } from "@/lib/agent/tools/removeModule";
import { renameCasePropertiesTool } from "@/lib/agent/tools/renameCaseProperties";
import { searchBlueprintTool } from "@/lib/agent/tools/searchBlueprint";
import { setFieldOptionsSourceTool } from "@/lib/agent/tools/setFieldOptionsSource";
import { setFormSectionsTool } from "@/lib/agent/tools/setFormSections";
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

/**
 * External mutable state a tool's batch or success result depends on. Each
 * entry's policy names its kinds; the organization revision is the one a
 * commit fences (`expectedOrganizationRevision` on the tool's write).
 */
export type ExternalReadSetKind =
	| "organization"
	| "lookup-definition"
	| "lookup-column"
	| "media-asset"
	| "project-scope";

/**
 * Runtime capabilities a tool's execution requires. The policy test keeps
 * every external-WRITE capability off stageable classifications, and the
 * source guards (`lib/agent/__tests__/toolSourceGuards.test.ts`) admit an
 * external-writer import only where a declared capability justifies it.
 */
export type ToolRuntimeCapability =
	| "canonical-blueprint-write"
	| "organization-read"
	| "organization-write"
	| "media-read"
	| "media-write"
	| "lookup-read"
	| "lookup-write"
	| "case-store-migration"
	| "deployment-write";

/**
 * Execution policy for one shared tool — the reviewed classification the
 * policy test (`lib/agent/__tests__/sharedToolRegistryPolicy.test.ts`) pins
 * entry by entry.
 *
 * - `effect` — what the tool changes: nothing (`read-blueprint`), the
 *   Blueprint through the guarded commit (`mutate-blueprint`), external
 *   Project/app rows or object storage (`mutate-external`), or both stores in
 *   one service transaction (`mixed-transaction`).
 * - `staging` — the stageability classification: `allowed` for ordinary
 *   Blueprint work, `exclusive` for the tool whose every batch IS the
 *   batch-exclusive case-store saga, `forbidden` for anything with an
 *   external side effect. A tool whose batches only SOMETIMES compose a
 *   case-store saga (a module removal retiring a case type, a field edit
 *   migrating rows) is `allowed`; the batch-exclusive mutation KINDS
 *   (`renameCaseProperties`, `retireCaseType`) carry that exclusivity.
 * - `readSets` — the external read-set kinds the tool reads (see
 *   {@link ExternalReadSetKind}).
 * - `capabilities` — what the tool's execution requires of its host surface.
 * - `emitsFinalGuidanceFrom` — read sets whose CURRENT state the tool's
 *   success message projects (e.g. automation setup guidance from the
 *   organization), fenced at commit via `expectedOrganizationRevision`.
 */
export interface ToolExecutionPolicy {
	readonly effect:
		| "read-blueprint"
		| "mutate-blueprint"
		| "mutate-external"
		| "mixed-transaction";
	readonly staging: "allowed" | "exclusive" | "forbidden";
	readonly readSets: readonly ExternalReadSetKind[];
	readonly capabilities: readonly ToolRuntimeCapability[];
	readonly emitsFinalGuidanceFrom?: readonly ExternalReadSetKind[];
}

export interface SharedToolRegistryEntry {
	readonly saName: string;
	readonly mcpName: string;
	readonly tool: SharedToolModule;
	readonly requires: AppCapability;
	readonly policy: ToolExecutionPolicy;
}

/** Shorthand policies for the recurring classifications. */
const READ_POLICY: ToolExecutionPolicy = {
	effect: "read-blueprint",
	staging: "allowed",
	readSets: [],
	capabilities: [],
};
const BLUEPRINT_WRITE_POLICY: ToolExecutionPolicy = {
	effect: "mutate-blueprint",
	staging: "allowed",
	readSets: [],
	capabilities: ["canonical-blueprint-write"],
};
/** Blueprint writers whose batch may compose the case-store saga (row
 * migration/parking/retirement) — a module removal or retype retiring a case
 * type, a field edit converting a property's stored rows. */
const BLUEPRINT_WRITE_WITH_MIGRATION_POLICY: ToolExecutionPolicy = {
	effect: "mutate-blueprint",
	staging: "allowed",
	readSets: [],
	capabilities: ["canonical-blueprint-write", "case-store-migration"],
};
const MEDIA_ATTACH_POLICY: ToolExecutionPolicy = {
	effect: "mutate-blueprint",
	staging: "allowed",
	readSets: ["media-asset"],
	capabilities: ["canonical-blueprint-write", "media-read"],
};
const AUTOMATION_WRITE_POLICY: ToolExecutionPolicy = {
	effect: "mutate-blueprint",
	staging: "allowed",
	readSets: ["organization"],
	capabilities: ["canonical-blueprint-write", "organization-read"],
	emitsFinalGuidanceFrom: ["organization"],
};
const PLACE_ROW_WRITE_POLICY: ToolExecutionPolicy = {
	effect: "mutate-external",
	staging: "forbidden",
	readSets: ["organization"],
	capabilities: ["organization-write"],
};

export const SHARED_TOOL_REGISTRY = [
	{
		saName: "getAutomations",
		mcpName: "get_automations",
		tool: getAutomationsTool,
		requires: "view",
		policy: {
			effect: "read-blueprint",
			staging: "allowed",
			readSets: ["organization"],
			capabilities: ["organization-read"],
			emitsFinalGuidanceFrom: ["organization"],
		},
	},
	{
		saName: "addAutomations",
		mcpName: "add_automations",
		tool: addAutomationsTool,
		requires: "edit",
		policy: AUTOMATION_WRITE_POLICY,
	},
	{
		saName: "updateAutomation",
		mcpName: "update_automation",
		tool: updateAutomationTool,
		requires: "edit",
		policy: AUTOMATION_WRITE_POLICY,
	},
	{
		saName: "removeAutomation",
		mcpName: "remove_automation",
		tool: removeAutomationTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "addFields",
		mcpName: "add_fields",
		tool: addFieldsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "getLanguages",
		mcpName: "get_languages",
		tool: getLanguagesTool,
		requires: "view",
		policy: READ_POLICY,
	},
	{
		saName: "getTranslatableContent",
		mcpName: "get_translatable_content",
		tool: getTranslatableContentTool,
		requires: "view",
		policy: READ_POLICY,
	},
	{
		saName: "addLanguage",
		mcpName: "add_language",
		tool: addLanguageTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateLanguage",
		mcpName: "update_language",
		tool: updateLanguageTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeLanguage",
		mcpName: "remove_language",
		tool: removeLanguageTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateTranslations",
		mcpName: "update_translations",
		tool: updateTranslationsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "getLookupTables",
		mcpName: "get_lookup_tables",
		tool: getLookupTablesTool,
		requires: "view",
		policy: {
			effect: "read-blueprint",
			staging: "allowed",
			readSets: ["lookup-definition", "lookup-column"],
			capabilities: ["lookup-read"],
		},
	},
	{
		saName: "setFieldOptionsSource",
		mcpName: "set_field_options_source",
		tool: setFieldOptionsSourceTool,
		requires: "edit",
		policy: {
			effect: "mutate-blueprint",
			staging: "allowed",
			readSets: ["lookup-definition", "lookup-column"],
			capabilities: ["canonical-blueprint-write", "lookup-read"],
		},
	},
	{
		saName: "configureConnect",
		mcpName: "configure_connect",
		tool: configureConnectTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "createForm",
		mcpName: "create_form",
		tool: createFormTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "createModule",
		mcpName: "create_module",
		tool: createModuleTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "editField",
		mcpName: "edit_field",
		tool: editFieldTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_WITH_MIGRATION_POLICY,
	},
	{
		saName: "generateSchema",
		mcpName: "generate_schema",
		tool: generateSchemaTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "getField",
		mcpName: "get_field",
		tool: getFieldTool,
		requires: "view",
		policy: READ_POLICY,
	},
	{
		saName: "getForm",
		mcpName: "get_form",
		tool: getFormTool,
		requires: "view",
		policy: READ_POLICY,
	},
	{
		saName: "getModule",
		mcpName: "get_module",
		tool: getModuleTool,
		requires: "view",
		policy: READ_POLICY,
	},
	{
		saName: "getCaseOperations",
		mcpName: "get_case_operations",
		tool: getCaseOperationsTool,
		requires: "view",
		policy: READ_POLICY,
	},
	{
		saName: "moveField",
		mcpName: "move_field",
		tool: moveFieldTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "setFormSections",
		mcpName: "set_form_sections",
		tool: setFormSectionsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "moveModule",
		mcpName: "move_module",
		tool: moveModuleTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeField",
		mcpName: "remove_field",
		tool: removeFieldTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeForm",
		mcpName: "remove_form",
		tool: removeFormTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeModule",
		mcpName: "remove_module",
		tool: removeModuleTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_WITH_MIGRATION_POLICY,
	},
	{
		saName: "renameCaseProperties",
		mcpName: "rename_case_properties",
		tool: renameCasePropertiesTool,
		requires: "edit",
		policy: {
			effect: "mutate-blueprint",
			staging: "exclusive",
			readSets: [],
			capabilities: ["canonical-blueprint-write", "case-store-migration"],
		},
	},
	{
		saName: "searchBlueprint",
		mcpName: "search_blueprint",
		tool: searchBlueprintTool,
		requires: "view",
		policy: READ_POLICY,
	},
	{
		saName: "addCaseOperations",
		mcpName: "add_case_operations",
		tool: addCaseOperationsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateCaseOperation",
		mcpName: "update_case_operation",
		tool: updateCaseOperationTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeCaseOperation",
		mcpName: "remove_case_operation",
		tool: removeCaseOperationTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "moveCaseOperation",
		mcpName: "move_case_operation",
		tool: moveCaseOperationTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "addFormLinks",
		mcpName: "add_form_links",
		tool: addFormLinksTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateFormLink",
		mcpName: "update_form_link",
		tool: updateFormLinkTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeFormLink",
		mcpName: "remove_form_link",
		tool: removeFormLinkTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "moveFormLink",
		mcpName: "move_form_link",
		tool: moveFormLinkTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "addCaseListColumns",
		mcpName: "add_case_list_columns",
		tool: addCaseListColumnsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "configureCaseList",
		mcpName: "configure_case_list",
		tool: configureCaseListTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "addSearchInputs",
		mcpName: "add_search_inputs",
		tool: addSearchInputsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeCaseListColumn",
		mcpName: "remove_case_list_column",
		tool: removeCaseListColumnTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeSearchInput",
		mcpName: "remove_search_input",
		tool: removeSearchInputTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "reorderCaseListColumns",
		mcpName: "reorder_case_list_columns",
		tool: reorderCaseListColumnsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "reorderSearchInputs",
		mcpName: "reorder_search_inputs",
		tool: reorderSearchInputsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "setCaseListFilter",
		mcpName: "set_case_list_filter",
		tool: setCaseListFilterTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "setCaseListTile",
		mcpName: "set_case_list_tile",
		tool: setCaseListTileTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateCaseListColumn",
		mcpName: "update_case_list_column",
		tool: updateCaseListColumnTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateSearchInput",
		mcpName: "update_search_input",
		tool: updateSearchInputTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "setCaseSearchAdvanced",
		mcpName: "set_case_search_advanced",
		tool: setCaseSearchAdvancedTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "setCaseSearchDisplay",
		mcpName: "set_case_search_display",
		tool: setCaseSearchDisplayTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "attachFieldMedia",
		mcpName: "attach_field_media",
		tool: attachFieldMediaTool,
		requires: "edit",
		policy: MEDIA_ATTACH_POLICY,
	},
	{
		saName: "attachOptionMedia",
		mcpName: "attach_option_media",
		tool: attachOptionMediaTool,
		requires: "edit",
		policy: MEDIA_ATTACH_POLICY,
	},
	{
		saName: "setMenuMedia",
		mcpName: "set_menu_media",
		tool: setMenuMediaTool,
		requires: "edit",
		policy: MEDIA_ATTACH_POLICY,
	},
	{
		saName: "setAppLogo",
		mcpName: "set_app_logo",
		tool: setAppLogoTool,
		requires: "edit",
		policy: MEDIA_ATTACH_POLICY,
	},
	{
		saName: "listMediaAssets",
		mcpName: "list_media_assets",
		tool: listMediaAssetsTool,
		requires: "view",
		policy: {
			effect: "read-blueprint",
			staging: "allowed",
			readSets: ["media-asset"],
			capabilities: ["media-read"],
		},
	},
	{
		saName: "removeMediaAsset",
		mcpName: "remove_media_asset",
		tool: removeMediaAssetTool,
		requires: "edit",
		policy: {
			effect: "mutate-external",
			staging: "forbidden",
			readSets: ["media-asset", "project-scope"],
			capabilities: ["media-write"],
		},
	},
	{
		saName: "getUsers",
		mcpName: "get_users",
		tool: getUsersTool,
		requires: "view",
		policy: READ_POLICY,
	},
	{
		saName: "getOrganization",
		mcpName: "get_organization",
		tool: getOrganizationTool,
		requires: "view",
		policy: {
			effect: "read-blueprint",
			staging: "allowed",
			readSets: ["organization"],
			capabilities: ["organization-read"],
		},
	},
	{
		saName: "addOrganizationLevels",
		mcpName: "add_organization_levels",
		tool: addOrganizationLevelsTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateOrganizationLevel",
		mcpName: "update_organization_level",
		tool: updateOrganizationLevelTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeOrganizationLevel",
		mcpName: "remove_organization_level",
		tool: removeOrganizationLevelTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "addLocationProperties",
		mcpName: "add_location_properties",
		tool: addLocationPropertiesTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateLocationProperty",
		mcpName: "update_location_property",
		tool: updateLocationPropertyTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeLocationProperty",
		mcpName: "remove_location_property",
		tool: removeLocationPropertyTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "createLocation",
		mcpName: "create_location",
		tool: createLocationTool,
		requires: "edit",
		policy: PLACE_ROW_WRITE_POLICY,
	},
	{
		saName: "updateLocation",
		mcpName: "update_location",
		tool: updateLocationTool,
		requires: "edit",
		policy: PLACE_ROW_WRITE_POLICY,
	},
	{
		saName: "moveLocation",
		mcpName: "move_location",
		tool: moveLocationTool,
		requires: "edit",
		policy: PLACE_ROW_WRITE_POLICY,
	},
	{
		saName: "setLocationArchived",
		mcpName: "set_location_archived",
		tool: setLocationArchivedTool,
		requires: "edit",
		policy: {
			effect: "mixed-transaction",
			staging: "forbidden",
			readSets: ["organization"],
			capabilities: ["organization-write", "canonical-blueprint-write"],
		},
	},
	{
		saName: "addUserProperties",
		mcpName: "add_user_properties",
		tool: addUserPropertiesTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateUserProperty",
		mcpName: "update_user_property",
		tool: updateUserPropertyTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeUserProperty",
		mcpName: "remove_user_property",
		tool: removeUserPropertyTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "addUserTypes",
		mcpName: "add_user_types",
		tool: addUserTypesTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateUserType",
		mcpName: "update_user_type",
		tool: updateUserTypeTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removeUserType",
		mcpName: "remove_user_type",
		tool: removeUserTypeTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "addPersonas",
		mcpName: "add_personas",
		tool: addPersonasTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updatePersona",
		mcpName: "update_persona",
		tool: updatePersonaTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "removePersona",
		mcpName: "remove_persona",
		tool: removePersonaTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateApp",
		mcpName: "update_app",
		tool: updateAppTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateForm",
		mcpName: "update_form",
		tool: updateFormTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_POLICY,
	},
	{
		saName: "updateModule",
		mcpName: "update_module",
		tool: updateModuleTool,
		requires: "edit",
		policy: BLUEPRINT_WRITE_WITH_MIGRATION_POLICY,
	},
] as const satisfies readonly SharedToolRegistryEntry[];
