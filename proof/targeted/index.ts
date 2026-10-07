/**
 * The targeted documents (`proof/corpus/documents.ts::TARGETED_MODULE`): one
 * admitted document per work item 12 row that no other corpus document shows,
 * and per symptom only the fuzz sample shows, each fixed so its symptom's
 * values are exact (plan decision 12, work items 10 and 12), plus precise
 * edit witnesses for the harness's own contracts. Each is built
 * by Nova's planners and admitted by Nova's commit gate (`./build.ts`).
 */

import type { CorpusDocument } from "../corpus/documents";
import {
	closeConditions,
	closeConditionUnparsable,
} from "./documents/closeConditions";
import {
	connectDeliverKeyNames,
	connectDeliverRename,
	connectLearnKeyNames,
	connectLearnRename,
} from "./documents/connectApps";
import { customTile } from "./documents/customTile";
import { emptyListNoEnglish } from "./documents/emptyListNoEnglish";
import { formLinkHiddenTarget } from "./documents/formLinkHiddenTarget";
import { formLinksHiddenFallback } from "./documents/formLinksHiddenFallback";
import {
	invalidConnectIds,
	invalidQuestionIds,
	labelledGroupRepeat,
	reservedNodeNames,
	surveyMenu,
} from "./documents/formShapes";
import { hiddenColumn } from "./documents/hiddenColumn";
import { hqSideState } from "./documents/hqSideState";
import { labelSort } from "./documents/labelSort";
import { loadTimeValues } from "./documents/loadTimeValues";
import { lookupReservedTags } from "./documents/lookupReservedTags";
import { multiSelectDestinations } from "./documents/multiSelectDestinations";
import { queryRepeatPlaces, repeatCountCopy } from "./documents/repeats";
import {
	listFirstWebApps,
	searchButtonLabel,
	searchDefaultFilterName,
	searchHqCompile,
	searchRelatedLookups,
	syncOnFormEntry,
} from "./documents/searchApps";
import { sharedPropertySort } from "./documents/sortKeys";
import {
	parentFormPreviousFrame,
	parentFormSelectionFrame,
	wireEqualRepublish,
} from "./documents/stableWitnesses";
import { timeOrdering } from "./documents/timeOrdering";
import { validatedBarcodeSecret } from "./documents/validatedBarcodeSecret";

/** Every targeted document's maker, in the corpus's order. */
export const TARGETED_DOCUMENTS: readonly (() => CorpusDocument)[] = [
	lookupReservedTags,
	timeOrdering,
	searchHqCompile,
	validatedBarcodeSecret,
	labelSort,
	customTile,
	closeConditions,
	closeConditionUnparsable,
	multiSelectDestinations,
	surveyMenu,
	invalidQuestionIds,
	invalidConnectIds,
	hiddenColumn,
	listFirstWebApps,
	queryRepeatPlaces,
	formLinksHiddenFallback,
	labelledGroupRepeat,
	repeatCountCopy,
	reservedNodeNames,
	searchRelatedLookups,
	loadTimeValues,
	sharedPropertySort,
	searchDefaultFilterName,
	syncOnFormEntry,
	hqSideState,
	parentFormSelectionFrame,
	parentFormPreviousFrame,
	wireEqualRepublish,
	searchButtonLabel,
	formLinkHiddenTarget,
	emptyListNoEnglish,
	connectDeliverRename,
	connectLearnRename,
	connectLearnKeyNames,
	connectDeliverKeyNames,
];

/** Every targeted document, in a fixed order. */
export function targetedDocuments(): CorpusDocument[] {
	return TARGETED_DOCUMENTS.map((make) => make());
}
