// Controlled count/select boundary interleaving, not a database concurrency proof.
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import type { CaseRow, CaseStore, JsonObject } from "@/lib/case-store";
import { calculatedColumn } from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression";
import {
	CASEDB_READING,
	SEARCH_READING,
} from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import {
	readCases,
	runningCaseSelectionQuery,
} from "../caseDataBindingHelpers";
import { previewCaseStoreOrder } from "../caseListOrder";

const APP_ID = "app-binding";
const OWNER_A = "owner-a";
function buildSyntheticRow(properties: JsonObject): CaseRow {
	return {
		case_id: "test-id",
		app_id: APP_ID,
		case_type: "patient",
		owner_id: OWNER_A,
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: "Synthetic Case",
		external_id: null,
		parent_case_id: null,
		properties,
	};
}

describe("readCases boundary interleaving", () => {
	it("keeps inline result calculations out of ordinary record projections and order", async () => {
		const uuid = testUuid("result-only-village");
		const expression = term(prop("patient", "village"));
		const column = {
			...calculatedColumn(uuid, "Found in", expression),
			inlineResultProperty: true as const,
			visibleInDetail: false,
		};
		const doc = buildDoc({
			appName: "Patients",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "village",
							label: proseText("Village"),
							data_type: "text",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseSearchConfig: { formsReadSearch: true },
					caseListConfig: resolveCaseListConfig({
						columns: [column],
						searchInputs: [],
					}),
					forms: [
						{
							name: "Followup",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		});
		const module = doc.modules[doc.moduleOrder[0]];
		const config = module.caseListConfig;
		if (!config) throw new Error("Test case list is missing.");
		const order = previewCaseStoreOrder(
			{ ...module, caseType: "patient" },
			doc,
			config,
			"en",
			{ picks: [{ column: uuid, reversed: false }], thenListOrder: true },
		);
		const query = vi
			.fn<CaseStore["query"]>()
			.mockResolvedValue([
				{ ...buildSyntheticRow({ village: "North" }), calculated: {} },
			]);
		const ordinary = {
			appId: APP_ID,
			caseType: "patient",
			caseListConfig: config,
			order,
			reading: CASEDB_READING,
			tileGrouping: "flat" as const,
		};
		await readCases({ count: vi.fn(), query, queryGrouped: vi.fn() }, ordinary);
		expect(query).toHaveBeenCalledWith(
			expect.objectContaining({
				calculated: [],
				sort: [
					expect.objectContaining({
						expression: term(prop("patient", "case_id")),
					}),
				],
			}),
		);
		const completed = {
			...ordinary,
			reading: SEARCH_READING,
			searchPopulation: {
				heldBy: { ownerIds: [OWNER_A] },
				request: { maximum: 500 as const },
			},
		};
		expect(runningCaseSelectionQuery(completed).sort).toContainEqual(
			expect.objectContaining({ expression }),
		);
	});

	it("recounts and retries once when a delete empties the counted page", async () => {
		let backingRows = Array.from({ length: 51 }, (_, index) => ({
			...buildSyntheticRow({ name: `Patient ${index + 1}` }),
			case_id: `10000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
			calculated: {},
		}));
		const count = vi.fn(async () => backingRows.length);
		const query = vi.fn(async (args) => {
			if (query.mock.calls.length === 1) {
				// The store's backing population mutates after COUNT observed 51
				// rows but before the first SELECT applies its offset.
				backingRows = backingRows.slice(0, 50);
			}
			const offset = args.offset ?? 0;
			return backingRows.slice(
				offset,
				offset + (args.limit ?? backingRows.length),
			);
		});
		const racingStore = { count, query } as unknown as CaseStore;

		const result = await readCases(racingStore, {
			tileGrouping: "grouped",
			reading: CASEDB_READING,
			appId: APP_ID,
			caseType: "patient",
			page: { offset: 50, limit: 50 },
		});

		expect(result).toMatchObject({
			kind: "rows",
			totalCount: 50,
			pageOffset: 0,
			pageSize: 50,
		});
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(50);
		expect(count).toHaveBeenCalledTimes(2);
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls.map(([args]) => args.offset)).toEqual([50, 0]);
		expect(query.mock.calls.map(([args]) => args.limit)).toEqual([50, 50]);
	});
});
