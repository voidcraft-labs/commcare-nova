import { describe, expect, it } from "vitest";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	asUuid,
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

const FIELD_1 = asUuid("20000000-0000-7000-8000-000000000001");
const FIELD_2 = asUuid("20000000-0000-7000-8000-000000000002");
const FIELD_3 = asUuid("20000000-0000-7000-8000-000000000003");
const FIELD_4 = asUuid("20000000-0000-7000-8000-000000000004");
const FIELD_5 = asUuid("20000000-0000-7000-8000-000000000005");
const FIELD_6 = asUuid("20000000-0000-7000-8000-000000000006");
const FIELD_7 = asUuid("20000000-0000-7000-8000-000000000007");
const FIELD_8 = asUuid("20000000-0000-7000-8000-000000000008");

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
		kind: "lookup-table" as const,
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
		options: [
			{
				uuid: asUuid("21000000-0000-7000-8000-000000000001"),
				order: "a",
				value: "a",
				label: "A",
			},
			{
				uuid: asUuid("21000000-0000-7000-8000-000000000002"),
				order: "b",
				value: "b",
				label: "B",
			},
		],
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
							plainColumn(asUuid("lookup-test-column"), "region", "Region"),
						],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("lookup-test-input"),
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
				order: "a",
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

	it("uses effective (order, uuid) DFS rather than membership-array position", () => {
		const doc = surveyDoc([
			// Membership is deliberately late, select, early. Equal authored
			// order keys force uuid to decide the effective sequence.
			f({
				uuid: FIELD_3,
				order: "same",
				kind: "text",
				id: "late",
				label: "Late",
			}),
			select(
				FIELD_2,
				"choice",
				and(
					eq(formField(FIELD_1), literal("yes")),
					gt(formField(FIELD_3), literal("M")),
				),
				"same",
			),
			f({
				uuid: FIELD_1,
				order: "same",
				kind: "text",
				id: "early",
				label: "Early",
			}),
		]);

		const findings = semanticFindings(doc);
		expect(findings.map((finding) => finding.code)).toEqual([
			"LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER",
		]);
		expect(findings[0].details?.referencedFieldUuid).toBe(FIELD_3);
	});

	it("rejects missing and non-value form-field leaves", () => {
		const doc = surveyDoc([
			f({
				uuid: FIELD_1,
				order: "a",
				kind: "label",
				id: "instructions",
				label: "Instructions",
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
			order: "a",
			kind: "multi_select",
			id: "many_choices",
			label: "Many choices",
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
				order: "a",
				kind: "text",
				id: "root",
				label: "Root",
			}),
			f({
				uuid: FIELD_2,
				order: "b",
				kind: "repeat",
				id: "outer",
				label: "Outer",
				children: [
					f({
						uuid: FIELD_3,
						order: "a",
						kind: "text",
						id: "outer_value",
						label: "Outer value",
					}),
					f({
						uuid: FIELD_4,
						order: "b",
						kind: "repeat",
						id: "inner",
						label: "Inner",
						children: [
							f({
								uuid: FIELD_5,
								order: "a",
								kind: "text",
								id: "inner_value",
								label: "Inner value",
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
				order: "a",
				kind: "repeat",
				id: "left",
				label: "Left",
				children: [
					f({
						uuid: FIELD_2,
						order: "a",
						kind: "text",
						id: "left_value",
						label: "Left value",
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
						order: "b",
						kind: "repeat",
						id: "child",
						label: "Child",
						children: [
							f({
								uuid: FIELD_5,
								order: "a",
								kind: "text",
								id: "child_value",
								label: "Child value",
							}),
						],
					}),
				],
			}),
			f({
				uuid: FIELD_7,
				order: "b",
				kind: "repeat",
				id: "right",
				label: "Right",
				children: [
					f({
						uuid: FIELD_8,
						order: "a",
						kind: "text",
						id: "right_value",
						label: "Right value",
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
						eq(input("region_query"), literal("North")),
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
				order: "b",
				kind: "text",
				id: "later",
				label: "Later",
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
				label: "Future",
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
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "rank", label: "Rank", data_type: "int" },
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
							plainColumn(asUuid("lookup-carrier-name"), "case_name", "Name"),
							calculatedColumn(
								asUuid("lookup-carrier-rank"),
								"Rank",
								lookupInt,
							),
						],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("lookup-carrier-default"),
								"case_name_query",
								"Name",
								"text",
								"case_name",
								{ default: lookupText },
							),
							advancedSearchInputDef(
								asUuid("lookup-carrier-advanced"),
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
									label: "Name",
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
				uuid: asUuid("lookup-carrier-create-operation"),
				id: "create_patient",
				order: "a",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				name: lookupText,
			},
			{
				uuid: asUuid("lookup-carrier-operation"),
				id: "update_patient",
				order: "b",
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
		const calculatedUuid = asUuid("typed-lookup-carrier-rank");
		const defaultInputUuid = asUuid("typed-lookup-carrier-default");
		const advancedInputUuid = asUuid("typed-lookup-carrier-advanced");
		const doc = buildDoc({
			appName: "Typed lookup carriers",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "rank", label: "Rank", data_type: "int" },
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
								asUuid("typed-lookup-carrier-name"),
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
									label: "Name",
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
			order: "a",
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
					uuid: asUuid("typed-operation-target"),
					id: "target_expression",
					target: { kind: "expression", expr: lookupInt },
				},
			},
			{
				label: "condition",
				operation: {
					...baseUpdate,
					uuid: asUuid("typed-operation-condition"),
					id: "condition",
					condition: wrongPredicate,
				},
			},
			{
				label: "create name",
				operation: {
					uuid: asUuid("typed-operation-name"),
					id: "create_name",
					order: "a",
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
					uuid: asUuid("typed-operation-owner"),
					id: "owner",
					owner: lookupInt,
				},
			},
			{
				label: "rename",
				operation: {
					...baseUpdate,
					uuid: asUuid("typed-operation-rename"),
					id: "rename",
					rename: lookupInt,
				},
			},
			{
				label: "write value",
				operation: {
					...baseUpdate,
					uuid: asUuid("typed-operation-write-value"),
					id: "write_value",
					writes: [{ property: "rank", value: lookupText }],
				},
			},
			{
				label: "write condition",
				operation: {
					...baseUpdate,
					uuid: asUuid("typed-operation-write-condition"),
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
					uuid: asUuid("typed-operation-link-target"),
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
							{ name: "case_name", label: "Name", data_type: "text" },
							{ name: "rank", label: "Rank", data_type: "int" },
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
									asUuid("typed-operation-case-name"),
									"case_name",
									"Name",
								),
							],
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
										label: "Name",
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
					properties: [{ name: "case_name", label: "Name", data_type: "text" }],
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
								asUuid("missing-lookup-carrier-name"),
								"case_name",
								"Name",
							),
							calculatedColumn(
								asUuid("missing-lookup-carrier-value"),
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
									label: "Name",
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
				uuid: asUuid("missing-lookup-carrier-operation"),
				id: "update_patient",
				order: "a",
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
