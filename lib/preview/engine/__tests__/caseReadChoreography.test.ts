// Controlled count/select boundary interleaving, not a database concurrency proof.
import { describe, expect, it, vi } from "vitest";
import type { CaseRow, CaseStore, JsonObject } from "@/lib/case-store";
import { readCases } from "../caseDataBindingHelpers";

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
