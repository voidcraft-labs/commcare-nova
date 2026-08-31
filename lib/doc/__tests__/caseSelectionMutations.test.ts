import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { emptyCaseListConfig, type Module } from "@/lib/domain";
import { planCaseSelectionChange } from "../caseSelectionMutations";

const MODULE_UUID = testUuid("case-selection-planner-module");

function moduleWith(config: Module["caseListConfig"]): Module {
	return {
		uuid: MODULE_UUID,
		id: "visits",
		name: "Visits",
		caseType: "visit",
		...(config !== undefined && { caseListConfig: config }),
	};
}

describe("planCaseSelectionChange", () => {
	it("refuses a module without a case list", () => {
		expect(
			planCaseSelectionChange(moduleWith(undefined), {
				kind: "multiple",
				maximum: 10,
			}),
		).toEqual({ ok: false, reason: "missing-case-list" });
	});

	it("sets bounded multiple selection with one granular mutation", () => {
		expect(
			planCaseSelectionChange(moduleWith(emptyCaseListConfig()), {
				kind: "multiple",
				maximum: 10,
			}),
		).toEqual({
			ok: true,
			clearsPersistentTile: false,
			mutations: [
				{
					kind: "setCaseListMeta",
					uuid: MODULE_UUID,
					patch: { selection: { kind: "multiple", maximum: 10 } },
				},
			],
		});
	});

	it("clears to the canonical single-case state with JSON-stable null", () => {
		const plan = planCaseSelectionChange(
			moduleWith({
				...emptyCaseListConfig(),
				selection: { kind: "multiple", maximum: 5 },
			}),
			undefined,
		);
		expect(plan).toEqual({
			ok: true,
			clearsPersistentTile: false,
			mutations: [
				{
					kind: "setCaseListMeta",
					uuid: MODULE_UUID,
					patch: { selection: null },
				},
			],
		});
		expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
	});

	it("removes only persistent form tiles when multiple selection is enabled", () => {
		expect(
			planCaseSelectionChange(
				moduleWith({
					...emptyCaseListConfig(),
					tile: {
						persistOnForms: true,
						grouping: { identifier: "parent", headerRows: 1 },
					},
				}),
				{ kind: "multiple", maximum: 25 },
			),
		).toEqual({
			ok: true,
			clearsPersistentTile: true,
			mutations: [
				{
					kind: "setCaseListMeta",
					uuid: MODULE_UUID,
					patch: {
						selection: { kind: "multiple", maximum: 25 },
						tile: { grouping: { identifier: "parent", headerRows: 1 } },
					},
				},
			],
		});
	});

	it("returns a no-op when the requested state is already current", () => {
		expect(
			planCaseSelectionChange(
				moduleWith({
					...emptyCaseListConfig(),
					selection: { kind: "multiple", maximum: 3 },
				}),
				{ kind: "multiple", maximum: 3 },
			),
		).toEqual({ ok: true, mutations: [], clearsPersistentTile: false });
	});
});
