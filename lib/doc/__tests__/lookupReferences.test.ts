import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { collectDormantLookupCarriers } from "@/lib/doc/dormantLookupCarriers";
import {
	canonicalLookupReferenceSubpath,
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	extractLookupReferenceOccurrences,
	extractLookupReferenceTargets,
	type LookupReferenceExtractorRegistry,
	lookupReferenceTargetsFromOccurrences,
	normalizeLookupReferenceTargetSet,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
	unionLookupReferenceTargetSets,
} from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	asUuid,
	calculatedColumn,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	eq,
	literal,
	type Predicate,
	tableColumn,
	tableLookup,
	type ValueExpression,
} from "@/lib/domain/predicate";

const tableId = (suffix: string) =>
	`00000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupTableId;
const columnId = (suffix: string) =>
	`10000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupColumnId;

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
		const doc = buildDoc({ appName: "No carriers" });
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

	it("extracts every production carrier slot with the exact nested owner identity", () => {
		const moduleUuid = asUuid("module-lookup");
		const formUuid = asUuid("form-lookup");
		const fieldUuid = asUuid("field-lookup");
		const columnUuid = asUuid("column-lookup");
		const simpleInputUuid = asUuid("search-simple");
		const advancedInputUuid = asUuid("search-advanced");
		const operationUuid = asUuid("operation-lookup");
		const sourceTable = tableId("1");
		const nestedTable = tableId("2");

		const doc = buildDoc({
			appName: "All lookup carriers",
			modules: [
				{
					uuid: moduleUuid,
					name: "Cases",
					displayCondition: lookupPredicate(3),
					caseListConfig: {
						columns: [
							calculatedColumn(columnUuid, "Calculated", lookupExpression(4)),
						],
						filter: lookupPredicate(5),
						searchInputs: [
							simpleSearchInputDef(
								simpleInputUuid,
								"simple",
								"Simple",
								"text",
								"name",
								{ default: lookupExpression(6) },
							),
							advancedSearchInputDef(
								advancedInputUuid,
								"advanced",
								"Advanced",
								"text",
								lookupPredicate(8),
								{ default: lookupExpression(7) },
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
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
									optionsSource: {
										kind: "lookup-table",
										tableId: sourceTable,
										valueColumnId: columnId("11"),
										labelColumnId: columnId("12"),
										filter: eq(
											tableColumn(sourceTable, columnId("13")),
											tableLookup(
												nestedTable,
												columnId("21"),
												eq(
													tableColumn(nestedTable, columnId("22")),
													literal("enabled"),
												),
											),
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
				caseType: "case",
				target: { kind: "expression", expr: lookupExpression(12) },
				condition: lookupPredicate(13),
				name: lookupExpression(14),
				owner: lookupExpression(15),
				rename: lookupExpression(16),
				writes: [
					{
						property: "status",
						value: lookupExpression(17),
						condition: lookupPredicate(18),
					},
				],
				links: [
					{
						identifier: "parent",
						targetType: "parent",
						target: {
							kind: "expression",
							expr: lookupExpression(19),
						},
						relationship: "child",
					},
				],
			},
		];

		const occurrences = extractLookupReferenceOccurrences(
			doc,
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		);
		const slotOwners = [
			...new Set(
				occurrences.map(
					(occurrence) =>
						`${occurrence.registrySlot}:${occurrence.carrierUuid}`,
				),
			),
		].sort();

		const expectedSlotOwners = [
			`case_list_column_expression:${columnUuid}`,
			`case_list_filter:${moduleUuid}`,
			`case_operation_condition:${operationUuid}`,
			`case_operation_link_target_expression:${operationUuid}`,
			`case_operation_name:${operationUuid}`,
			`case_operation_owner:${operationUuid}`,
			`case_operation_rename:${operationUuid}`,
			`case_operation_target_expression:${operationUuid}`,
			`case_operation_write_condition:${operationUuid}`,
			`case_operation_write_value:${operationUuid}`,
			`excluded_owner_ids:${moduleUuid}`,
			`form_display_condition:${formUuid}`,
			`lookup_options_source:${fieldUuid}`,
			`module_display_condition:${moduleUuid}`,
			`search_button_display_condition:${moduleUuid}`,
			`search_input_default:${advancedInputUuid}`,
			`search_input_default:${simpleInputUuid}`,
			`search_input_predicate:${advancedInputUuid}`,
		].sort();

		expect(slotOwners).toEqual(expectedSlotOwners);
		expect(
			[
				...new Set(
					collectDormantLookupCarriers(doc).map(
						(carrier) => `${carrier.slot}:${carrier.ownerUuid}`,
					),
				),
			].sort(),
		).toEqual(expectedSlotOwners);
		expect(occurrences).toHaveLength(39);
		expect(
			occurrences.every((occurrence) => occurrence.columnId !== undefined),
		).toBe(true);
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
			[
				"lookup_options_source",
				fieldUuid,
				"/k:filter/k:right/k:resultColumnId",
				nestedTable,
				columnId("21"),
			],
			[
				"lookup_options_source",
				fieldUuid,
				"/k:filter/k:right/k:where/k:left/k:term/k:columnId",
				nestedTable,
				columnId("22"),
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
			...expectedPredicateOccurrences("case_list_filter", moduleUuid, 5),
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
			...expectedPredicateOccurrences(
				"search_input_predicate",
				advancedInputUuid,
				8,
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
			...expectedExpressionOccurrences(
				"case_operation_name",
				operationUuid,
				14,
			),
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
				"/k:property/k:status",
			),
			...expectedPredicateOccurrences(
				"case_operation_write_condition",
				operationUuid,
				18,
				"/k:property/k:status",
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

		const sourceOccurrences = occurrences.filter(
			(occurrence) => occurrence.registrySlot === "lookup_options_source",
		);
		expect(
			sourceOccurrences.map((occurrence) => ({
				subpath: occurrence.subpath,
				tableId: occurrence.tableId,
				columnId: occurrence.columnId,
			})),
		).toEqual([
			{
				subpath: "/k:filter/k:left/k:term/k:columnId",
				tableId: sourceTable,
				columnId: columnId("13"),
			},
			{
				subpath: "/k:filter/k:right/k:resultColumnId",
				tableId: nestedTable,
				columnId: columnId("21"),
			},
			{
				subpath: "/k:filter/k:right/k:where/k:left/k:term/k:columnId",
				tableId: nestedTable,
				columnId: columnId("22"),
			},
			{
				subpath: "/k:labelColumnId",
				tableId: sourceTable,
				columnId: columnId("12"),
			},
			{
				subpath: "/k:valueColumnId",
				tableId: sourceTable,
				columnId: columnId("11"),
			},
		]);
		expect(
			sourceOccurrences.every(
				(occurrence) =>
					occurrence.columnId !== undefined &&
					occurrence.location.moduleUuid === moduleUuid &&
					occurrence.location.formUuid === formUuid &&
					occurrence.location.fieldUuid === fieldUuid,
			),
		).toBe(true);

		expect(
			occurrences.find(
				(occurrence) =>
					occurrence.registrySlot === "case_operation_write_condition",
			)?.subpath,
		).toBe("/k:property/k:status/k:left/k:resultColumnId");
		expect(
			occurrences.find(
				(occurrence) =>
					occurrence.registrySlot === "case_operation_link_target_expression",
			)?.subpath,
		).toBe("/k:identifier/k:parent/k:resultColumnId");
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
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
									optionsSource: {
										kind: "lookup-table",
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
			modules: [
				{
					name: "No references",
					displayCondition: eq(
						literal("table-column"),
						literal("table-lookup"),
					),
					caseListConfig: {
						columns: [],
						filter: eq(literal("tableId"), literal("columnId")),
						searchInputs: [],
					},
				},
			],
		});

		expect(extractLookupReferenceOccurrences(doc, [])).toEqual([]);
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
		const doc = buildDoc({ appName: "Synthetic" });
		const registry: LookupReferenceExtractorRegistry = Object.freeze([
			{
				registrySlot: "future.itemset.value",
				extract: () => [
					{
						carrierUuid: asUuid("carrier-b"),
						subpath: ["value", 1],
						tableId: tableId("2"),
						columnId: columnId("2"),
						acceptedColumnTypes: ["decimal", "int", "decimal"] as const,
						location: {
							scope: "field" as const,
							fieldUuid: asUuid("carrier-b"),
						},
					},
					{
						carrierUuid: asUuid("carrier-a"),
						subpath: ["value", 0],
						tableId: tableId("1"),
						location: {
							scope: "module" as const,
							moduleUuid: asUuid("carrier-a"),
						},
					},
				],
			},
		]);

		const occurrences = extractLookupReferenceOccurrences(doc, registry);
		expect(occurrences.map((occurrence) => occurrence.carrierUuid)).toEqual([
			"carrier-a",
			"carrier-b",
		]);
		expect(occurrences[1]).toMatchObject({
			registrySlot: "future.itemset.value",
			subpath: "/k:value/i:1",
			acceptedColumnTypes: ["int", "decimal"],
		});
		expect(Object.isFrozen(occurrences)).toBe(true);
		expect(Object.isFrozen(occurrences[1].acceptedColumnTypes)).toBe(true);
	});

	it("rejects duplicate registry slots and a type contract without a column", () => {
		const doc = buildDoc();
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
							carrierUuid: asUuid("carrier"),
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
							carrierUuid: asUuid("carrier"),
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
			carrierUuid: asUuid("carrier"),
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
