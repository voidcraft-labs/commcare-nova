import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type CaseOperation,
	calculatedColumn,
	type LookupColumnId,
	type LookupOptionsSource,
	type LookupTableId,
	plainColumn,
} from "@/lib/domain";
import { eq, literal, tableColumn, tableLookup } from "@/lib/domain/predicate";
import type {
	LookupDefinitionsSnapshot,
	LookupRevision,
} from "@/lib/lookup/types";
import { makeStubToolContext } from "../../__tests__/fixtures";
import { getCaseOperationsTool } from "../case-operations/getCaseOperations";
import { getFieldTool } from "../getField";
import { getFormTool } from "../getForm";
import { getModuleTool } from "../getModule";

const MODULE = asUuid("10000000-0000-4000-8000-000000000000");
const FORM = asUuid("20000000-0000-4000-8000-000000000000");
const GROUP = asUuid("30000000-0000-4000-8000-000000000000");
const SELECT = asUuid("40000000-0000-4000-8000-000000000000");
const SAFE_COLUMN = asUuid("50000000-0000-4000-8000-000000000000");
const LOOKUP_COLUMN = asUuid("60000000-0000-4000-8000-000000000000");

const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LABEL_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;
const REVISION = "1" as LookupRevision;

const LOOKUP_CATALOG: LookupDefinitionsSnapshot = {
	projectId: "project-test",
	projectRevision: REVISION,
	definitions: [
		{
			id: TABLE,
			name: "Regions",
			tag: "regions",
			definitionRevision: REVISION,
			columns: [
				{
					id: VALUE_COLUMN,
					wireName: "code",
					label: "Code",
					dataType: "text",
				},
				{
					id: LABEL_COLUMN,
					wireName: "label",
					label: "Label",
					dataType: "text",
				},
			],
		},
	],
};

const lookupRowPredicate = eq(
	tableColumn(TABLE, VALUE_COLUMN),
	literal("north"),
);
const lookupExpression = tableLookup(TABLE, LABEL_COLUMN, lookupRowPredicate);
const lookupPredicate = eq(lookupExpression, literal("North"));

const optionsSource: LookupOptionsSource = {
	kind: "lookup",
	tableId: TABLE,
	valueColumnId: VALUE_COLUMN,
	labelColumnId: LABEL_COLUMN,
	filter: lookupRowPredicate,
};

function lookupDoc() {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "person",
				properties: [{ name: "case_name", label: "Name" }],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "People",
				caseType: "person",
				displayCondition: lookupPredicate,
				caseListConfig: {
					columns: [
						plainColumn(SAFE_COLUMN, "case_name", "Name"),
						calculatedColumn(LOOKUP_COLUMN, "Region label", lookupExpression),
					],
					filter: lookupPredicate,
					searchInputs: [],
				},
				caseSearchConfig: {
					excludedOwnerIds: lookupExpression,
				},
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						displayCondition: lookupPredicate,
						fields: [
							f({
								uuid: GROUP,
								id: "details",
								kind: "group",
								label: "Details",
								children: [
									f({
										uuid: SELECT,
										id: "district",
										kind: "single_select",
										label: "District",
										optionsSource,
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const operation: CaseOperation = {
		uuid: asUuid("a0000000-0000-4000-8000-000000000000"),
		id: "lookup_parent",
		action: "update",
		caseType: "person",
		target: { kind: "expression", expr: lookupExpression },
		condition: lookupPredicate,
	};
	doc.forms[FORM].caseOperations = [operation];
	return doc;
}

describe("shared read tools — canonical lookup identity", () => {
	it("returns every immutable lookup UUID without mutating the doc", async () => {
		const doc = lookupDoc();
		const before = JSON.stringify(doc);
		const stub = makeStubToolContext();
		const ctx = {
			...stub.ctx,
			lookupCatalog: async () => LOOKUP_CATALOG,
		};

		const fieldRead = await getFieldTool.execute(
			{ moduleUuid: MODULE, formUuid: FORM, fieldUuid: GROUP },
			ctx,
			doc,
		);
		const formRead = await getFormTool.execute(
			{ moduleUuid: MODULE, formUuid: FORM },
			ctx,
			doc,
		);
		const moduleRead = await getModuleTool.execute(
			{ moduleUuid: MODULE },
			ctx,
			doc,
		);
		const operationRead = await getCaseOperationsTool.execute(
			{ moduleUuid: MODULE, formUuid: FORM },
			ctx,
			doc,
		);
		if ("error" in fieldRead.data) throw new Error(fieldRead.data.error);
		if ("error" in formRead.data) throw new Error(formRead.data.error);
		if ("error" in moduleRead.data) throw new Error(moduleRead.data.error);
		if ("error" in operationRead.data) {
			throw new Error(operationRead.data.error);
		}

		const reads = {
			field: fieldRead.data,
			form: formRead.data,
			module: moduleRead.data,
			operations: operationRead.data,
		};
		const serialized = JSON.stringify(reads);
		expect(serialized).toContain(`"tableId":"${TABLE}"`);
		expect(serialized).toContain(`"columnId":"${VALUE_COLUMN}"`);
		expect(serialized).toContain(`"resultColumnId":"${LABEL_COLUMN}"`);
		expect(serialized).not.toContain('"tableTag"');
		expect(serialized).not.toContain('"resultColumn":');

		const field = fieldRead.data.field;
		if (!("children" in field) || field.children === undefined) {
			throw new Error("expected group children");
		}
		expect(field.children[0]).toMatchObject({
			uuid: SELECT,
			optionsSource: {
				kind: "lookup",
				tableId: TABLE,
				valueColumnId: VALUE_COLUMN,
				labelColumnId: LABEL_COLUMN,
				filter: {
					kind: "eq",
					left: {
						kind: "term",
						term: {
							kind: "table-column",
							tableId: TABLE,
							columnId: VALUE_COLUMN,
						},
					},
				},
			},
		});
		expect(moduleRead.data.display_condition).toEqual(
			expect.objectContaining({ kind: "eq" }),
		);
		expect(moduleRead.data.case_list_config?.columns).toHaveLength(2);
		expect(formRead.data.form.displayCondition).toEqual(
			expect.objectContaining({ kind: "eq" }),
		);
		expect(formRead.data.form.caseOperations).toEqual(
			operationRead.data.operations,
		);
		expect(operationRead.data.operations[0]).toMatchObject({
			id: "lookup_parent",
			target: {
				kind: "expression",
				expr: {
					kind: "table-lookup",
					tableId: TABLE,
					resultColumnId: LABEL_COLUMN,
				},
			},
		});
		expect(JSON.stringify(doc)).toBe(before);
	});
});
