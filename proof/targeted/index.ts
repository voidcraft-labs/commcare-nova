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
	parentIndexAgainstSelection,
	rootCaseBlockNames,
} from "./documents/advancedModules";
import { ancestorIndexNames } from "./documents/ancestorIndexNames";
import { androidAppAnswers } from "./documents/androidAppAnswers";
import { attributeDisplayCondition } from "./documents/attributeDisplayCondition";
import { blankLabels } from "./documents/blankLabels";
import { calculationTextNames } from "./documents/calculationTextNames";
import { captureWidgets } from "./documents/captureWidgets";
import { attributeColumns, caseIdColumn } from "./documents/caseIdColumn";
import {
	caseListDeviceLookup,
	caseListDeviceLookupCount,
	caseListDeviceLookupProperty,
	caseListDeviceLookupSum,
	caseListDeviceLookupWording,
} from "./documents/caseListDeviceLookup";
import { caseListIconAction } from "./documents/caseListIconAction";
import { caseListMenuItem } from "./documents/caseListMenuItems";
import { caseListSearchTextDocument } from "./documents/caseListSearchText";
import { caseMap } from "./documents/caseMap";
import { caseTypeNames } from "./documents/caseTypeNames";
import { caseWriteNames } from "./documents/caseWriteNames";
import { caseWritesOneConcept } from "./documents/caseWritesOneConcept";
import { choiceValueColumns } from "./documents/choiceValueColumns";
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
	connectRecipientRepeat,
	connectSectionOrder,
} from "./documents/connectApps";
import { csqlComposition } from "./documents/csqlComposition";
import { customTile, tileHiddenOrder } from "./documents/customTile";
import { datetimeEquality } from "./documents/datetimeEquality";
import { datetimeOperands } from "./documents/datetimeOperands";
import { datetimeOrdering } from "./documents/datetimeOrdering";
import { datetimeSaved } from "./documents/datetimeSaved";
import { datetimeSplit } from "./documents/datetimeSplit";
import { detailOnlyColumn } from "./documents/detailOnlyColumn";
import { nearestClinics } from "./documents/distanceOrder";
import { emptyListNoEnglish } from "./documents/emptyListNoEnglish";
import {
	expressionPropertyRenames,
	expressionRenames,
} from "./documents/expressionRenames";
import { facePhoto } from "./documents/facePhoto";
import { formBehaviorPragmas } from "./documents/formBehaviorPragmas";
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
import { hiddenAnswerTypes } from "./documents/hiddenAnswerTypes";
import { hiddenCalculatedColumn, hiddenColumn } from "./documents/hiddenColumn";
import { hiddenFromMenu } from "./documents/hiddenFromMenu";
import {
	hqChangesCaseManagement,
	hqChangesFormSetting,
	hqChangesForms,
	hqChangesLabel,
	hqChangesLocationList,
	hqChangesMedia,
	hqChangesMenu,
	hqChangesMenuLayouts,
	hqChangesOrder,
	hqChangesQuestions,
	hqChangesResave,
} from "./documents/hqChanges";
import {
	hqChangesCaseFormats,
	legacyRelatedCaseText,
} from "./documents/hqChangesCaseFormats";
import { hqChangesCaseImage } from "./documents/hqChangesCaseImage";
import { hqChangesCaseTabs } from "./documents/hqChangesCaseTabs";
import { hqSideLookup } from "./documents/hqSideLookup";
import { hqSideOwned } from "./documents/hqSideOwned";
import { hqSideState } from "./documents/hqSideState";
import { hyphenatedQuestionIds } from "./documents/hyphenatedQuestionIds";
import { independentFormChoices } from "./documents/independentFormChoices";
import { indexedLookup } from "./documents/indexedLookup";
import { inlineSearchReads } from "./documents/inlineSearchReads";
import { instanceReads } from "./documents/instanceReads";
import { keptValues } from "./documents/keptValues";
import { labelContent } from "./documents/labelContent";
import { labelSort } from "./documents/labelSort";
import { listedForms } from "./documents/listedForms";
import { loadTimeValues } from "./documents/loadTimeValues";
import { lookupNames } from "./documents/lookupNames";
import { lookupNonAsciiNames } from "./documents/lookupNonAsciiNames";
import { lookupReservedTags } from "./documents/lookupReservedTags";
import { mediaSlots } from "./documents/mediaSlots";
import { menuBadges } from "./documents/menuBadges";
import { menuLayouts } from "./documents/menuLayouts";
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
import { missingMedia } from "./documents/missingMedia";
import { multiSelectDestinations } from "./documents/multiSelectDestinations";
import { namedAnswerRoot } from "./documents/namedAnswerRoot";
import {
	formLinkSessionReads,
	nestedMenuSessionReads,
	tileSessionReads,
} from "./documents/nativeSessionReads";
import { noMatchesReturnIdentity } from "./documents/noMatchesReturnIdentity";
import { numberKeypad } from "./documents/numberKeypad";
import { plainHelp } from "./documents/plainHelp";
import { platformDeclaration } from "./documents/platformDeclaration";
import { positionedCaseCreate } from "./documents/positionedCaseCreate";
import { previewAndroidRenders } from "./documents/previewAndroidRenders";
import { proseValue } from "./documents/proseValue";
import { qualifiedLookupValues } from "./documents/qualifiedLookupValues";
import { questionCalendar } from "./documents/questionCalendar";
import { reachedChoiceColumns } from "./documents/reachedChoiceColumns";
import {
	registerFromCaseList,
	registerFromCaseListWebApps,
} from "./documents/registerFromCaseList";
import { relatedColumns } from "./documents/relatedColumns";
import { relativeCaseDates } from "./documents/relativeCaseDates";
import { repeatInvitations } from "./documents/repeatInvitations";
import {
	openingQueryChoices,
	queryRepeatPlacements,
	queryRepeatPlaces,
	repeatCountCopy,
	repeatCountWhole,
} from "./documents/repeats";
import { sameTypeChild } from "./documents/sameTypeChild";
import { savedFormDescriptor } from "./documents/savedFormDescriptor";
import { saveToCaseRead } from "./documents/saveToCaseRead";
import { saveToCaseShapes } from "./documents/saveToCaseShapes";
import {
	listFirstPlaces,
	listFirstWebApps,
	searchDefaultFilterName,
	searchHqCompile,
	searchRelatedLookups,
	searchWithFormsAbove,
	syncOnFormEntry,
	syncOnFormEntryWebApps,
} from "./documents/searchApps";
import { searchedSharedVisit } from "./documents/searchedSharedVisit";
import { searchFieldNames } from "./documents/searchFieldNames";
import { searchNoTitle } from "./documents/searchNoTitle";
import {
	searchWorkflow,
	searchWorkflowAndroid,
	searchWorkflowInline,
} from "./documents/searchWorkflows";
import { sessionContextReads } from "./documents/sessionContextReads";
import { sessionReads } from "./documents/sessionReads";
import { severalCaseClose } from "./documents/severalCaseClose";
import { sharedVisitEntries } from "./documents/sharedVisitEntries";
import { sortBlanks } from "./documents/sortBlanks";
import {
	caseChoiceReopen,
	sortedCaseChoices,
} from "./documents/sortedCaseChoices";
import { independentCaseOrder, sharedPropertySort } from "./documents/sortKeys";
import { sortLabels } from "./documents/sortLabels";
import {
	parentFormPreviousFrame,
	parentFormSelectionFrame,
	wireEqualRepublish,
} from "./documents/stableWitnesses";
import { startingAndCalculatedAnswers } from "./documents/startingAndCalculatedAnswers";
import { styledValue } from "./documents/styledValue";
import {
	receivingAnswersOnAndroid,
	receivingAnswersOnBoth,
} from "./documents/submittedAnswerNames";
import { submittedGroups } from "./documents/submittedGroups";
import { supplyPointText } from "./documents/supplyPointText";
import { plainLabels, textReads } from "./documents/textReads";
import { tileGroupFilter } from "./documents/tileGroupFilter";
import { tileRowBound } from "./documents/tileRowBound";
import { validatedBarcodeSecret } from "./documents/validatedBarcodeSecret";
import { webFormActivity } from "./documents/webFormActivity";
import { workerMessages } from "./documents/workerMessages";
import { workerRecordColumns } from "./documents/workerRecordColumns";

/** Every targeted document's maker, in the corpus's order. */
export const TARGETED_DOCUMENTS: readonly (() => CorpusDocument)[] = [
	receivingAnswersOnBoth,
	receivingAnswersOnAndroid,
	facePhoto,
	lookupReservedTags,
	searchHqCompile,
	validatedBarcodeSecret,
	workerMessages,
	webFormActivity,
	formBehaviorPragmas,
	labelSort,
	calculationTextNames,
	customTile,
	caseListDeviceLookup,
	caseListDeviceLookupCount,
	caseListDeviceLookupProperty,
	caseListDeviceLookupSum,
	caseListDeviceLookupWording,
	caseListIconAction,
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
	repeatInvitations,
	reservedNodeNames,
	searchRelatedLookups,
	loadTimeValues,
	sharedPropertySort,
	independentCaseOrder,
	nearestClinics,
	searchDefaultFilterName,
	searchWithFormsAbove,
	syncOnFormEntry,
	hqSideState,
	hqSideOwned,
	parentFormSelectionFrame,
	parentFormPreviousFrame,
	wireEqualRepublish,
	formLinkHiddenTarget,
	emptyListNoEnglish,
	connectDeliverRename,
	connectRecipientRepeat,
	connectSectionOrder,
	connectLearnRename,
	saveToCaseRead,
	saveToCaseShapes,
	positionedCaseCreate,
	mediaSlots,
	labelContent,
	missingMedia,
	captureWidgets,
	noMatchesReturnIdentity,
	hqSideLookup,
	datetimeOrdering,
	datetimeOperands,
	datetimeEquality,
	caseIdColumn,
	menuBadges,
	attributeDisplayCondition,
	gpsQuestion,
	blankLabels,
	attributeColumns,
	hiddenCalculatedColumn,
	tileHiddenOrder,
	tileRowBound,
	hiddenFromMenu,
	listedForms,
	startingAndCalculatedAnswers,
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
	hiddenAnswerTypes,
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
	openingQueryChoices,
	repeatCountWhole,
	caseWritesOneConcept,
	heldPlacement,
	advancedModule,
	extensionCarried,
	advancedChildModule,
	advancedHeldKind,
	parentIndexAgainstSelection,
	rootCaseBlockNames,
	sameTypeChild,
	supplyPointText,
	fieldListFlags,
	submittedGroups,
	namedAnswerRoot,
	plainLabels,
	plainHelp,
	searchWorkflow,
	searchWorkflowInline,
	searchWorkflowAndroid,
	caseListMenuItem,
	commtrackAdvanced,
	formLinkChain,
	formLinkCarriedCase,
	indexedLookup,
	independentFormChoices,
	sharedVisitEntries,
	searchedSharedVisit,
	formLinkOtherwise,
	hyphenatedQuestionIds,
	caseTypeNames,
	choiceValues,
	lookupNames,
	qualifiedLookupValues,
	lookupNonAsciiNames,
	searchFieldNames,
	caseWriteNames,
	connectDeliverHyphenIds,
	connectLearnHyphenIds,
	androidAppAnswers,
	sortedCaseChoices,
	caseChoiceReopen,
	numberKeypad,
	questionCalendar,
	savedFormDescriptor,
	detailOnlyColumn,
	relatedColumns,
	workerRecordColumns,
	proseValue,
	searchNoTitle,
	choiceValueColumns,
	caseMap,
	reachedChoiceColumns,
	relativeCaseDates,
	sortBlanks,
	sortLabels,
	datetimeSaved,
	formsInMenuAbove,
	formsInMenuAboveNested,
	menuLayouts,
	formsInMenuAboveRegistrationOnly,
	formsInMenuAboveOneCase,
	registerFromCaseList,
	registerFromCaseListWebApps,
	tileGroupFilter,
	keptValues,
	severalCaseClose,
	ancestorIndexNames,
	hqChangesLabel,
	hqChangesResave,
	hqChangesQuestions,
	hqChangesFormSetting,
	hqChangesCaseManagement,
	hqChangesCaseFormats,
	legacyRelatedCaseText,
	hqChangesCaseImage,
	hqChangesCaseTabs,
	hqChangesMenu,
	hqChangesMenuLayouts,
	hqChangesForms,
	hqChangesOrder,
	hqChangesLocationList,
	hqChangesMedia,
	styledValue,
];

/** Every targeted document, in a fixed order. */
export function targetedDocuments(): CorpusDocument[] {
	return TARGETED_DOCUMENTS.map((make) => make());
}
