import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { buildFieldTree } from "@/lib/doc/fieldWalk";
import {
	advancedSearchInputDef,
	type CaseOperation,
	calculatedColumn,
	emptyCaseListConfig,
	type LookupColumnId,
	type LookupOptionsSource,
	type LookupTableId,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	concat,
	eq,
	literal,
	not,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { makeStubToolContext } from "../../__tests__/fixtures";
import { getCaseOperationsTool } from "../case-operations/getCaseOperations";
import { getFieldTool } from "../getField";
import { getFormTool } from "../getForm";
import { getModuleTool } from "../getModule";

const MODULE = testUuid("10000000-0000-4000-8000-000000000000");
const FORM = testUuid("20000000-0000-4000-8000-000000000000");
const GROUP = testUuid("30000000-0000-4000-8000-000000000000");
const SELECT = testUuid("40000000-0000-4000-8000-000000000000");
const SAFE_COLUMN = testUuid("50000000-0000-4000-8000-000000000000");
const LOOKUP_COLUMN = testUuid("60000000-0000-4000-8000-000000000000");
const SAFE_INPUT = testUuid("70000000-0000-4000-8000-000000000000");
const DEFAULT_LOOKUP_INPUT = testUuid("80000000-0000-4000-8000-000000000000");
const PREDICATE_LOOKUP_INPUT = testUuid("90000000-0000-4000-8000-000000000000");

const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LABEL_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;

const lookupRowPredicate = and(
	eq(tableColumn(TABLE, LABEL_COLUMN), literal("enabled")),
	eq(literal(1), literal(1)),
);
const deepLookupExpression = concat(
	term(literal("prefix:")),
	tableLookup(TABLE, VALUE_COLUMN, lookupRowPredicate),
);
const deepLookupPredicate = not(
	eq(deepLookupExpression, term(literal("active"))),
);

const optionsSource: LookupOptionsSource = {
	kind: "lookup-table",
	tableId: TABLE,
	valueColumnId: VALUE_COLUMN,
	labelColumnId: LABEL_COLUMN,
	filter: deepLookupPredicate,
};

function lookupCarrierDoc() {
	const doc = buildDoc({
		modules: [
			{
				uuid: MODULE,
				name: "People",
				caseType: "person",
				caseListConfig: {
					columns: [
						plainColumn(SAFE_COLUMN, "name", "Name", {}),
						calculatedColumn(
							LOOKUP_COLUMN,
							"Lookup-derived",
							deepLookupExpression,
							{ listOrder: "b", detailOrder: "b" },
						),
					],
					filter: deepLookupPredicate,
					searchInputs: [
						simpleSearchInputDef(SAFE_INPUT, "name", "Name", "text", "name", {
							default: term(literal("Ada")),
						}),
						simpleSearchInputDef(
							DEFAULT_LOOKUP_INPUT,
							"district",
							"District",
							"text",
							"district",
							{ default: deepLookupExpression },
						),
						advancedSearchInputDef(
							PREDICATE_LOOKUP_INPUT,
							"lookup_match",
							"Lookup match",
							"text",
							deepLookupPredicate,
						),
					],
					icon: "asset-case-list",
				},
				caseSearchConfig: {
					searchScreenTitle: "Find a person",
					excludedOwnerIds: deepLookupExpression,
					searchButtonDisplayCondition: deepLookupPredicate,
				},
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						displayCondition: deepLookupPredicate,
						postSubmit: "previous",
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
										options: [
											{
												uuid: testUuid("41000000-0000-4000-8000-000000000000"),
												value: "north",
												label: "North",
											},
											{
												uuid: testUuid("42000000-0000-4000-8000-000000000000"),
												value: "south",
												label: "South",
											},
										],
										optionsSource,
										hint: "Safe inline fallback remains visible",
									}),
								],
							}),
						],
					},
				],
			},
		],
	});

	const safeOperation: CaseOperation = {
		uuid: testUuid("a0000000-0000-4000-8000-000000000000"),
		id: "safe_update",
		action: "update",
		caseType: "person",
		target: { kind: "session" },
		owner: term(literal("safe-owner")),
		writes: [{ property: "safe", value: term(literal("safe-value")) }],
	};
	const partiallyDormantOperation: CaseOperation = {
		uuid: testUuid("b0000000-0000-4000-8000-000000000000"),
		id: "partial_update",
		action: "update",
		caseType: "person",
		target: { kind: "session" },
		condition: deepLookupPredicate,
		name: deepLookupExpression,
		owner: term(literal("preserved-owner")),
		writes: [
			{
				property: "preserved_write",
				value: term(literal("preserved-value")),
				condition: deepLookupPredicate,
			},
			{ property: "dormant_write", value: deepLookupExpression },
		],
		links: [
			{
				identifier: "safe_null",
				targetType: "household",
				target: null,
				relationship: "child",
			},
			{
				identifier: "safe_expression",
				targetType: "household",
				target: { kind: "expression", expr: term(literal("case-id")) },
				relationship: "extension",
			},
			{
				identifier: "dormant_expression",
				targetType: "household",
				target: { kind: "expression", expr: deepLookupExpression },
				relationship: "child",
			},
		],
	};
	const dormantTargetOperation: CaseOperation = {
		uuid: testUuid("c0000000-0000-4000-8000-000000000000"),
		id: "dormant_target",
		action: "update",
		caseType: "person",
		target: { kind: "expression", expr: deepLookupExpression },
	};
	doc.forms[FORM].caseOperations = [
		safeOperation,
		partiallyDormantOperation,
		dormantTargetOperation,
	];
	return doc;
}

function serialized(value: unknown): string {
	return JSON.stringify(value);
}

function expectNoDormantCarrier(value: unknown): void {
	const json = serialized(value);
	expect(json).not.toContain("optionsSource");
	expect(json).not.toContain("table-column");
	expect(json).not.toContain("table-lookup");
}

describe("shared read tools — dormant lookup carriers", () => {
	it("redacts carriers recursively, preserves safe peers, and never mutates the source doc", async () => {
		const doc = lookupCarrierDoc();
		const sourceBeforeReads = serialized(doc);
		const { ctx } = makeStubToolContext();

		const fieldRead = await getFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: GROUP },
			ctx,
			doc,
		);
		const formRead = await getFormTool.execute(
			{ moduleIndex: 0, formIndex: 0 },
			ctx,
			doc,
		);
		const moduleRead = await getModuleTool.execute(
			{ moduleIndex: 0 },
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

		expectNoDormantCarrier(fieldRead.data);
		expectNoDormantCarrier(formRead.data);
		expectNoDormantCarrier(moduleRead.data);
		expectNoDormantCarrier(operationRead.data);
		expect(
			operationRead.data.operations.map((operation) => operation.id),
		).toEqual(["safe_update", "partial_update", "dormant_target"]);

		const field = fieldRead.data.field;
		if (!("children" in field) || field.children === undefined) {
			throw new Error("expected group children");
		}
		expect(field.children).toHaveLength(1);
		expect(field.children[0]).toMatchObject({
			uuid: SELECT,
			hint: "Safe inline fallback remains visible",
			options: [
				expect.objectContaining({ value: "north", label: "North" }),
				expect.objectContaining({ value: "south", label: "South" }),
			],
		});

		expect(formRead.data.form.displayCondition).toBeUndefined();
		expect(formRead.data.form.postSubmit).toBe("previous");
		expect(formRead.data.form.caseOperations?.map((op) => op.id)).toEqual([
			"safe_update",
			"partial_update",
			"dormant_target",
		]);
		const partial = formRead.data.form.caseOperations?.[1];
		expect(partial).toEqual({
			id: "partial_update",
			action: "update",
			caseType: "person",
			unavailable: {
				kind: "lookup-table-logic",
				reason:
					"This case change uses lookup-table logic that Nova preserves but cannot safely edit from this surface.",
			},
		});
		expect(formRead.data.form.caseOperations?.[2]).toEqual({
			id: "dormant_target",
			action: "update",
			caseType: "person",
			unavailable: {
				kind: "lookup-table-logic",
				reason:
					"This case change uses lookup-table logic that Nova preserves but cannot safely edit from this surface.",
			},
		});

		expect(moduleRead.data.case_list_config).toMatchObject({
			icon: "asset-case-list",
			columns: [expect.objectContaining({ uuid: SAFE_COLUMN, header: "Name" })],
		});
		expect(moduleRead.data.case_list_config?.filter).toBeUndefined();
		expect(moduleRead.data.case_list_config?.searchInputs).toEqual([
			expect.objectContaining({
				uuid: SAFE_INPUT,
				default: term(literal("Ada")),
			}),
			expect.not.objectContaining({ default: expect.anything() }),
		]);
		expect(
			moduleRead.data.case_list_config?.searchInputs.map((input) => input.uuid),
		).toEqual([SAFE_INPUT, DEFAULT_LOOKUP_INPUT]);
		expect(moduleRead.data.results_column_order).toEqual([SAFE_COLUMN]);
		expect(moduleRead.data.details_column_order).toEqual([SAFE_COLUMN]);
		expect(moduleRead.data.case_search_config).toEqual({
			searchScreenTitle: "Find a person",
		});

		// All projections above clone and redact; the canonical historical doc
		// remains byte-identical after every read.
		expect(serialized(doc)).toBe(sourceBeforeReads);
	});

	it("keeps carrier-free field, form, and config payloads structurally unchanged", async () => {
		const doc = buildDoc({
			modules: [
				{
					uuid: MODULE,
					name: "Clean",
					caseListConfig: {
						columns: [plainColumn(SAFE_COLUMN, "name", "Name")],
						searchInputs: [
							simpleSearchInputDef(SAFE_INPUT, "name", "Name", "text", "name", {
								default: term(literal("Ada")),
							}),
						],
					},
					caseSearchConfig: { searchScreenTitle: "Search people" },
					forms: [
						{
							uuid: FORM,
							name: "Clean form",
							type: "survey",
							postSubmit: "app_home",
							fields: [
								f({
									uuid: SELECT,
									id: "name",
									kind: "text",
									label: "Name",
									hint: "Ordinary field",
								}),
							],
						},
					],
				},
			],
		});
		const { ctx } = makeStubToolContext();
		const fieldRead = await getFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: SELECT },
			ctx,
			doc,
		);
		const formRead = await getFormTool.execute(
			{ moduleIndex: 0, formIndex: 0 },
			ctx,
			doc,
		);
		const moduleRead = await getModuleTool.execute(
			{ moduleIndex: 0 },
			ctx,
			doc,
		);
		if ("error" in fieldRead.data) throw new Error(fieldRead.data.error);
		if ("error" in formRead.data) throw new Error(formRead.data.error);
		if ("error" in moduleRead.data) throw new Error(moduleRead.data.error);

		expect(fieldRead.data.field).toEqual(doc.fields[SELECT]);
		expect(formRead.data.form).toEqual({
			...doc.forms[FORM],
			fields: buildFieldTree(doc, FORM),
		});
		expect(moduleRead.data.case_list_config).toEqual(
			doc.modules[MODULE].caseListConfig,
		);
		expect(moduleRead.data.case_search_config).toEqual(
			doc.modules[MODULE].caseSearchConfig,
		);
	});

	it("uses existing absent/null forms when a whole optional carrier-owned surface is hidden", async () => {
		const doc = lookupCarrierDoc();
		doc.modules[MODULE].caseListConfig = resolveCaseListConfig({
			columns: [
				calculatedColumn(LOOKUP_COLUMN, "Lookup-derived", deepLookupExpression),
			],
			searchInputs: [
				advancedSearchInputDef(
					PREDICATE_LOOKUP_INPUT,
					"lookup_match",
					"Lookup match",
					"text",
					deepLookupPredicate,
				),
			],
		});
		doc.modules[MODULE].caseSearchConfig = {
			excludedOwnerIds: deepLookupExpression,
			// Legacy/editor objects can retain present-with-undefined optional
			// keys; they are still semantically absent after carrier redaction.
			searchScreenSubtitle: undefined,
		};
		doc.forms[FORM].caseOperations = [
			{
				uuid: testUuid("d0000000-0000-4000-8000-000000000000"),
				id: "dormant_links",
				action: "update",
				caseType: "person",
				target: { kind: "session" },
				links: [
					{
						identifier: "dormant_expression",
						targetType: "household",
						target: { kind: "expression", expr: deepLookupExpression },
						relationship: "child",
					},
				],
			},
		];
		const { ctx } = makeStubToolContext();
		const formRead = await getFormTool.execute(
			{ moduleIndex: 0, formIndex: 0 },
			ctx,
			doc,
		);
		const moduleRead = await getModuleTool.execute(
			{ moduleIndex: 0 },
			ctx,
			doc,
		);
		if ("error" in formRead.data) throw new Error(formRead.data.error);
		if ("error" in moduleRead.data) throw new Error(moduleRead.data.error);

		expect(formRead.data.form.caseOperations).toHaveLength(1);
		const operation = formRead.data.form.caseOperations?.[0];
		expect(operation).toEqual({
			id: "dormant_links",
			action: "update",
			caseType: "person",
			unavailable: {
				kind: "lookup-table-logic",
				reason:
					"This case change uses lookup-table logic that Nova preserves but cannot safely edit from this surface.",
			},
		});
		expect(moduleRead.data.case_list_config).toEqual(emptyCaseListConfig());
		expect(moduleRead.data.case_search_config).toBeNull();
		expect(moduleRead.data.results_column_order).toEqual([]);
		expect(moduleRead.data.details_column_order).toEqual([]);
		expectNoDormantCarrier({ formRead, moduleRead });
	});
});
