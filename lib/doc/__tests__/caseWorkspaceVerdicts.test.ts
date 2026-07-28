import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseSearchConfig,
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
	eq,
	isNull,
	literal,
	matchAll,
	type Predicate,
	prop,
	sessionContext,
	tableLookup,
	term,
	unwrapList,
} from "@/lib/domain/predicate";
import { caseWorkspaceBoundaryVerdicts } from "../commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lookupReferences";

const MODULE_UUID = asUuid("module-clients");
const CALCULATED_UUID = asUuid("calculated-tags");
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
			case_property_on: "client",
		}),
	],
};

function docWith({
	filter,
	searchInputs = [],
	caseSearchConfig,
	columns = [plainColumn(asUuid("name-column"), "case_name", "Name")],
}: {
	readonly filter?: Predicate;
	readonly searchInputs?: SearchInputDef[];
	readonly caseSearchConfig?: CaseSearchConfig;
	readonly columns?: Column[];
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
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "score", label: "Score", data_type: "int" },
					{ name: "tags", label: "Tags", data_type: "multi_select" },
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
				searchButtonDisplayCondition: isNull(prop("client", "case_name")),
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
					asUuid("score-input"),
					"score",
					"Score",
					"text",
					eq(prop("client", "score"), prop("client", "age")),
				),
			],
			caseSearchConfig: {},
			columns: [
				plainColumn(asUuid("name-column"), "case_name", "Name"),
				calculatedColumn(
					CALCULATED_UUID,
					"Tags",
					unwrapList(term(prop("client", "tags"))),
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

	it("marks a column broken for an empty id-mapping value", () => {
		// `CASE_LIST_ID_MAPPING_EMPTY_VALUE` is a gating finding the repair
		// pipeline defers to the owner, so the workspace must surface it —
		// otherwise export fails naming a column the UI shows as clean.
		const columnUuid = asUuid("status-mapping-column");
		const doc = docWith({
			columns: [
				plainColumn(asUuid("name-column"), "case_name", "Name"),
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
		const columnUuid = asUuid("flag-image-column");
		const doc = docWith({
			columns: [
				plainColumn(asUuid("name-column"), "case_name", "Name"),
				imageMapColumn(columnUuid, "case_name", "Flag", [
					imageMapEntry("open", "asset-a"),
					imageMapEntry("open", "asset-b"),
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

	it("marks search inputs broken for a range mode on a single-value widget", () => {
		// `CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE` gates the commit;
		// the workspace's Search surface must mirror it.
		const doc = docWith({
			searchInputs: [
				simpleSearchInputDef(
					asUuid("age-range-input"),
					"age",
					"Age",
					"text",
					"age",
					{ mode: { kind: "range" } },
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
					asUuid("historical-lookup-input"),
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
});
