import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import { settleDraft } from "../OptionsEditor";

function option(value: string, label: string, n: number) {
	return { uuid: testUuid(`opt-${n}`), value, label: proseText(label) };
}

describe("settleDraft", () => {
	it("leaves rows that already hold a value untouched, by identity", () => {
		const rows = [option("yes", "Yes", 1), option("no", "No", 2)];
		const settled = settleDraft(rows);
		expect(settled[0]).toBe(rows[0]);
		expect(settled[1]).toBe(rows[1]);
	});

	it("drops a row with nothing on it", () => {
		const rows = [option("yes", "Yes", 1), option("", "", 2)];
		expect(settleDraft(rows).map((row) => row.value)).toEqual(["yes"]);
	});

	it("keeps a blank row that carries media", () => {
		const rows = [
			option("yes", "Yes", 1),
			{
				...option("", "", 2),
				media: {
					image: asMediaAssetId("55555555-5555-4555-8555-555555555555"),
				},
			},
		];
		expect(settleDraft(rows)).toHaveLength(2);
	});

	it("fills an emptied value from the label, stepping past a sibling", () => {
		const rows = [
			option("", "Not applicable", 1),
			option("not_applicable", "Also", 2),
		];
		expect(settleDraft(rows).map((row) => row.value)).toEqual([
			"not_applicable_2",
			"not_applicable",
		]);
	});

	it("falls back to the minted placeholder at the row's own position", () => {
		const rows = [option("yes", "Yes", 1), option("", "???", 2)];
		expect(settleDraft(rows)[1]?.value).toBe("option_2");
	});
});
