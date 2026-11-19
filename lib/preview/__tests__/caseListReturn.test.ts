// The worker's place in a running case list (its page, filter text and Sort
// by pick) when they come back to it, under each platform's rule: Web Apps
// keeps what the list's address carries on a step back and keeps the pick
// through a search run again; Android shows a new list on both, holding the
// filter text it had when it last opened a case's details. A forward step
// starts the list afresh on both.

import { describe, expect, it } from "vitest";
import {
	type CaseListPlace,
	caseListPlaceOnReturn,
	caseListPlaceOnSearch,
	NEW_LIST_PLACE,
	UNEDITED_FILTER_BOX,
} from "../caseListReturn";
import type { CaseListSortChoice } from "../caseListSortMenu";
import { previewPlatformRules } from "../platform";

const WEB_APPS = previewPlatformRules("web-apps").caseListReturn;
const ANDROID = previewPlatformRules("android").caseListReturn;

const PICKED: CaseListSortChoice = {
	picks: [{ column: "village", reversed: true }],
	thenListOrder: false,
};

/** A worker on the third page, who filtered for "ada" and sorted by village
 *  turned around. */
const LEFT: CaseListPlace = {
	page: 2,
	filter: { text: "ada", edited: true },
	sort: PICKED,
};

describe("coming back to a list by a step back", () => {
	it("keeps the page, the filter text and the pick in Web Apps, as its address does", () => {
		expect(caseListPlaceOnReturn(LEFT, "ad", "back", WEB_APPS)).toBe(LEFT);
	});

	it("shows a new list on Android, with the text it held when it opened a case's details", () => {
		expect(caseListPlaceOnReturn(LEFT, "ad", "back", ANDROID)).toEqual({
			page: 0,
			filter: { text: "ad", edited: true },
			sort: NEW_LIST_PLACE.sort,
		});
	});

	it("shows an empty filter on Android where the list opened no case's details", () => {
		expect(caseListPlaceOnReturn(LEFT, undefined, "back", ANDROID)).toEqual(
			NEW_LIST_PLACE,
		);
		expect(caseListPlaceOnReturn(LEFT, "", "back", ANDROID)).toEqual(
			NEW_LIST_PLACE,
		);
	});
});

describe("coming back to a list by a forward step", () => {
	it.each([
		["Web Apps", WEB_APPS],
		["Android", ANDROID],
	])("starts it afresh on %s, a submission's landing included", (_, rule) => {
		const place = caseListPlaceOnReturn(LEFT, "ad", "forward", rule);
		expect(place).toEqual({
			page: 0,
			filter: UNEDITED_FILTER_BOX,
			sort: { picks: [], thenListOrder: true },
		});
	});
});

describe("a search run again", () => {
	it("keeps the pick in Web Apps and lets the page and the filter text go", () => {
		expect(caseListPlaceOnSearch(LEFT, WEB_APPS)).toEqual({
			page: 0,
			filter: UNEDITED_FILTER_BOX,
			sort: PICKED,
		});
	});

	it("opens the results in a new list on Android", () => {
		expect(caseListPlaceOnSearch(LEFT, ANDROID)).toEqual(NEW_LIST_PLACE);
	});
});
