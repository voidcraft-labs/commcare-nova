import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "@/lib/agent/tools/case-list-config/addSearchInputs";
import { setCaseListFilterTool } from "@/lib/agent/tools/case-list-config/setCaseListFilter";
import { updateCaseListColumnTool } from "@/lib/agent/tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "@/lib/agent/tools/case-list-config/updateSearchInput";
import { setCaseSearchAdvancedTool } from "@/lib/agent/tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "@/lib/agent/tools/case-search-config/setCaseSearchDisplay";
import { createModuleTool } from "@/lib/agent/tools/createModule";
import { updateModuleTool } from "@/lib/agent/tools/updateModule";
import {
	registerSharedTool,
	type SharedToolModule,
} from "../adapters/sharedToolAdapter";
import type { ToolContext } from "../types";

const TABLE_ID = "018f3e8a-7b2c-7def-8abc-1234567890ab";
const COLUMN_ID = "018f3e8a-7b2c-7def-8abc-1234567890ad";

const tableLookupExpression = {
	kind: "table-lookup",
	tableId: TABLE_ID,
	resultColumnId: COLUMN_ID,
	where: { kind: "match-all" },
} as const;

const literalExpression = {
	kind: "term",
	term: { kind: "literal", value: "ordinary" },
} as const;

const lookupPredicate = {
	kind: "eq",
	left: tableLookupExpression,
	right: literalExpression,
} as const;

interface RegisteredToolCase {
	readonly name: string;
	readonly tool: SharedToolModule;
	readonly dormantInput: Record<string, unknown>;
}

const REGISTERED_TOOLS: readonly RegisteredToolCase[] = [
	{
		name: "create_module",
		tool: createModuleTool,
		dormantInput: {
			name: "Patients",
			case_list_columns: [
				{
					kind: "calculated",
					header: "Lookup",
					expression: tableLookupExpression,
				},
			],
		},
	},
	{
		name: "update_module",
		tool: updateModuleTool,
		dormantInput: {
			moduleIndex: 0,
			case_type: "patient",
			case_list_columns: [
				{
					kind: "calculated",
					header: "Lookup",
					expression: tableLookupExpression,
				},
			],
		},
	},
	{
		name: "add_case_list_columns",
		tool: addCaseListColumnsTool,
		dormantInput: {
			moduleIndex: 0,
			columns: [
				{
					kind: "calculated",
					header: "Lookup",
					expression: tableLookupExpression,
				},
			],
		},
	},
	{
		name: "update_case_list_column",
		tool: updateCaseListColumnTool,
		dormantInput: {
			moduleIndex: 0,
			columnUuid: "column-1",
			column: {
				kind: "calculated",
				header: "Lookup",
				expression: tableLookupExpression,
			},
		},
	},
	{
		name: "add_search_inputs",
		tool: addSearchInputsTool,
		dormantInput: {
			moduleIndex: 0,
			searchInputs: [
				{
					kind: "simple",
					name: "status",
					label: "Status",
					type: "text",
					property: "status",
					default: tableLookupExpression,
				},
			],
		},
	},
	{
		name: "update_search_input",
		tool: updateSearchInputTool,
		dormantInput: {
			moduleIndex: 0,
			searchInputUuid: "search-1",
			searchInput: {
				kind: "advanced",
				name: "status",
				label: "Status",
				type: "text",
				predicate: lookupPredicate,
			},
		},
	},
	{
		name: "set_case_list_filter",
		tool: setCaseListFilterTool,
		dormantInput: { moduleIndex: 0, filter: lookupPredicate },
	},
	{
		name: "set_case_search_advanced",
		tool: setCaseSearchAdvancedTool,
		dormantInput: {
			moduleIndex: 0,
			excludedOwnerIds: tableLookupExpression,
		},
	},
	{
		name: "set_case_search_display",
		tool: setCaseSearchDisplayTool,
		dormantInput: {
			moduleIndex: 0,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: lookupPredicate,
		},
	},
];

const toolContext: ToolContext = {
	userId: "user-1",
	scopes: [],
	authKind: "oauth",
};

function captureRegisteredInputSchema(
	name: string,
	tool: SharedToolModule,
): z.ZodObject<z.ZodRawShape> {
	let rawShape: z.ZodRawShape | undefined;
	const server = {
		registerTool(
			_registeredName: string,
			config: { inputSchema?: z.ZodRawShape },
		) {
			rawShape = config.inputSchema;
		},
	} as unknown as McpServer;

	registerSharedTool(server, name, tool, toolContext, "edit");
	if (!rawShape) {
		throw new Error(`${name} did not register an MCP input schema`);
	}
	return z.object(rawShape);
}

describe("raw MCP write schemas stay carrier-blind", () => {
	for (const toolCase of REGISTERED_TOOLS) {
		it(`${toolCase.name} omits and rejects dormant lookup carriers`, () => {
			const schema = captureRegisteredInputSchema(toolCase.name, toolCase.tool);
			const json = JSON.stringify(
				z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
			);
			expect(json).not.toContain("table-column");
			expect(json).not.toContain("table-lookup");
			expect(
				schema.safeParse({
					app_id: "app-1",
					...toolCase.dormantInput,
				}).success,
			).toBe(false);
		});
	}
});
