import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { searchInputRemovalDependencies } from "@/lib/doc/searchInputMutations";
import {
	advancedSearchInputDef,
	type CaseListConfig,
	type CaseSearchConfig,
	calculatedColumn,
	hiddenSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	concat,
	eq,
	input,
	isBlank,
	literal,
	matchesPattern,
	prop,
	sessionContext,
	term,
	whenInput,
} from "@/lib/domain/predicate";

const targetUuid = testUuid("00000000-0000-4000-8000-000000000011");
const siblingUuid = testUuid("00000000-0000-4000-8000-000000000012");

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
				input(targetUuid),
				eq(prop("client", "external_id"), input(targetUuid)),
			),
		);
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [target, sibling],
			filter: whenInput(
				input(targetUuid),
				eq(prop("client", "case_name"), input(targetUuid)),
			),
		});
		const searchConfig: CaseSearchConfig = {
			excludedOwnerIds: concat(
				term(input(targetUuid)),
				term(input(targetUuid)),
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
				slot: "match",
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

	it("surfaces sibling starting values and the Search button condition", () => {
		// Both slots are validator-checked against declared inputs
		// (`searchInputDefaultTypeCheck` / `searchButtonDisplayConditionTypeCheck`),
		// so a removal that only these reference would otherwise skip the
		// review dialog and bounce off the commit gate as a raw rejection.
		const target = simpleSearchInputDef(
			targetUuid,
			"case_name",
			"Client name",
			"text",
			"case_name",
		);
		const sibling = {
			...simpleSearchInputDef(
				siblingUuid,
				"external_id",
				"External ID",
				"text",
				"external_id",
			),
			default: term(input(targetUuid)),
		};
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [target, sibling],
		});
		const searchConfig: CaseSearchConfig = {
			searchButtonDisplayCondition: whenInput(
				input(targetUuid),
				eq(prop("client", "case_name"), input(targetUuid)),
			),
		};

		expect(
			searchInputRemovalDependencies(config, searchConfig, targetUuid),
		).toEqual([
			{
				kind: "search-field-default",
				label: "“External ID” starting value",
				inputUuid: siblingUuid,
				paths: [[]],
			},
			{
				kind: "search-button-visibility",
				label: "Search button visibility",
				paths: [
					["when-input-present", "input"],
					["when-input-present", "clause", "right"],
				],
			},
		]);
	});

	it("surfaces a calculated-column formula that reads the answer", () => {
		// The gate forbids NEW input refs in column formulas, but stored
		// pre-gate docs can carry one while its repair is owner-tier
		// pending — and the rename path keeps such refs coherent, so the
		// removal review must see them too. Without this arm the dialog
		// reports "zero uses" and the removal strands the formula.
		const columnUuid = testUuid("00000000-0000-4000-8000-000000000021");
		const target = simpleSearchInputDef(
			targetUuid,
			"case_name",
			"Client name",
			"text",
			"case_name",
		);
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [
				calculatedColumn(columnUuid, "Match note", term(input(targetUuid))),
			],
			searchInputs: [target],
		});

		expect(
			searchInputRemovalDependencies(config, undefined, targetUuid),
		).toEqual([
			{
				kind: "calculated-column",
				label: "“Match note” column formula",
				columnUuid,
				paths: [[]],
			},
		]);
	});

	it("surfaces a sibling's required condition and check that read the answer", () => {
		// The two Search-screen predicates are validator-checked against
		// declared inputs (`searchInputScreenPredicateTypeCheck`), so each is
		// its own dependency carrying the slot the review dialog opens.
		const target = simpleSearchInputDef(
			targetUuid,
			"case_name",
			"Client name",
			"text",
			"case_name",
		);
		const sibling = simpleSearchInputDef(
			siblingUuid,
			"external_id",
			"External ID",
			"text",
			"external_id",
			{
				required: { when: isBlank(input(targetUuid)) },
				validation: {
					rule: whenInput(
						input(targetUuid),
						eq(input(siblingUuid), input(targetUuid)),
					),
					message: "Enter the id that goes with the name.",
				},
			},
		);
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [target, sibling],
		});

		expect(
			searchInputRemovalDependencies(config, undefined, targetUuid),
		).toEqual([
			{
				kind: "search-field-condition",
				label: "“External ID” required condition",
				inputUuid: siblingUuid,
				slot: "required",
				paths: [["left"]],
			},
			{
				kind: "search-field-condition",
				label: "“External ID” check",
				inputUuid: siblingUuid,
				slot: "validation",
				paths: [
					["when-input-present", "input"],
					["when-input-present", "clause", "right"],
				],
			},
		]);
	});

	it("reports a hidden input a sibling's condition reads, and lets its own value go", () => {
		// A hidden input is read through `input(...)` like any other, so a
		// sibling's condition over it is a dependency. Its own value never
		// reads an input (the boundary refuses that), and it carries no
		// required condition or check, so removing it while it reads nothing
		// reports no dependency.
		const hidden = hiddenSearchInputDef(
			targetUuid,
			"search_time",
			"Search time",
			term(sessionContext("username")),
		);
		const sibling = simpleSearchInputDef(
			siblingUuid,
			"external_id",
			"External ID",
			"text",
			"external_id",
			{
				required: { when: eq(input(targetUuid), literal("")) },
			},
		);
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [hidden, sibling],
		});

		expect(
			searchInputRemovalDependencies(config, undefined, targetUuid),
		).toEqual([
			{
				kind: "search-field-condition",
				label: "“External ID” required condition",
				inputUuid: siblingUuid,
				slot: "required",
				paths: [["left"]],
			},
		]);
		expect(
			searchInputRemovalDependencies(config, undefined, siblingUuid),
		).toEqual([]);
	});

	it("ignores the removed field's own required condition and check", () => {
		const target = simpleSearchInputDef(
			targetUuid,
			"case_name",
			"Client name",
			"text",
			"case_name",
			{
				required: { when: isBlank(input(siblingUuid)) },
				validation: {
					rule: matchesPattern(input(targetUuid), "^[A-Za-z ]+$"),
					message: "Use letters only.",
				},
			},
		);
		const sibling = simpleSearchInputDef(
			siblingUuid,
			"external_id",
			"External ID",
			"text",
			"external_id",
		);
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [target, sibling],
		});

		expect(
			searchInputRemovalDependencies(config, undefined, targetUuid),
		).toEqual([]);
	});

	it("ignores the removed field's own starting value", () => {
		const target = {
			...simpleSearchInputDef(
				targetUuid,
				"case_name",
				"Client name",
				"text",
				"case_name",
			),
			default: term(input(targetUuid)),
		};
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [target],
		});

		expect(
			searchInputRemovalDependencies(config, undefined, targetUuid),
		).toEqual([]);
	});
});
