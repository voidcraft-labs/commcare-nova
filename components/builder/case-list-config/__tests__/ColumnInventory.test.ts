import { describe, expect, it } from "vitest";
import { asUuid, type Column } from "@/lib/domain";
import { columnLabel } from "../canvas/ColumnInventory";

function blankHeaderColumn(field: string): Column {
	return {
		uuid: asUuid("00000000-0000-4000-8000-000000000901"),
		kind: "plain",
		field,
		header: "",
		order: "a",
	};
}

describe("columnLabel", () => {
	it.each([
		["name", "Case name"],
		["external-id", "External ID"],
		["date-opened", "Date opened"],
	])("renders the legacy %s field with its canonical label", (field, label) => {
		expect(columnLabel(blankHeaderColumn(field))).toBe(label);
	});

	it("keeps meaningful authored copy ahead of the fallback", () => {
		expect(
			columnLabel({
				...blankHeaderColumn("name"),
				header: "Participant",
			}),
		).toBe("Participant");
	});
});
