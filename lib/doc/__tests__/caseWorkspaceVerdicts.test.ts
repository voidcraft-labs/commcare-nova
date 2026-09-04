import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	type CaseSearchConfig,
	type CaseType,
	type Column,
	calculatedColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	plainColumn,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	ancestorPath,
	dateAdd,
	double,
	eq,
	isBlank,
	literal,
	matchAll,
	now,
	type Predicate,
	prop,
	relationStep,
	sessionContext,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { caseWorkspaceBoundaryVerdicts } from "../commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lookupReferences";

const MODULE_UUID = testUuid("module-clients");
const CALCULATED_UUID = testUuid("calculated-tags");
const LOOKUP_TABLE = "00000000-0000-7000-8000-0000000000a1" as LookupTableId;
const LOOKUP_COLUMN = "10000000-0000-7000-8000-0000000000a1" as LookupColumnId;

const form = {
	name: "Register client",
	type: "registration" as const,
	fields: [
		f({
			kind: "text" as const,
			id: "case_name",
			label: "Name",
			caseWrite: { caseType: "client", property: "case_name" },
		}),
	],
};

function docWith({
	filter,
	searchInputs = [],
	caseSearchConfig,
	columns = [plainColumn(testUuid("name-column"), "case_name", "Name")],
	caseTypes,
}: {
	readonly filter?: Predicate;
	readonly searchInputs?: SearchInputDef[];
	readonly caseSearchConfig?: CaseSearchConfig;
	readonly columns?: Column[];
	readonly caseTypes?: CaseType[];
} = {}) {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				uuid: MODULE_UUID,
				name: "Clients",
				caseType: "client",
				caseListConfig: {
					columns,
					searchInputs,
					...(filter === undefined ? {} : { filter }),
				},
				...(caseSearchConfig === undefined ? {} : { caseSearchConfig }),
				forms: [form],
			},
		],
		caseTypes: caseTypes ?? [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "score", label: proseText("Score"), data_type: "int" },
					{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
				],
			},
		],
	});
}

describe("caseWorkspaceBoundaryVerdicts", () => {
	it("keeps valid Search-action and assigned-case settings clean", () => {
		const doc = docWith({
			caseSearchConfig: {
				searchButtonDisplayCondition: eq(
					term(sessionContext("userid")),
					literal("worker-1"),
				),
				excludedOwnerIds: term(sessionContext("userid")),
			},
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual({
			filterBroken: false,
			searchInputsBroken: false,
			searchButtonConditionBroken: false,
			excludedOwnerIdsBroken: false,
			brokenColumnUuids: [],
		});
	});

	it("attributes Search-action and row-dependent assigned-case findings to different surfaces", () => {
		const doc = docWith({
			caseSearchConfig: {
				searchButtonDisplayCondition: isBlank(prop("client", "case_name")),
				// Text-typed on purpose: this is broken because the global setting
				// has no case row, not because the result type is wrong.
				excludedOwnerIds: term(prop("client", "case_name")),
			},
		});

		const verdict = caseWorkspaceBoundaryVerdicts(
			doc,
			MODULE_UUID,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.searchButtonConditionBroken).toBe(true);
		expect(verdict.excludedOwnerIdsBroken).toBe(true);
		expect(verdict.filterBroken).toBe(false);
		expect(verdict.searchInputsBroken).toBe(false);
	});

	it("projects dialect findings for filters, advanced inputs, and calculated fields", () => {
		const doc = docWith({
			filter: eq(prop("client", "age"), prop("client", "score")),
			searchInputs: [
				advancedSearchInputDef(
					testUuid("score-input"),
					"score",
					"Score",
					"text",
					eq(prop("client", "score"), prop("client", "age")),
				),
			],
			caseSearchConfig: {},
			columns: [
				plainColumn(testUuid("name-column"), "case_name", "Name"),
				calculatedColumn(
					CALCULATED_UUID,
					"Tags",
					dateAdd(now(), "months", term(literal(1))),
				),
			],
		});

		const verdict = caseWorkspaceBoundaryVerdicts(
			doc,
			MODULE_UUID,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.filterBroken).toBe(true);
		expect(verdict.searchInputsBroken).toBe(true);
		expect(verdict.brokenColumnUuids).toContain(CALCULATED_UUID);
	});

	it("routes an unsupported Search related-case calculation to its calculated field", () => {
		const doc = docWith({
			caseSearchConfig: {},
			caseTypes: [
				{
					name: "client",
					parent_type: "household",
					properties: [
						{
							name: "case_name",
							label: proseText("Name"),
							data_type: "text",
						},
					],
				},
				{
					name: "household",
					properties: [
						{
							name: "score",
							label: proseText("Score"),
							data_type: "int",
						},
					],
				},
			],
			columns: [
				plainColumn(testUuid("name-column"), "case_name", "Name"),
				calculatedColumn(
					CALCULATED_UUID,
					"Household score",
					double(
						term(
							prop(
								"client",
								"score",
								ancestorPath(relationStep("parent", "household")),
							),
						),
					),
				),
			],
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).brokenColumnUuids,
		).toContain(CALCULATED_UUID);
	});

	it("marks a column broken for an empty id-mapping value", () => {
		// `CASE_LIST_ID_MAPPING_EMPTY_VALUE` is a gating finding the repair
		// pipeline defers to the owner, so the workspace must surface it —
		// otherwise export fails naming a column the UI shows as clean.
		const columnUuid = testUuid("status-mapping-column");
		const doc = docWith({
			columns: [
				plainColumn(testUuid("name-column"), "case_name", "Name"),
				idMappingColumn(columnUuid, "case_name", "Status", [
					idMappingEntry("", "Blank"),
				]),
			],
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).brokenColumnUuids,
		).toContain(columnUuid);
	});

	it("marks a column broken for a duplicate image-map value", () => {
		const columnUuid = testUuid("flag-image-column");
		const doc = docWith({
			columns: [
				plainColumn(testUuid("name-column"), "case_name", "Name"),
				imageMapColumn(columnUuid, "case_name", "Flag", [
					imageMapEntry("open", testMediaAssetId("asset-a")),
					imageMapEntry("open", testMediaAssetId("asset-b")),
				]),
			],
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).brokenColumnUuids,
		).toContain(columnUuid);
	});

	it("does not apply the remote-query restriction to an on-device-only filter", () => {
		const doc = docWith({
			filter: eq(prop("client", "age"), prop("client", "score")),
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).filterBroken,
		).toBe(false);
	});

	it("marks a historical lookup carrier broken when definitions are unavailable", () => {
		const doc = docWith({
			searchInputs: [
				advancedSearchInputDef(
					testUuid("historical-lookup-input"),
					"lookup_query",
					"Lookup query",
					"text",
					eq(
						tableLookup(LOOKUP_TABLE, LOOKUP_COLUMN, matchAll()),
						literal("north"),
					),
				),
			],
			caseSearchConfig: {},
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).searchInputsBroken,
		).toBe(true);
	});

	it("marks Search broken for a lookup finding on a choice prompt's options", () => {
		// `search_input_options` is a registry slot the older hand-written
		// match never named; the finding carries only `registrySlot`, so a
		// literal set left the workspace clean while export refused.
		const doc = docWith({
			searchInputs: [
				simpleSearchInputDef(
					testUuid("region-input"),
					"region",
					"Region",
					"select",
					"region",
					{
						options: {
							kind: "lookup",
							tableId: LOOKUP_TABLE,
							valueColumnId: LOOKUP_COLUMN,
							labelColumnId: LOOKUP_COLUMN,
						},
					},
				),
			],
			caseSearchConfig: {},
		});

		expect(
			caseWorkspaceBoundaryVerdicts(
				doc,
				MODULE_UUID,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).searchInputsBroken,
		).toBe(true);
	});
});
