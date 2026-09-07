/** Actual author schemas, independent JSON Schema validation, and the SA
 * runtime validator. Paired inputs differ only in lookup identities, so an
 * obsolete module/form address cannot accidentally explain the refusal. */
import Ajv from "ajv";
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
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
			formUuid: FORM_UUID,
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
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
			formUuid: FORM_UUID,
			fieldUuid: FIELD_UUID,
			source: {
				kind: "lookup",
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

		it(`${toolCase.name} exports an independently validated full schema with the same lookup identity boundary`, () => {
			const validate = new Ajv({
				strict: false,
				validateFormats: false,
			}).compile(
				z.toJSONSchema(toolCase.schema, { target: "draft-7", io: "input" }),
			);
			expect(
				validate(toolCase.canonicalInput),
				JSON.stringify(validate.errors),
			).toBe(true);
			expect(validate(toolCase.legacyInput)).toBe(false);
		});

		it(`${toolCase.name} keeps chat wire compact while validating canonical input`, async () => {
			const full = JSON.stringify(
				z.toJSONSchema(toolCase.schema, { target: "draft-7", io: "input" }),
			);
			const wire = wireToolSchema(toolCase.schema);
			const json = JSON.stringify(await wire.jsonSchema);

			// This finite corpus measures emitted byte reduction. Runtime validation
			// below owns acceptance; the compact provider projection is intentionally permissive.
			expect(json.length).toBeLessThan(full.length);

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
	it("includes the current generated reference in the actual edit prompt", () => {
		const grammar = buildExpressionReference();
		expect(grammar.length).toBeGreaterThan(0);
		expect(buildSolutionsArchitectPrompt()).toContain(grammar);
	});
});
