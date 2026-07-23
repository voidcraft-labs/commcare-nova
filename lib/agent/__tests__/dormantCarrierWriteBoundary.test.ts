import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { buildExpressionReference } from "../expressionReference";
import { buildSolutionsArchitectPrompt } from "../prompts";
import { addCaseListColumnsTool } from "../tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "../tools/case-list-config/addSearchInputs";
import { setCaseListFilterTool } from "../tools/case-list-config/setCaseListFilter";
import { updateCaseListColumnTool } from "../tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "../tools/case-list-config/updateSearchInput";
import { setCaseSearchAdvancedTool } from "../tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "../tools/case-search-config/setCaseSearchDisplay";
import { createModuleTool } from "../tools/createModule";
import { updateModuleTool } from "../tools/updateModule";
import { wireToolSchema } from "../wireSchemas";

const TABLE_ID = "018f3e8a-7b2c-7def-8abc-1234567890ab";
const COLUMN_ID = "018f3e8a-7b2c-7def-8abc-1234567890ad";

const literalExpression = {
	kind: "term",
	term: { kind: "literal", value: "ordinary" },
} as const;

const tableColumnExpression = {
	kind: "term",
	term: {
		kind: "table-column",
		tableId: TABLE_ID,
		columnId: COLUMN_ID,
	},
} as const;

const tableLookupExpression = {
	kind: "table-lookup",
	tableId: TABLE_ID,
	resultColumnId: COLUMN_ID,
	where: { kind: "match-all" },
} as const;

function deeplyNestExpression(expression: unknown): unknown {
	return {
		kind: "concat",
		parts: [
			{
				kind: "if",
				cond: {
					kind: "not",
					clause: {
						kind: "eq",
						left: expression,
						right: literalExpression,
					},
				},
				// biome-ignore lint/suspicious/noThenProperty: Predicate AST fixture mirrors the canonical if arm.
				then: literalExpression,
				else: literalExpression,
			},
		],
	};
}

function predicateContaining(expression: unknown): unknown {
	return {
		kind: "not",
		clause: {
			kind: "eq",
			left: expression,
			right: literalExpression,
		},
	};
}

interface ToolBoundaryCase {
	readonly name: string;
	readonly schema: z.ZodType;
	readonly validInput: unknown;
	readonly dormantInputs: readonly unknown[];
}

const TOOL_CASES: readonly ToolBoundaryCase[] = [
	{
		name: "createModule",
		schema: createModuleTool.inputSchema,
		validInput: {
			name: "Patients",
			case_list_columns: [
				{
					kind: "calculated",
					header: "Display",
					expression: literalExpression,
				},
			],
		},
		dormantInputs: [
			{
				name: "Patients",
				case_list_columns: [
					{
						kind: "calculated",
						header: "Lookup",
						expression: tableLookupExpression,
					},
				],
			},
			{
				name: "Patients",
				case_list_columns: [
					{
						kind: "calculated",
						header: "Lookup",
						expression: deeplyNestExpression(tableColumnExpression),
					},
				],
			},
		],
	},
	{
		name: "updateModule",
		schema: updateModuleTool.inputSchema,
		validInput: {
			moduleIndex: 0,
			case_type: "patient",
			case_list_columns: [
				{
					kind: "calculated",
					header: "Display",
					expression: literalExpression,
				},
			],
		},
		dormantInputs: [
			{
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
			{
				moduleIndex: 0,
				case_type: "patient",
				case_list_columns: [
					{
						kind: "calculated",
						header: "Lookup",
						expression: deeplyNestExpression(tableColumnExpression),
					},
				],
			},
		],
	},
	{
		name: "addCaseListColumns",
		schema: addCaseListColumnsTool.inputSchema,
		validInput: {
			moduleIndex: 0,
			columns: [
				{
					kind: "calculated",
					header: "Display",
					expression: literalExpression,
				},
			],
		},
		dormantInputs: [
			{
				moduleIndex: 0,
				columns: [
					{
						kind: "calculated",
						header: "Lookup",
						expression: tableLookupExpression,
					},
				],
			},
			{
				moduleIndex: 0,
				columns: [
					{
						kind: "calculated",
						header: "Lookup",
						expression: deeplyNestExpression(tableColumnExpression),
					},
				],
			},
		],
	},
	{
		name: "updateCaseListColumn",
		schema: updateCaseListColumnTool.inputSchema,
		validInput: {
			moduleIndex: 0,
			columnUuid: "column-1",
			column: {
				kind: "calculated",
				header: "Display",
				expression: literalExpression,
			},
		},
		dormantInputs: [
			{
				moduleIndex: 0,
				columnUuid: "column-1",
				column: {
					kind: "calculated",
					header: "Lookup",
					expression: tableLookupExpression,
				},
			},
			{
				moduleIndex: 0,
				columnUuid: "column-1",
				column: {
					kind: "calculated",
					header: "Lookup",
					expression: deeplyNestExpression(tableColumnExpression),
				},
			},
		],
	},
	{
		name: "addSearchInputs",
		schema: addSearchInputsTool.inputSchema,
		validInput: {
			moduleIndex: 0,
			searchInputs: [
				{
					kind: "advanced",
					name: "status",
					label: "Status",
					type: "text",
					default: literalExpression,
					predicate: { kind: "match-all" },
				},
			],
		},
		dormantInputs: [
			{
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
			{
				moduleIndex: 0,
				searchInputs: [
					{
						kind: "simple",
						name: "status",
						label: "Status",
						type: "text",
						property: "status",
						default: deeplyNestExpression(tableColumnExpression),
					},
				],
			},
			{
				moduleIndex: 0,
				searchInputs: [
					{
						kind: "advanced",
						name: "status",
						label: "Status",
						type: "text",
						predicate: predicateContaining(tableLookupExpression),
					},
				],
			},
			{
				moduleIndex: 0,
				searchInputs: [
					{
						kind: "advanced",
						name: "status",
						label: "Status",
						type: "text",
						predicate: predicateContaining(
							deeplyNestExpression(tableColumnExpression),
						),
					},
				],
			},
		],
	},
	{
		name: "updateSearchInput",
		schema: updateSearchInputTool.inputSchema,
		validInput: {
			moduleIndex: 0,
			searchInputUuid: "search-1",
			searchInput: {
				kind: "simple",
				name: "status",
				label: "Status",
				type: "text",
				property: "status",
				default: literalExpression,
			},
		},
		dormantInputs: [
			{
				moduleIndex: 0,
				searchInputUuid: "search-1",
				searchInput: {
					kind: "simple",
					name: "status",
					label: "Status",
					type: "text",
					property: "status",
					default: tableLookupExpression,
				},
			},
			{
				moduleIndex: 0,
				searchInputUuid: "search-1",
				searchInput: {
					kind: "simple",
					name: "status",
					label: "Status",
					type: "text",
					property: "status",
					default: deeplyNestExpression(tableColumnExpression),
				},
			},
			{
				moduleIndex: 0,
				searchInputUuid: "search-1",
				searchInput: {
					kind: "advanced",
					name: "status",
					label: "Status",
					type: "text",
					predicate: predicateContaining(tableLookupExpression),
				},
			},
			{
				moduleIndex: 0,
				searchInputUuid: "search-1",
				searchInput: {
					kind: "advanced",
					name: "status",
					label: "Status",
					type: "text",
					predicate: predicateContaining(
						deeplyNestExpression(tableColumnExpression),
					),
				},
			},
		],
	},
	{
		name: "setCaseListFilter",
		schema: setCaseListFilterTool.inputSchema,
		validInput: { moduleIndex: 0, filter: { kind: "match-all" } },
		dormantInputs: [
			{
				moduleIndex: 0,
				filter: predicateContaining(tableLookupExpression),
			},
			{
				moduleIndex: 0,
				filter: predicateContaining(
					deeplyNestExpression(tableColumnExpression),
				),
			},
		],
	},
	{
		name: "setCaseSearchAdvanced",
		schema: setCaseSearchAdvancedTool.inputSchema,
		validInput: {
			moduleIndex: 0,
			excludedOwnerIds: literalExpression,
		},
		dormantInputs: [
			{ moduleIndex: 0, excludedOwnerIds: tableLookupExpression },
			{
				moduleIndex: 0,
				excludedOwnerIds: deeplyNestExpression(tableColumnExpression),
			},
		],
	},
	{
		name: "setCaseSearchDisplay",
		schema: setCaseSearchDisplayTool.inputSchema,
		validInput: {
			moduleIndex: 0,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: { kind: "match-all" },
		},
		dormantInputs: [
			{
				moduleIndex: 0,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				searchButtonLabel: null,
				searchButtonDisplayCondition: predicateContaining(
					tableLookupExpression,
				),
			},
			{
				moduleIndex: 0,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				searchButtonLabel: null,
				searchButtonDisplayCondition: predicateContaining(
					deeplyNestExpression(tableColumnExpression),
				),
			},
		],
	},
];

function editableDoc(): BlueprintDoc {
	const moduleUuid = asUuid("11111111-1111-1111-1111-111111111111");
	return {
		appId: "app-1",
		appName: "Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[moduleUuid]: {
				uuid: moduleUuid,
				id: "patients",
				name: "Patients",
				caseType: "patient",
			},
		},
		forms: {},
		fields: {},
		moduleOrder: [moduleUuid],
		formOrder: { [moduleUuid]: [] },
		fieldOrder: {},
		fieldParent: {},
	};
}

describe("dormant lookup carriers stay outside SA write schemas", () => {
	for (const toolCase of TOOL_CASES) {
		it(`${toolCase.name} accepts its ordinary authoring shape`, () => {
			expect(toolCase.schema.safeParse(toolCase.validInput).success).toBe(true);
		});

		it(`${toolCase.name} rejects direct and deeply nested lookup carriers`, () => {
			for (const input of toolCase.dormantInputs) {
				expect(
					toolCase.schema.safeParse(input).success,
					`${toolCase.name} accepted ${JSON.stringify(input)}`,
				).toBe(false);
			}
		});

		it(`${toolCase.name} raw JSON schema omits dormant discriminators`, () => {
			const json = JSON.stringify(
				z.toJSONSchema(toolCase.schema, { target: "draft-7", io: "input" }),
			);
			expect(json).not.toContain("table-column");
			expect(json).not.toContain("table-lookup");
		});
	}
});

describe("chat wire projection stays compact and validates carrier-blind input", () => {
	for (const toolCase of TOOL_CASES) {
		it(`${toolCase.name} keeps AST stubs while rejecting dormant input`, async () => {
			const wire = wireToolSchema(toolCase.schema);
			const json = JSON.stringify(await wire.jsonSchema);
			expect(json).toContain("Shape reference");
			expect(json).not.toContain("table-column");
			expect(json).not.toContain("table-lookup");

			const valid = await wire.validate?.(toolCase.validInput);
			expect(valid?.success).toBe(true);
			for (const input of toolCase.dormantInputs) {
				const rejected = await wire.validate?.(input);
				expect(rejected?.success).toBe(false);
			}
		});
	}
});

describe("generated expression grammar", () => {
	it("retains ordinary Predicate/ValueExpression grammar but omits dormant arms", () => {
		const grammar = buildExpressionReference();
		expect(grammar).toContain("type Predicate =");
		expect(grammar).toContain("type ValueExpression =");
		expect(grammar).toContain("type Term =");
		expect(grammar).toContain('kind: "eq"');
		expect(grammar).toContain('kind: "prop"');
		expect(grammar).not.toContain("CarrierBlind");
		expect(grammar).not.toContain("table-column");
		expect(grammar).not.toContain("table-lookup");
	});

	it("omits dormant arms from both build and edit prompts", () => {
		for (const prompt of [
			buildSolutionsArchitectPrompt(),
			buildSolutionsArchitectPrompt(editableDoc()),
		]) {
			expect(prompt).toContain("Filters & expressions");
			expect(prompt).toContain("type Predicate =");
			expect(prompt).not.toContain("table-column");
			expect(prompt).not.toContain("table-lookup");
		}
	});
});
