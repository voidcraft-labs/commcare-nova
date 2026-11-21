// lib/preview/caseListReturn.ts
//
// What a running case list keeps of the worker's place in it (its page, its
// filter text and its Sort by pick) when the worker comes back to it, as the
// platform Preview plays keeps it (`platform.ts`, `caseListReturn`).
//
// The list's own case details belong to it: going to them and back keeps
// everything on both platforms, so they are no return here. A return is the
// list shown again after the worker went past it, and it comes one of two
// ways: a step back (Back, Forward, a screen's own Back) or a forward step (a
// form's submission landing on the list, a menu, a crumb, Home). A search run
// again is the third thing that moves a list's place.

import { type CaseListSortChoice, LIST_ORDER } from "./caseListSortMenu";
import type { PreviewPlatformRules } from "./platform";

/** The list's filter box: its text, and whether the worker has changed it
 *  since the list opened (`PreviewPlatformRules.listFilter`, `emptyText`). */
export interface CaseListFilterBox {
	readonly text: string;
	readonly edited: boolean;
}

/** An untouched filter box. */
export const UNEDITED_FILTER_BOX: CaseListFilterBox = Object.freeze({
	text: "",
	edited: false,
});

/** The worker's place in a list: the page (zero-based), the filter box and
 *  the Sort by choice. */
export interface CaseListPlace {
	readonly page: number;
	readonly filter: CaseListFilterBox;
	readonly sort: CaseListSortChoice;
}

/** A list with nothing of the worker's in it. */
export const NEW_LIST_PLACE: CaseListPlace = Object.freeze({
	page: 0,
	filter: UNEDITED_FILTER_BOX,
	sort: LIST_ORDER,
});

/** How the worker came back to a list they went past. */
export type CaseListReturn = "back" | "forward";

/**
 * The list's place when the worker comes back to it, from the place it held
 * as they left it and the filter text it held when it last opened a case's
 * details (`undefined` where it opened none).
 *
 * A forward step starts the list afresh on both platforms. A step back keeps
 * the place under `address` (Web Apps, whose list address carries it), and
 * under `new-list` (Android) shows a new list, at its top in its own order,
 * whose filter box holds the text the list held when it last opened a case's
 * details. The place left is returned as it is where nothing moves.
 */
export function caseListPlaceOnReturn(
	left: CaseListPlace,
	textAtDetails: string | undefined,
	how: CaseListReturn,
	rule: PreviewPlatformRules["caseListReturn"],
): CaseListPlace {
	if (how === "forward") return NEW_LIST_PLACE;
	if (rule.back === "address") return left;
	return textAtDetails === undefined || textAtDetails === ""
		? NEW_LIST_PLACE
		: { ...NEW_LIST_PLACE, filter: { text: textAtDetails, edited: true } };
}

/**
 * The list's place once a search runs again: under `keeps-sort` (Web Apps)
 * the pick stays and the page and filter text go; under `new-list`
 * (Android) the results open in a new list.
 */
export function caseListPlaceOnSearch(
	place: CaseListPlace,
	rule: PreviewPlatformRules["caseListReturn"],
): CaseListPlace {
	return rule.search === "keeps-sort"
		? { ...NEW_LIST_PLACE, sort: place.sort }
		: NEW_LIST_PLACE;
}
