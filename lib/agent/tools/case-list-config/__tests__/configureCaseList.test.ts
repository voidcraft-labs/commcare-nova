import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { eq, literal, prop } from "@/lib/domain/predicate";
import {
	configureCaseListInputSchema,
	configureCaseListTool,
} from "../configureCaseList";
import { BASE_COLUMN, MOD_A, makeCaseListFixture } from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(async (args) => {
		const { commitApplyBlueprintChangeTestBatch } = await import(
			"@/lib/db/__tests__/applyBlueprintChangeTestWriter"
		);
		return commitApplyBlueprintChangeTestBatch(args);
	}),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

const PHONE_COLUMN = testUuid("configure-case-list-phone-column");
const NAME_SEARCH = testUuid("configure-case-list-name-search");

describe("configureCaseList", () => {
	it("lands one coherent configuration as granular mutations", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			columns: [
				{
					columnUuid: PHONE_COLUMN,
					kind: "phone",
					field: "phone",
					header: "Phone",
				},
			],
			searchInputs: [
				{
					searchInputUuid: NAME_SEARCH,
					kind: "simple",
					name: "patient_name",
					label: "Patient name",
					type: "text",
					property: "case_name",
				},
			],
			filter: eq(prop("patient", "case_name"), literal("Ada")),
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Search by the name on the record.",
			searchButtonLabel: "Find patient",
			searchButtonDisplayCondition: null,
			resultsColumnOrder: [PHONE_COLUMN, BASE_COLUMN],
			detailsColumnOrder: [BASE_COLUMN, PHONE_COLUMN],
			searchInputOrder: [NAME_SEARCH],
		});

		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.columnUuids).toEqual([PHONE_COLUMN]);
		expect(result.result.searchInputUuids).toEqual([NAME_SEARCH]);
		expect(result.result.message).toContain("Configured the case list");
		expect(result.result.summary).toEqual({ location: "Patient" });

		const config = h.currentDoc().modules[MOD_A].caseListConfig;
		expect(config?.columns.map((column) => column.uuid)).toEqual([
			BASE_COLUMN,
			PHONE_COLUMN,
		]);
		expect(config?.listColumnOrder).toEqual([PHONE_COLUMN, BASE_COLUMN]);
		expect(config?.detailColumnOrder).toEqual([BASE_COLUMN, PHONE_COLUMN]);
		expect(config?.searchInputs.map((input) => input.uuid)).toEqual([
			NAME_SEARCH,
		]);
		expect(config?.filter).toEqual(
			eq(prop("patient", "case_name"), literal("Ada")),
		);
		expect(h.currentDoc().modules[MOD_A].caseSearchConfig).toMatchObject({
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Search by the name on the record.",
			searchButtonLabel: "Find patient",
		});
		expect(result.mutations.map((mutation) => mutation.kind)).toEqual(
			expect.arrayContaining([
				"addColumn",
				"addSearchInput",
				"setCaseListMeta",
				"moveColumn",
				"updateModule",
			]),
		);
	});

	it("uses the targeted display tool's root field shape", () => {
		const display = {
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Search by the name on the record.",
			searchButtonLabel: "Find patient",
			searchButtonDisplayCondition: null,
		};
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				...display,
			}).success,
		).toBe(true);
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				searchDisplay: display,
			}).success,
		).toBe(false);
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				searchScreenTitle: "Find a patient",
			}).success,
		).toBe(false);
	});

	it("returns no mutations when a requested order is not complete", async () => {
		const h = makeCaseListFixture();
		const before = h.currentDoc();
		const result = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			columns: [
				{
					columnUuid: PHONE_COLUMN,
					kind: "phone",
					field: "phone",
					header: "Phone",
				},
			],
			resultsColumnOrder: [PHONE_COLUMN],
		});

		expect(result.mutations).toEqual([]);
		expect(h.currentDoc()).toEqual(before);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("2 entries");
	});
});
