import { describe, expect, it } from "vitest";
import { z } from "zod";
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
import { setFieldOptionsSourceTool } from "../tools/setFieldOptionsSource";
import { updateFormTool } from "../tools/updateForm";
import { updateModuleTool } from "../tools/updateModule";
import { wireToolSchema } from "../wireSchemas";

const MODULE_UUID = "11111111-1111-4111-8111-111111111111";
const FORM_UUID = "22222222-2222-4222-8222-222222222222";
const FIELD_UUID = "33333333-3333-4333-8333-333333333333";
const COLUMN_UUID = "44444444-4444-4444-8444-444444444444";
const SEARCH_INPUT_UUID = "55555555-5555-4555-8555-555555555555";
const TABLE_ID = "018f3e8a-7b2c-7def-8abc-1234567890ab";
const VALUE_COLUMN_ID = "018f3e8a-7b2c-7def-8abc-1234567890ad";
const LABEL_COLUMN_ID = "018f3e8a-7b2c-7def-8abc-1234567890ae";

const lookupExpression = {
	kind: "table-lookup",
	tableId: TABLE_ID,
	resultColumnId: LABEL_COLUMN_ID,
	where: {
		kind: "eq",
		left: {
			kind: "term",
			term: {
				kind: "table-column",
				tableId: TABLE_ID,
				columnId: VALUE_COLUMN_ID,
			},
		},
		right: {
			kind: "term",
			term: { kind: "literal", value: "north" },
		},
	},
} as const;

const lookupPredicate = {
	kind: "eq",
	left: lookupExpression,
	right: {
		kind: "term",
		term: { kind: "literal", value: "North" },
	},
} as const;

const legacyLookupExpression = {
	kind: "table-lookup",
	tableTag: "regions",
	resultColumn: "label",
	where: {
		kind: "eq",
		left: {
			kind: "term",
			term: {
				kind: "table-column",
				tableTag: "regions",
				column: "code",
			},
		},
		right: {
			kind: "term",
			term: { kind: "literal", value: "north" },
		},
	},
} as const;

const legacyLookupPredicate = {
	kind: "eq",
	left: legacyLookupExpression,
	right: {
		kind: "term",
		term: { kind: "literal", value: "North" },
	},
} as const;

interface ToolBoundaryCase {
	readonly name: string;
	readonly schema: z.ZodType;
	readonly canonicalInput: unknown;
	readonly legacyInput: unknown;
}

const TOOL_CASES: readonly ToolBoundaryCase[] = [
	{
		name: "createModule",
		schema: createModuleTool.inputSchema,
		canonicalInput: {
			name: "Patients",
			case_list_columns: [
				{
					kind: "calculated",
					header: "Region",
					expression: lookupExpression,
				},
			],
		},
		legacyInput: {
			name: "Patients",
			case_list_columns: [
				{
					kind: "calculated",
					header: "Region",
					expression: legacyLookupExpression,
				},
			],
		},
	},
	{
		name: "updateModule",
		schema: updateModuleTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			displayCondition: lookupPredicate,
		},
		legacyInput: {
			moduleIndex: 0,
			displayCondition: legacyLookupPredicate,
		},
	},
	{
		name: "updateForm",
		schema: updateFormTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			formUuid: FORM_UUID,
			displayCondition: lookupPredicate,
		},
		legacyInput: {
			moduleIndex: 0,
			formIndex: 0,
			displayCondition: legacyLookupPredicate,
		},
	},
	{
		name: "addCaseListColumns",
		schema: addCaseListColumnsTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			columns: [
				{
					kind: "calculated",
					header: "Region",
					expression: lookupExpression,
				},
			],
		},
		legacyInput: {
			moduleIndex: 0,
			columns: [
				{
					kind: "calculated",
					header: "Region",
					expression: legacyLookupExpression,
				},
			],
		},
	},
	{
		name: "updateCaseListColumn",
		schema: updateCaseListColumnTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			columnUuid: COLUMN_UUID,
			column: {
				kind: "calculated",
				header: "Region",
				expression: lookupExpression,
			},
		},
		legacyInput: {
			moduleIndex: 0,
			columnUuid: COLUMN_UUID,
			column: {
				kind: "calculated",
				header: "Region",
				expression: legacyLookupExpression,
			},
		},
	},
	{
		name: "addSearchInputs",
		schema: addSearchInputsTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			searchInputs: [
				{
					kind: "advanced",
					name: "region",
					label: "Region",
					type: "text",
					predicate: lookupPredicate,
				},
			],
		},
		legacyInput: {
			moduleIndex: 0,
			searchInputs: [
				{
					kind: "advanced",
					name: "region",
					label: "Region",
					type: "text",
					predicate: legacyLookupPredicate,
				},
			],
		},
	},
	{
		name: "updateSearchInput",
		schema: updateSearchInputTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			searchInputUuid: SEARCH_INPUT_UUID,
			searchInput: {
				kind: "advanced",
				name: "region",
				label: "Region",
				type: "text",
				predicate: lookupPredicate,
			},
		},
		legacyInput: {
			moduleIndex: 0,
			searchInputUuid: SEARCH_INPUT_UUID,
			searchInput: {
				kind: "advanced",
				name: "region",
				label: "Region",
				type: "text",
				predicate: legacyLookupPredicate,
			},
		},
	},
	{
		name: "setCaseListFilter",
		schema: setCaseListFilterTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			filter: lookupPredicate,
		},
		legacyInput: {
			moduleIndex: 0,
			filter: legacyLookupPredicate,
		},
	},
	{
		name: "setCaseSearchAdvanced",
		schema: setCaseSearchAdvancedTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			excludedOwnerIds: lookupExpression,
			searchFirst: null,
		},
		legacyInput: {
			moduleIndex: 0,
			excludedOwnerIds: legacyLookupExpression,
			searchFirst: null,
		},
	},
	{
		name: "setCaseSearchDisplay",
		schema: setCaseSearchDisplayTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: lookupPredicate,
		},
		legacyInput: {
			moduleIndex: 0,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: legacyLookupPredicate,
		},
	},
	{
		name: "setFieldOptionsSource",
		schema: setFieldOptionsSourceTool.inputSchema,
		canonicalInput: {
			moduleUuid: MODULE_UUID,
			formUuid: FORM_UUID,
			fieldUuid: FIELD_UUID,
			source: {
				kind: "lookup",
				tableId: TABLE_ID,
				valueColumnId: VALUE_COLUMN_ID,
				labelColumnId: LABEL_COLUMN_ID,
				filter: lookupPredicate,
			},
		},
		legacyInput: {
			moduleIndex: 0,
			formIndex: 0,
			fieldPath: "location/region",
			source: {
				tableTag: "regions",
				valueColumn: "code",
				labelColumn: "label",
				filter: legacyLookupPredicate,
			},
		},
	},
];

describe("lookup author identity boundary", () => {
	for (const toolCase of TOOL_CASES) {
		it(`${toolCase.name} accepts immutable UUID identities and rejects legacy projections`, () => {
			expect(toolCase.schema.safeParse(toolCase.canonicalInput).success).toBe(
				true,
			);
			expect(toolCase.schema.safeParse(toolCase.legacyInput).success).toBe(
				false,
			);
		});

		it(`${toolCase.name} exposes canonical lookup vocabulary in its MCP schema`, () => {
			const json = JSON.stringify(
				z.toJSONSchema(toolCase.schema, { target: "draft-7", io: "input" }),
			);
			expect(json).toContain("table-column");
			expect(json).toContain("table-lookup");
			expect(json).toContain("tableId");
			expect(json).toContain("columnId");
			expect(json).not.toContain("tableTag");
			expect(json).not.toContain('"resultColumn":');
		});

		it(`${toolCase.name} keeps chat wire compact while validating canonical input`, async () => {
			const full = JSON.stringify(
				z.toJSONSchema(toolCase.schema, { target: "draft-7", io: "input" }),
			);
			const wire = wireToolSchema(toolCase.schema);
			const json = JSON.stringify(await wire.jsonSchema);

			/* The chat wire is a projection, not a second contract. It carries
			 * the Predicate slot's own discriminator vocabulary; the operand
			 * grammar below it (Term/ValueExpression arms, lookup terms) is
			 * taught once by the prompt's "Filters & expressions" section and
			 * enforced by the untouched Zod validation — the grammar tests
			 * below pin that the prompt actually names those arms. */
			expect(json.length).toBeLessThan(full.length);
			const definitions =
				((JSON.parse(json) as Record<string, unknown>).definitions as
					| Record<string, unknown>
					| undefined) ?? {};
			expect(
				"Predicate" in definitions || "ValueExpression" in definitions,
				"an expression-bearing tool must mount a family root definition",
			).toBe(true);
			if ("Predicate" in definitions) {
				expect(json).toContain('"match-all"');
				expect(json).toContain('"when-input-present"');
			}
			if ("ValueExpression" in definitions) {
				expect(json).toContain('"table-lookup"');
				expect(json).toContain('"table-column"');
			}
			expect(json).not.toContain("tableTag");

			/* Compaction never widens what is accepted: the untouched Zod schema
			 * is still the validator on both sides. */
			expect((await wire.validate?.(toolCase.canonicalInput))?.success).toBe(
				true,
			);
			expect((await wire.validate?.(toolCase.legacyInput))?.success).toBe(
				false,
			);
		});
	}
});

describe("generated expression grammar", () => {
	it("publishes the same immutable UUID leaves the schemas accept", () => {
		const grammar = buildExpressionReference();
		expect(grammar).toContain("type Predicate =");
		expect(grammar).toContain("type ValueExpression =");
		expect(grammar).toContain('kind: "table-column"');
		expect(grammar).toContain('kind: "table-lookup"');
		expect(grammar).toContain("tableId");
		expect(grammar).toContain("columnId");
		expect(grammar).toContain("resultColumnId");
		expect(grammar).toContain("opUuid");
		expect(grammar).toContain("userPropertyUuid");
		expect(grammar).toContain("searchInputUuid");
		expect(grammar).not.toContain("tableTag");
		expect(grammar).not.toContain("operationId");
	});

	it("keeps UUID lookup guidance in every edit prompt", () => {
		for (const prompt of [
			buildSolutionsArchitectPrompt(),
			buildSolutionsArchitectPrompt(),
		]) {
			expect(prompt).toContain("Project data consent and identity");
			expect(prompt).toContain("getLookupTables");
			expect(prompt).toContain("setFieldOptionsSource");
			expect(prompt).toContain("tableId");
			expect(prompt).toContain("columnId");
			expect(prompt).not.toContain("never invent or pass their storage uuids");
		}
	});
});
