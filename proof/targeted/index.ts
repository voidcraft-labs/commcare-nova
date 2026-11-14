/**
 * The targeted documents (`proof/corpus/documents.ts::TARGETED_MODULE`): one
 * admitted document per work item 12 row that no other corpus document shows,
 * and per symptom only the fuzz sample shows, each fixed so its symptom's
 * values are exact (plan decision 12, work items 10 and 12), plus precise
 * edit witnesses for the harness's own contracts, and the migration witnesses
 * (`./documents/migrations.ts`). Each is built
 * by Nova's planners and admitted by Nova's commit gate (`./build.ts`).
 */

import type { CorpusDocument } from "../corpus/documents";
import {
	advancedChildModule,
	advancedHeldKind,
	advancedModule,
	commtrackAdvanced,
	extensionCarried,
	rootCaseBlockNames,
} from "./documents/advancedModules";
import { attributeDisplayCondition } from "./documents/attributeDisplayCondition";
import { blankLabels } from "./documents/blankLabels";
import { captureWidgets } from "./documents/captureWidgets";
import { attributeColumns, caseIdColumn } from "./documents/caseIdColumn";
import { caseListMenuItem } from "./documents/caseListMenuItems";
import { caseListSearchTextDocument } from "./documents/caseListSearchText";
import { caseTypeNames } from "./documents/caseTypeNames";
import { caseWriteNames } from "./documents/caseWriteNames";
import { caseWritesOneConcept } from "./documents/caseWritesOneConcept";
import { choiceValues } from "./documents/choiceValues";
import {
	closeConditions,
	closeConditionUnparsable,
} from "./documents/closeConditions";
import {
	connectDeliverHyphenIds,
	connectDeliverRename,
	connectLearnHyphenIds,
	connectLearnRename,
} from "./documents/connectApps";
import { csqlComposition } from "./documents/csqlComposition";
import { customTile, tileHiddenOrder } from "./documents/customTile";
import { datetimeEquality } from "./documents/datetimeEquality";
import { datetimeOperands } from "./documents/datetimeOperands";
import { datetimeOrdering } from "./documents/datetimeOrdering";
import { datetimeSaved } from "./documents/datetimeSaved";
import { datetimeSplit } from "./documents/datetimeSplit";
import { detailOnlyColumn } from "./documents/detailOnlyColumn";
import { emptyListNoEnglish } from "./documents/emptyListNoEnglish";
import {
	expressionPropertyRenames,
	expressionRenames,
} from "./documents/expressionRenames";
import { formLinkCarriedCase } from "./documents/formLinkCarriedCase";
import { formLinkChain } from "./documents/formLinkChain";
import { formLinkHiddenTarget } from "./documents/formLinkHiddenTarget";
import { formLinkOtherwise } from "./documents/formLinkOtherwise";
import { formLinksHiddenFallback } from "./documents/formLinksHiddenFallback";
import {
	fieldListFlags,
	invalidConnectIds,
	invalidQuestionIds,
	labelledGroupRepeat,
	reservedNodeNames,
	surveyMenu,
} from "./documents/formShapes";
import { formsInMenuAbove } from "./documents/formsInMenuAbove";
import { formsInMenuAboveNested } from "./documents/formsInMenuAboveNested";
import {
	formsInMenuAboveOneCase,
	formsInMenuAboveRegistrationOnly,
} from "./documents/formsInMenuAbovePrefixes";
import { gpsQuestion } from "./documents/gpsQuestion";
import { heldPlacement } from "./documents/heldPlacement";
import { hiddenCalculatedColumn, hiddenColumn } from "./documents/hiddenColumn";
import { hiddenFromMenu } from "./documents/hiddenFromMenu";
import { hqSideLookup } from "./documents/hqSideLookup";
import { hqSideState } from "./documents/hqSideState";
import { hyphenatedQuestionIds } from "./documents/hyphenatedQuestionIds";
import { inlineSearchReads } from "./documents/inlineSearchReads";
import { instanceReads } from "./documents/instanceReads";
import { keptValues } from "./documents/keptValues";
import { labelSort } from "./documents/labelSort";
import { loadTimeValues } from "./documents/loadTimeValues";
import { lookupNames } from "./documents/lookupNames";
import { lookupReservedTags } from "./documents/lookupReservedTags";
import { mediaSlots } from "./documents/mediaSlots";
import {
	migrationAttachment,
	migrationCaseWrites,
	migrationExtensionChildren,
	migrationFormLinks,
	migrationGroupsPreloads,
	migrationQueryRepeats,
	migrationRepeatCounts,
	migrationSearchWorkflow,
} from "./documents/migrations";
import { multiSelectDestinations } from "./documents/multiSelectDestinations";
import {
	formLinkSessionReads,
	nestedMenuSessionReads,
	tileSessionReads,
} from "./documents/nativeSessionReads";
import { noMatchesReturnIdentity } from "./documents/noMatchesReturnIdentity";
import { numberKeypad } from "./documents/numberKeypad";
import { plainHelp } from "./documents/plainHelp";
import { platformDeclaration } from "./documents/platformDeclaration";
import { previewAndroidRenders } from "./documents/previewAndroidRenders";
import { proseValue } from "./documents/proseValue";
import {
	registerFromCaseList,
	registerFromCaseListWebApps,
} from "./documents/registerFromCaseList";
import {
	queryRepeatPlacements,
	queryRepeatPlaces,
	repeatCountCopy,
	repeatCountWhole,
} from "./documents/repeats";
import { sameTypeChild } from "./documents/sameTypeChild";
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
import { searchFieldNames } from "./documents/searchFieldNames";
import { searchNoTitle } from "./documents/searchNoTitle";
import {
	searchWorkflow,
	searchWorkflowAndroid,
	searchWorkflowInline,
} from "./documents/searchWorkflows";
import { sessionContextReads } from "./documents/sessionContextReads";
import { sessionReads } from "./documents/sessionReads";
import { sortBlanks } from "./documents/sortBlanks";
import { sharedPropertySort } from "./documents/sortKeys";
import {
	parentFormPreviousFrame,
	parentFormSelectionFrame,
	wireEqualRepublish,
} from "./documents/stableWitnesses";
import { supplyPointText } from "./documents/supplyPointText";
import { plainLabels, textReads } from "./documents/textReads";
import { tileGroupFilter } from "./documents/tileGroupFilter";
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
	sessionContextReads,
	caseListSearchTextDocument,
	migrationSearchWorkflow,
	migrationCaseWrites,
	migrationAttachment,
	migrationExtensionChildren,
	migrationQueryRepeats,
	migrationFormLinks,
	migrationGroupsPreloads,
	migrationRepeatCounts,
	queryRepeatPlacements,
	repeatCountWhole,
	caseWritesOneConcept,
	heldPlacement,
	advancedModule,
	extensionCarried,
	advancedChildModule,
	advancedHeldKind,
	rootCaseBlockNames,
	sameTypeChild,
	supplyPointText,
	fieldListFlags,
	plainLabels,
	plainHelp,
	searchWorkflow,
	searchWorkflowInline,
	searchWorkflowAndroid,
	caseListMenuItem,
	commtrackAdvanced,
	formLinkChain,
	formLinkCarriedCase,
	formLinkOtherwise,
	hyphenatedQuestionIds,
	caseTypeNames,
	choiceValues,
	lookupNames,
	searchFieldNames,
	caseWriteNames,
	connectDeliverHyphenIds,
	connectLearnHyphenIds,
	numberKeypad,
	detailOnlyColumn,
	proseValue,
	searchNoTitle,
	sortBlanks,
	datetimeSaved,
	formsInMenuAbove,
	formsInMenuAboveNested,
	formsInMenuAboveRegistrationOnly,
	formsInMenuAboveOneCase,
	registerFromCaseList,
	registerFromCaseListWebApps,
	tileGroupFilter,
	keptValues,
];

/** Every targeted document, in a fixed order. */
export function targetedDocuments(): CorpusDocument[] {
	return TARGETED_DOCUMENTS.map((make) => make());
}
