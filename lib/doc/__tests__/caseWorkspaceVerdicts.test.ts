import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseSearchConfig,
	type Column,
	calculatedColumn,
	plainColumn,
	type SearchInputDef,
} from "@/lib/domain";
import {
	eq,
	isNull,
	literal,
	type Predicate,
	prop,
	sessionContext,
	term,
	unwrapList,
} from "@/lib/domain/predicate";
import { caseWorkspaceBoundaryVerdicts } from "../commitVerdicts";

const MODULE_UUID = asUuid("module-clients");
const CALCULATED_UUID = asUuid("calculated-tags");

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

		expect(caseWorkspaceBoundaryVerdicts(doc, MODULE_UUID)).toEqual({
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

		const verdict = caseWorkspaceBoundaryVerdicts(doc, MODULE_UUID);
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

		const verdict = caseWorkspaceBoundaryVerdicts(doc, MODULE_UUID);
		expect(verdict.filterBroken).toBe(true);
		expect(verdict.searchInputsBroken).toBe(true);
		expect(verdict.brokenColumnUuids).toContain(CALCULATED_UUID);
	});

	it("does not apply the remote-query restriction to an on-device-only filter", () => {
		const doc = docWith({
			filter: eq(prop("client", "age"), prop("client", "score")),
		});

		expect(caseWorkspaceBoundaryVerdicts(doc, MODULE_UUID).filterBroken).toBe(
			false,
		);
	});
});
