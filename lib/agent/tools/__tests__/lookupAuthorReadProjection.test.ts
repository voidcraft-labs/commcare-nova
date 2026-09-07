import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type CaseOperation,
	calculatedColumn,
	type LookupOptionsSource,
	plainColumn,
} from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	eq,
	literal,
	prop,
	tableColumn,
	tableLookup,
} from "@/lib/domain/predicate";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { LookupDefinitionsSnapshot } from "@/lib/lookup/types";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
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

const TABLE = lookupTableIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ab");
const VALUE_COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const LABEL_COLUMN = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ae",
);
const REVISION = parseLookupRevision("1");

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
					filter: eq(prop("person", "case_name"), lookupExpression),
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
	return expectAdmittedDoc(doc, { kind: "available", ...LOOKUP_CATALOG });
}

describe("shared read tools — canonical lookup identity", () => {
	it("returns every immutable lookup UUID without mutating the doc", async () => {
		const doc = lookupDoc();
		const before = structuredClone(doc);
		const h = makeToolWorkspaceHarness(doc, {
			lookupCatalog: async () => LOOKUP_CATALOG,
		});

		const fieldRead = await h.runTool(getFieldTool, {
			moduleUuid: MODULE,
			formUuid: FORM,
			fieldUuid: GROUP,
		});
		const formRead = await h.runTool(getFormTool, {
			moduleUuid: MODULE,
			formUuid: FORM,
		});
		const moduleRead = await h.runTool(getModuleTool, {
			moduleUuid: MODULE,
		});
		const operationRead = await h.runTool(getCaseOperationsTool, {
			moduleUuid: MODULE,
			formUuid: FORM,
		});
		if ("error" in fieldRead.data) throw new Error(fieldRead.data.error);
		if ("error" in formRead.data) throw new Error(formRead.data.error);
		if ("error" in moduleRead.data) throw new Error(moduleRead.data.error);
		if ("error" in operationRead.data) {
			throw new Error(operationRead.data.error);
		}

		const field = fieldRead.data.field;
		if (!("children" in field) || field.children === undefined) {
			throw new Error("expected group children");
		}
		expect(field.children[0]).toMatchObject({ uuid: SELECT, optionsSource });
		expect(moduleRead.data.display_condition).toEqual(lookupPredicate);
		expect(moduleRead.data.case_list_config).toEqual(
			doc.modules[MODULE].caseListConfig,
		);
		expect(moduleRead.data.case_search_config).toEqual(
			doc.modules[MODULE].caseSearchConfig,
		);
		expect(formRead.data.form.displayCondition).toEqual(lookupPredicate);
		expect(formRead.data.form.fields[0]).toMatchObject({
			children: [{ uuid: SELECT, optionsSource }],
		});
		expect(formRead.data.form.caseOperations).toEqual(
			doc.forms[FORM].caseOperations,
		);
		expect(operationRead.data.operations).toEqual(
			doc.forms[FORM].caseOperations,
		);
		expect(doc).toEqual(before);
		expect(h.host.recordMutations).not.toHaveBeenCalled();
	});
});
