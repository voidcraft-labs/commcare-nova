import { describe, expect, it } from "vitest";
import { searchInputRemovalDependencies } from "@/lib/doc/searchInputMutations";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseListConfig,
	type CaseSearchConfig,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	concat,
	eq,
	input,
	prop,
	term,
	whenInput,
} from "@/lib/domain/predicate";

const targetUuid = asUuid("00000000-0000-4000-8000-000000000011");
const siblingUuid = asUuid("00000000-0000-4000-8000-000000000012");

describe("searchInputRemovalDependencies", () => {
	it("groups every deterministic occurrence by its friendly source", () => {
		const target = simpleSearchInputDef(
			targetUuid,
			"case_name",
			"Client name",
			"text",
			"case_name",
		);
		const sibling = advancedSearchInputDef(
			siblingUuid,
			"external_id",
			"External ID",
			"text",
			whenInput(
				input("case_name"),
				eq(prop("client", "external_id"), input("case_name")),
			),
		);
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [target, sibling],
			filter: whenInput(
				input("case_name"),
				eq(prop("client", "case_name"), input("case_name")),
			),
		};
		const searchConfig: CaseSearchConfig = {
			excludedOwnerIds: concat(
				term(input("case_name")),
				term(input("case_name")),
			),
		};

		expect(
			searchInputRemovalDependencies(config, searchConfig, targetUuid),
		).toEqual([
			{
				kind: "cases-available",
				label: "Cases available",
				paths: [
					["when-input-present", "input"],
					["when-input-present", "clause", "right"],
				],
			},
			{
				kind: "search-field-condition",
				label: "“External ID” search condition",
				inputUuid: siblingUuid,
				paths: [
					["when-input-present", "input"],
					["when-input-present", "clause", "right"],
				],
			},
			{
				kind: "assigned-cases",
				label: "Assigned cases",
				paths: [
					["parts", 0],
					["parts", 1],
				],
			},
		]);
	});
});
