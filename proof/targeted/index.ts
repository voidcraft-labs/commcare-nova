/**
 * The targeted documents (`proof/corpus/documents.ts::TARGETED_MODULE`): one
 * admitted document per work item 12 row that no other corpus document shows,
 * and per symptom only the fuzz sample shows, each fixed so its symptom's
 * values are exact (plan decision 12, work items 10 and 12), plus precise
 * edit witnesses for the harness's own contracts. Each is built
 * by Nova's planners and admitted by Nova's commit gate (`./build.ts`).
 */

import type { CorpusDocument } from "../corpus/documents";
import { attributeDisplayCondition } from "./documents/attributeDisplayCondition";
import { blankLabels } from "./documents/blankLabels";
import { captureWidgets } from "./documents/captureWidgets";
import { attributeColumns, caseIdColumn } from "./documents/caseIdColumn";
import {
	closeConditions,
	closeConditionUnparsable,
} from "./documents/closeConditions";
import {
	connectDeliverRename,
	connectLearnRename,
} from "./documents/connectApps";
import { csqlComposition } from "./documents/csqlComposition";
import { customTile, tileHiddenOrder } from "./documents/customTile";
import { datetimeEquality } from "./documents/datetimeEquality";
import { datetimeOperands } from "./documents/datetimeOperands";
import { datetimeOrdering } from "./documents/datetimeOrdering";
import { datetimeSplit } from "./documents/datetimeSplit";
import { emptyListNoEnglish } from "./documents/emptyListNoEnglish";
import {
	expressionPropertyRenames,
	expressionRenames,
} from "./documents/expressionRenames";
import { formLinkHiddenTarget } from "./documents/formLinkHiddenTarget";
import { formLinksHiddenFallback } from "./documents/formLinksHiddenFallback";
import {
	invalidConnectIds,
	invalidQuestionIds,
	labelledGroupRepeat,
	reservedNodeNames,
	surveyMenu,
} from "./documents/formShapes";
import { gpsQuestion } from "./documents/gpsQuestion";
import { hiddenCalculatedColumn, hiddenColumn } from "./documents/hiddenColumn";
import { hiddenFromMenu } from "./documents/hiddenFromMenu";
import { hqSideLookup } from "./documents/hqSideLookup";
import { hqSideState } from "./documents/hqSideState";
import { inlineSearchReads } from "./documents/inlineSearchReads";
import { instanceReads } from "./documents/instanceReads";
import { labelSort } from "./documents/labelSort";
import { loadTimeValues } from "./documents/loadTimeValues";
import { lookupReservedTags } from "./documents/lookupReservedTags";
import { mediaSlots } from "./documents/mediaSlots";
import { multiSelectDestinations } from "./documents/multiSelectDestinations";
import {
	formLinkSessionReads,
	nestedMenuSessionReads,
	tileSessionReads,
} from "./documents/nativeSessionReads";
import { noMatchesReturnIdentity } from "./documents/noMatchesReturnIdentity";
import { platformDeclaration } from "./documents/platformDeclaration";
import { previewAndroidRenders } from "./documents/previewAndroidRenders";
import { queryRepeatPlaces, repeatCountCopy } from "./documents/repeats";
import { saveToCaseRead } from "./documents/saveToCaseRead";
import {
	listFirstPlaces,
	listFirstWebApps,
	searchDefaultFilterName,
	searchHqCompile,
	searchRelatedLookups,
	syncOnFormEntry,
	syncOnFormEntryWebApps,
} from "./documents/searchApps";
import { sessionReads } from "./documents/sessionReads";
import { sharedPropertySort } from "./documents/sortKeys";
import {
	parentFormPreviousFrame,
	parentFormSelectionFrame,
	wireEqualRepublish,
} from "./documents/stableWitnesses";
import { textReads } from "./documents/textReads";
import { validatedBarcodeSecret } from "./documents/validatedBarcodeSecret";

/** Every targeted document's maker, in the corpus's order. */
export const TARGETED_DOCUMENTS: readonly (() => CorpusDocument)[] = [
	lookupReservedTags,
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
	formLinkHiddenTarget,
	emptyListNoEnglish,
	connectDeliverRename,
	connectLearnRename,
	saveToCaseRead,
	mediaSlots,
	captureWidgets,
	noMatchesReturnIdentity,
	hqSideLookup,
	datetimeOrdering,
	datetimeOperands,
	datetimeEquality,
	caseIdColumn,
	attributeDisplayCondition,
	gpsQuestion,
	blankLabels,
	attributeColumns,
	hiddenCalculatedColumn,
	tileHiddenOrder,
	hiddenFromMenu,
	listFirstPlaces,
	sessionReads,
	expressionRenames,
	expressionPropertyRenames,
	formLinkSessionReads,
	nestedMenuSessionReads,
	tileSessionReads,
	instanceReads,
	inlineSearchReads,
	textReads,
	csqlComposition,
	datetimeSplit,
	platformDeclaration,
	syncOnFormEntryWebApps,
	previewAndroidRenders,
];

/** Every targeted document, in a fixed order. */
export function targetedDocuments(): CorpusDocument[] {
	return TARGETED_DOCUMENTS.map((make) => make());
}
