import { describe, expect, it } from "vitest";
import type { CaseRow, JsonObject } from "@/lib/case-store";
import { RESERVED_SCALAR_COLUMN_BY_PROPERTY } from "@/lib/case-store/sql/dataTypeTokens";
import {
	caseRowDisplayValue,
	caseRowToFormPreload,
} from "../caseDataBindingClient";

const APP_ID = "30000000-0000-0000-0000-000000000001";
const OWNER_ID = "20000000-0000-0000-0000-000000000001";
const CASE_ID = "40000000-0000-0000-0000-000000000001";

function buildSyntheticRow(properties: JsonObject): CaseRow {
	return {
		case_id: CASE_ID,
		app_id: APP_ID,
		case_type: "patient",
		owner_id: OWNER_ID,
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

describe("caseRowToFormPreload scalar vocabulary", () => {
	it("flattens custom JSONB values and canonical scalar columns into one string-valued Map", () => {
		const opened = new Date("2026-01-02T03:04:05.000Z");
		const modified = new Date("2026-02-03T04:05:06.000Z");
		const row: CaseRow = {
			...buildSyntheticRow({ clinic_name: "Alice", age: 30 }),
			case_name: "Canonical case name",
			opened_on: opened,
			modified_on: modified,
		};

		const preload = caseRowToFormPreload(row);

		expect(preload.get("clinic_name")).toBe("Alice");
		expect(preload.get("case_name")).toBe("Canonical case name");
		expect(preload.get("age")).toBe("30");
		expect(preload.get("case_id")).toBe(CASE_ID);
		expect(preload.get("status")).toBe("open");
		expect(preload.get("date_opened")).toBe(opened.toISOString());
		expect(preload.get("last_modified")).toBe(modified.toISOString());
	});
});

describe("caseRowDisplayValue scalar vocabulary", () => {
	it.each(["name", "external-id", "date-opened"])(
		"keeps retired spelling %s out of the live scalar-name map",
		(property) => {
			expect(RESERVED_SCALAR_COLUMN_BY_PROPERTY.has(property)).toBe(false);
			expect(caseRowToFormPreload(buildSyntheticRow({})).has(property)).toBe(
				false,
			);
		},
	);

	it("reads ordinary custom JSONB properties and renders an absent property as empty", () => {
		const row = buildSyntheticRow({ clinic_name: "Alice", age: 30 });

		expect(caseRowDisplayValue(row, "clinic_name")).toBe("Alice");
		expect(caseRowDisplayValue(row, "age")).toBe("30");
		expect(caseRowDisplayValue(row, "does_not_exist")).toBe("");
	});
});
