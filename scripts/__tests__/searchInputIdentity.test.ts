import { describe, expect, it } from "vitest";
import {
	findLegacySearchInputRefs,
	migrateModuleSearchInputRefs,
	planModuleSearchInputIdentityMigration,
} from "../lib/searchInputIdentity";

const INPUT_UUID = "65aa6175-e424-4c41-abfb-2e9f932e5bc7";

function moduleRecord(searchInputs: unknown[]) {
	return {
		uuid: "9536e1c1-ae08-4aaf-a146-df5d9ce06665",
		id: "patients",
		name: "Patients",
		caseListConfig: {
			columns: [],
			listColumnOrder: [],
			detailColumnOrder: [],
			searchInputs,
			filter: {
				kind: "and",
				clauses: [
					{
						kind: "eq",
						left: { kind: "term", term: { kind: "input", name: "district" } },
						right: { kind: "term", term: { kind: "literal", value: "north" } },
					},
					{
						kind: "is-blank",
						left: { kind: "term", term: { kind: "input", name: "district" } },
					},
				],
			},
		},
	};
}

describe("Search-input identity migration", () => {
	it("converts every same-module legacy name to the definition UUID", () => {
		const before = moduleRecord([
			{
				uuid: INPUT_UUID,
				kind: "simple",
				name: "district",
				label: "District",
				type: "text",
				property: "district",
			},
		]);
		const result = migrateModuleSearchInputRefs(before);

		expect(result.issues).toEqual([]);
		expect(result.converted).toHaveLength(2);
		expect(findLegacySearchInputRefs(result.record)).toEqual([]);
		expect(JSON.stringify(result.record)).toContain(
			`"searchInputUuid":"${INPUT_UUID}"`,
		);
		expect(before).toEqual(moduleRecord(before.caseListConfig.searchInputs));
	});

	it("records canonical UUID-bearing mutations for every changed Blueprint slot", () => {
		const before = moduleRecord([
			{
				uuid: INPUT_UUID,
				kind: "simple",
				name: "district",
				label: "District",
				type: "text",
				property: "district",
			},
		]);
		const plan = planModuleSearchInputIdentityMigration(before);

		expect(plan.mutations).toHaveLength(1);
		expect(plan.mutations[0]).toMatchObject({
			kind: "updateModule",
			uuid: before.uuid,
		});
		expect(plan.mutations[0]).toHaveProperty(
			"patch.caseListConfig.filter.clauses.0.left.term.searchInputUuid",
			INPUT_UUID,
		);
		expect(plan.mutations[0]).toHaveProperty(
			"patch.caseListConfig.filter.clauses.1.left.term.searchInputUuid",
			INPUT_UUID,
		);
		expect(findLegacySearchInputRefs(plan.mutations)).toEqual([]);
	});

	it("records a canonical per-setting Search mutation for a case-search leaf", () => {
		const before = moduleRecord([
			{
				uuid: INPUT_UUID,
				kind: "simple",
				name: "district",
				label: "District",
				type: "text",
				property: "district",
			},
		]);
		const { filter: _legacyFilter, ...caseListConfig } = before.caseListConfig;
		const withSearch = {
			...before,
			caseListConfig,
			caseSearchConfig: {
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "input", name: "district" },
				},
			},
		};

		const plan = planModuleSearchInputIdentityMigration(withSearch);
		expect(plan.mutations).toHaveLength(1);
		expect(plan.mutations[0]).toMatchObject({
			kind: "updateModule",
			uuid: before.uuid,
			caseSearchConfigPatch: {
				excludedOwnerIds: {
					kind: "term",
					term: {
						kind: "input",
						searchInputUuid: INPUT_UUID,
					},
				},
			},
		});
		expect(findLegacySearchInputRefs(plan.mutations)).toEqual([]);
	});

	it("refuses missing and ambiguous names instead of guessing", () => {
		const missing = migrateModuleSearchInputRefs(moduleRecord([]));
		expect(missing.issues).toEqual([
			expect.objectContaining({
				name: "district",
				reason: "missing-definition",
			}),
			expect.objectContaining({
				name: "district",
				reason: "missing-definition",
			}),
		]);

		const ambiguous = migrateModuleSearchInputRefs(
			moduleRecord([
				{ uuid: INPUT_UUID, name: "district" },
				{
					uuid: "75aa6175-e424-4c41-abfb-2e9f932e5bc7",
					name: "district",
				},
			]),
		);
		expect(ambiguous.issues[0]).toEqual(
			expect.objectContaining({
				reason: "ambiguous-definition",
				candidateUuids: [INPUT_UUID, "75aa6175-e424-4c41-abfb-2e9f932e5bc7"],
			}),
		);
	});

	it("finds legacy references inside stored mutation payloads", () => {
		expect(
			findLegacySearchInputRefs([
				{
					kind: "updateModule",
					patch: {
						displayCondition: {
							kind: "is-blank",
							left: { kind: "term", term: { kind: "input", name: "q" } },
						},
					},
				},
			]),
		).toEqual([
			{
				path: "[0].patch.displayCondition.left.term",
				name: "q",
			},
		]);
	});
});
