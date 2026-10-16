import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	translationUnitsById,
} from "@/lib/domain";

const NAME = testUuid("translation-units-name");
const WEIGHT = testUuid("translation-units-weight");

/** A list whose second column, over `weight`, orders the list and is hidden
 *  from Results, shown on Details or not as `visibleInDetail` says. */
function listWithHiddenOrderColumn(visibleInDetail: boolean): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: resolveCaseListConfig({
					columns: [
						plainColumn(NAME, "case_name", "Name"),
						plainColumn(WEIGHT, "weight", "Weight", {
							visibleInList: false,
							visibleInDetail,
							sort: { direction: "asc", priority: 0 },
						}),
					],
					searchInputs: [],
				}),
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "weight", label: proseText("Weight") },
				],
			},
		],
	});
}

describe("a case list column's header unit", () => {
	const header = makeTranslationUnitId("column", WEIGHT, "header");

	it("is not listed for a column hidden from both screens, though it orders the list", () => {
		// Its header reaches no screen: HQ's build writes a hidden field's
		// header empty, so there is nothing for a translator to translate.
		expect(
			translationUnitsById(listWithHiddenOrderColumn(false)).has(header),
		).toBe(false);
	});

	it("is listed for the same column shown on Details", () => {
		expect(
			translationUnitsById(listWithHiddenOrderColumn(true)).has(header),
		).toBe(true);
	});
});
