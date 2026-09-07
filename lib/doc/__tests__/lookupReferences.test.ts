import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	canonicalLookupReferenceSubpath,
	collectLookupOptionsSourceCarriers,
	describeLookupOptionsSourceOwner,
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	extractLookupReferenceOccurrences,
	extractLookupReferenceTargets,
	type LookupReferenceExtractorRegistry,
	type LookupValidationContext,
	lookupReferenceTargetsFromOccurrences,
	normalizeLookupReferenceTargetSet,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
	unionLookupReferenceTargetSets,
} from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	calculatedColumn,
	hiddenSearchInputDef,
	plainColumn,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	eq,
	literal,
	type Predicate,
	prop,
	tableColumn,
	tableLookup,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { assertAdmittedDoc } from "./admittedDoc";

const tableId = (suffix: string) =>
	lookupTableIdSchema.parse(
		`00000000-0000-7000-8000-${suffix.padStart(12, "0")}`,
	);
const columnId = (suffix: string) =>
	lookupColumnIdSchema.parse(
		`10000000-0000-7000-8000-${suffix.padStart(12, "0")}`,
	);

const lookupContext: LookupValidationContext = {
	kind: "available",
	projectId: "project",
	projectRevision: parseLookupRevision("1"),
	definitions: [...Array.from({ length: 23 }, (_, i) => i + 1), 30, 40].map(
		(seed) => ({
			id: tableId(String(seed)),
			name: `Table ${seed}`,
			tag: `table_${seed}`,
			definitionRevision: parseLookupRevision("1"),
			columns: [1, 2, 3].map((offset) => ({
				id: columnId(String(seed * 10 + offset)),
				wireName: `column_${offset}`,
				label: `Column ${offset}`,
				dataType: "text",
			})),
		}),
	),
};
function surveyDoc() {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: "Notes" }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function lookupExpression(seed: number): ValueExpression {
	const table = tableId(String(seed));
	return tableLookup(
		table,
		columnId(String(seed * 10 + 1)),
		eq(
			tableColumn(table, columnId(String(seed * 10 + 2))),
			literal(`value-${seed}`),
		),
	);
}

function lookupPredicate(seed: number): Predicate {
	return eq(lookupExpression(seed), literal(`result-${seed}`));
}

type ExpectedOccurrence = readonly [
	registrySlot: string,
	carrierUuid: Uuid,
	subpath: string,
	tableId: LookupTableId,
	columnId: LookupColumnId,
];

function expectedExpressionOccurrences(
	registrySlot: string,
	carrierUuid: Uuid,
	seed: number,
	prefix = "",
): ExpectedOccurrence[] {
	const table = tableId(String(seed));
	return [
		[
			registrySlot,
			carrierUuid,
			`${prefix}/k:resultColumnId`,
			table,
			columnId(String(seed * 10 + 1)),
		],
		[
			registrySlot,
			carrierUuid,
			`${prefix}/k:where/k:left/k:term/k:columnId`,
			table,
			columnId(String(seed * 10 + 2)),
		],
	];
}

function expectedPredicateOccurrences(
	registrySlot: string,
	carrierUuid: Uuid,
	seed: number,
	prefix = "",
): ExpectedOccurrence[] {
	return expectedExpressionOccurrences(
		registrySlot,
		carrierUuid,
		seed,
		`${prefix}/k:left`,
	);
}

describe("lookup reference extraction", () => {
	it("keeps the production registry immutable and ordinary documents carrier-free", () => {
		const doc = surveyDoc();
		expect(Object.isFrozen(PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS)).toBe(true);
		expect(PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS.length).toBeGreaterThan(0);
		expect(PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS.every(Object.isFrozen)).toBe(
			true,
		);
		expect(
			extractLookupReferenceOccurrences(
				doc,
				PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
			),
		).toEqual([]);
		expect(extractLookupReferenceTargets(doc)).toBe(
			EMPTY_LOOKUP_REFERENCE_TARGETS,
		);
	});

	it("extracts admitted choice, search, condition and operation carriers by owner and exact path", () => {
		const moduleUuid = testUuid("module-lookup");
		const formUuid = testUuid("form-lookup");
		const fieldUuid = testUuid("field-lookup");
		const columnUuid = testUuid("column-lookup");
		const simpleInputUuid = testUuid("search-simple");
		const advancedInputUuid = testUuid("search-advanced");
		const selectInputUuid = testUuid("search-select");
		const hiddenInputUuid = testUuid("search-hidden");
		const operationUuid = testUuid("operation-lookup");
		const createUuid = testUuid("create-lookup");
		const sourceTable = tableId("1");
		const choiceTable = tableId("3");

		const doc = buildDoc({
			appName: "All lookup carriers",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "region", label: "Region", data_type: "text" },
						{ name: "visit_status", label: "Status", data_type: "text" },
					],
					parent_type: "household",
				},
				{ name: "household", properties: [] },
			],
			modules: [
				{
					uuid: moduleUuid,
					name: "Cases",
					caseType: "patient",
					displayCondition: lookupPredicate(3),
					caseListConfig: {
						columns: [
							calculatedColumn(columnUuid, "Calculated", lookupExpression(4)),
						],
						filter: eq(prop("patient", "region"), lookupExpression(5)),
						searchInputs: [
							simpleSearchInputDef(
								simpleInputUuid,
								"simple",
								"Simple",
								"text",
								"case_name",
								{ default: lookupExpression(6) },
							),
							advancedSearchInputDef(
								advancedInputUuid,
								"advanced",
								"Advanced",
								"text",
								eq(prop("patient", "region"), lookupExpression(8)),
								{
									default: lookupExpression(7),
									required: { when: lookupPredicate(20) },
									validation: {
										rule: lookupPredicate(21),
										message: "Pick a listed value.",
									},
								},
							),
							simpleSearchInputDef(
								selectInputUuid,
								"region",
								"Region",
								"select",
								"region",
								{
									options: {
										kind: "lookup",
										tableId: choiceTable,
										valueColumnId: columnId("31"),
										labelColumnId: columnId("32"),
										filter: eq(
											tableColumn(choiceTable, columnId("33")),
											literal("enabled"),
										),
									},
								},
							),
							hiddenSearchInputDef(
								hiddenInputUuid,
								"site",
								"Site",
								lookupExpression(23),
							),
						],
					},
					caseSearchConfig: {
						excludedOwnerIds: lookupExpression(9),
						searchButtonDisplayCondition: lookupPredicate(10),
					},
					forms: [
						{
							uuid: formUuid,
							name: "Visit",
							type: "survey",
							displayCondition: lookupPredicate(11),
							fields: [
								{
									uuid: fieldUuid,
									kind: "single_select",
									id: "choice",
									optionsSource: {
										kind: "lookup",
										tableId: sourceTable,
										valueColumnId: columnId("11"),
										labelColumnId: columnId("12"),
										filter: eq(
											tableColumn(sourceTable, columnId("13")),
											literal("enabled"),
										),
									},
								},
							],
						},
					],
				},
			],
		});

		doc.forms[formUuid].caseOperations = [
			{
				uuid: operationUuid,
				id: "lookup_operation",
				action: "update",
				caseType: "patient",
				target: { kind: "expression", expr: lookupExpression(12) },
				condition: lookupPredicate(13),
				owner: lookupExpression(15),
				rename: lookupExpression(16),
				writes: [
					{
						property: "visit_status",
						value: lookupExpression(17),
						condition: lookupPredicate(18),
					},
				],
				links: [
					{
						identifier: "parent",
						targetType: "household",
						target: {
							kind: "expression",
							expr: lookupExpression(19),
						},
						relationship: "child",
					},
				],
			},
			{
				uuid: createUuid,
				id: "create_lookup",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				name: lookupExpression(14),
			},
		];

		assertAdmittedDoc(doc, lookupContext);
		const occurrences = extractLookupReferenceOccurrences(
			doc,
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		);
		const expectedOccurrences: ExpectedOccurrence[] = [
			[
				"lookup_options_source",
				fieldUuid,
				"/k:valueColumnId",
				sourceTable,
				columnId("11"),
			],
			[
				"lookup_options_source",
				fieldUuid,
				"/k:labelColumnId",
				sourceTable,
				columnId("12"),
			],
			[
				"lookup_options_source",
				fieldUuid,
				"/k:filter/k:left/k:term/k:columnId",
				sourceTable,
				columnId("13"),
			],
			...expectedPredicateOccurrences(
				"module_display_condition",
				moduleUuid,
				3,
			),
			...expectedExpressionOccurrences(
				"case_list_column_expression",
				columnUuid,
				4,
			),
			...expectedExpressionOccurrences(
				"case_list_filter",
				moduleUuid,
				5,
				"/k:right",
			),
			...expectedExpressionOccurrences(
				"search_input_default",
				simpleInputUuid,
				6,
			),
			...expectedExpressionOccurrences(
				"search_input_default",
				advancedInputUuid,
				7,
			),
			...expectedExpressionOccurrences(
				"search_input_predicate",
				advancedInputUuid,
				8,
				"/k:right",
			),
			[
				"search_input_options",
				selectInputUuid,
				"/k:valueColumnId",
				choiceTable,
				columnId("31"),
			],
			[
				"search_input_options",
				selectInputUuid,
				"/k:labelColumnId",
				choiceTable,
				columnId("32"),
			],
			[
				"search_input_options",
				selectInputUuid,
				"/k:filter/k:left/k:term/k:columnId",
				choiceTable,
				columnId("33"),
			],
			...expectedPredicateOccurrences(
				"search_input_required_when",
				advancedInputUuid,
				20,
			),
			...expectedPredicateOccurrences(
				"search_input_validation_rule",
				advancedInputUuid,
				21,
			),
			...expectedExpressionOccurrences(
				"search_input_hidden_value",
				hiddenInputUuid,
				23,
			),
			...expectedExpressionOccurrences("excluded_owner_ids", moduleUuid, 9),
			...expectedPredicateOccurrences(
				"search_button_display_condition",
				moduleUuid,
				10,
			),
			...expectedPredicateOccurrences("form_display_condition", formUuid, 11),
			...expectedExpressionOccurrences(
				"case_operation_target_expression",
				operationUuid,
				12,
			),
			...expectedPredicateOccurrences(
				"case_operation_condition",
				operationUuid,
				13,
			),
			...expectedExpressionOccurrences("case_operation_name", createUuid, 14),
			...expectedExpressionOccurrences(
				"case_operation_owner",
				operationUuid,
				15,
			),
			...expectedExpressionOccurrences(
				"case_operation_rename",
				operationUuid,
				16,
			),
			...expectedExpressionOccurrences(
				"case_operation_write_value",
				operationUuid,
				17,
				"/k:property/k:visit_status",
			),
			...expectedPredicateOccurrences(
				"case_operation_write_condition",
				operationUuid,
				18,
				"/k:property/k:visit_status",
			),
			...expectedExpressionOccurrences(
				"case_operation_link_target_expression",
				operationUuid,
				19,
				"/k:identifier/k:parent",
			),
		];
		expect(
			occurrences
				.map((occurrence) =>
					JSON.stringify([
						occurrence.registrySlot,
						occurrence.carrierUuid,
						occurrence.subpath,
						occurrence.tableId,
						occurrence.columnId,
					]),
				)
				.sort(),
		).toEqual(
			expectedOccurrences
				.map((occurrence) => JSON.stringify(occurrence))
				.sort(),
		);

		expect(
			occurrences
				.filter(
					(occurrence) => occurrence.registrySlot === "lookup_options_source",
				)
				.map((occurrence) => occurrence.location),
		).toEqual(
			Array.from({ length: 3 }, () => ({
				scope: "field",
				moduleUuid,
				moduleName: "Cases",
				formUuid,
				formName: "Visit",
				fieldUuid,
				fieldId: "choice",
				field: "optionsSource",
			})),
		);
	});

	it("lists a Search prompt's choice list beside select fields, owned by the input", () => {
		// The compile boundary's row-dependent option validity walks this list
		// against the same fixture snapshot the emitters use, so a prompt's
		// choices must appear here with an owner a finding can name.
		const moduleUuid = testUuid("module-choices");
		const formUuid = testUuid("form-choices");
		const fieldUuid = testUuid("field-choices");
		const selectInputUuid = testUuid("search-select-choices");
		const multiInputUuid = testUuid("search-multi-choices");
		const table = tableId("40");
		const options = {
			kind: "lookup" as const,
			tableId: table,
			valueColumnId: columnId("401"),
			labelColumnId: columnId("402"),
		};
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "region", label: "Region", data_type: "text" },
						{ name: "regions", label: "Regions", data_type: "text" },
					],
				},
			],
			modules: [
				{
					uuid: moduleUuid,
					name: "Cases",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("choice-name-column"), "case_name", "Name"),
						],
						searchInputs: [
							simpleSearchInputDef(
								selectInputUuid,
								"region",
								"Region",
								"select",
								"region",
								{ options },
							),
							simpleSearchInputDef(
								multiInputUuid,
								"regions",
								"",
								"multi-select",
								"regions",
								{ options },
							),
						],
					},
					forms: [
						{
							uuid: formUuid,
							name: "Visit",
							type: "survey",
							fields: [
								{
									uuid: fieldUuid,
									kind: "single_select",
									id: "choice",
									optionsSource: options,
								},
							],
						},
					],
				},
			],
		});

		assertAdmittedDoc(doc, lookupContext);
		const carriers = collectLookupOptionsSourceCarriers(doc);
		expect(carriers.map((carrier) => carrier.owner)).toEqual([
			{ kind: "field", fieldUuid, fieldId: "choice" },
			{
				kind: "search-input",
				moduleUuid,
				inputUuid: selectInputUuid,
				inputName: "region",
				inputLabel: "Region",
			},
			{
				kind: "search-input",
				moduleUuid,
				inputUuid: multiInputUuid,
				inputName: "regions",
				inputLabel: "",
			},
		]);
		expect(carriers.map((carrier) => carrier.source)).toEqual([
			options,
			options,
			options,
		]);
		expect(carriers[1].location).toEqual({
			scope: "module",
			moduleUuid,
			moduleName: "Cases",
			field: `caseListConfig.searchInputs[${selectInputUuid}].options`,
		});
		expect(
			carriers.map((carrier) =>
				describeLookupOptionsSourceOwner(carrier.owner),
			),
		).toEqual([
			'Field "choice"',
			'Search field "Region"',
			'Search field "regions"',
		]);
	});

	it("deduplicates production targets without collapsing exact occurrences", () => {
		const sharedTable = tableId("30");
		const sharedColumn = columnId("301");
		const doc = buildDoc({
			modules: [
				{
					name: "Module",
					forms: [
						{
							name: "Form",
							type: "survey",
							fields: [
								{
									kind: "multi_select",
									id: "choices",
									optionsSource: {
										kind: "lookup",
										tableId: sharedTable,
										valueColumnId: sharedColumn,
										labelColumnId: sharedColumn,
										filter: eq(
											tableColumn(sharedTable, sharedColumn),
											literal("a"),
										),
									},
								},
							],
						},
					],
				},
			],
		});

		assertAdmittedDoc(doc, lookupContext);
		const occurrences = extractLookupReferenceOccurrences(
			doc,
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		);
		expect(occurrences).toHaveLength(3);
		expect(extractLookupReferenceTargets(doc)).toEqual({
			tableIds: [sharedTable],
			columnTargets: [{ tableId: sharedTable, columnId: sharedColumn }],
		});
		expect(
			unionLookupReferenceTargetSets(
				extractLookupReferenceTargets(doc),
				extractLookupReferenceTargets(doc),
			),
		).toEqual({
			tableIds: [sharedTable],
			columnTargets: [{ tableId: sharedTable, columnId: sharedColumn }],
		});
	});

	it("does not infer lookup references from discriminator-like literals", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "No references",
					caseType: "patient",
					caseListOnly: true,
					displayCondition: eq(
						literal("table-column"),
						literal("table-lookup"),
					),
					caseListConfig: {
						columns: [
							plainColumn(testUuid("literal-name-column"), "case_name", "Name"),
						],
						filter: eq(literal("tableId"), literal("columnId")),
						searchInputs: [],
					},
				},
			],
		});

		assertAdmittedDoc(doc);
		expect(
			extractLookupReferenceOccurrences(
				doc,
				PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
			),
		).toEqual([]);
		expect(extractLookupReferenceTargets(doc)).toBe(
			EMPTY_LOOKUP_REFERENCE_TARGETS,
		);
	});

	it("canonicalizes typed nested paths without key/index aliases", () => {
		expect(canonicalLookupReferenceSubpath([])).toBe("");
		expect(canonicalLookupReferenceSubpath(["rows", 0, "a/b~c"])).toBe(
			"/k:rows/i:0/k:a~1b~0c",
		);
		expect(canonicalLookupReferenceSubpath(["0"])).not.toBe(
			canonicalLookupReferenceSubpath([0]),
		);
		expect(() => canonicalLookupReferenceSubpath([-1])).toThrow(
			"nonnegative safe integers",
		);
	});

	it("stamps an explicit synthetic registry and returns deterministic occurrences", () => {
		const doc = surveyDoc();
		const registry: LookupReferenceExtractorRegistry = Object.freeze([
			{
				registrySlot: "future.itemset.value",
				extract: () => [
					{
						carrierUuid: testUuid("carrier-b"),
						subpath: ["value", 1],
						tableId: tableId("2"),
						columnId: columnId("2"),
						acceptedColumnTypes: ["decimal", "int", "decimal"] as const,
						location: {
							scope: "field" as const,
							fieldUuid: testUuid("carrier-b"),
						},
					},
					{
						carrierUuid: testUuid("carrier-a"),
						subpath: ["value", 0],
						tableId: tableId("1"),
						location: {
							scope: "module" as const,
							moduleUuid: testUuid("carrier-a"),
						},
					},
				],
			},
		]);

		const occurrences = extractLookupReferenceOccurrences(doc, registry);
		expect(occurrences.map((occurrence) => occurrence.carrierUuid)).toEqual([
			testUuid("carrier-b"),
			testUuid("carrier-a"),
		]);
		expect(occurrences[0]).toMatchObject({
			registrySlot: "future.itemset.value",
			subpath: "/k:value/i:1",
			acceptedColumnTypes: ["int", "decimal"],
		});
		expect(Object.isFrozen(occurrences)).toBe(true);
		expect(Object.isFrozen(occurrences[0].acceptedColumnTypes)).toBe(true);
	});

	it("rejects duplicate registry slots and a type contract without a column", () => {
		const doc = surveyDoc();
		const extractor = {
			registrySlot: "future.slot",
			extract: () => [],
		};
		expect(() =>
			extractLookupReferenceOccurrences(doc, [extractor, extractor]),
		).toThrow("Duplicate lookup reference registry slot");

		expect(() =>
			extractLookupReferenceOccurrences(doc, [
				{
					registrySlot: "future.typed",
					extract: () => [
						{
							carrierUuid: testUuid("carrier"),
							subpath: [],
							tableId: tableId("1"),
							acceptedColumnTypes: ["text"],
							location: { scope: "app" },
						},
					],
				},
			]),
		).toThrow("accepted column types without a column target");

		expect(() =>
			extractLookupReferenceOccurrences(doc, [
				{
					registrySlot: "future.empty-types",
					extract: () => [
						{
							carrierUuid: testUuid("carrier"),
							subpath: [],
							tableId: tableId("1"),
							columnId: columnId("1"),
							acceptedColumnTypes: [],
							location: { scope: "app" },
						},
					],
				},
			]),
		).toThrow("empty accepted column type set");
	});
});

describe("lookup reference target normalization", () => {
	it("sorts, deduplicates, and makes every column imply its table", () => {
		const targets = normalizeLookupReferenceTargetSet({
			tableIds: [tableId("3"), tableId("1"), tableId("1")],
			columnTargets: [
				{ tableId: tableId("2"), columnId: columnId("2") },
				{ tableId: tableId("2"), columnId: columnId("1") },
				{ tableId: tableId("2"), columnId: columnId("2") },
			],
		});

		expect(targets.tableIds).toEqual([
			tableId("1"),
			tableId("2"),
			tableId("3"),
		]);
		expect(targets.columnTargets).toEqual([
			{ tableId: tableId("2"), columnId: columnId("1") },
			{ tableId: tableId("2"), columnId: columnId("2") },
		]);
		expect(Object.isFrozen(targets.tableIds)).toBe(true);
		expect(Object.isFrozen(targets.columnTargets)).toBe(true);
	});

	it("projects occurrences and unions partitions through the same normalizer", () => {
		const occurrence = {
			carrierUuid: testUuid("carrier"),
			registrySlot: "future.slot",
			subpath: "",
			tableId: tableId("1"),
			columnId: columnId("1"),
			location: { scope: "app" as const },
		};
		const fromOccurrence = lookupReferenceTargetsFromOccurrences([occurrence]);
		const union = unionLookupReferenceTargetSets(
			fromOccurrence,
			normalizeLookupReferenceTargetSet({ tableIds: [tableId("2")] }),
			fromOccurrence,
		);

		expect(union).toEqual({
			tableIds: [tableId("1"), tableId("2")],
			columnTargets: [{ tableId: tableId("1"), columnId: columnId("1") }],
		});
		expect(normalizeLookupReferenceTargetSet({})).toBe(
			EMPTY_LOOKUP_REFERENCE_TARGETS,
		);
	});
});
