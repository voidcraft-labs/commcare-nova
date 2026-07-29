import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	type CaseOperation,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	and,
	arith,
	concat,
	eq,
	formField,
	gt,
	input,
	literal,
	matchAll,
	type Predicate,
	prop,
	sessionUser,
	tableColumn,
	tableLookup,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import type { LookupRevision, LookupTableDefinition } from "@/lib/lookup/types";
import { lookupTypeIndex } from "../lookupTypeContext";
import { validateLookupOptionsSources } from "../rules/lookupOptionsSource";
import { runValidation } from "../runner";

const TABLE_A = "00000000-0000-7000-8000-0000000000a1" as LookupTableId;
const TABLE_B = "00000000-0000-7000-8000-0000000000b1" as LookupTableId;
const MISSING_TABLE = "00000000-0000-7000-8000-0000000000f1" as LookupTableId;

const TEXT_A = "10000000-0000-7000-8000-0000000000a1" as LookupColumnId;
const INT_A = "10000000-0000-7000-8000-0000000000a2" as LookupColumnId;
const DATE_A = "10000000-0000-7000-8000-0000000000a3" as LookupColumnId;
const TEXT_B = "10000000-0000-7000-8000-0000000000b1" as LookupColumnId;
const MISSING_COLUMN = "10000000-0000-7000-8000-0000000000f1" as LookupColumnId;

const FIELD_1 = testUuid("20000000-0000-7000-8000-000000000001");
const FIELD_2 = testUuid("20000000-0000-7000-8000-000000000002");
const FIELD_3 = testUuid("20000000-0000-7000-8000-000000000003");
const FIELD_4 = testUuid("20000000-0000-7000-8000-000000000004");
const FIELD_5 = testUuid("20000000-0000-7000-8000-000000000005");
const FIELD_6 = testUuid("20000000-0000-7000-8000-000000000006");
const FIELD_7 = testUuid("20000000-0000-7000-8000-000000000007");
const FIELD_8 = testUuid("20000000-0000-7000-8000-000000000008");

const REVISION = "1" as LookupRevision;

function definition(
	id: LookupTableId,
	name: string,
	columns: LookupTableDefinition["columns"],
): LookupTableDefinition {
	return {
		id,
		name,
		tag: name.toLowerCase(),
		definitionRevision: REVISION,
		columns,
	};
}

const LOOKUP_CONTEXT: LookupValidationContext = {
	kind: "available",
	projectId: "project-1",
	projectRevision: REVISION,
	definitions: [
		definition(TABLE_A, "TableA", [
			{ id: TEXT_A, wireName: "label", label: "Label", dataType: "text" },
			{ id: INT_A, wireName: "rank", label: "Rank", dataType: "int" },
			{ id: DATE_A, wireName: "day", label: "Day", dataType: "date" },
		]),
		definition(TABLE_B, "TableB", [
			{ id: TEXT_B, wireName: "label", label: "Label", dataType: "text" },
		]),
	],
};

function optionsSource(
	filter: Predicate,
	tableId: LookupTableId = TABLE_A,
	valueColumnId: LookupColumnId = TEXT_A,
	labelColumnId: LookupColumnId = TEXT_A,
) {
	return {
		kind: "lookup" as const,
		tableId,
		valueColumnId,
		labelColumnId,
		filter,
	};
}

function select(
	uuid: Uuid,
	id: string,
	filter: Predicate,
	order = "b",
): FieldSpec {
	return f({
		uuid,
		order,
		kind: "single_select",
		id,
		label: id,
		optionsSource: optionsSource(filter),
	});
}

function surveyDoc(
	fields: FieldSpec[],
	patch: {
		readonly caseAware?: boolean;
	} = {},
): BlueprintDoc {
	return buildDoc({
		appName: "Lookup choices",
		caseTypes: patch.caseAware
			? [
					{
						name: "patient",
						properties: [
							{ name: "region", label: "Region", data_type: "text" },
						],
					},
				]
			: null,
		modules: [
			{
				name: "Survey",
				...(patch.caseAware && {
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("lookup-test-column"), "region", "Region"),
						],
						listColumnOrder: [testUuid("lookup-test-column")],
						detailColumnOrder: [testUuid("lookup-test-column")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("lookup-test-input"),
								"region_query",
								"Region",
								"text",
								"region",
							),
						],
					},
				}),
				forms: [{ name: "Visit", type: "survey", fields }],
			},
		],
	});
}

function semanticFindings(doc: BlueprintDoc) {
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	return validateLookupOptionsSources(
		doc,
		formUuid,
		moduleUuid,
		lookupTypeIndex(LOOKUP_CONTEXT),
	);
}

describe("lookup-backed select filter semantics", () => {
	it("admits same-row columns, earlier hidden answers, session values, and composed operators", () => {
		const doc = surveyDoc([
			f({
				uuid: FIELD_1,
				kind: "hidden",
				id: "seed",
				default_value: "'north'",
			}),
			select(
				FIELD_2,
				"district",
				and(
					eq(tableColumn(TABLE_A, TEXT_A), literal("North")),
					eq(
						concat(
							term(formField(FIELD_1)),
							term(sessionUser("assigned_region")),
						),
						literal("northNorth"),
					),
					eq(tableColumn(TABLE_A, DATE_A), today()),
				),
			),
		]);

		expect(semanticFindings(doc)).toEqual([]);
	});

	it("reports only the read that sits BELOW the select in the form", () => {
		// A filter may read an answer the worker has already given, which is
		// exactly the fields above it. This select reads one of each.
		const doc = surveyDoc([
			f({
				uuid: FIELD_3,
				kind: "text",
				id: "above",
				label: proseText("Above"),
			}),
			select(
				FIELD_2,
				"choice",
				and(
					eq(formField(FIELD_1), literal("yes")),
					eq(formField(FIELD_3), literal("M")),
				),
				"same",
			),
			f({
				uuid: FIELD_1,
				kind: "text",
				id: "below",
				label: proseText("Below"),
			}),
		]);

		const findings = semanticFindings(doc);
		expect(findings.map((finding) => finding.code)).toEqual([
			"LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER",
		]);
		expect(findings[0].details?.referencedFieldUuid).toBe(FIELD_1);
	});

	it("rejects missing and non-value form-field leaves", () => {
		const doc = surveyDoc([
			f({
				uuid: FIELD_1,
				kind: "label",
				id: "instructions",
				label: proseText("Instructions"),
			}),
			select(
				FIELD_2,
				"choice",
				and(
					eq(formField(FIELD_1), literal("label")),
					eq(formField(FIELD_8), literal("missing")),
				),
				"b",
			),
		]);

		const findings = semanticFindings(doc);
		expect(findings.map((finding) => finding.code)).toEqual([
			"LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED",
			"LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED",
		]);
		expect(findings.map((finding) => finding.details?.target)).toEqual([
			`field:${FIELD_1}`,
			`field:${FIELD_8}`,
		]);
	});

	it("carries multi-select answer types into compatible and incompatible operators", () => {
		const multiSelect = f({
			uuid: FIELD_3,
			kind: "multi_select",
			id: "many_choices",
			label: proseText("Many choices"),
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
		});
		const compatible = surveyDoc([
			multiSelect,
			select(
				FIELD_2,
				"compatible_choice",
				eq(formField(FIELD_3), literal("a")),
				"b",
			),
		]);
		expect(semanticFindings(compatible)).toEqual([]);

		const incompatible = surveyDoc([
			multiSelect,
			select(
				FIELD_2,
				"incompatible_choice",
				gt(formField(FIELD_3), literal("a")),
				"b",
			),
		]);
		expect(semanticFindings(incompatible)).toEqual([
			expect.objectContaining({
				code: "LOOKUP_SELECT_FILTER_TYPE_ERROR",
				message: expect.stringContaining("multi_select"),
				details: expect.objectContaining({ checkCode: "ordered-values" }),
			}),
		]);
	});

	it("admits current/enclosing repeat answers and rejects child or sibling repeat answers", () => {
		const valid = surveyDoc([
			f({
				uuid: FIELD_1,
				kind: "text",
				id: "root",
				label: proseText("Root"),
			}),
			f({
				uuid: FIELD_2,
				kind: "repeat",
				id: "outer",
				label: proseText("Outer"),
				children: [
					f({
						uuid: FIELD_3,
						kind: "text",
						id: "outer_value",
						label: proseText("Outer value"),
					}),
					f({
						uuid: FIELD_4,
						kind: "repeat",
						id: "inner",
						label: proseText("Inner"),
						children: [
							f({
								uuid: FIELD_5,
								kind: "text",
								id: "inner_value",
								label: proseText("Inner value"),
							}),
							select(
								FIELD_6,
								"nested_choice",
								and(
									eq(formField(FIELD_1), literal("root")),
									eq(formField(FIELD_3), literal("outer")),
									eq(formField(FIELD_5), literal("inner")),
								),
								"b",
							),
						],
					}),
				],
			}),
		]);
		expect(semanticFindings(valid)).toEqual([]);

		const invalid = surveyDoc([
			f({
				uuid: FIELD_1,
				kind: "repeat",
				id: "left",
				label: proseText("Left"),
				children: [
					f({
						uuid: FIELD_2,
						kind: "text",
						id: "left_value",
						label: proseText("Left value"),
					}),
					select(
						FIELD_3,
						"left_choice",
						and(
							eq(formField(FIELD_5), literal("child")),
							eq(formField(FIELD_8), literal("sibling")),
						),
						"c",
					),
					f({
						uuid: FIELD_4,
						kind: "repeat",
						id: "child",
						label: proseText("Child"),
						children: [
							f({
								uuid: FIELD_5,
								kind: "text",
								id: "child_value",
								label: proseText("Child value"),
							}),
						],
					}),
				],
			}),
			f({
				uuid: FIELD_7,
				kind: "repeat",
				id: "right",
				label: proseText("Right"),
				children: [
					f({
						uuid: FIELD_8,
						kind: "text",
						id: "right_value",
						label: proseText("Right value"),
					}),
				],
			}),
		]);

		const repeatFindings = semanticFindings(invalid).filter(
			(finding) => finding.code === "LOOKUP_SELECT_FILTER_FIELD_REPEAT_SCOPE",
		);
		expect(
			repeatFindings.map((finding) => finding.details?.referencedFieldUuid),
		).toEqual([FIELD_5, FIELD_8]);
		expect(
			semanticFindings(invalid).some(
				(finding) => finding.code === "LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER",
			),
		).toBe(false);
	});

	it("rejects case and Search leaves while leaving the containing operators available", () => {
		const doc = surveyDoc(
			[
				select(
					FIELD_2,
					"choice",
					and(
						eq(prop("patient", "region"), literal("North")),
						eq(input(testUuid("region_query")), literal("North")),
					),
				),
			],
			{ caseAware: true },
		);

		const findings = semanticFindings(doc);
		expect(findings.map((finding) => finding.code)).toEqual([
			"LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED",
			"LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED",
		]);
		expect(findings.map((finding) => finding.details?.reason).sort()).toEqual([
			"case-data",
			"search-input",
		]);
	});

	it("surfaces other-table columns, nested lookups, and same-table operator mismatches", () => {
		const cases = [
			{
				filter: eq(tableColumn(TABLE_B, TEXT_B), literal("x")),
				checkCode: "lookup-table-scope",
			},
			{
				filter: eq(tableLookup(TABLE_B, TEXT_B, matchAll()), literal("x")),
				checkCode: "lookup-table-scope",
			},
			{
				filter: gt(tableColumn(TABLE_A, TEXT_A), literal("M")),
				checkCode: "ordered-values",
			},
		] as const;

		for (const [index, testCase] of cases.entries()) {
			const doc = surveyDoc([
				select(FIELD_2, `choice_${index}`, testCase.filter),
			]);
			const findings = semanticFindings(doc);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				code: "LOOKUP_SELECT_FILTER_TYPE_ERROR",
				details: { checkCode: testCase.checkCode },
			});
		}
	});
});

describe("lookup type-context integration", () => {
	it("leaves missing table/column identity to structural lookup findings", () => {
		const missingTableDoc = surveyDoc([
			{
				...select(
					FIELD_2,
					"missing_table",
					eq(tableColumn(MISSING_TABLE, MISSING_COLUMN), literal("x")),
				),
				optionsSource: optionsSource(
					eq(tableColumn(MISSING_TABLE, MISSING_COLUMN), literal("x")),
					MISSING_TABLE,
					MISSING_COLUMN,
					MISSING_COLUMN,
				),
			},
		]);
		const missingTableFindings = runValidation(
			missingTableDoc,
			LOOKUP_CONTEXT,
		).filter((finding) => finding.location.fieldUuid === FIELD_2);
		expect(
			new Set(
				missingTableFindings
					.filter((finding) => finding.code.startsWith("LOOKUP_"))
					.map((finding) => finding.code),
			),
		).toEqual(new Set(["LOOKUP_TABLE_NOT_AVAILABLE"]));
		expect(
			missingTableFindings.some(
				(finding) => finding.code === "LOOKUP_SELECT_FILTER_TYPE_ERROR",
			),
		).toBe(false);

		const missingColumnDoc = surveyDoc([
			select(
				FIELD_2,
				"missing_column",
				eq(tableColumn(TABLE_A, MISSING_COLUMN), literal("x")),
			),
		]);
		const missingColumnFindings = runValidation(
			missingColumnDoc,
			LOOKUP_CONTEXT,
		).filter((finding) => finding.location.fieldUuid === FIELD_2);
		expect(
			new Set(
				missingColumnFindings
					.filter((finding) => finding.code.startsWith("LOOKUP_"))
					.map((finding) => finding.code),
			),
		).toEqual(new Set(["LOOKUP_COLUMN_NOT_AVAILABLE"]));
		expect(
			missingColumnFindings.some(
				(finding) => finding.code === "LOOKUP_SELECT_FILTER_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("continues field-order policy checks when the source table is missing", () => {
		const doc = surveyDoc([
			{
				...select(
					FIELD_2,
					"missing_table_with_later_answer",
					eq(formField(FIELD_3), literal("later")),
					"a",
				),
				optionsSource: optionsSource(
					eq(formField(FIELD_3), literal("later")),
					MISSING_TABLE,
					MISSING_COLUMN,
					MISSING_COLUMN,
				),
			},
			f({
				uuid: FIELD_3,
				kind: "text",
				id: "later",
				label: proseText("Later"),
			}),
		]);

		const findings = runValidation(doc, LOOKUP_CONTEXT);
		expect(
			findings.some((finding) => finding.code === "LOOKUP_TABLE_NOT_AVAILABLE"),
		).toBe(true);
		expect(
			findings.some(
				(finding) => finding.code === "LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER",
			),
		).toBe(true);
		expect(
			findings.some(
				(finding) => finding.code === "LOOKUP_SELECT_FILTER_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("walks only reachable forms semantically while structural extraction still sees detached carriers", () => {
		const doc = surveyDoc([
			{
				...select(
					FIELD_2,
					"detached",
					eq(formField(FIELD_3), literal("future")),
				),
				optionsSource: optionsSource(
					eq(formField(FIELD_3), literal("future")),
					MISSING_TABLE,
					MISSING_COLUMN,
					MISSING_COLUMN,
				),
			},
			f({
				uuid: FIELD_3,
				kind: "text",
				id: "future",
				label: proseText("Future"),
			}),
		]);
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		doc.fieldOrder[formUuid] = doc.fieldOrder[formUuid].filter(
			(uuid) => uuid !== FIELD_2,
		);

		const findings = runValidation(doc, LOOKUP_CONTEXT);
		expect(
			findings.some(
				(finding) =>
					finding.code === "LOOKUP_TABLE_NOT_AVAILABLE" &&
					finding.location.fieldUuid === FIELD_2,
			),
		).toBe(true);
		expect(
			findings.some(
				(finding) =>
					finding.location.fieldUuid === FIELD_2 &&
					(finding.code === "LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER" ||
						finding.code === "LOOKUP_SELECT_FILTER_TYPE_ERROR"),
			),
		).toBe(false);
	});

	it("threads lookup result types through module, form, and case-operation slots", () => {
		const lookupText = tableLookup(
			TABLE_A,
			TEXT_A,
			eq(tableColumn(TABLE_A, TEXT_A), literal("North")),
		);
		const lookupInt = tableLookup(
			TABLE_A,
			INT_A,
			eq(tableColumn(TABLE_A, TEXT_A), literal("North")),
		);
		const doc = buildDoc({
			appName: "Lookup carriers",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "rank", label: proseText("Rank"), data_type: "int" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					displayCondition: eq(lookupText, literal("North")),
					caseListConfig: {
						columns: [
							plainColumn(testUuid("lookup-carrier-name"), "case_name", "Name"),
							calculatedColumn(
								testUuid("lookup-carrier-rank"),
								"Rank",
								lookupInt,
							),
						],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("lookup-carrier-default"),
								"case_name_query",
								"Name",
								"text",
								"case_name",
								{ default: lookupText },
							),
							advancedSearchInputDef(
								testUuid("lookup-carrier-advanced"),
								"advanced_query",
								"Advanced",
								"text",
								eq(lookupText, literal("North")),
							),
						],
						filter: eq(lookupText, literal("North")),
					},
					caseSearchConfig: {
						searchButtonDisplayCondition: eq(lookupText, literal("North")),
						excludedOwnerIds: lookupText,
					},
					forms: [
						{
							name: "Update",
							type: "followup",
							displayCondition: eq(lookupText, literal("North")),
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		doc.forms[formUuid].caseOperations = [
			{
				uuid: testUuid("lookup-carrier-create-operation"),
				id: "create_patient",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				name: lookupText,
			},
			{
				uuid: testUuid("lookup-carrier-operation"),
				id: "update_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "expression", expr: lookupText },
				condition: eq(lookupText, literal("North")),
				owner: lookupText,
				rename: lookupText,
				writes: [
					{
						property: "rank",
						value: lookupInt,
						condition: eq(lookupText, literal("North")),
					},
				],
				links: [
					{
						identifier: "related_patient",
						targetType: "patient",
						target: { kind: "expression", expr: lookupText },
						relationship: "child",
					},
				],
			},
		];

		const findings = runValidation(doc, LOOKUP_CONTEXT);
		expect(
			findings.some(
				(finding) =>
					finding.code === "MODULE_DISPLAY_CONDITION_TYPE_ERROR" ||
					finding.code === "FORM_DISPLAY_CONDITION_TYPE_ERROR" ||
					finding.code === "CASE_LIST_FILTER_TYPE_ERROR" ||
					finding.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR" ||
					finding.code === "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR" ||
					finding.code === "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR" ||
					finding.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR" ||
					finding.code === "CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR" ||
					(finding.code === "CASE_OPERATION_EXPRESSION_TYPE" &&
						finding.message.includes("is not valid here")),
			),
		).toBe(false);
	});

	it("observes resolved lookup result types at every module and form carrier", () => {
		const lookupText = tableLookup(TABLE_A, TEXT_A, matchAll());
		const lookupInt = tableLookup(TABLE_A, INT_A, matchAll());
		const wrongPredicate = eq(lookupInt, literal("North"));
		const calculatedUuid = testUuid("typed-lookup-carrier-rank");
		const defaultInputUuid = testUuid("typed-lookup-carrier-default");
		const advancedInputUuid = testUuid("typed-lookup-carrier-advanced");
		const doc = buildDoc({
			appName: "Typed lookup carriers",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "rank", label: proseText("Rank"), data_type: "int" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					displayCondition: wrongPredicate,
					caseListConfig: {
						columns: [
							plainColumn(
								testUuid("typed-lookup-carrier-name"),
								"case_name",
								"Name",
							),
							calculatedColumn(
								calculatedUuid,
								"Rank",
								arith("+", lookupText, term(literal(1))),
							),
						],
						searchInputs: [
							simpleSearchInputDef(
								defaultInputUuid,
								"case_name_query",
								"Name",
								"text",
								"case_name",
								{ default: lookupInt },
							),
							advancedSearchInputDef(
								advancedInputUuid,
								"advanced_query",
								"Advanced",
								"text",
								wrongPredicate,
							),
						],
						filter: wrongPredicate,
					},
					caseSearchConfig: {
						searchButtonDisplayCondition: wrongPredicate,
						excludedOwnerIds: lookupInt,
					},
					forms: [
						{
							name: "Update",
							type: "followup",
							displayCondition: wrongPredicate,
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];

		const findings = runValidation(doc, LOOKUP_CONTEXT);
		expect(findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "MODULE_DISPLAY_CONDITION_TYPE_ERROR",
					location: expect.objectContaining({ moduleUuid }),
				}),
				expect.objectContaining({
					code: "FORM_DISPLAY_CONDITION_TYPE_ERROR",
					location: expect.objectContaining({ formUuid }),
				}),
				expect.objectContaining({
					code: "CASE_LIST_FILTER_TYPE_ERROR",
					location: expect.objectContaining({ moduleUuid }),
				}),
				expect.objectContaining({
					code: "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
					details: expect.objectContaining({ columnUuid: calculatedUuid }),
				}),
				expect.objectContaining({
					code: "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
					details: expect.objectContaining({
						inputUuid: defaultInputUuid,
						expectedType: "text",
					}),
				}),
				expect.objectContaining({
					code: "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
					details: expect.objectContaining({ inputUuid: advancedInputUuid }),
				}),
				expect.objectContaining({
					code: "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
					details: expect.objectContaining({
						slot: "caseSearchConfig.searchButtonDisplayCondition",
					}),
				}),
				expect.objectContaining({
					code: "CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR",
					details: expect.objectContaining({
						slot: "caseSearchConfig.excludedOwnerIds",
					}),
				}),
			]),
		);
	});

	it("observes resolved lookup result types in each case-operation carrier", () => {
		const lookupText = tableLookup(TABLE_A, TEXT_A, matchAll());
		const lookupInt = tableLookup(TABLE_A, INT_A, matchAll());
		const wrongPredicate = eq(lookupInt, literal("North"));
		const baseUpdate = {
			action: "update" as const,
			caseType: "patient",
			target: { kind: "session" as const },
		};
		const cases: readonly {
			readonly label: string;
			readonly operation: CaseOperation;
		}[] = [
			{
				label: "target expression",
				operation: {
					...baseUpdate,
					uuid: testUuid("typed-operation-target"),
					id: "target_expression",
					target: { kind: "expression", expr: lookupInt },
				},
			},
			{
				label: "condition",
				operation: {
					...baseUpdate,
					uuid: testUuid("typed-operation-condition"),
					id: "condition",
					condition: wrongPredicate,
				},
			},
			{
				label: "create name",
				operation: {
					uuid: testUuid("typed-operation-name"),
					id: "create_name",
					action: "create",
					caseType: "patient",
					target: { kind: "new" },
					name: lookupInt,
				},
			},
			{
				label: "owner",
				operation: {
					...baseUpdate,
					uuid: testUuid("typed-operation-owner"),
					id: "owner",
					owner: lookupInt,
				},
			},
			{
				label: "rename",
				operation: {
					...baseUpdate,
					uuid: testUuid("typed-operation-rename"),
					id: "rename",
					rename: lookupInt,
				},
			},
			{
				label: "write value",
				operation: {
					...baseUpdate,
					uuid: testUuid("typed-operation-write-value"),
					id: "write_value",
					writes: [{ property: "rank", value: lookupText }],
				},
			},
			{
				label: "write condition",
				operation: {
					...baseUpdate,
					uuid: testUuid("typed-operation-write-condition"),
					id: "write_condition",
					writes: [
						{
							property: "rank",
							value: lookupInt,
							condition: wrongPredicate,
						},
					],
				},
			},
			{
				label: "link target expression",
				operation: {
					...baseUpdate,
					uuid: testUuid("typed-operation-link-target"),
					id: "link_target",
					links: [
						{
							identifier: "related_patient",
							targetType: "patient",
							target: { kind: "expression", expr: lookupInt },
							relationship: "child",
						},
					],
				},
			},
		];

		for (const testCase of cases) {
			const doc = buildDoc({
				appName: "Typed case-operation carrier",
				caseTypes: [
					{
						name: "patient",
						properties: [
							{
								name: "case_name",
								label: proseText("Name"),
								data_type: "text",
							},
							{ name: "rank", label: proseText("Rank"), data_type: "int" },
						],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: {
							columns: [
								plainColumn(
									testUuid("typed-operation-case-name"),
									"case_name",
									"Name",
								),
							],
							listColumnOrder: [testUuid("typed-operation-case-name")],
							detailColumnOrder: [testUuid("typed-operation-case-name")],
							searchInputs: [],
						},
						forms: [
							{
								name: "Update",
								type: "followup",
								fields: [
									f({
										kind: "text",
										id: "case_name",
										label: proseText("Name"),
										case_property_on: "patient",
									}),
								],
							},
						],
					},
				],
			});
			const moduleUuid = doc.moduleOrder[0];
			const formUuid = doc.formOrder[moduleUuid][0];
			doc.forms[formUuid].caseOperations = [testCase.operation];

			const typeFindings = runValidation(doc, LOOKUP_CONTEXT).filter(
				(finding) =>
					finding.code === "CASE_OPERATION_EXPRESSION_TYPE" &&
					finding.details?.operationUuid === testCase.operation.uuid &&
					finding.message.includes("not valid here"),
			);
			expect(typeFindings, testCase.label).toHaveLength(1);
		}
	});

	it("leaves missing carrier identities structural across module, form, and case-operation slots", () => {
		const missingText = tableLookup(MISSING_TABLE, MISSING_COLUMN, matchAll());
		const doc = buildDoc({
			appName: "Missing lookup carriers",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					displayCondition: eq(missingText, literal("North")),
					caseListConfig: {
						columns: [
							plainColumn(
								testUuid("missing-lookup-carrier-name"),
								"case_name",
								"Name",
							),
							calculatedColumn(
								testUuid("missing-lookup-carrier-value"),
								"Lookup value",
								missingText,
							),
						],
						searchInputs: [],
						filter: eq(missingText, literal("North")),
					},
					forms: [
						{
							name: "Update",
							type: "followup",
							displayCondition: eq(missingText, literal("North")),
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		doc.forms[formUuid].caseOperations = [
			{
				uuid: testUuid("missing-lookup-carrier-operation"),
				id: "update_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: eq(missingText, literal("North")),
				writes: [{ property: "case_name", value: missingText }],
			},
		];

		const findings = runValidation(doc, LOOKUP_CONTEXT);
		expect(
			findings.some((finding) => finding.code === "LOOKUP_TABLE_NOT_AVAILABLE"),
		).toBe(true);
		expect(
			findings.some(
				(finding) =>
					finding.code === "MODULE_DISPLAY_CONDITION_TYPE_ERROR" ||
					finding.code === "FORM_DISPLAY_CONDITION_TYPE_ERROR" ||
					finding.code === "CASE_LIST_FILTER_TYPE_ERROR" ||
					finding.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR" ||
					(finding.code === "CASE_OPERATION_EXPRESSION_TYPE" &&
						finding.message.includes("is not valid here")),
			),
		).toBe(false);
	});

	it("does not turn an unavailable snapshot into generic containing-slot type errors", () => {
		const doc = surveyDoc([
			select(
				FIELD_2,
				"choice",
				eq(tableColumn(TABLE_A, TEXT_A), literal("North")),
			),
		]);
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);

		expect(
			findings.some(
				(finding) => finding.code === "LOOKUP_SELECT_FILTER_TYPE_ERROR",
			),
		).toBe(false);
		expect(
			findings.some((finding) => finding.code === "LOOKUP_CONTEXT_UNAVAILABLE"),
		).toBe(true);
	});
});
