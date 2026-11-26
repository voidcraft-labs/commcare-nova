/**
 * Contract: the Edit tabs draft's transitions leave a draft the tab planner saves. Moving an
 * ordering field to another tab, or turning a records tab back to the selected case, clears the
 * ordering choice the dialog no longer shows a checkbox for. The plausible failure: the draft
 * keeps the choice, and Save tabs refuses with an error the author can't clear in place.
 */
import { describe, expect, it } from "vitest";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import {
	type DetailTabGroup,
	planDetailTabGroups,
} from "@/lib/doc/caseDetailTabMutations";
import { moveDraftField, setDraftRowSource } from "../canvas/detailTabDraft";

function draft() {
	const doc = tileFixture("conditional-search-children");
	const menu = doc.modules[doc.moduleOrder[0]];
	const config = menu?.caseListConfig;
	if (!menu || !config) throw new Error("The fixture menu has a case list.");
	const [name, village, lastVisit] = config.detailColumnOrder;
	const [first, second] = config.detailTabs ?? [];
	if (!first || !second || !name || !village || !lastVisit)
		throw new Error("The fixture has two tabs over three fields.");
	const groups: DetailTabGroup[] = [
		{ uuid: first.uuid, title: first.title, fields: [name, village] },
		{
			uuid: second.uuid,
			title: second.title,
			rowSource: second.rowSource,
			fields: [lastVisit],
			orderFields: [lastVisit],
		},
	];
	return { menu, config, groups, first, second, lastVisit };
}

describe("the Edit tabs draft", () => {
	it("saves after an ordering field moves to another tab", () => {
		const { menu, config, groups, first, lastVisit } = draft();
		const moved = moveDraftField(groups, lastVisit, first.uuid);
		expect(moved[1]?.orderFields).toEqual([]);
		// The second tab needs a field of its own to stay a tab.
		const [, village] = config.detailColumnOrder;
		const kept = moved.map((group, index) =>
			index === 0
				? { ...group, fields: group.fields.filter((one) => one !== village) }
				: { ...group, fields: [village as (typeof group.fields)[number]] },
		);
		expect(planDetailTabGroups(menu.uuid, config, kept)).not.toHaveProperty(
			"error",
		);
	});

	it("saves after a records tab goes back to the selected case", () => {
		const { menu, config, groups, second } = draft();
		const plain = setDraftRowSource(groups, second.uuid, null);
		expect(plain[1]?.orderFields).toEqual([]);
		expect(planDetailTabGroups(menu.uuid, config, plain)).not.toHaveProperty(
			"error",
		);
	});
});
