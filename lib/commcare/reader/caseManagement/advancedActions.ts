/**
 * An advanced form's case actions (`models/form_actions.py::AdvancedFormActions`)
 * read into its type, its menu's parent selection and its case operations,
 * and an advanced menu's own keys read into its held kind.
 *
 * HQ's `AdvancedModule` stores no parent selection: each form states its own
 * selections as loads. The menu's one chain is the one every case-loading
 * form agrees on (`readLoadChain`), and the reading holds only where the
 * loads Nova derives from it (`planFormCaseWire`) are HQ's, tag by tag. Every
 * operation read from a load or an open action holds the action's tag as its
 * placement, so a publish keeps each `case_<tag>` and `case_id_<tag>` HQ's
 * forms read.
 */

import {
	advancedCaseIndexNameProblem,
	advancedCaseIndexNeedsAndroid,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	type CaseWriteVia,
	type Expression,
	type FormCaseSelection,
	type FormSelectionSource,
	type FormType,
	isCaseOperationIdentifier,
	isCaseOperationLinkIdentifier,
	ownCaseOperationId,
	type TargetedCaseOperation,
	type Term,
	type Uuid,
} from "@/lib/domain";
import {
	formCaseSelections,
	isAdvancedOwnLabelProperty,
} from "@/lib/domain/advancedEntryDatums";
import { advancedKindBlockers } from "@/lib/domain/advancedModule";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	actingUser,
	formField,
	matchAll,
	term,
	unowned,
} from "@/lib/domain/expression/builders";
import { implicitFormSelectionId } from "@/lib/domain/formEntryCases";
import { isPortableName } from "@/lib/domain/portableName";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import { submittedElementNameNeedsAndroid } from "@/lib/domain/submittedAnswerName";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import { advancedActionsWithEntry } from "../../advancedEntryValues";
import type { PlannedLoad } from "../../advancedSelections";
import { HQ_CASE_TAG_PATTERN } from "../../advancedTags";
import { planFormCaseWire } from "../../casePlacementPlan";
import {
	entrySessionDatums,
	formLinkProjectionContext,
	physicalEntrySupplyProblems,
} from "../../formLinkProjection";
import {
	datumIdsFromFacts,
	type HqAppEntryFacts,
	hqEntryFacts,
} from "../../hq/entryFacts";
import { planPlacements } from "../../placement";
import { sharedFormDependencies } from "../../validator/rules/sharedForm";
import { rethrowWorkStop } from "../../workMeter";
import {
	type GeneratedNodePurpose,
	generatedBaseName,
	planGeneratedNodes,
} from "../../xform/generatedNodes";
import type { Admitted } from "../accounting";
import { type Claim, defineClaims, drop, refuse, take } from "../claims";
import type { DraftForm, DraftModule, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { externalKey } from "../identity";
import {
	isJsonObject,
	type JsonCursor,
	objectMembers,
	sameJson,
} from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { whereText } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import { provisionalDocument } from "../provisional";
import { holdsWorkerRecordWrite } from "../worldEntities";
import type { DraftField } from "../xform";
import { isAllocatedName } from "../xform/generated";
import type { DataNode } from "../xform/model";
import { registrationOpenIndex } from "./advancedRegistration";
import {
	ancestorSteps,
	BASIC_CLAIMS,
	dropCreateNameRequired,
	namesAttachment,
	type PropertyNameClass,
	type ProposedValue,
	propertyNameClass,
	type QuestionValue,
	questionValue,
	repeatOfField,
} from "./basicActions";
import {
	ANSWER_ALONE_CLAIMS,
	conditionField,
	conditionFinding,
	conditionQuestionPath,
	conditionReadsAnswerAlone,
	conditionType,
	readActionCondition,
	recordRespelledConditions,
	repeatAtPath,
	statedBack,
} from "./conditions";
import {
	holdsAsOpeningAssignment,
	holdsEarlierDefault,
	recordLateAssignment,
} from "./openingAssignments";
import {
	addPreloadCandidate,
	fieldAt,
	holdsDefault,
	hqBuildRefusesProperty,
	preloadNameRefusal,
	preloadReadOf,
	UNNAMED_PRELOAD,
	writeDefault,
} from "./preloads";

const F = "forms-and-case-writes";
const M = "menus-and-case-lists";

export const ADVANCED_CLAIMS = defineClaims("caseManagement.advancedActions", {
	// The menu.
	productDefault: drop(
		`${M}/advancedmodule-product-details-equal-to-the-default-single-name`,
		"schema:AdvancedModule.product_details",
	),
	productOther: refuse(
		`${M}/advancedmodule-product-details-differing-from-the-default`,
		"schema:AdvancedModule.product_details",
	),
	hasSchedule: refuse(
		`${M}/advancedmodule-has-schedule-true-or-schedule-phases-non-empty`,
		"schema:AdvancedModule.has_schedule",
	),
	schedulePhases: refuse(
		`${M}/advancedmodule-has-schedule-true-or-schedule-phases-non-empty`,
		"schema:AdvancedModule.schedule_phases",
	),
	autoSelectCase: take(
		`${M}/auto-select-case-on-an-advanced-module`,
		"schema:AdvancedModule.auto_select_case",
	),
	kindBlocked: refuse(
		`${M}/advanced-module-nova-would-write-as-a-basic-one`,
		"schema:AdvancedModule",
	),

	// The form.
	scheduleOff: drop(
		`${F}/advancedform-schedule-with-enabled-false`,
		"schema:AdvancedForm.schedule",
	),
	scheduleOn: refuse(
		`${F}/advancedform-schedule-with-enabled-true-visits-transition`,
		"schema:AdvancedForm.schedule",
	),
	scheduleMissingQuestion: refuse(
		`${F}/advancedform-schedule-with-enabled-false-on-an-advanced-form`,
		"schema:AdvancedForm.schedule",
	),
	arbitraryDatumId: take(
		`${F}/arbitrary-datums-datum-id-datum-function`,
		"schema:ArbitraryDatum.datum_id",
	),
	arbitraryDatums: take(
		`${F}/arbitrary-datums-datum-id-datum-function`,
		"schema:AdvancedForm.arbitrary_datums",
	),
	actions: take(
		`${F}/load-update-cases-loadupdateaction`,
		"schema:AdvancedForm.actions",
	),
	loads: take(
		`${F}/load-update-cases-loadupdateaction`,
		"schema:AdvancedFormActions.load_update_cases",
	),
	opens: take(
		`${F}/open-cases-advancedopencaseaction-any-other`,
		"schema:AdvancedFormActions.open_cases",
	),

	// A load.
	tag: take(
		`${F}/loadupdateaction-case-tag-without`,
		"schema:LoadUpdateAction.case_tag",
	),
	tagSlash: refuse(
		`${F}/a-load-or-open-action-s-case-tag-containing-which-the-advanced`,
		"schema:LoadUpdateAction.case_tag",
	),
	tagBlank: refuse(
		`${F}/case-tag-blank-on-a-non-auto-select-action`,
		"schema:LoadUpdateAction.case_tag",
	),
	tagFailsPage: refuse(
		`${F}/case-tag-of-a-non-auto-select-action-failing-actions-js`,
		"schema:LoadUpdateAction.case_tag",
	),
	tagHyphen: take(
		`${F}/case-tag-holding-a-hyphen`,
		"schema:LoadUpdateAction.case_tag",
	),
	caseType: take(
		`${F}/loadupdateaction-case-type`,
		"schema:LoadUpdateAction.case_type",
	),
	detailsModule: take(
		`${F}/loadupdateaction-details-module`,
		"schema:LoadUpdateAction.details_module",
	),
	detailsModuleOther: refuse(
		`${F}/details-module-naming-another-module-of-a-different-case-type-or`,
		"schema:LoadUpdateAction.details_module",
	),
	duplicateEntryKey: refuse(
		`${F}/opening-values-sharing-a-physical-session-name`,
		"schema:AdvancedFormActions.load_update_cases",
	),
	alignedConnection: refuse(
		`${F}/automatic-connection-to-a-load-renamed-by-its-parent`,
		"schema:LoadUpdateAction.auto_select",
	),
	notOneChain: take(
		`${F}/advanced-form-loads-other-than-its-menu-s-one-chain`,
		"schema:AdvancedFormActions.load_update_cases",
	),
	/** A load outside the menu's one chain, in a menu whose case list offers a registration:
	 *  the refusal at the case list (`menus/registration.ts`) is its finding. */
	listFormRules: refuse(
		`${F}/advanced-forms-in-a-module-whose-case-list-offers-a-registration`,
		"schema:AdvancedFormActions.load_update_cases",
	),
	underivedTag: take(
		`${F}/load-changing-no-case-with-a-tag-nova-does-not-derive`,
		"schema:LoadUpdateAction.case_tag",
	),
	usercaseWritesNothing: take(
		`${F}/load-changing-no-case-with-a-tag-nova-does-not-derive`,
		"schema:LoadUpdateAction.auto_select",
	),
	caseIndex: take(
		`${F}/loadupdateaction-case-index-tag-reference-id-relationship`,
		"schema:LoadUpdateAction.case_index",
	),
	caseIndexOnFirst: refuse(
		`${F}/loadupdateaction-case-index-on-an-auto-selected-load-or-on-the`,
		"schema:LoadUpdateAction.case_index",
	),
	caseIndexNoAction: refuse(
		`${F}/case-index-tag-naming-no-action`,
		"schema:LoadUpdateAction.case_index",
	),
	caseIndexOtherLoad: refuse(
		`${F}/loadupdateaction-case-index-tag-naming-a-load-other-than-the-one`,
		"schema:LoadUpdateAction.case_index",
	),
	/** The first chosen load's index naming the worker's record's load stored before it, which
	 *  narrows the chosen list to the worker's record's children. */
	caseIndexToWorkerLoad: take(
		`${F}/an-index-on-the-first-chosen-load-naming-the-worker-s-record-loaded-before-it`,
		"schema:LoadUpdateAction.case_index",
	),
	/** The worker's record's load stored before a chosen load: HQ's entry computes its datum
	 *  before the chosen loads' selections, and Nova writes it after them. */
	workerLoadFirst: take(
		`${F}/the-worker-s-record-s-auto-selected-load-stored-before-a-chosen-load`,
		"schema:AdvancedFormActions.load_update_cases",
	),
	fromFixture: refuse(
		`${F}/load-case-from-fixture-loadcasefromfixture-all-fields`,
		"schema:LoadUpdateAction.load_case_from_fixture",
	),
	productStock: refuse(
		`${F}/show-product-stock-true-or-a-non-empty-product-program`,
		"schema:LoadUpdateAction.show_product_stock",
	),
	productStockOff: drop(
		`${F}/show-product-stock-false-and-product-program`,
		"schema:LoadUpdateAction.show_product_stock",
	),
	productProgramOff: drop(
		`${F}/show-product-stock-false-and-product-program`,
		"schema:LoadUpdateAction.product_program",
	),
	loadProperties: take(
		`${F}/loadupdateaction-case-properties`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadQuestionPath: take(
		`${F}/loadupdateaction-case-properties`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	slashOnIndexedLoad: refuse(
		`${F}/loadupdateaction-preload-or-case-properties-property-with-on-a`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadIllegalKey: refuse(
		`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadNonCoreKey: refuse(
		`${F}/update-key-holding-a-character-validate-property-accepts-that-is`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadNonAsciiKey: refuse(
		`${F}/update-key-holding-a-non-ascii-core-name-character`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadWorkerKey: refuse(
		`${F}/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadViaUnknown: refuse(
		`${F}/index-path-through-a-case-type-the-app-does-not-fix`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadViaElsewhere: refuse(
		`${F}/loadupdateaction-case-properties-key-with-on-a-load-with-no-case`,
		"schema:LoadUpdateAction.case_properties",
	),
	loadViaFacet: take(
		`${F}/update-key-name-or-owner-id-through-an-index-segment`,
		"schema:LoadUpdateAction.case_properties",
	),
	slashPreloadOnIndexedLoad: refuse(
		`${F}/loadupdateaction-preload-or-case-properties-property-with-on-a`,
		"schema:LoadUpdateAction.preload",
	),
	editHeld: take(
		`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
		"schema:ConditionalCaseUpdate.update_mode",
	),
	editFacet: take(
		`${F}/update-mode-edit-on-a-case-s-name-or-owner`,
		"schema:ConditionalCaseUpdate.update_mode",
	),
	editNotApplied: drop(
		`${F}/update-mode-edit-in-a-project-space-that-saves-every-time`,
		"schema:ConditionalCaseUpdate.update_mode",
	),
	ownClose: take(
		`${F}/loadupdateaction-close-condition-on-the-form-s-own-selection`,
		"schema:LoadUpdateAction.close_condition",
	),
	otherClose: take(
		`${F}/loadupdateaction-close-condition-on-any-other-selection`,
		"schema:LoadUpdateAction.close_condition",
	),
	preload: take(
		`${F}/loadupdateaction-preload-question-property`,
		"schema:LoadUpdateAction.preload",
	),
	assignedAtOpen: take(
		`${F}/loadupdateaction-preload-read-later-in-the-load`,
		"schema:LoadUpdateAction.preload",
	),
	calculatedOpening: take(
		`${F}/case-preload-into-a-question-that-holds-no-default`,
		"schema:LoadUpdateAction.preload",
	),
	preloadLater: refuse(
		`${F}/a-source-only-record-load-with-no-equivalent-editable-initial-value`,
		"schema:LoadUpdateAction.preload",
	),
	preloadNoDefault: refuse(
		`${F}/a-source-only-record-load-with-no-equivalent-editable-initial-value`,
		"schema:LoadUpdateAction.preload",
	),
	preloadOtherCase: refuse(
		`${F}/index-path-through-a-case-type-the-app-does-not-fix`,
		"schema:LoadUpdateAction.preload",
	),
	illegalPreload: refuse(
		`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
		"schema:LoadUpdateAction.preload",
	),
	passiveLabelWrite: take(
		`${F}/an-advanced-follow-up-update-from-its-root-passive-label`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	labelQuestion: refuse(
		`${F}/an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	usercase: take(
		`${F}/auto-select-mode-usercase`,
		"schema:LoadUpdateAction.auto_select",
	),
	heldRaw: take(
		`${F}/auto-select-mode-raw-value-key`,
		"schema:LoadUpdateAction.auto_select",
	),
	heldRawUnusedSource: take(
		`${F}/auto-select-mode-raw-value-key`,
		"schema:AutoSelectCase.value_source",
	),
	heldRawMode: take(
		`${F}/auto-select-mode-raw-value-key`,
		"schema:AutoSelectCase.mode",
	),
	heldUser: take(
		`${F}/auto-select-mode-user`,
		"schema:LoadUpdateAction.auto_select",
	),
	heldFixture: take(
		`${F}/auto-select-mode-fixture`,
		"schema:LoadUpdateAction.auto_select",
	),
	heldCase: take(
		`${F}/auto-select-mode-case-index-of-an-earlier-load`,
		"schema:LoadUpdateAction.auto_select",
	),
	duplicateTag: refuse(
		`${F}/case-actions-using-the-same-tag`,
		"schema:LoadUpdateAction.case_tag",
	),
	workerModeType: refuse(
		`${F}/worker-record-selection-with-another-case-type`,
		"schema:LoadUpdateAction.auto_select",
	),
	fixtureSourceMissing: refuse(
		`${F}/automatic-table-choice-without-its-table-or-column`,
		"schema:LoadUpdateAction.auto_select",
	),
	unknownMode: refuse(
		`${F}/automatic-choice-with-an-unknown-mode`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoCaseLater: refuse(
		`${F}/auto-select-mode-case-naming-itself-a-later-load-or-an-open`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoMissingKey: refuse(
		`${F}/auto-select-missing-its-key-in-case-fixture-user-or-raw-mode`,
		"schema:LoadUpdateAction.auto_select",
	),
	autoBlank: refuse(
		`${F}/an-auto-select-load-with-a-blank-mode-or-a-blank-case-type`,
		"schema:LoadUpdateAction.auto_select",
	),

	// An open action.
	openOwn: take(
		`${F}/open-cases-advancedopencaseaction-the-one-open-action-outside`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openOwnType: take(
		`${F}/open-cases-advancedopencaseaction-the-one-open-action-outside`,
		"schema:AdvancedOpenCaseAction.case_type",
	),
	openTag: take(
		`${F}/open-cases-advancedopencaseaction-any-other`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openType: take(
		`${F}/open-cases-advancedopencaseaction-any-other`,
		"schema:AdvancedOpenCaseAction.case_type",
	),
	openTagSlash: refuse(
		`${F}/a-load-or-open-action-s-case-tag-containing-which-the-advanced`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openTagBlank: refuse(
		`${F}/case-tag-blank-on-a-non-auto-select-action`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openTagFailsPage: refuse(
		`${F}/case-tag-of-a-non-auto-select-action-failing-actions-js`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openTagHyphen: take(
		`${F}/case-tag-holding-a-hyphen`,
		"schema:AdvancedOpenCaseAction.case_tag",
	),
	openTypeUnknown: refuse(
		`${F}/open-case-type-not-any-module-s-case-type-and-not-commcare-user`,
		"schema:AdvancedOpenCaseAction.case_type",
	),
	openName: take(
		`${F}/advancedopencaseaction-name-update`,
		"schema:AdvancedOpenCaseAction.name_update",
	),
	openProperties: take(
		`${F}/advancedopencaseaction-case-properties-keys-without`,
		"schema:AdvancedOpenCaseAction.case_properties",
	),
	openQuestionPath: take(
		`${F}/advancedopencaseaction-case-properties-keys-without`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	openSlashKey: refuse(
		`${F}/advancedopencaseaction-case-properties-key-with-parent-p`,
		"schema:AdvancedOpenCaseAction.case_properties",
	),
	openIllegalKey: refuse(
		`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
		"schema:AdvancedOpenCaseAction.case_properties",
	),
	openNonCoreKey: refuse(
		`${F}/update-key-holding-a-character-validate-property-accepts-that-is`,
		"schema:AdvancedOpenCaseAction.case_properties",
	),
	openNonAsciiKey: refuse(
		`${F}/update-key-holding-a-non-ascii-core-name-character`,
		"schema:AdvancedOpenCaseAction.case_properties",
	),
	openRepeat: take(
		`${F}/advancedopencaseaction-repeat-context-equal-to-the-name-question`,
		"schema:AdvancedOpenCaseAction.repeat_context",
	),
	openRepeatOther: refuse(
		`${F}/advancedopencaseaction-repeat-context-other-than-the-name`,
		"schema:AdvancedOpenCaseAction.repeat_context",
	),
	openSharedRepeat: refuse(
		`${F}/two-or-more-open-actions-whose-repeat-context-is-one-repeat`,
		"schema:AdvancedOpenCaseAction.repeat_context",
	),
	openCondition: take(
		`${F}/advancedopencaseaction-open-condition`,
		"schema:AdvancedOpenCaseAction.open_condition",
	),
	openClose: take(
		`${F}/advancedopencaseaction-close-condition`,
		"schema:AdvancedOpenCaseAction.close_condition",
	),
	openIndices: take(
		`${F}/advancedopencaseaction-case-indices-child-extension-one-or-many`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	extendedOpenIndexReference: take(
		`${F}/advancedopencaseaction-case-indices-child-extension-one-or-many`,
		"schema:CaseIndex.reference_id",
	),
	unicodeOpenIndexReference: take(
		`${F}/advanced-open-connection-unicode-name`,
		"schema:CaseIndex.reference_id",
	),
	openIndexOwnOrLater: refuse(
		`${F}/advancedopencaseaction-case-indices-naming-its-own-or-a-later`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexNoAction: refuse(
		`${F}/case-index-tag-naming-no-action`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexQuestion: refuse(
		`${F}/relationship-question-without-relationship-question`,
		"schema:CaseIndex.relationship",
	),
	openIndexOutsideRepeat: refuse(
		`${F}/an-advanced-open-action-indexed-to-an-open-action-that-has-a-neither`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	/** An index to an earlier open action in a repeat, from an open action in the same repeat. */
	openIndexInsideRepeat: take(
		`${F}/an-advanced-open-action-indexed-to-an-open-action-that-has-a-equal`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexInvalidXml: refuse(
		`${F}/index-identifier-invalid-xml-local-name`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexUnaddressable: refuse(
		`${F}/index-identifier-unaddressable-in-worker-xpath`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	rootOpenIndexWebOnly: refuse(
		`${F}/root-open-index-unavailable-on-either-worker`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexName: refuse(
		`${F}/index-identifier-outside-an-xml-element-name`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexRenamedLoad: refuse(
		`${F}/an-advanced-open-action-s-index-to-a-load-whose-datum-hq-renames`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	openIndexAgainstSelection: take(
		`${F}/an-advanced-open-action-s-parent-index-against-a-menu-s-parent-selection`,
		"schema:AdvancedOpenCaseAction.case_indices",
	),
	questionToLoad: refuse(
		`${F}/caseindex-relationship-question-relationship-question-the-index-naming-a`,
		"schema:CaseIndex.relationship",
	),
	questionInRepeat: refuse(
		`${F}/caseindex-relationship-question-inside-a-repeat`,
		"schema:CaseIndex.relationship_question",
	),
	questionToOpen: refuse(
		`${F}/caseindex-relationship-question-relationship-question-the-index-naming-an`,
		"schema:CaseIndex.relationship",
	),
	questionAfterOpenIndex: refuse(
		`${F}/caseindex-relationship-question-on-an-index-to-a-load-that`,
		"schema:CaseIndex.relationship",
	),
});

/** The claims of a load's write map (`readProperties`), a chosen load's and the worker's alike. */
const LOAD_PROPERTY_CLAIMS = {
	map: ADVANCED_CLAIMS.loadProperties,
	path: ADVANCED_CLAIMS.loadQuestionPath,
	slash: undefined,
	surface: "schema:LoadUpdateAction.case_properties",
	names: {
		illegal: ADVANCED_CLAIMS.loadIllegalKey,
		"non-core": ADVANCED_CLAIMS.loadNonCoreKey,
		"non-ascii": ADVANCED_CLAIMS.loadNonAsciiKey,
	},
};

/** The worker's load's: a key no worker property takes is its own row. */
const WORKER_LOAD_PROPERTY_CLAIMS = {
	...LOAD_PROPERTY_CLAIMS,
	worker: ADVANCED_CLAIMS.loadWorkerKey,
};

// ── What the first pass proposes ────────────────────────────────────────

type ProposedCaseRef =
	| { readonly kind: "session" }
	| { readonly kind: "selected"; readonly module: Uuid }
	| { readonly kind: "selection"; readonly uuid: Uuid }
	| { readonly kind: "op"; readonly uuid: Uuid };

interface ProposedLink {
	readonly identifier: string;
	readonly targetType: string;
	readonly relationship: "child" | "extension";
	readonly target: ProposedCaseRef;
}

interface ProposedCondition {
	readonly stored: unknown;
	readonly repeat: DraftField | undefined;
	readonly place: HqPlace;
	/** Where the condition sits in the app's JSON. */
	readonly pointer: string;
}

interface AdvancedProposal {
	readonly uuid: Uuid;
	readonly id: string;
	readonly action: "own" | "create" | "update" | "close";
	readonly caseType?: string;
	readonly tag: string;
	readonly row?: true;
	readonly name?: ProposedValue;
	/** The own arm's rename on a load, saved only when changed. */
	readonly nameOnlyIfChanged?: true;
	readonly rename?: ProposedValue;
	readonly renameOnlyIfChanged?: true;
	readonly owner?: ProposedValue | "acting-user" | "unowned";
	readonly ownerOnlyIfChanged?: true;
	readonly writes: readonly {
		readonly property: string;
		readonly value: ProposedValue;
		readonly via?: CaseWriteVia;
		readonly onlyIfChanged?: true;
	}[];
	readonly condition?: ProposedCondition;
	readonly forEach?: DraftField;
	readonly target?:
		| ProposedCaseRef
		| { readonly kind: "worker-record" }
		| { readonly kind: "new" };
	readonly links: readonly ProposedLink[];
	/** A close sharing its place: the create or update it follows. */
	readonly shares?: Uuid;
}

/** One chosen load as stored: its tag, case type, list menu and index. */
export interface StoredLoad {
	readonly tag: string;
	readonly caseType: string;
	/** The menu whose list chooses the case, by `unique_id`; the form's own where blank. */
	readonly detailsModule: string;
	readonly index?: { readonly tag: string; readonly identifier: string };
	/** Whether it writes or closes a case. */
	readonly changes: boolean;
}

interface AdvancedReading {
	readonly choiceRelationshipQuestions?: ReadonlyMap<Uuid, DraftField>;
	readonly type: FormType;
	readonly operations: readonly AdvancedProposal[];
	readonly openCondition?: ProposedCondition;
	readonly closeCondition?: ProposedCondition;
	/** A registration that closes the case it opens on every submission. */
	readonly closesAlways?: true;
	/** The chosen loads, in order; empty for a registration or a survey. */
	readonly chosen: readonly StoredLoad[];
	/** The worker's load, where HQ holds one. */
	readonly worker?: StoredLoad;
	/** The form's own chain of list menus, root first; undefined where a load was a finding. */
	readonly chain?: readonly Uuid[];
	/** Each id the reading gave, in the order it gave them. */
	readonly mints: readonly AdvancedMint[];
	/** Whether the first pass refused part of the stored actions (a key, a load, an open
	 *  action), each refusal standing as its own finding. */
	readonly refused?: true;
	/** Each open action's name question, which carries the scalar check of the case's name. */
	readonly createNames: readonly DraftField[];
	/** The name and external id questions of each create whose condition the settle refuses
	 *  (`settleAdvancedForm`): the check each carries stands under that condition's finding. */
	readonly refusedScalarFields: DraftField[];
}

/** One id the reading gave an operation: its case type's, or the name its owner node carries. */
interface AdvancedMint {
	readonly id: string;
	readonly caseType: string;
	/** The id the operation's owner node names, where it names one. */
	readonly named?: string;
}

const READINGS = new WeakMap<DraftForm, AdvancedReading>();

/** Each advanced form's stored actions and loads as the first pass read them:
 *  the sites a refusal of the whole form's opening values covers. */
const OPENING_SITES = new WeakMap<
	DraftForm,
	{ readonly actions: JsonCursor; readonly loads: readonly JsonCursor[] }
>();

/** The first pass's reading of an advanced form. */
export function advancedCaseReading(
	form: DraftForm,
): AdvancedReading | undefined {
	return READINGS.get(form);
}

function consume<T>(admitted: Admitted<T>): T {
	return admitted.value;
}

function activeCondition(condition: unknown): boolean {
	const type = conditionType(condition);
	return type === "if" || type === "always";
}

/** The refusal a tag is, in the rows' order; undefined for a tag Nova holds. */
function tagFinding(tag: unknown, open: boolean): Claim<"refuse"> | undefined {
	const C = ADVANCED_CLAIMS;
	if (typeof tag !== "string" || tag === "")
		return open ? C.openTagBlank : C.tagBlank;
	if (tag.includes("/")) return open ? C.openTagSlash : C.tagSlash;
	if (!HQ_CASE_TAG_PATTERN.test(tag))
		return open ? C.openTagFailsPage : C.tagFailsPage;
	return undefined;
}

// ── The menu ────────────────────────────────────────────────────────────

/** Whether a menu's `product_details` is HQ's default: one `name` column of
 *  the product headed "Product", and an empty long detail. */
function defaultProductDetails(value: unknown): boolean {
	if (!isJsonObject(value)) return true;
	const short = isJsonObject(value.short) ? value.short : NO_ENTRIES;
	const long = isJsonObject(value.long) ? value.long : NO_ENTRIES;
	const columns = Array.isArray(short.columns) ? short.columns : [];
	const longColumns = Array.isArray(long.columns) ? long.columns : [];
	if (columns.length !== 1 || longColumns.length > 0) return false;
	const column = columns[0];
	if (
		!isJsonObject(column) ||
		column.field !== "name" ||
		column.model !== "product"
	)
		return false;
	const header = isJsonObject(column.header)
		? Object.values(column.header)
		: [];
	return header.length > 0 && header.every((text) => text === "Product");
}

/**
 * An advanced menu's own keys (`AdvancedModule`): its held kind, and the
 * product list, schedule and auto-selection HQ keeps on it.
 */
export function readAdvancedMenu(ctx: ReadContext, module: DraftModule): void {
	if (module.docType !== "AdvancedModule") return;
	const json = module.json;
	ctx.writeDraft(() => {
		module.module.heldKind = "advanced";
	});
	if (json.used("product_details")) {
		if (defaultProductDetails(json.peek("product_details")))
			json.drop("product_details", ADVANCED_CLAIMS.productDefault);
		else json.refuse("product_details", ADVANCED_CLAIMS.productOther);
	}
	if (json.peek("has_schedule") === true)
		json.refuse("has_schedule", ADVANCED_CLAIMS.hasSchedule);
	const phases = json.peek("schedule_phases");
	if (Array.isArray(phases) && phases.length > 0)
		json.refuse("schedule_phases", ADVANCED_CLAIMS.schedulePhases);
	if (json.peek("auto_select_case") === true) {
		consume(
			json.take(
				"auto_select_case",
				ADVANCED_CLAIMS.autoSelectCase,
				(value) => value,
			),
		);
		ctx.writeDraft(() => {
			module.module.autoSelectSingle = true;
		});
	}
}

// ── The chain ───────────────────────────────────────────────────────────

/**
 * The menu's one chain of list menus, root first and ending at the menu,
 * from its forms' chosen loads: every
 * form that has a chain agrees on it. Each form whose chain differs is
 * named, with the tag of its own load. Undefined where no form has one.
 */
export function readLoadChain(
	module: DraftModule,
	forms: readonly DraftForm[],
): {
	readonly chain: readonly Uuid[] | undefined;
	readonly disagreeing: readonly {
		readonly form: DraftForm;
		readonly tag: string;
	}[];
} {
	let chain: readonly Uuid[] | undefined;
	const disagreeing: { form: DraftForm; tag: string }[] = [];
	for (const form of forms) {
		const reading = READINGS.get(form);
		const own = reading?.chain;
		if (reading === undefined || own === undefined || own.length === 0)
			continue;
		const tag = reading.chosen[reading.chosen.length - 1]?.tag ?? "";
		// A form's chain ends at the menu the form stands in.
		if (own[own.length - 1] !== module.uuid) {
			disagreeing.push({ form, tag });
			continue;
		}
		if (chain === undefined) chain = own;
		else if (!sameJson(chain, own)) disagreeing.push({ form, tag });
	}
	return { chain, disagreeing };
}

/** The entry facts of each source, read once. */
const SOURCE_FACTS = new WeakMap<object, HqAppEntryFacts>();

/**
 * Whether CommCare HQ's entry gives the load tagged `tag` another session
 * value than its `case_id_<tag>`: a child menu's load its parent's first
 * form already selects (`entries.py::EntriesHelper.add_parent_datums`), by
 * HQ's own id rules over the source's facts (`datumIdsFromFacts`). A form
 * whose facts HQ's rules cannot read gives no answer here; the entry facts
 * comparison judges it.
 */
function loadDatumRenamed(
	ctx: ReadContext,
	form: DraftForm,
	tag: string,
): boolean {
	const raw = ctx.input.source.raw as object;
	let facts = SOURCE_FACTS.get(raw);
	if (facts === undefined) {
		facts = hqEntryFacts(raw);
		SOURCE_FACTS.set(raw, facts);
	}
	const readId =
		ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
	const own = readId === undefined ? undefined : facts.forms.get(readId);
	if (own === undefined) return false;
	let ids: readonly string[];
	try {
		ids = datumIdsFromFacts(own, facts);
	} catch (error) {
		rethrowWorkStop(error);
		return false;
	}
	return !ids.includes(`case_id_${tag}`);
}

// ── The first pass ──────────────────────────────────────────────────────

interface Reading {
	readonly ctx: ReadContext;
	readonly module: DraftModule;
	readonly form: DraftForm;
	readonly applied: boolean;
	ok: boolean;
}

/**
 * Where a key holding `/` of a write map stands. HQ's build writes such a key
 * of a load into a block of the case its index steps reach from the load's
 * own case (`xform.py::XForm._add_case_updates`, over
 * `XFormCaseBlock.make_parent_case_block` and `get_case_parent_id_xpath`,
 * one `index/<segment>` a step), whatever the load's place in the chain:
 *
 * - `indexed`: a load chosen under an earlier one, whose keys HQ's build
 *   holds as a subcase's, with no `/` (`slashOnIndexedLoad`);
 * - `own`: the form's own load with no `case_index`, the only chosen load,
 *   where each step `parent` or `host` is the own arm's write through `via`,
 *   as in the basic own update (`basicActions.ts::readUpdateMap`), from the
 *   menu's `caseType`;
 * - `elsewhere`: any other load with no `case_index` (the first of a chain,
 *   the worker's record), whose change Nova writes through no index.
 *
 * An open action names its own row (`claims.slash`) and is never asked.
 */
type SlashKeys =
	| { readonly kind: "indexed" }
	| { readonly kind: "own"; readonly caseType: string }
	| { readonly kind: "elsewhere" };

/** One write map (`case_properties`) of a load or an open action, key by key. */
function readProperties(
	r: Reading,
	parent: JsonCursor,
	claims: {
		readonly map: Claim<"take">;
		readonly path: Claim<"take">;
		readonly slash: Claim<"refuse"> | undefined;
		/** The map's surface key, which an `unrecognized` key names. */
		readonly surface: string;
		/** The rows of a key outside Nova's property grammar, by `propertyNameClass`. */
		readonly names: Readonly<
			Record<Exclude<PropertyNameClass, "too-long">, Claim<"refuse">>
		>;
		/** The worker's load's row of a key the worker's record takes no write to
		 *  (`worldEntities.ts::holdsWorkerRecordWrite`), `name` and `owner_id`
		 *  among them; absent on every other action. */
		readonly worker?: Claim<"refuse">;
	},
	slashes: SlashKeys,
	options: {
		/** An open action may name Nova's generated owner node. */
		readonly opens?: boolean;
		/** The selected record carries a passive label only on its ordinary update. */
		readonly ownLoad?: {
			readonly closes: boolean;
			readonly preloadedLabels: ReadonlySet<DraftField>;
		};
	} = {},
): {
	writes: {
		property: string;
		value: ProposedValue;
		via?: CaseWriteVia;
		onlyIfChanged?: true;
	}[];
	name?: ProposedValue;
	nameOnlyIfChanged?: true;
	owner?: ProposedValue | "acting-user" | "unowned";
	ownerOnlyIfChanged?: true;
	ownerNode?: OwnerNode;
	/** A key of the map was refused, as its own finding. */
	refused?: true;
} {
	const out: ReturnType<typeof readProperties> = { writes: [] };
	if (!parent.used("case_properties")) return out;
	const entries = parent.map(
		"case_properties",
		"ConditionalCaseUpdate",
		claims.map,
	);
	for (const [key, cursor] of entries) {
		// HQ's build holds every key of every advanced action, a load's and an
		// open action's alike, to its grammar with parents and its reserved words
		// on the last step (`AdvancedFormValidator.check_actions`, over
		// `get_all_actions`), before anything else is asked of the key.
		if (hqBuildRefusesProperty(key)) {
			cursor.refuseMapEntry(claims.names.illegal, { name: key });
			r.ok = false;
			out.refused = true;
			continue;
		}
		const segments = key.split("/");
		const property = segments[segments.length - 1] as string;
		let via: CaseWriteVia | undefined;
		if (segments.length > 1) {
			const refuseKey = (claim: Claim<"refuse">) => {
				cursor.refuseMapEntry(claim, { name: key });
				r.ok = false;
				out.refused = true;
			};
			if (claims.slash !== undefined) {
				refuseKey(claims.slash);
				continue;
			}
			if (slashes.kind === "indexed") {
				refuseKey(ADVANCED_CLAIMS.slashOnIndexedLoad);
				continue;
			}
			const indices = segments.slice(0, -1);
			if (
				slashes.kind === "elsewhere" ||
				!indices.every((step) => step === "parent" || step === "host")
			) {
				refuseKey(ADVANCED_CLAIMS.loadViaElsewhere);
				continue;
			}
			const steps = ancestorSteps(r.ctx, slashes.caseType, indices);
			if (steps === undefined) {
				refuseKey(ADVANCED_CLAIMS.loadViaUnknown);
				continue;
			}
			via = steps.steps as CaseWriteVia;
		}
		// The case above's name and owner: HQ's build writes `name` as the
		// block's `case_name` (`XFormCaseBlock.add_case_updates`) and `owner_id`
		// as its owner, which Nova holds as a write of `case_name` or `owner_id`
		// through `via` (`CASE_FACETS_THROUGH_INDEX`).
		const viaFacet =
			via !== undefined && (property === "name" || property === "owner_id");
		// `name` and `owner_id` are the case's name and owner; every other key is a
		// property, which Nova's grammar must name.
		const named =
			(via === undefined && (key === "name" || key === "owner_id")) || viaFacet
				? undefined
				: propertyNameClass(property);
		if (named === "too-long") {
			const place = r.form.place;
			r.ctx.accounting.circumstance("unrecognized", place, {
				name: claims.surface,
			});
			const raised = circumstanceFinding("unrecognized", place, {
				name: claims.surface,
			});
			for (const covered of [
				"question_path",
				"update_mode",
				...cursor.undeclared(),
			])
				r.ctx.accounting.cover({ json: cursor, key: covered }, raised);
			r.ok = false;
			out.refused = true;
			continue;
		}
		if (named !== undefined) {
			cursor.refuseMapEntry(claims.names[named], { name: key });
			r.ok = false;
			out.refused = true;
			continue;
		}
		// The worker's record takes a write only to a worker property the
		// reading declares; HQ's build writes `name` as its `case_name` and
		// `owner_id` as its owner, which HQ's user-case sync writes over. A key
		// read from an upload names an attachment, the upload question's row.
		if (
			claims.worker !== undefined &&
			!holdsWorkerRecordWrite(key) &&
			!namesAttachment(r.form, cursor.peek("question_path"))
		) {
			cursor.refuseMapEntry(claims.worker, { name: key });
			r.ok = false;
			out.refused = true;
			continue;
		}
		// Every write is saved only when changed where HQ's build applies the
		// mode (`XFormCaseBlock.add_case_updates`), the action's own name and
		// owner, its facets, among them (`CaseFacetOnlyIfChanged`).
		let onlyIfChanged: true | undefined;
		if (cursor.peek("update_mode") === "edit") {
			if (!r.applied)
				cursor.drop("update_mode", ADVANCED_CLAIMS.editNotApplied);
			else {
				consume(
					cursor.take(
						"update_mode",
						via === undefined && (key === "name" || key === "owner_id")
							? ADVANCED_CLAIMS.editFacet
							: ADVANCED_CLAIMS.editHeld,
						(value) => value,
					),
				);
				onlyIfChanged = true;
			}
		}
		const storedPath = cursor.peek("question_path");
		const source =
			options.ownLoad &&
			via === undefined &&
			cursor.peek("update_mode") === "always" &&
			isAdvancedOwnLabelProperty(property) &&
			typeof storedPath === "string"
				? fieldAt(r.form, storedPath)
				: undefined;
		const label =
			source?.kind === "label" &&
			source.parent === null &&
			source.dataParent === null &&
			source.field.askForConfirmation !== true &&
			source.field.banner === undefined &&
			!options.ownLoad?.closes &&
			!options.ownLoad?.preloadedLabels.has(source) &&
			!source.expressions.some(
				(expression) => expression.slot === "default_value",
			)
				? source
				: undefined;
		if (source?.kind === "label" && label === undefined) {
			cursor.refuse("question_path", ADVANCED_CLAIMS.labelQuestion, {
				name: key,
			});
			r.ok = false;
			out.refused = true;
			continue;
		}
		const path = consume(
			cursor.take(
				"question_path",
				label === undefined ? claims.path : ADVANCED_CLAIMS.passiveLabelWrite,
				(value) => value,
			),
		);
		if (typeof path !== "string" || path === "") {
			r.ok = false;
			r.ctx.accounting.circumstance("unrecognized", r.form.place, {
				name: "schema:ConditionalCaseUpdate.question_path",
			});
			out.refused = true;
			continue;
		}
		// An open action's owner may name the owner node Nova folds beside it,
		// which Nova saves every time.
		if (key === "owner_id" && options.opens && onlyIfChanged === undefined) {
			const owner = ownerNode(r, path);
			if (owner !== undefined) {
				out.ownerNode = owner;
				continue;
			}
		}
		const read: QuestionValue =
			label === undefined
				? questionValue(r.ctx, r.form, path, property)
				: {
						kind: "value",
						value: { field: label, link: false },
						datetimeSibling: false,
					};
		if (read.kind === "finding") {
			r.ctx.accounting.finding(advancedReadClaim(read.claim), r.form.place, {
				name: key,
			});
			r.ok = false;
			out.refused = true;
			continue;
		}
		// A date-and-time question's day is saved straight only to a `date`
		// property of the action's own case, which the catalog types: the
		// worker's record is no catalogued type, and Nova saves a date and time
		// there as its moment.
		if (
			(via !== undefined || claims.worker !== undefined) &&
			read.value.day === true
		) {
			r.ctx.accounting.finding(BASIC_CLAIMS.datetimeStraight, r.form.place, {
				name: key,
			});
			r.ok = false;
			out.refused = true;
			continue;
		}
		if (viaFacet) cursor.holdMapEntry(ADVANCED_CLAIMS.loadViaFacet);
		if (via !== undefined)
			out.writes.push({
				property: viaFacet && property === "name" ? "case_name" : property,
				value: read.value,
				via,
				...(onlyIfChanged !== undefined && { onlyIfChanged }),
			});
		else if (key === "name") {
			out.name = read.value;
			if (onlyIfChanged !== undefined) out.nameOnlyIfChanged = true;
		} else if (key === "owner_id") {
			out.owner = read.value;
			if (onlyIfChanged !== undefined) out.ownerOnlyIfChanged = true;
		} else
			out.writes.push({
				property: key,
				value: read.value,
				...(onlyIfChanged !== undefined && { onlyIfChanged }),
			});
	}
	return out;
}

/** An open action's `owner_id` naming a node the form stage proposed as an owner node. */
interface OwnerNode {
	readonly node: DataNode;
	readonly value: "acting-user" | "unowned";
	/** The stored `question_path`. */
	readonly path: string;
}

/** The owner node an open action's `owner_id` names, where the form stage proposed one there. */
function ownerNode(r: Reading, path: string): OwnerNode | undefined {
	const xform = r.form.xform;
	const relative = conditionQuestionPath(r.form, path);
	const node = relative === undefined ? undefined : xform?.nodes.get(relative);
	const role = node === undefined ? undefined : xform?.roles.get(node);
	if (
		node === undefined ||
		role?.kind !== "generated-candidate" ||
		role.purpose !== "owner" ||
		role.ownerValue === undefined
	)
		return undefined;
	return { node, value: role.ownerValue, path };
}

const OWNER_NODE_PREFIX = generatedBaseName("owner", "");

/** The operation id an owner node's name gives: what follows `nova_owner_`, where that is
 *  an operation id. A suffix the allocator added on a collision reads as part of the id,
 *  which names the node the same. */
function ownerNodeOperationId(
	owner: OwnerNode | undefined,
): string | undefined {
	if (owner === undefined || !owner.node.name.startsWith(OWNER_NODE_PREFIX))
		return undefined;
	const id = owner.node.name.slice(OWNER_NODE_PREFIX.length);
	return isCaseOperationIdentifier(id) ? id : undefined;
}

/** Whether a node stands in the scope the emitter writes an open action's owner node in: the
 *  form's root, or a row of the action's repeat. */
function standsInScope(
	form: DraftForm,
	node: DataNode,
	repeat: DraftField | undefined,
): boolean {
	if (node.parent === null) return repeat === undefined;
	const role = form.xform?.roles.get(node.parent);
	const holder =
		role?.kind === "field"
			? role.field
			: role?.kind === "query-row"
				? role.repeat
				: undefined;
	return holder !== undefined && holder === repeat;
}

/**
 * Settles the owner node an open action names, once the action's operation has its id: Nova's
 * node where it holds the allocator's name for that id in the action's scope, and the owner
 * its value states; otherwise the person's own Hidden Value, and the owner a read of it.
 * Undefined where that read is a finding, which it records.
 */
function settleOwner(
	r: Reading,
	owner: OwnerNode,
	operation: string,
	repeat: DraftField | undefined,
): ProposedValue | "acting-user" | "unowned" | undefined {
	const xform = r.form.xform;
	if (xform === null || xform === undefined) return undefined;
	const open = xform.candidates.includes(owner.node);
	if (
		open &&
		isAllocatedName(owner.node.name, generatedBaseName("owner", operation)) &&
		standsInScope(r.form, owner.node, repeat)
	) {
		r.ctx.writeDraft(() => xform.settle(owner.node, "generated", operation));
		return owner.value;
	}
	if (open) r.ctx.writeDraft(() => xform.settle(owner.node, "field"));
	const read = questionValue(r.ctx, r.form, owner.path, "owner_id");
	if (read.kind === "finding") {
		r.ctx.accounting.finding(advancedReadClaim(read.claim), r.form.place, {
			name: "owner_id",
		});
		r.ok = false;
		return undefined;
	}
	return read.value;
}

/** A basic action's finding as an advanced action's: a label read is the advanced entry's. */
function advancedReadClaim(claim: Claim<"refuse">): Claim<"refuse"> {
	return claim.entry ===
		`${F}/a-case-write-name-or-preload-on-a-question-the-picker-does-not`
		? ADVANCED_CLAIMS.labelQuestion
		: claim;
}

function mint(
	r: Reading,
	tag: string,
	action: CaseOperation["action"],
	n: number,
): Uuid | undefined {
	return r.ctx.accounting.identity(
		r.ctx.identities.claim(
			externalKey.caseOperation(r.form.xmlns, ["advanced", tag], action, n),
			whereText(r.form.place),
		),
		r.form.place,
		"schema:AdvancedForm.actions",
	);
}

/** The menus of the app by `unique_id`. */
function menusById(ctx: ReadContext): ReadonlyMap<string, DraftModule> {
	return new Map(ctx.draft.modules.map((module) => [module.uniqueId, module]));
}

/** Resolve a blank details menu as HQ does, preferring the form's own menu
 * of this type and then the first matching menu in app order. */
function sourceListMenu(
	menus: ReadonlyMap<string, DraftModule>,
	owning: DraftModule,
	load: Record<string, unknown>,
): DraftModule | undefined {
	if (typeof load.details_module === "string" && load.details_module !== "")
		return menus.get(load.details_module);
	const sameType = (menu: DraftModule) =>
		(menu.module.caseType ?? menu.json.peek("case_type")) === load.case_type;
	if (sameType(owning)) return owning;
	return [...menus.values()].find(sameType);
}

const sharedManualSequences = new WeakMap<DraftModule, boolean>();

/** A menu has an implicit sequence only if its case-loading entries agree.
 * Compute this once per menu so independently configured forms do not acquire
 * each other's parent selection. */
function sharesManualSequence(
	own: DraftModule,
	menus: ReadonlyMap<string, DraftModule>,
): boolean {
	const held = sharedManualSequences.get(own);
	if (held !== undefined) return held;
	const distinct = new Set<string>();
	for (const form of own.forms) {
		const loads = object(form.json.peek("actions")).load_update_cases;
		if (!Array.isArray(loads)) continue;
		const chosen = loads.filter(isJsonObject).filter((row) => !row.auto_select);
		if (!chosen.length) continue;
		const positions = new Map<string, number>();
		const signature = chosen.map((row, index) => {
			const link = object(row.case_index);
			const previous =
				typeof link.tag === "string" && link.tag
					? (positions.get(link.tag) ?? -1)
					: null;
			if (typeof row.case_tag === "string") positions.set(row.case_tag, index);
			return [
				sourceListMenu(menus, own, row)?.uuid,
				previous,
				previous === null ? null : chainIndexName(link),
			];
		});
		distinct.add(JSON.stringify(signature));
		if (distinct.size > 1) break;
	}
	const shared = distinct.size <= 1;
	sharedManualSequences.set(own, shared);
	return shared;
}

interface SourceChoice {
	requiresExplicitWorker?: boolean;
	indexInForm: number;
	tag: string;
	caseType: string;
	menu?: DraftModule;
	parentTag?: string;
	index?: string;
	relationship?: "extension";
	relationshipQuestion?: DraftField;
	automatic?: FormSelectionSource;
	worker?: boolean;
	changes: boolean;
}

type UnreadChoice = { readonly issue: Claim<"refuse">; readonly name?: string };
type ParsedChoice = SourceChoice | UnreadChoice;

/** Classify each source row independently so a malformed sibling cannot
 * change the standing of a valid raw, worker, table or indexed choice. */
function parseSourceChoice(
	ctx: ReadContext,
	form: DraftForm,
	own: DraftModule,
	menus: ReadonlyMap<string, DraftModule>,
	raw: unknown,
	i: number,
	tags: ReadonlyMap<string, number>,
	allTags: ReadonlySet<string>,
	sharedTags: ReadonlySet<string>,
): ParsedChoice {
	const C = ADVANCED_CLAIMS;
	const load = object(raw);
	const tag = load.case_tag;
	const tagIssue = tagFinding(tag, false);
	if (tagIssue || typeof tag !== "string")
		return { issue: tagIssue ?? C.tagBlank };
	if (sharedTags.has(tag)) return { issue: C.duplicateTag, name: tag };
	if (typeof load.case_type !== "string" || load.case_type === "")
		return { issue: C.autoBlank, name: tag };
	const changes =
		Object.keys(object(load.case_properties)).length > 0 ||
		activeCondition(load.close_condition);
	const row = { indexInForm: i, tag, caseType: load.case_type, changes };
	const before = (other: unknown) =>
		typeof other === "string" && (tags.get(other) ?? i) < i;
	if (load.auto_select !== null && load.auto_select !== undefined) {
		const auto = object(load.auto_select);
		const key = auto.value_key;
		if (auto.mode === "usercase")
			return load.case_type === "commcare-user"
				? {
						...row,
						automatic: { kind: "worker-record" },
						worker: true,
						requiresExplicitWorker:
							activeCondition(load.close_condition) ||
							Object.keys(object(load.case_properties)).some(
								(key) => key === "name" || key === "owner_id",
							),
					}
				: { issue: C.workerModeType, name: tag };
		if (!auto.mode) return { issue: C.autoBlank, name: tag };
		if (typeof key !== "string" || key === "")
			return { issue: C.autoMissingKey, name: tag };
		switch (auto.mode) {
			case "raw":
				return {
					...row,
					automatic: { kind: "expression", value: pendingPlaceholder("value") },
				};
			case "user":
				return {
					...row,
					automatic: {
						kind: "worker-data",
						property: { kind: "session-user", field: key },
					},
				};
			case "fixture": {
				const table =
					typeof auto.value_source === "string"
						? ctx.input.lookup.table(auto.value_source)
						: undefined;
				const column = table?.column(key);
				return table && column
					? {
							...row,
							automatic: { kind: "table", table: table.tableId, column },
						}
					: { issue: C.fixtureSourceMissing, name: tag };
			}
			case "case":
				return typeof auto.value_source === "string" &&
					before(auto.value_source)
					? { ...row, parentTag: auto.value_source, index: key }
					: { issue: C.autoCaseLater, name: tag };
			default:
				return { issue: C.unknownMode, name: tag };
		}
	}
	const menu = sourceListMenu(menus, own, load);
	if (
		!menu ||
		(menu.module.caseType ?? menu.json.peek("case_type")) !== load.case_type
	)
		return { issue: C.detailsModuleOther, name: tag };
	const index = object(load.case_index);
	if (typeof index.tag !== "string" || index.tag === "")
		return { ...row, menu };
	// HQ's editor indexes a load only to the load stored right before it
	// (`advanced/actions.js`, `subcase.write`: `load_update_cases()[index - 1]`).
	if (tags.get(index.tag) !== i - 1)
		return {
			issue:
				i === 0
					? C.caseIndexOnFirst
					: allTags.has(index.tag)
						? C.caseIndexOtherLoad
						: C.caseIndexNoAction,
			name: tag,
		};
	const relationshipQuestion =
		index.relationship === "question" &&
		typeof index.relationship_question === "string"
			? fieldAt(form, index.relationship_question)
			: undefined;
	if (index.relationship === "question" && !relationshipQuestion)
		return { issue: C.openIndexQuestion, name: tag };
	return {
		...row,
		menu,
		parentTag: index.tag,
		index: chainIndexName(index),
		...(relationshipQuestion
			? { relationshipQuestion }
			: index.relationship === "extension"
				? { relationship: "extension" as const }
				: {}),
	};
}

/** Explicit rows are needed when the implicit menu sequence cannot reproduce
 * the source. Keep authored labels through an HQ edit of an existing entry. */
function explicitFormChoices(
	ctx: ReadContext,
	form: DraftForm,
	own: DraftModule,
	menus: ReadonlyMap<string, DraftModule>,
	loads: readonly unknown[],
	registration: boolean,
	opens: readonly unknown[],
	inherited?: {
		rows: ReadonlyMap<string, FormCaseSelection>;
		content: DraftForm;
	},
):
	| {
			choices: Map<number, FormCaseSelection>;
			unread: Map<number, UnreadChoice>;
			questions: Map<Uuid, DraftField>;
	  }
	| undefined {
	const known = ctx.input.knownFormEntryChoices?.get(form.uuid);
	const tags = new Map<string, number>();
	for (const [i, raw] of loads.entries()) {
		const tag = object(raw).case_tag;
		if (typeof tag === "string" && !tags.has(tag)) tags.set(tag, i);
	}
	const allTags = new Set(tags.keys());
	for (const raw of opens) {
		const tag = object(raw).case_tag;
		if (typeof tag === "string") allTags.add(tag);
	}
	// A tag another load or open action also holds: HQ's build resolves an
	// action by its tag (`actions_meta_by_tag`), so each holder is refused.
	const held = new Map<string, number>();
	for (const raw of [...loads, ...opens]) {
		const tag = object(raw).case_tag;
		if (typeof tag === "string" && tag !== "")
			held.set(tag, (held.get(tag) ?? 0) + 1);
	}
	const sharedTags = new Set(
		[...held].filter(([, count]) => count > 1).map(([tag]) => tag),
	);
	const source: SourceChoice[] = [];
	const unread = new Map<number, UnreadChoice>();
	for (const [i, raw] of loads.entries()) {
		const parsed = parseSourceChoice(
			ctx,
			inherited?.content ?? form,
			own,
			menus,
			raw,
			i,
			tags,
			allTags,
			sharedTags,
		);
		if ("issue" in parsed) unread.set(i, parsed);
		else source.push(parsed);
	}
	const manual = source.filter((row) => row.menu);
	const menusSeen = new Set(manual.map((row) => row.menu?.uuid));
	const worker = source.findIndex((row) => row.worker);
	const needsOwnChoices =
		unread.size > 0 ||
		known !== undefined ||
		(manual.length > 0 &&
			(registration ||
				!sharesManualSequence(own, menus) ||
				(manual.length > 1 &&
					manual.some((row) => row.caseType === "commcare-user")))) ||
		source.some(
			(row) => (!row.menu && !row.worker) || row.requiresExplicitWorker,
		) ||
		source.filter((row) => row.worker).length > 1 ||
		(worker >= 0 &&
			(worker !== source.length - 1 || !source[worker]?.changes)) ||
		manual.some(
			(row) =>
				row.relationship !== undefined ||
				row.relationshipQuestion !== undefined,
		) ||
		menusSeen.size !== manual.length ||
		(manual.length > 0 && manual.at(-1)?.menu?.uuid !== own.uuid) ||
		manual.some((row, i) => row.parentTag !== manual[i - 1]?.tag) ||
		manual.some(
			(row, i) =>
				!row.changes &&
				row.tag !== `load_${row.caseType.replaceAll("-", "_")}${i}`,
		);
	if (!inherited && !needsOwnChoices) return undefined;

	const choices = new Map<number, FormCaseSelection>();
	const questions = new Map<Uuid, DraftField>();
	const byTag = new Map<string, FormCaseSelection>();
	const groupSize = new Map<string, number>();
	const positionInGroup = new Map<string, number>();
	const groupKey = (row: (typeof source)[number]) =>
		row.menu?.uuid ?? row.caseType;
	for (const row of source) {
		const key = groupKey(row);
		groupSize.set(key, (groupSize.get(key) ?? 0) + 1);
	}
	for (const row of source) {
		const uuid =
			inherited?.rows.get(row.tag)?.uuid ??
			ctx.accounting.identity(
				ctx.identities.claim(
					externalKey.formSelection(form.uuid, row.tag),
					whereText(form.place),
				),
				form.place,
				"schema:LoadUpdateAction.case_tag",
			);
		if (!uuid) return undefined;
		const earlier = row.parentTag && byTag.get(row.parentTag);
		if (row.parentTag && !earlier) {
			const parentIndex = tags.get(row.parentTag);
			unread.set(
				row.indexInForm,
				(parentIndex !== undefined && unread.get(parentIndex)) || {
					issue: ADVANCED_CLAIMS.caseIndexNoAction,
					name: row.tag,
				},
			);
			continue;
		}
		const link =
			earlier && row.index
				? {
						selection: earlier.uuid,
						identifier: row.index,
						...(row.relationship && { relationship: row.relationship }),
					}
				: undefined;
		const selectionSource: FormSelectionSource | undefined = row.menu
			? { kind: "choose", module: row.menu.uuid, ...(link && { under: link }) }
			: (row.automatic ?? (link && { kind: "index", ...link }));
		if (!selectionSource) {
			const parentIndex = row.parentTag && tags.get(row.parentTag);
			const parent =
				typeof parentIndex === "number" ? unread.get(parentIndex) : undefined;
			unread.set(
				row.indexInForm,
				parent ?? { issue: ADVANCED_CLAIMS.caseIndexNoAction, name: row.tag },
			);
			continue;
		}
		const listName = row.menu?.module.name ?? row.caseType;
		const key = groupKey(row);
		const ordinal = (positionInGroup.get(key) ?? 0) + 1;
		positionInGroup.set(key, ordinal);
		const name =
			known?.get(row.tag) ??
			(groupSize.get(key) === 1 ? listName : `${listName} ${ordinal}`);
		const selection = {
			uuid,
			name,
			caseType: row.caseType,
			tag: row.tag,
			source: selectionSource,
		};
		choices.set(row.indexInForm, selection);
		if (row.relationshipQuestion) questions.set(uuid, row.relationshipQuestion);
		byTag.set(row.tag, selection);
	}
	return { choices, unread, questions };
}

/**
 * Reads `form.actions` of an advanced form (`AdvancedFormActions`) into its
 * type and its proposed case operations, claiming every key; its chosen
 * loads are kept for the chain test. The form's own keys `schedule` and
 * `arbitrary_datums` are claimed here.
 */
export function readAdvancedActions(
	ctx: ReadContext,
	module: DraftModule,
	form: DraftForm,
): void {
	const json = form.json;
	const schedule = json.peek("schedule");
	if (isJsonObject(schedule)) {
		if (schedule.enabled === true)
			json.refuse("schedule", ADVANCED_CLAIMS.scheduleOn);
		else if (scheduleNamesMissingQuestion(form, schedule))
			json.refuse("schedule", ADVANCED_CLAIMS.scheduleMissingQuestion);
		else json.drop("schedule", ADVANCED_CLAIMS.scheduleOff);
	}
	readEntryValues(ctx, form);
	readOrdinaryAdvancedActions(ctx, module, form);
}

function readEntryValues(ctx: ReadContext, form: DraftForm) {
	const json = form.json;
	const datums = json.peek("arbitrary_datums");
	if (Array.isArray(datums) && datums.length > 0) {
		const sources = json.list(
			"arbitrary_datums",
			"ArbitraryDatum",
			form.docType === "ShadowForm"
				? SHARED.datums
				: ADVANCED_CLAIMS.arbitraryDatums,
		);
		const values = sources.flatMap((row, index) => {
			const raw = datums[index];
			if (
				!isJsonObject(raw) ||
				typeof raw.datum_id !== "string" ||
				typeof raw.datum_function !== "string"
			)
				return [];
			const key = raw.datum_id;
			const uuid = ctx.accounting.identity(
				ctx.identities.claim(
					externalKey.entryValue(form.uuid, key),
					whereText(form.place),
				),
				form.place,
				"schema:ArbitraryDatum.datum_id",
			);
			if (!uuid) return [];
			consume(
				row.take(
					"datum_id",
					ADVANCED_CLAIMS.arbitraryDatumId,
					(value) => value,
				),
			);
			ctx.pending.register(
				{
					ref: {
						entity: "form",
						uuid: form.uuid,
						slot: "form_entry_value",
						member: { supplyUuid: uuid },
					},
					text: raw.datum_function,
					mode: { target: "hq-json", interpolation: "none" },
					place: form.place,
					key: "schema:ArbitraryDatum.datum_function",
				},
				{ json: row, key: "datum_function" },
			);
			return [{ uuid, key }];
		});
		if (values.length) {
			ctx.writeDraft(() => {
				form.form.computedDatums = values.map(({ uuid, key }) => ({
					uuid,
					key,
					value: pendingPlaceholder("value"),
				}));
			});
		}
	}
}

function readOrdinaryAdvancedActions(
	ctx: ReadContext,
	module: DraftModule,
	form: DraftForm,
) {
	const json = form.json;
	const stored = json.peek("actions");
	const actions = isJsonObject(stored) ? stored : NO_ENTRIES;
	const A = json.object(
		"actions",
		"AdvancedFormActions",
		ADVANCED_CLAIMS.actions,
	);
	recordRespelledConditions(
		ctx,
		actions,
		A.pointer,
		ADVANCED_CLAIMS.actions.entry,
	);
	const r: Reading = {
		ctx,
		module,
		form,
		applied: ctx.input.saveOnlyEditedApplied === true,
		ok: true,
	};
	const menus = menusById(ctx);
	const menuType =
		module.module.caseType ??
		(typeof module.json.peek("case_type") === "string"
			? (module.json.peek("case_type") as string)
			: "");
	const storedLoads = Array.isArray(actions.load_update_cases)
		? actions.load_update_cases
		: [];
	const preloadedLabels = new Set<DraftField>();
	for (const load of storedLoads) {
		if (!isJsonObject(load) || !isJsonObject(load.preload)) continue;
		for (const path of Object.keys(load.preload)) {
			const field = fieldAt(form, path);
			if (field?.kind === "label") preloadedLabels.add(field);
		}
	}
	const storedOpens = Array.isArray(actions.open_cases)
		? actions.open_cases
		: [];
	const ownOpenIndex = registrationOpenIndex(
		storedOpens,
		storedLoads,
		menuType as string,
	);
	const explicit = explicitFormChoices(
		ctx,
		form,
		module,
		menus,
		storedLoads,
		ownOpenIndex >= 0,
		storedOpens,
	);
	if (explicit)
		ctx.writeDraft(() => {
			form.form.caseSelections = [...explicit.choices.values()];
		});
	if (explicit) {
		const choices = [...explicit.choices.values()];
		const firstWorker = choices.findIndex(
			(choice) => choice.source.kind === "worker-record",
		);
		const lastChosen = choices.findLastIndex(
			(choice) => choice.source.kind === "choose",
		);
		if (firstWorker >= 0 && lastChosen > firstWorker) {
			A.takePart(
				"load_update_cases",
				"worker-before-choice",
				ADVANCED_CLAIMS.workerLoadFirst,
			);
		}
		if (lastChosen >= 0)
			A.takePart(
				"load_update_cases",
				"form-choices",
				ADVANCED_CLAIMS.notOneChain,
			);
	}
	const loadCursors =
		storedLoads.length > 0
			? A.list("load_update_cases", "LoadUpdateAction", ADVANCED_CLAIMS.loads)
			: [];
	OPENING_SITES.set(form, { actions: A, loads: loadCursors });
	const openCursors =
		storedOpens.length > 0
			? A.list("open_cases", "AdvancedOpenCaseAction", ADVANCED_CLAIMS.opens)
			: [];

	const operations: AdvancedProposal[] = [];
	/** The questions that name a case an open action opens. */
	const createNames: DraftField[] = [];
	const takenIds = new Set<string>();
	const mints: AdvancedMint[] = [];
	const operationId = (type: string, named?: string) => {
		const id = ownCaseOperationId(type, takenIds);
		takenIds.add(id);
		mints.push({ id, caseType: type, ...(named !== undefined && { named }) });
		return id;
	};
	// An open action whose owner node names its operation keeps that id, so Nova names the node
	// as the source does.
	const openOperationId = (type: string, owner: OwnerNode | undefined) => {
		const named = ownerNodeOperationId(owner);
		if (named === undefined || takenIds.has(named))
			return operationId(type, named);
		takenIds.add(named);
		mints.push({ id: named, caseType: type, named });
		return named;
	};
	const counts = new Map<string, number>();
	const ordinal = (tag: string, action: string) => {
		const key = `${tag}\u0000${action}`;
		const n = counts.get(key) ?? 0;
		counts.set(key, n + 1);
		return n;
	};

	// The chosen loads, with every check a chosen load takes.
	const chosenIndexes = storedLoads
		.map((load, i) =>
			isJsonObject(load) &&
			(load.auto_select === null || load.auto_select === undefined)
				? i
				: -1,
		)
		.filter((i) => i >= 0);
	const chosen: StoredLoad[] = [];
	const chain: Uuid[] = [];
	let chainOk = true;
	const loadTags = new Map<string, number>();
	storedLoads.forEach((load, i) => {
		if (isJsonObject(load) && typeof load.case_tag === "string")
			loadTags.set(load.case_tag, i);
	});
	/** Each chosen load's place among the chosen loads, by its place among the loads. */
	const chosenPosition = new Map(
		chosenIndexes.map((index, position) => [index, position]),
	);
	const openTags = new Map<string, number>();
	storedOpens.forEach((open, j) => {
		if (isJsonObject(open) && typeof open.case_tag === "string")
			openTags.set(open.case_tag, j);
	});
	let type: FormType = "survey";
	let closeCondition: ProposedCondition | undefined;
	let closesAlways = false;
	let openCondition: ProposedCondition | undefined;
	let worker: StoredLoad | undefined;
	const loadUuids = new Map<number, ProposedCaseRef>();
	// Each auto-selected load the reading refused, by its tag, with its finding.
	const refusedAutoLoads = new Map<string, Finding>();
	// Each chosen load the reading refused, by its place among the loads, with its finding.
	const refusedChosenLoads = new Map<number, Finding>();

	const ownChoiceIndex =
		explicit &&
		[...explicit.choices].findLast(
			([, row]) => row.source.kind === "choose" && row.caseType === menuType,
		)?.[0];
	const readLoad = (L: JsonCursor, i: number): void => {
		const load = storedLoads[i] as Record<string, unknown>;
		const unread = explicit?.unread.get(i);
		if (unread) {
			const before = ctx.accounting.findingCount();
			L.refuseWhole(
				unread.issue,
				unread.name ? { name: unread.name } : undefined,
			);
			const refusal = ctx.accounting.findingRaised(before);
			if (refusal && typeof load?.case_tag === "string") {
				if (load.auto_select) refusedAutoLoads.set(load.case_tag, refusal);
				else refusedChosenLoads.set(i, refusal);
			}
			chainOk = false;
			r.ok = false;
			return;
		}
		if (
			!explicit &&
			load.auto_select !== null &&
			load.auto_select !== undefined
		) {
			const before = ctx.accounting.findingCount();
			const read = readAutoSelectLoad(
				r,
				L,
				load,
				operations,
				operationId,
				ordinal,
			);
			if (read !== undefined) {
				worker = read;
				readLoadPreloads(r, L, load, "commcare-user", false, []);
			} else {
				const refusal = ctx.accounting.findingRaised(before);
				if (refusal !== undefined && typeof load.case_tag === "string")
					refusedAutoLoads.set(load.case_tag, refusal);
			}
			return;
		}
		const explicitChoice = explicit?.choices.get(i);
		if (
			explicitChoice &&
			!Object.keys(object(load.case_properties)).length &&
			!activeCondition(load.close_condition)
		) {
			const position = chosenPosition.get(i);
			if (explicitChoice.source.kind === "worker-record")
				L.takePart(
					"auto_select",
					"read-only-worker",
					ADVANCED_CLAIMS.usercaseWritesNothing,
				);
			else if (
				position !== undefined &&
				explicitChoice.tag !==
					`load_${explicitChoice.caseType.replaceAll("-", "_")}${position}`
			)
				L.takePart("case_tag", "read-only-name", ADVANCED_CLAIMS.underivedTag);
		}
		if (explicitChoice)
			readExplicitAutoSource(ctx, form, L, load, explicitChoice);

		const position = chosenPosition.get(i) ?? -1;
		const last =
			ownOpenIndex < 0 &&
			(explicit ? i === ownChoiceIndex : position === chosenIndexes.length - 1);
		const tag = load.case_tag;
		const tagClaim = tagFinding(tag, false);
		if (tagClaim !== undefined) {
			L.refuseWhole(
				tagClaim,
				typeof tag === "string" && tag !== "" ? { name: tag } : undefined,
			);
			chainOk = false;
			r.ok = false;
			return;
		}
		consume(
			L.take(
				"case_tag",
				typeof tag === "string" && tag.includes("-")
					? ADVANCED_CLAIMS.tagHyphen
					: ADVANCED_CLAIMS.tag,
				(value) => value,
			),
		);
		const caseType = load.case_type;
		consume(L.take("case_type", ADVANCED_CLAIMS.caseType, (value) => value));
		const detailsId =
			typeof load.details_module === "string" ? load.details_module : "";
		const automatic = explicitChoice && explicitChoice.source.kind !== "choose";
		const listMenu = automatic
			? undefined
			: sourceListMenu(menus, module, load);
		const listsAnotherType =
			listMenu === undefined ||
			(listMenu.module.caseType !== caseType &&
				listMenu.json.peek("case_type") !== caseType);
		// HQ's build checks the case type of every list menu a load names but
		// the form's own (`entries.py::EntriesHelper.get_target_module`), the last
		// load's too.
		const detailsRefused =
			!automatic &&
			(last
				? detailsId !== "" && detailsId !== module.uniqueId && listsAnotherType
				: listsAnotherType);
		if (detailsRefused) {
			L.refuse("details_module", ADVANCED_CLAIMS.detailsModuleOther, {
				name: tag as string,
			});
			chainOk = false;
			r.ok = false;
		}
		if (!detailsRefused && L.used("details_module"))
			consume(
				L.take(
					"details_module",
					ADVANCED_CLAIMS.detailsModule,
					(value) => value,
				),
			);
		// The index: none on the first, the tag of the load before on each later one.
		const index = isJsonObject(load.case_index) ? load.case_index : NO_ENTRIES;
		const indexTag = typeof index.tag === "string" ? index.tag : "";
		let indexRead: StoredLoad["index"];
		const refusedParent = refusedAutoLoads.get(indexTag);
		if (refusedParent !== undefined) {
			// An index to an auto-selected load the reading refused belongs to that
			// refusal: HQ's editor offers it on any load after the first that does
			// not auto-select (`case_config_advanced.html`).
			ctx.accounting.cover({ json: L, key: "case_index" }, refusedParent);
			chainOk = false;
			r.ok = false;
		} else if (automatic && indexTag !== "") {
			L.refuse("case_index", ADVANCED_CLAIMS.caseIndexOnFirst);
			chainOk = false;
			r.ok = false;
		} else {
			if (L.used("case_index")) {
				const predecessor = indexTag && loadTags.get(indexTag);
				const parent =
					typeof predecessor === "number" && explicit?.choices.get(predecessor);
				consume(
					L.take(
						"case_index",
						position === 0 && parent && parent.source.kind === "worker-record"
							? ADVANCED_CLAIMS.caseIndexToWorkerLoad
							: ADVANCED_CLAIMS.caseIndex,
						(value) => value,
					),
				);
			}
			if (indexTag !== "")
				indexRead = { tag: indexTag, identifier: chainIndexName(index) };
		}
		if (
			load.load_case_from_fixture !== null &&
			load.load_case_from_fixture !== undefined
		) {
			L.refuse("load_case_from_fixture", ADVANCED_CLAIMS.fromFixture);
			r.ok = false;
		}
		if (
			load.show_product_stock === true ||
			(typeof load.product_program === "string" && load.product_program !== "")
		) {
			L.refuse("show_product_stock", ADVANCED_CLAIMS.productStock);
			if (L.used("product_program"))
				L.refuse("product_program", ADVANCED_CLAIMS.productStock);
			r.ok = false;
		} else {
			if (L.used("show_product_stock"))
				L.drop("show_product_stock", ADVANCED_CLAIMS.productStockOff);
			if (L.used("product_program"))
				L.drop("product_program", ADVANCED_CLAIMS.productProgramOff);
		}
		const indexed = indexRead !== undefined;
		const closeStored = load.close_condition;
		const closes = activeCondition(closeStored);
		const properties = readProperties(
			r,
			L,
			caseType === "commcare-user"
				? WORKER_LOAD_PROPERTY_CLAIMS
				: LOAD_PROPERTY_CLAIMS,
			indexed
				? { kind: "indexed" }
				: last
					? { kind: "own", caseType: caseType as string }
					: { kind: "elsewhere" },
			{
				...(last &&
					!automatic &&
					caseType !== "commcare-user" && {
						ownLoad: { closes, preloadedLabels },
					}),
			},
		);
		// A `form-case` read walks from the form's own case the indices the document
		// links each type to its parent by (`caseTypeDepths.ts::caseTypeHopMap`). HQ
		// chose each later load among the cases whose index the load names points at
		// the load before (`index/<reference_id>`), so this load is reached from the
		// own case through each later load's index, the own load's first.
		const hops = chosenIndexes
			.slice(position + 1)
			.reverse()
			.map((later) => {
				const stored = storedLoads[later] as
					| Record<string, unknown>
					| undefined;
				return chainIndexName(
					isJsonObject(stored?.case_index) ? stored.case_index : NO_ENTRIES,
				);
			});
		readLoadPreloads(r, L, load, caseType as string, indexed, hops);
		// A close that never runs is read as no close. HQ's page stores one with its question,
		// answer and operator cleared (`advanced/actions.js::actionBase.clean_condition`), which
		// is not the schema's default, so the claim is made whether or not it closes.
		const closeClaim = last
			? ADVANCED_CLAIMS.ownClose
			: conditionReadsAnswerAlone(form, closeStored)
				? ANSWER_ALONE_CLAIMS.loadClose
				: ADVANCED_CLAIMS.otherClose;
		consume(L.take("close_condition", closeClaim, (value) => value));
		noteBooleanAnswer(
			ctx,
			closeStored,
			closeClaim.entry,
			`${L.pointer}/close_condition`,
		);
		const changes =
			properties.writes.length > 0 ||
			properties.name !== undefined ||
			properties.owner !== undefined ||
			closes;
		chosen.push({
			tag: tag as string,
			caseType: caseType as string,
			detailsModule: listMenu?.uniqueId ?? detailsId,
			...(indexRead !== undefined && { index: indexRead }),
			changes,
		});
		if (listMenu !== undefined) chain.push(listMenu.uuid);
		const placement = tag as string;
		const selected = explicit?.choices.get(i);
		const ref: ProposedCaseRef = last
			? { kind: "session" }
			: selected
				? { kind: "selection", uuid: selected.uuid }
				: { kind: "selected", module: (listMenu ?? module).uuid };
		loadUuids.set(i, ref);
		const condition = (
			stored: unknown,
			key: string,
		): ProposedCondition | undefined =>
			conditionType(stored) === "if"
				? {
						stored,
						repeat: undefined,
						place: conditionField(form, stored)?.place ?? form.place,
						pointer: `${L.pointer}/${key}`,
					}
				: undefined;
		if (last) {
			type = closes ? "close" : "followup";
			if (closes) closeCondition = condition(closeStored, "close_condition");
			// A follow-up or close form always carries its own arm, the first change, whether or
			// not its load writes anything (`CASE_OWN_OPERATION`).
			const uuid = mint(r, placement, "own", ordinal(placement, "own"));
			if (uuid !== undefined)
				operations.unshift({
					uuid,
					id: operationId(menuType),
					action: "own",
					tag: placement,
					...(properties.name !== undefined && { name: properties.name }),
					...(properties.nameOnlyIfChanged !== undefined && {
						nameOnlyIfChanged: true,
					}),
					...(properties.owner !== undefined && { owner: properties.owner }),
					...(properties.ownerOnlyIfChanged !== undefined && {
						ownerOnlyIfChanged: true,
					}),
					writes: properties.writes,
					links: [],
				});
			return;
		}
		let updateUuid: Uuid | undefined;
		if (
			properties.writes.length > 0 ||
			properties.name !== undefined ||
			properties.owner !== undefined
		) {
			updateUuid = mint(r, placement, "update", ordinal(placement, "update"));
			if (updateUuid !== undefined)
				operations.push({
					uuid: updateUuid,
					id: operationId(caseType as string),
					action: "update",
					caseType: caseType as string,
					tag: placement,
					target: ref,
					...(properties.name !== undefined && { rename: properties.name }),
					...(properties.nameOnlyIfChanged !== undefined && {
						renameOnlyIfChanged: true,
					}),
					...(properties.owner !== undefined && { owner: properties.owner }),
					...(properties.ownerOnlyIfChanged !== undefined && {
						ownerOnlyIfChanged: true,
					}),
					writes: properties.writes,
					links: [],
				});
		}
		if (closes) {
			const closeUuid = mint(
				r,
				placement,
				"close",
				ordinal(placement, "close"),
			);
			const closeOn = condition(closeStored, "close_condition");
			if (closeUuid !== undefined)
				operations.push({
					uuid: closeUuid,
					id: operationId(caseType as string),
					action: "close",
					caseType: caseType as string,
					tag: placement,
					target: ref,
					writes: [],
					links: [],
					...(closeOn !== undefined && { condition: closeOn }),
					...(updateUuid !== undefined && { shares: updateUuid }),
				});
		}
	};
	loadCursors.forEach((L, i) => {
		const before = ctx.accounting.findingCount();
		readLoad(L, i);
		const load = storedLoads[i];
		const chosen =
			isJsonObject(load) &&
			(load.auto_select === null || load.auto_select === undefined);
		const refusal = ctx.accounting.findingRaised(before);
		if (chosen && !loadUuids.has(i) && refusal !== undefined)
			refusedChosenLoads.set(i, refusal);
	});

	// The open actions.
	const moduleTypes = new Set(
		ctx.draft.modules.flatMap((one) => {
			const caseType = one.module.caseType ?? one.json.peek("case_type");
			return typeof caseType === "string" && caseType !== "" ? [caseType] : [];
		}),
	);
	const opUuidOfOpen = new Map<number, Uuid>();
	// HQ's build nests a repeat's open actions under `case_<tag>` only where two or more of
	// them carry indices (`xform.py::_create_casexml_advanced`, `get_action_path`, over
	// `AdvancedFormActions.count_subcases_per_repeat_context`); otherwise every open action of
	// the repeat writes its block at the row's one `case`.
	const repeatsWithIndices = new Map<string, number>();
	const repeatsWithOpens = new Map<string, number>();
	storedOpens.forEach((open) => {
		if (!isJsonObject(open)) return;
		const context =
			typeof open.repeat_context === "string" ? open.repeat_context : "";
		if (context === "") return;
		repeatsWithOpens.set(context, (repeatsWithOpens.get(context) ?? 0) + 1);
		const indices = Array.isArray(open.case_indices) ? open.case_indices : [];
		if (indices.length > 0)
			repeatsWithIndices.set(
				context,
				(repeatsWithIndices.get(context) ?? 0) + 1,
			);
	});
	/** Whether the open actions of a repeat share the row's one block. */
	const sharesRowBlock = (context: string) =>
		(repeatsWithOpens.get(context) ?? 0) > 1 &&
		(repeatsWithIndices.get(context) ?? 0) < 2;
	openCursors.forEach((O, j) => {
		const open = storedOpens[j] as Record<string, unknown>;
		const own = j === ownOpenIndex;
		const tag = open.case_tag;
		const tagClaim = tagFinding(tag, true);
		if (tagClaim !== undefined) {
			O.refuseWhole(
				tagClaim,
				typeof tag === "string" && tag !== "" ? { name: tag } : undefined,
			);
			r.ok = false;
			return;
		}
		const caseType = open.case_type;
		if (
			typeof caseType !== "string" ||
			(!moduleTypes.has(caseType) && caseType !== "commcare-user")
		) {
			O.refuseWhole(ADVANCED_CLAIMS.openTypeUnknown, {
				name: String(caseType ?? ""),
			});
			r.ok = false;
			return;
		}
		consume(
			O.take(
				"case_tag",
				typeof tag === "string" && tag.includes("-")
					? ADVANCED_CLAIMS.openTagHyphen
					: own
						? ADVANCED_CLAIMS.openOwn
						: ADVANCED_CLAIMS.openTag,
				(value) => value,
			),
		);
		consume(
			O.take(
				"case_type",
				own ? ADVANCED_CLAIMS.openOwnType : ADVANCED_CLAIMS.openType,
				(value) => value,
			),
		);
		const nameUpdate = consume(
			O.take("name_update", ADVANCED_CLAIMS.openName, (value) => value),
		);
		// No build reads a create's name mode, so the comparison leaves it out and Nova writes it as saved every time.
		if (isJsonObject(nameUpdate) && nameUpdate.update_mode === "edit")
			ctx.facts.sameStateRewrites.push({
				entry: ADVANCED_CLAIMS.openName.entry,
				path: `${O.pointer}/name_update/update_mode`,
				register: "case-settings-respelled",
			});
		const namePath = isJsonObject(nameUpdate)
			? nameUpdate.question_path
			: undefined;
		let name: ProposedValue | undefined;
		if (typeof namePath === "string" && namePath !== "") {
			const read = questionValue(ctx, form, namePath, "name");
			if (read.kind === "finding") {
				ctx.accounting.finding(ADVANCED_CLAIMS.labelQuestion, form.place, {
					name: "name",
				});
				r.ok = false;
			} else name = read.value;
		}
		const properties = readProperties(
			r,
			O,
			{
				map: ADVANCED_CLAIMS.openProperties,
				path: ADVANCED_CLAIMS.openQuestionPath,
				slash: ADVANCED_CLAIMS.openSlashKey,
				surface: "schema:AdvancedOpenCaseAction.case_properties",
				names: {
					illegal: ADVANCED_CLAIMS.openIllegalKey,
					"non-core": ADVANCED_CLAIMS.openNonCoreKey,
					"non-ascii": ADVANCED_CLAIMS.openNonAsciiKey,
				},
			},
			{ kind: "elsewhere" },
			{ opens: true },
		);
		// The repeat: the name question's innermost.
		const context =
			typeof open.repeat_context === "string" ? open.repeat_context : "";
		const nameRepeat =
			name === undefined ? undefined : repeatOfField(name.field);
		let repeat: DraftField | undefined;
		if (context !== "") {
			if (sharesRowBlock(context)) {
				O.refuse("repeat_context", ADVANCED_CLAIMS.openSharedRepeat);
				r.ok = false;
			} else if (
				nameRepeat !== undefined &&
				repeatAtPath(form, context) === nameRepeat
			) {
				consume(
					O.take(
						"repeat_context",
						ADVANCED_CLAIMS.openRepeat,
						(value) => value,
					),
				);
				repeat = nameRepeat;
			} else {
				O.refuse("repeat_context", ADVANCED_CLAIMS.openRepeatOther);
				r.ok = false;
			}
		} else if (nameRepeat === undefined) {
			// A blank context names the root, where a name question in no repeat stands.
			consume(
				O.take("repeat_context", ADVANCED_CLAIMS.openRepeat, (value) => value),
			);
		}
		const openStored = open.open_condition;
		if (O.used("open_condition")) {
			const openClaim = conditionReadsAnswerAlone(form, openStored)
				? ANSWER_ALONE_CLAIMS.openCondition
				: ADVANCED_CLAIMS.openCondition;
			consume(O.take("open_condition", openClaim, (value) => value));
			noteBooleanAnswer(
				ctx,
				openStored,
				openClaim.entry,
				`${O.pointer}/open_condition`,
			);
		}
		const closeStored = open.close_condition;
		const closes = activeCondition(closeStored);
		// A close that never runs is read as no close, claimed as a load's is.
		const openCloseClaim = conditionReadsAnswerAlone(form, closeStored)
			? ANSWER_ALONE_CLAIMS.openClose
			: ADVANCED_CLAIMS.openClose;
		consume(O.take("close_condition", openCloseClaim, (value) => value));
		noteBooleanAnswer(
			ctx,
			closeStored,
			openCloseClaim.entry,
			`${O.pointer}/close_condition`,
		);
		const condition = (
			stored: unknown,
			key: string,
		): ProposedCondition | undefined =>
			conditionType(stored) === "if"
				? {
						stored,
						repeat,
						place: conditionField(form, stored)?.place ?? form.place,
						pointer: `${O.pointer}/${key}`,
					}
				: undefined;

		// The links.
		const links: ProposedLink[] = [];
		const indices = Array.isArray(open.case_indices) ? open.case_indices : [];
		if (indices.length > 0) {
			const indexCursors = O.list(
				"case_indices",
				"CaseIndex",
				ADVANCED_CLAIMS.openIndices,
			);
			// Whether an index before this one, on this open action, names an open action.
			let afterOpenIndex = false;
			indexCursors.forEach((I, k) => {
				const index = indices[k] as Record<string, unknown>;
				const indexTag = typeof index.tag === "string" ? index.tag : "";
				const identifier =
					typeof index.reference_id === "string" && index.reference_id !== ""
						? index.reference_id
						: "parent";
				const loadIndex = loadTags.get(indexTag);
				const openIndex = openTags.get(indexTag);
				const namesOpen = openIndex !== undefined && loadIndex === undefined;
				const earlierOpenIndex = afterOpenIndex;
				if (namesOpen) afterOpenIndex = true;
				const nameProblem = advancedCaseIndexNameProblem(identifier);
				if (nameProblem) {
					// A top-level creation puts the index element in the primary instance
					// before Formplayer serializes it as ASCII. A repeat template is omitted.
					const rootWriter =
						nameProblem === "one-platform" &&
						form.docType === "AdvancedForm" &&
						(open.repeat_context == null || open.repeat_context === "") &&
						conditionType(openStored) === "always" &&
						(index.relationship === undefined ||
							index.relationship === "child") &&
						indexTag !== "" &&
						loadIndex !== undefined &&
						submittedElementNameNeedsAndroid(identifier) &&
						isPortableName(identifier, ["web-apps"]);
					const claim = {
						"invalid-xml": ADVANCED_CLAIMS.openIndexInvalidXml,
						unaddressable: ADVANCED_CLAIMS.openIndexUnaddressable,
						"one-platform": rootWriter
							? ADVANCED_CLAIMS.rootOpenIndexWebOnly
							: ADVANCED_CLAIMS.openIndexName,
					}[nameProblem];
					I.refuseWhole(claim, { name: identifier });
					r.ok = false;
					return;
				}
				// A load HQ's entry renames is one the index's `case_id_<tag>` read never finds.
				if (loadIndex !== undefined && loadDatumRenamed(ctx, form, indexTag)) {
					I.refuseWhole(ADVANCED_CLAIMS.openIndexRenamedLoad, {
						name: indexTag,
					});
					r.ok = false;
					return;
				}
				if (index.relationship === "question") {
					const question =
						typeof index.relationship_question === "string"
							? index.relationship_question
							: "";
					const field = question === "" ? undefined : fieldAt(form, question);
					const claim =
						question === ""
							? ADVANCED_CLAIMS.openIndexQuestion
							: field !== undefined && repeatOfField(field) !== undefined
								? ADVANCED_CLAIMS.questionInRepeat
								: namesOpen
									? ADVANCED_CLAIMS.questionToOpen
									: loadIndex !== undefined && earlierOpenIndex
										? ADVANCED_CLAIMS.questionAfterOpenIndex
										: loadIndex !== undefined && loadUuids.has(loadIndex)
											? ADVANCED_CLAIMS.questionToLoad
											: undefined;
					if (claim !== undefined) {
						I.refuseWhole(claim);
						r.ok = false;
						return;
					}
				}
				const relationship =
					index.relationship === "extension" ? "extension" : "child";
				let inRepeat = false;
				if (loadIndex !== undefined && !loadUuids.has(loadIndex)) {
					// An index to a load the form selects no case for (an auto-selected
					// one) names an action the chain does not hold: nothing here reads it.
					// An index to a chosen load the reading refused belongs to that refusal.
					const refusedLoad = refusedChosenLoads.get(loadIndex);
					if (refusedLoad !== undefined)
						for (const key of [
							"tag",
							"reference_id",
							"relationship",
							"relationship_question",
						])
							if (key === "tag" || I.used(key))
								ctx.accounting.cover({ json: I, key }, refusedLoad);
					r.ok = false;
					return;
				}
				if (loadIndex !== undefined && loadUuids.has(loadIndex)) {
					const load = storedLoads[loadIndex] as Record<string, unknown>;
					links.push({
						identifier,
						targetType: String(load.case_type),
						relationship,
						target: loadUuids.get(loadIndex) as ProposedCaseRef,
					});
				} else if (
					openIndex !== undefined &&
					openIndex < j &&
					opUuidOfOpen.has(openIndex)
				) {
					const target = storedOpens[openIndex] as Record<string, unknown>;
					const targetContext =
						typeof target.repeat_context === "string"
							? target.repeat_context
							: "";
					if (targetContext !== "" && targetContext !== context) {
						// The class reads the open action's repeat beside its index.
						I.refuseWhole(
							ADVANCED_CLAIMS.openIndexOutsideRepeat,
							undefined,
							undefined,
							O.pointer,
						);
						r.ok = false;
						return;
					}
					if (targetContext !== "") inRepeat = true;
					links.push({
						identifier,
						targetType: String(target.case_type),
						relationship,
						target: { kind: "op", uuid: opUuidOfOpen.get(openIndex) as Uuid },
					});
				} else if (openIndex !== undefined) {
					I.refuseWhole(ADVANCED_CLAIMS.openIndexOwnOrLater);
					r.ok = false;
					return;
				} else {
					I.refuseWhole(ADVANCED_CLAIMS.openIndexNoAction);
					r.ok = false;
					return;
				}
				consume(
					I.take(
						"tag",
						inRepeat
							? ADVANCED_CLAIMS.openIndexInsideRepeat
							: ADVANCED_CLAIMS.openIndices,
						(value) => value,
					),
				);
				const read = links.at(-1);
				if (identifier === "parent" && read !== undefined)
					parentIndicesRead(ctx).push({
						cursor: I,
						place: form.place,
						childType: caseType,
						parentType: read.targetType,
						relationship,
					});
				if (I.used("reference_id")) {
					const claim = advancedCaseIndexNeedsAndroid(identifier)
						? ADVANCED_CLAIMS.unicodeOpenIndexReference
						: isCaseOperationLinkIdentifier(identifier)
							? ADVANCED_CLAIMS.openIndices
							: ADVANCED_CLAIMS.extendedOpenIndexReference;
					consume(I.take("reference_id", claim, (value) => value));
				}
				if (I.used("relationship"))
					consume(
						I.take(
							"relationship",
							ADVANCED_CLAIMS.openIndices,
							(value) => value,
						),
					);
			});
		}
		// HQ's build refuses an open action with no name (`case_name required`,
		// `AdvancedFormValidator.check_actions`), and a `name` among its
		// properties renames the case it opens in the same block, which no
		// create of Nova's holds: neither is dropped unseen.
		const nameless = typeof namePath !== "string" || namePath === "";
		if (nameless || properties.name !== undefined) {
			ctx.accounting.circumstance("unrecognized", form.place, {
				name: nameless
					? "schema:AdvancedOpenCaseAction.name_update"
					: "schema:AdvancedOpenCaseAction.case_properties",
			});
			r.ok = false;
			return;
		}
		// A name question the reader refused is that finding already.
		if (name === undefined) return;
		createNames.push(name.field);
		// HQ's build sets no owner on an open action that names no `owner_id`
		// and carries indices that are all extensions, and writes `-`
		// (`xform.py::autoset_owner_id_for_advanced_action`, `add_create_block`):
		// the case is unowned, which Nova states as `unowned()` and prints with
		// no owner node (`generatedNodes.ts::advancedOwnerNodeValue`).
		const unownedByLinks =
			links.length > 0 &&
			links.every((link) => link.relationship === "extension");
		/** The operation's owner: an owner node it names settled once the operation has its id. */
		const ownerOfOpen = (id: string) =>
			properties.ownerNode !== undefined
				? settleOwner(r, properties.ownerNode, id, repeat)
				: properties.owner === undefined && unownedByLinks
					? ("unowned" as const)
					: properties.owner;
		const placementTag = tag as string;
		const row =
			repeat !== undefined && (repeatsWithIndices.get(context) ?? 0) < 2
				? (true as const)
				: undefined;
		if (own) {
			type = "registration";
			openCondition = condition(openStored, "open_condition");
			if (closes) {
				closeCondition = condition(closeStored, "close_condition");
				closesAlways = conditionType(closeStored) === "always";
			}
			const uuid = mint(r, placementTag, "own", ordinal(placementTag, "own"));
			if (uuid === undefined) return;
			opUuidOfOpen.set(j, uuid);
			const id = openOperationId(caseType, properties.ownerNode);
			const owner = ownerOfOpen(id);
			operations.unshift({
				uuid,
				id,
				action: "own",
				tag: placementTag,
				name,
				...(owner !== undefined && { owner }),
				...(properties.ownerOnlyIfChanged !== undefined && {
					ownerOnlyIfChanged: true,
				}),
				writes: properties.writes,
				links,
			});
			return;
		}
		const uuid = mint(
			r,
			placementTag,
			"create",
			ordinal(placementTag, "create"),
		);
		if (uuid === undefined) return;
		opUuidOfOpen.set(j, uuid);
		const openOn = condition(openStored, "open_condition");
		const id = openOperationId(caseType, properties.ownerNode);
		const owner = ownerOfOpen(id);
		operations.push({
			uuid,
			id,
			action: "create",
			caseType,
			tag: placementTag,
			...(row !== undefined && { row }),
			name,
			...(owner !== undefined && { owner }),
			...(properties.ownerOnlyIfChanged !== undefined && {
				ownerOnlyIfChanged: true,
			}),
			writes: properties.writes,
			...(openOn !== undefined && { condition: openOn }),
			...(repeat !== undefined && { forEach: repeat }),
			target: { kind: "new" },
			links,
		});
		if (closes) {
			const closeUuid = mint(
				r,
				placementTag,
				"close",
				ordinal(placementTag, "close"),
			);
			const closeOn = condition(closeStored, "close_condition");
			if (closeUuid !== undefined)
				operations.push({
					uuid: closeUuid,
					id: operationId(caseType),
					action: "close",
					caseType,
					tag: placementTag,
					target: { kind: "op", uuid },
					writes: [],
					links: [],
					...(closeOn !== undefined && { condition: closeOn }),
					...(repeat !== undefined && { forEach: repeat }),
					shares: uuid,
				});
		}
	});
	// The worker's record is written last.
	const workerIndex = operations.findIndex(
		(one) => one.target?.kind === "worker-record",
	);
	if (workerIndex !== -1) operations.push(...operations.splice(workerIndex, 1));
	// HQ's build writes `required` on each open action's name question.
	dropCreateNameRequired(ctx, form, createNames);

	ctx.writeDraft(() => {
		form.form.type = type;
	});
	READINGS.set(form, {
		type,
		operations,
		...(explicit?.questions.size && {
			choiceRelationshipQuestions: explicit.questions,
		}),
		...(openCondition !== undefined && { openCondition }),
		...(closeCondition !== undefined && { closeCondition }),
		...(closesAlways ? { closesAlways: true as const } : {}),
		chosen,
		...(worker !== undefined && { worker }),
		...(explicit === undefined &&
			chainOk &&
			chain.length === chosen.length && { chain: [...chain] }),
		mints,
		...(!r.ok && { refused: true as const }),
		createNames,
		refusedScalarFields: [],
	});
}

/**
 * Names `form`'s advanced operations past `carried`, the ids the form's Save
 * to Case blocks carry, which win: each operation is named again in the order
 * the reading named them, its owner node's name where that is free, else its
 * case type's id free among the carried ones and those named before it. That
 * is the id `operationOrder.ts::caseManagementOperationsAsRead` gives it.
 */
export function nameAdvancedOperationsPast(
	form: DraftForm,
	carried: ReadonlySet<string>,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined || carried.size === 0) return;
	const taken = new Set(carried);
	const renamed = new Map<string, string>();
	for (const mint of reading.mints) {
		const id =
			mint.named !== undefined && !taken.has(mint.named)
				? mint.named
				: ownCaseOperationId(mint.caseType, taken);
		taken.add(id);
		renamed.set(mint.id, id);
	}
	READINGS.set(form, {
		...reading,
		operations: reading.operations.map((one) => ({
			...one,
			id: renamed.get(one.id) ?? one.id,
		})),
		mints: reading.mints.map((mint) => ({
			...mint,
			id: renamed.get(mint.id) ?? mint.id,
		})),
	});
}

/** Whether a disabled schedule's conditions name a question the form no longer has. */
function scheduleNamesMissingQuestion(
	form: DraftForm,
	schedule: Readonly<Record<string, unknown>>,
): boolean {
	for (const key of ["transition_condition", "termination_condition"]) {
		const condition = schedule[key];
		if (conditionType(condition) !== "if") continue;
		if (conditionField(form, condition) === undefined) return true;
	}
	return false;
}

/** An auto-selected load: the worker's record where it writes it, else its finding. */
function readAutoSelectLoad(
	r: Reading,
	L: JsonCursor,
	load: Readonly<Record<string, unknown>>,
	operations: AdvancedProposal[],
	operationId: (type: string) => string,
	ordinal: (tag: string, action: string) => number,
): StoredLoad | undefined {
	const auto = isJsonObject(load.auto_select) ? load.auto_select : NO_ENTRIES;
	const C = ADVANCED_CLAIMS;
	const tag = load.case_tag;
	const properties = readProperties(r, L, WORKER_LOAD_PROPERTY_CLAIMS, {
		kind: "elsewhere",
	});
	if (typeof tag !== "string") return undefined;
	// The worker's load Nova writes names no value and saves answers outside
	// any repeat: a stray `value_source` or `value_key`, or a write from a
	// repeat's question, is a load Nova does not write, never claimed unseen.
	const stray = ["value_source", "value_key"].find(
		(one) => typeof auto[one] === "string" && auto[one] !== "",
	);
	const repeated = properties.writes.some(
		(write) => repeatOfField(write.value.field) !== undefined,
	);
	if (stray !== undefined || repeated) {
		r.ctx.accounting.circumstance("unrecognized", r.form.place, {
			name:
				stray !== undefined
					? `schema:AutoSelectCase.${stray}`
					: "schema:LoadUpdateAction.case_properties",
		});
		r.ok = false;
		return undefined;
	}
	// The index: none on an auto-selected load. HQ's page stores one with a blank tag, which
	// indexes nothing (`advanced/actions.js`, `case_index.tag('')`).
	const index = isJsonObject(load.case_index) ? load.case_index : NO_ENTRIES;
	// Each refusal below reads the load no further, so the load stands under
	// it whole: one cause, one finding, no key of it left unclaimed.
	if (typeof index.tag === "string" && index.tag !== "") {
		L.refuseWhole(C.caseIndexOnFirst);
		r.ok = false;
		return undefined;
	}
	if (L.used("case_index"))
		consume(L.take("case_index", C.caseIndex, (value) => value));
	if (
		load.show_product_stock === true ||
		(typeof load.product_program === "string" && load.product_program !== "")
	) {
		L.refuseWhole(C.productStock);
		r.ok = false;
		return undefined;
	}
	if (L.used("show_product_stock"))
		L.drop("show_product_stock", C.productStockOff);
	if (L.used("product_program")) L.drop("product_program", C.productProgramOff);
	// A close that never runs is read as no close, claimed as another selection's is.
	consume(L.take("close_condition", C.otherClose, (value) => value));
	consume(L.take("auto_select", C.usercase, (value) => value));
	consume(
		L.take(
			"case_tag",
			tag.includes("-") ? C.tagHyphen : C.tag,
			(value) => value,
		),
	);
	consume(L.take("case_type", C.caseType, (value) => value));
	const uuid = mint(r, tag, "update", ordinal(tag, "update"));
	if (uuid !== undefined)
		operations.push({
			uuid,
			id: operationId("commcare-user"),
			action: "update",
			caseType: "commcare-user",
			tag,
			target: { kind: "worker-record" },
			writes: properties.writes,
			links: [],
		});
	return { tag, caseType: "commcare-user", detailsModule: "", changes: true };
}

/** The index name a load's `case_index` gives the case it chooses: its
 *  `reference_id`, `parent` where it names none (`CaseIndex.reference_id`'s
 *  default). */
function chainIndexName(index: Readonly<Record<string, unknown>>): string {
	return typeof index.reference_id === "string" && index.reference_id !== ""
		? index.reference_id
		: "parent";
}

/** A load's `preload`: each into a question outside any repeat, from a
 *  property with no `/`, read as the question's default; any other is the
 *  finding that it would hold its place at the end of the load. HQ's build
 *  reads each load's preload from that load's own case
 *  (`xform.py::XForm._create_casexml_advanced`, `session_case_id`), and the
 *  default is a `form-case` read, which walks from the form's own case the
 *  indices the document links each type to its parent by
 *  (`caseTypeDepths.ts::caseTypeHopMap`). `hops` is the walk to this load
 *  from the own case: each later load's index, the own load's first. A load
 *  the document's walk does not reach that way (a type the catalog does not
 *  place that deep, another load of the chain nearer the own sharing its
 *  type, a link of the app giving a type of the chain another parent, or a
 *  later load chosen through an index the app's links between the two types
 *  do not name alone) is the finding that Nova's read would name another case
 *  (`preloadOtherCase`), once the catalog and the links are read
 *  (`preloads.ts::settlePreloads`). */
function readLoadPreloads(
	r: Reading,
	L: JsonCursor,
	load: Readonly<Record<string, unknown>>,
	caseType: string,
	indexed: boolean,
	hops: readonly string[],
): void {
	const preload = isJsonObject(load.preload) ? load.preload : NO_ENTRIES;
	if (Object.keys(preload).length === 0) return;
	// HQ's build refuses the form for a property its validator refuses
	// (`LoadUpdateAction.get_property_names` → `check_case_properties`).
	if (
		Object.values(preload).some(
			(property) =>
				typeof property === "string" && hqBuildRefusesProperty(property),
		)
	) {
		L.refuse("preload", ADVANCED_CLAIMS.illegalPreload);
		r.ok = false;
		return;
	}
	if (
		indexed &&
		Object.values(preload).some(
			(property) => typeof property === "string" && property.includes("/"),
		)
	) {
		L.refuse("preload", ADVANCED_CLAIMS.slashPreloadOnIndexedLoad);
		r.ok = false;
		return;
	}
	const allEntries = Object.entries(preload).map(([path, property]) => ({
		path,
		property,
		field: fieldAt(r.form, path),
	}));
	const source = {
		kind: "load" as const,
		tag: typeof load.case_tag === "string" ? load.case_tag : "",
	};
	const late = allEntries.flatMap(({ path, property, field }) => {
		if (
			!field ||
			typeof property !== "string" ||
			holdsEarlierDefault(r.ctx, r.form, source, path, property)
		)
			return [];
		const { indices, name } = preloadReadOf(property);
		return name &&
			!hqBuildRefusesProperty(name === "case_name" ? "name" : name) &&
			holdsAsOpeningAssignment(indices, name)
			? [{ field, indices, property: name, path }]
			: [];
	});
	const carried = new Set(late.map((row) => row.path));
	for (const row of late) {
		recordLateAssignment(r.form, { ...row, source });
		L.takePart(
			"preload",
			JSON.stringify([row.path, "ready"]),
			ADVANCED_CLAIMS.assignedAtOpen,
		);
		if (!holdsDefault(r.form, row.field))
			L.takePart(
				"preload",
				JSON.stringify([row.path, "calculated"]),
				ADVANCED_CLAIMS.calculatedOpening,
			);
	}
	const entries = allEntries.filter((row) => !carried.has(row.path));
	if (!entries.length) {
		consume(L.take("preload", ADVANCED_CLAIMS.preload, (value) => value));
		return;
	}
	const label = entries.find(
		({ field }) => field?.kind === "label" || field === undefined,
	);
	if (label !== undefined) {
		L.refuse("preload", ADVANCED_CLAIMS.labelQuestion);
		r.ok = false;
		return;
	}
	const noDefault = entries.find(
		({ field }) => field !== undefined && !holdsDefault(r.form, field),
	);
	if (noDefault !== undefined) {
		L.refuse("preload", ADVANCED_CLAIMS.preloadNoDefault);
		r.ok = false;
		return;
	}
	const later = entries.find(
		({ field, property }) =>
			field === undefined ||
			repeatOfField(field) !== undefined ||
			typeof property !== "string" ||
			property.includes("/"),
	);
	if (later !== undefined) {
		L.refuse("preload", ADVANCED_CLAIMS.preloadLater);
		r.ok = false;
		return;
	}
	// A name HQ's grammar admits for its trailing newline reads a child element
	// no property name of Nova's names (`preloads.ts::preloadReadOf`).
	const unnamed = entries.find(
		({ property }) =>
			typeof property === "string" &&
			preloadNameRefusal(preloadReadOf(property).name) !== undefined,
	);
	if (unnamed !== undefined) {
		L.refuse(
			"preload",
			preloadNameRefusal(preloadReadOf(unnamed.property as string).name) ??
				UNNAMED_PRELOAD,
			{
				name: unnamed.property as string,
				reason: "name:case-property",
			},
		);
		r.ok = false;
		return;
	}
	consume(L.take("preload", ADVANCED_CLAIMS.preload, (value) => value));
	// Nova writes the load as each question's default, never as a stored
	// preload: the first publish respells the case settings.
	if (entries.length > 0)
		r.ctx.facts.sameStateRewrites.push({
			entry: ADVANCED_CLAIMS.preload.entry,
			path: `${L.pointer}/preload`,
			register: "case-settings-respelled",
		});
	for (const { field, property } of entries) {
		const question = field as DraftField;
		const read: Term = {
			kind: "form-case",
			caseType,
			property: preloadReadOf(property as string).name as string,
		};
		writeDefault(r.ctx, r.form, question, term(read));
		addPreloadCandidate(r.form, {
			field: question,
			place: question.place,
			moves: ADVANCED_CLAIMS.preloadLater,
			load: {
				caseType,
				hops,
				otherCase: ADVANCED_CLAIMS.preloadOtherCase,
			},
		});
	}
}

// ── The writes, once the fields have their UUIDs ────────────────────────

function valueExpression(value: ProposedValue): Expression | undefined {
	const uuid = value.field.uuid;
	if (uuid === undefined) return undefined;
	return value.link
		? term({ kind: "capture-link", field: uuid })
		: term(formField(uuid));
}

function conditionOf(
	form: DraftForm,
	condition: ProposedCondition | undefined,
): Expression | undefined {
	if (condition === undefined) return undefined;
	const read = readActionCondition(
		condition.stored,
		{ own: false, repeat: condition.repeat?.uuid },
		form,
	);
	return read.kind === "if" ? read.expression : undefined;
}

function selectedCase(module: Uuid): Expression {
	return term({
		kind: "session-datum",
		datum: { kind: "selected-case", module },
	} as never);
}

function caseTarget(
	ref: NonNullable<AdvancedProposal["target"]>,
): TargetedCaseOperation["target"] {
	switch (ref.kind) {
		case "session":
			return { kind: "session" };
		case "selected":
			return { kind: "expression", expr: selectedCase(ref.module) };
		case "selection":
			return {
				kind: "expression",
				expr: term({
					kind: "session-datum",
					datum: { kind: "form-selection", selection: ref.uuid },
				}),
			};
		case "op":
			return { kind: "op", opUuid: ref.uuid };
		case "worker-record":
			return { kind: "worker-record" };
		case "new":
			return { kind: "new" };
	}
}

function linkTarget(ref: ProposedCaseRef): CaseOperationLink["target"] {
	switch (ref.kind) {
		case "session":
			return { kind: "session" };
		case "selected":
			return { kind: "expression", expr: selectedCase(ref.module) };
		case "selection":
			return {
				kind: "expression",
				expr: term({
					kind: "session-datum",
					datum: { kind: "form-selection", selection: ref.uuid },
				}),
			};
		case "op":
			return { kind: "op", opUuid: ref.uuid };
	}
}

function ownerOf(owner: AdvancedProposal["owner"]): Expression | undefined {
	if (owner === undefined) return undefined;
	if (owner === "acting-user") return actingUser();
	if (owner === "unowned") return unowned();
	return valueExpression(owner);
}

/** Writes one advanced form's proposed operations and conditions into its draft. */
export function writeAdvancedOperations(
	ctx: ReadContext,
	form: DraftForm,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined) return;
	const operations: CaseOperation[] = [];
	for (const proposal of reading.operations) {
		const writes: CaseOperationWrite[] = [];
		for (const write of proposal.writes) {
			const value = valueExpression(write.value);
			if (value !== undefined)
				writes.push({
					property: write.property,
					value,
					...(write.via !== undefined && { via: write.via }),
					...(write.onlyIfChanged !== undefined && { onlyIfChanged: true }),
				});
		}
		const placement = {
			kind: "advanced" as const,
			tag: proposal.tag,
			...(proposal.row !== undefined && { row: true as const }),
		};
		// A case the action opens is the worker's where it states no owner
		// (`generatedNodes.ts::advancedOwnerNodeValue`), so the worker's owner
		// node reads as none (`assemble.ts`, `opened-case-owner-acting-user-is-absent`).
		const owner =
			proposal.owner === "acting-user" &&
			(proposal.action === "own" || proposal.action === "create")
				? undefined
				: ownerOf(proposal.owner);
		const name =
			proposal.name === undefined ? undefined : valueExpression(proposal.name);
		const rename =
			proposal.rename === undefined
				? undefined
				: valueExpression(proposal.rename);
		const condition = conditionOf(form, proposal.condition);
		const links: CaseOperationLink[] = proposal.links.map(
			(link) =>
				({
					identifier: link.identifier,
					targetType: link.targetType,
					relationship: link.relationship,
					target: linkTarget(link.target),
				}) as CaseOperationLink,
		);
		const forEach =
			proposal.forEach?.uuid === undefined
				? undefined
				: { repeat: proposal.forEach.uuid };
		const common = {
			uuid: proposal.uuid,
			id: proposal.id,
			...(writes.length > 0 && { writes }),
			...(proposal.shares === undefined && { placement }),
		};
		// A facet saved only when changed is read from a question, so it is
		// never the worker or "no one".
		const ownerFlag =
			owner !== undefined && proposal.ownerOnlyIfChanged === true
				? { ownerOnlyIfChanged: true as const }
				: {};
		if (proposal.action === "own")
			operations.push({
				...common,
				action: "own",
				...(name !== undefined && { name }),
				...(name !== undefined &&
					proposal.nameOnlyIfChanged === true && {
						nameOnlyIfChanged: true,
					}),
				...(owner !== undefined && { owner }),
				...ownerFlag,
				...(links.length > 0 && { links }),
			} as CaseOperation);
		else if (proposal.action === "create" && name !== undefined)
			operations.push({
				...common,
				action: "create",
				caseType: proposal.caseType as string,
				target: { kind: "new" },
				name,
				...(owner !== undefined && { owner }),
				...ownerFlag,
				...(links.length > 0 && { links }),
				...(condition !== undefined && { condition }),
				...(forEach !== undefined && { forEach }),
			} as CaseOperation);
		else if (proposal.action === "update")
			operations.push({
				...common,
				action: "update",
				caseType: proposal.caseType as string,
				target: caseTarget(proposal.target ?? { kind: "session" }),
				...(owner !== undefined && { owner }),
				...ownerFlag,
				...(rename !== undefined && { rename }),
				...(rename !== undefined &&
					proposal.renameOnlyIfChanged === true && {
						renameOnlyIfChanged: true,
					}),
			} as CaseOperation);
		else if (proposal.action === "close")
			operations.push({
				uuid: proposal.uuid,
				id: proposal.id,
				...(proposal.shares === undefined && { placement }),
				action: "close",
				caseType: proposal.caseType as string,
				target: caseTarget(proposal.target ?? { kind: "session" }),
				...(condition !== undefined && { condition }),
				...(forEach !== undefined && { forEach }),
			} as CaseOperation);
	}
	const open = conditionOf(form, reading.openCondition);
	const close =
		reading.closesAlways === true
			? matchAll()
			: conditionOf(form, reading.closeCondition);
	// A read records each actual source tag, including a load that writes nothing.
	const tags: Array<[Uuid, string]> =
		form.form.caseSelections?.map((row) => [row.uuid, row.tag]) ??
		(reading.chain ?? []).flatMap((menu, i) => {
			const load = reading.chosen[i];
			return load
				? [
						[implicitFormSelectionId(form.uuid, menu), load.tag] as [
							Uuid,
							string,
						],
					]
				: [];
		});
	if (form.form.caseSelections === undefined && reading.worker)
		tags.push([
			implicitFormSelectionId(form.uuid, "worker-record"),
			reading.worker.tag,
		]);
	// An implicit record's UUID is the form's own derivation; the map
	// holds its key under that UUID, as `externalIdentityMap` spells it.
	if (form.form.caseSelections === undefined)
		for (const [uuid, tag] of tags)
			ctx.accounting.identity(
				ctx.identities.record(
					externalKey.formSelection(form.uuid, tag),
					uuid,
					whereText(form.place),
				),
				form.place,
				"schema:LoadUpdateAction.case_tag",
			);
	ctx.writeDraft(() => {
		if (tags.length) form.form.heldSelectionTags = recordFromEntries(tags);
		for (const row of form.form.caseSelections ?? []) {
			const supplied = reading.choiceRelationshipQuestions?.get(row.uuid);
			if (row.source.kind === "choose" && row.source.under && supplied?.uuid)
				row.source.under.relationship = { question: supplied.uuid };
		}
		if (operations.length > 0) form.form.caseOperations = operations;
		if (open !== undefined) form.form.openCondition = open;
		if (close !== undefined) form.form.closeCondition = close;
	});
}

const LIST_FORM_RULES = ADVANCED_CLAIMS.listFormRules.entry;

/**
 * The menu's case list, where it offers a registration and the refusal there stands for the
 * menu's advanced forms breaking the rules such a menu's forms keep (the same loads, a chain of
 * parents, the same tag, the menu's own list and case type for the last load), else
 * `undefined`. Those rules are the menu's one chain, so a form's loads outside it are that
 * refusal's, one finding for the one cause.
 */
export function listFormRulesPlace(
	ctx: ReadContext,
	module: DraftModule,
): HqPlace | undefined {
	const place: HqPlace = {
		kind: "case-list",
		menu: module.index,
		name: module.place.kind === "menu" ? module.place.name : "",
	};
	const where = whereText(place);
	return ctx.accounting
		.findings()
		.some(
			(finding) =>
				finding.code === LIST_FORM_RULES && whereText(finding.place) === where,
		)
		? place
		: undefined;
}

/** Each menu's parent selection from its forms' loads, and each
 *  form whose chain differs from the menu's one chain (its finding). */
export function writeAdvancedChains(ctx: ReadContext): void {
	const outsideTheChain = new Set<DraftForm>();
	for (const module of ctx.draft.modules) {
		if (module.docType !== "AdvancedModule") continue;
		const forms = module.forms.filter((form) => READINGS.has(form));
		const { chain, disagreeing } = readLoadChain(module, forms);
		const rulesAt = listFormRulesPlace(ctx, module);
		for (const { form } of disagreeing) {
			if (rulesAt === undefined)
				ctx.accounting.circumstance("unrecognized", form.place, {
					name: "schema:AdvancedFormActions.load_update_cases",
				});
			outsideTheChain.add(form);
		}
		for (const form of forms)
			if (READINGS.get(form)?.refused === true) outsideTheChain.add(form);
		if (chain === undefined || chain.length < 2) continue;
		const parent = chain[chain.length - 2] as Uuid;
		ctx.writeDraft(() => {
			module.module.parentCaseModuleUuid = parent;
		});
	}
	for (const module of ctx.draft.modules)
		for (const form of module.forms)
			if (outsideTheChain.has(form))
				dropUnselectedCaseOperations(ctx, module, form);
}

/**
 * Leaves out of `form`'s draft each operation that reaches a case a menu chooses where the
 * entry the draft gives the form chooses none through that menu: the menu's own case and
 * each case its parent menus choose first are the ones it chooses. Such an operation stands
 * only where a load the first pass refused, or a chain that is not the menu's one chain,
 * broke the chain the form's loads name; that finding at the form covers it, and the
 * operation, with every one that reaches the case it changes or shares its place, belongs to
 * it.
 */
function dropUnselectedCaseOperations(
	ctx: ReadContext,
	module: DraftModule,
	form: DraftForm,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined) return;
	const chosen = new Set<Uuid>();
	const byUuid = new Map(ctx.draft.modules.map((one) => [one.uuid, one]));
	for (
		let at: DraftModule | undefined = module;
		at !== undefined && !chosen.has(at.uuid);
		at =
			at.module.parentCaseModuleUuid === undefined
				? undefined
				: byUuid.get(at.module.parentCaseModuleUuid)
	)
		chosen.add(at.uuid);
	const unselected = (ref: NonNullable<AdvancedProposal["target"]>) =>
		ref.kind === "selected" && !chosen.has(ref.module);
	const dropped = new Set<Uuid>();
	for (const proposal of reading.operations)
		if (
			(proposal.target !== undefined && unselected(proposal.target)) ||
			proposal.links.some((link) => unselected(link.target))
		)
			dropped.add(proposal.uuid);
	if (dropped.size === 0) return;
	const reaches = (ref: NonNullable<AdvancedProposal["target"]>) =>
		ref.kind === "op" && dropped.has(ref.uuid);
	for (let grown = true; grown; ) {
		grown = false;
		for (const proposal of reading.operations)
			if (
				!dropped.has(proposal.uuid) &&
				((proposal.shares !== undefined && dropped.has(proposal.shares)) ||
					(proposal.target !== undefined && reaches(proposal.target)) ||
					proposal.links.some((link) => reaches(link.target)))
			) {
				dropped.add(proposal.uuid);
				grown = true;
			}
	}
	READINGS.set(form, {
		...reading,
		operations: reading.operations.filter((one) => !dropped.has(one.uuid)),
	});
	const kept = (form.form.caseOperations ?? []).filter(
		(operation) => !dropped.has(operation.uuid),
	);
	ctx.writeDraft(() => {
		if (kept.length > 0) form.form.caseOperations = kept;
		else delete form.form.caseOperations;
	});
}

// ── Pass 2: acceptance by re-emission ───────────────────────────────────

/** What `judgeLoads` finds: nothing, a load whose only
 *  difference is a tag Nova would not derive, or a chain that differs. */
export type LoadsVerdict =
	| { readonly kind: "same" }
	| { readonly kind: "tag"; readonly tag: string }
	| { readonly kind: "chain"; readonly tag: string };

/**
 * Nova's loads for the form over `doc` against
 * HQ's chosen loads, in count, order, case type, list menu and index, then
 * the worker's load. `menuIdOf` names a planned list menu by the id the
 * source gives it.
 */
export function judgeLoads(
	planned: readonly PlannedLoad[],
	chosen: readonly StoredLoad[],
	worker: StoredLoad | undefined,
	menuIdOf: (uuid: Uuid) => string,
): LoadsVerdict {
	const plannedChosen = planned.filter((load) => !load.worker);
	const plannedWorker = planned.find((load) => load.worker);
	const lastTag = chosen[chosen.length - 1]?.tag ?? worker?.tag ?? "";
	if (plannedChosen.length !== chosen.length)
		return { kind: "chain", tag: lastTag };
	let tagOnly: string | undefined;
	for (let i = 0; i < chosen.length; i++) {
		const ours = plannedChosen[i] as PlannedLoad;
		const theirs = chosen[i] as StoredLoad;
		if (
			ours.caseType !== theirs.caseType ||
			ours.listModule === null ||
			menuIdOf(ours.listModule) !== theirs.detailsModule ||
			(ours.index === undefined) !== (theirs.index === undefined) ||
			(ours.index !== undefined &&
				ours.index.identifier !== theirs.index?.identifier)
		)
			return { kind: "chain", tag: theirs.tag };
		const sameIndexTag =
			ours.index === undefined ||
			ours.index.tag === theirs.index?.tag ||
			// An index names the load before it: a tag that differs there is that load's.
			plannedChosen[i - 1]?.tag !== chosen[i - 1]?.tag;
		if (!sameIndexTag) return { kind: "chain", tag: theirs.tag };
		if (ours.tag !== theirs.tag) {
			if (theirs.changes) return { kind: "chain", tag: theirs.tag };
			tagOnly ??= theirs.tag;
		}
	}
	if ((plannedWorker === undefined) !== (worker === undefined))
		return { kind: "chain", tag: worker?.tag ?? lastTag };
	if (
		plannedWorker !== undefined &&
		worker !== undefined &&
		plannedWorker.tag !== worker.tag
	)
		return { kind: "chain", tag: worker.tag };
	return tagOnly === undefined
		? { kind: "same" }
		: { kind: "tag", tag: tagOnly };
}

/** Compare each explicit load with the action emitted for this read, including
 * the resolved display menu when HQ omitted its id. Raw XPath is compared by
 * the expression reader under the actual entry ids; the remaining modes use
 * literal HQ source names here, including the Project table/column pair. */
function judgeExplicitLoads(
	source: unknown,
	emitted: unknown,
	menus: ReadonlyMap<string, DraftModule>,
	own: DraftModule,
): LoadsVerdict {
	const list = (value: unknown) => {
		const raw = object(value).load_update_cases;
		return Array.isArray(raw) ? raw.map(object) : [];
	};
	const original = list(source);
	const planned = list(emitted);
	const shape = (load: JsonObject) => {
		const auto = object(load.auto_select);
		const idx = object(load.case_index);
		return {
			tag: load.case_tag,
			type: load.case_type,
			menu: auto.mode ? null : sourceListMenu(menus, own, load)?.uuid,
			index: idx.tag
				? [
						idx.tag,
						chainIndexName(idx),
						idx.relationship ?? "child",
						idx.relationship === "question" ? idx.relationship_question : null,
					]
				: null,
			auto: !auto.mode
				? null
				: [
						auto.mode,
						auto.mode === "user" ||
						auto.mode === "fixture" ||
						auto.mode === "case"
							? auto.value_key
							: null,
						auto.mode === "fixture" || auto.mode === "case"
							? auto.value_source
							: null,
					],
		};
	};
	for (let i = 0; i < Math.max(original.length, planned.length); i++) {
		const old = original[i];
		const row = planned[i];
		if (!old || !row || !sameJson(shape(old), shape(row)))
			return {
				kind: "chain",
				tag: String(old?.case_tag ?? row?.case_tag ?? ""),
			};
	}
	return { kind: "same" };
}

type JsonObject = Readonly<Record<string, unknown>>;

function object(value: unknown): JsonObject {
	return isJsonObject(value) ? value : NO_ENTRIES;
}

/** A question path of `form`, mapped through each generated node to the
 *  question it belongs to; an owner node as `#owner:` and its path. */
function ownerPathOf(form: DraftForm, path: unknown): string | null {
	if (typeof path !== "string" || path === "") return null;
	const xform = form.xform;
	if (xform === null) return path;
	const relative = conditionQuestionPath(form, path) ?? path;
	const node = xform.nodes.get(relative);
	const role = node === undefined ? undefined : xform.roles.get(node);
	if (role?.kind === "generated")
		return role.purpose === "owner"
			? `#owner:${relative}`
			: role.owner.path.join("/");
	if (role?.kind === "generated-candidate")
		return role.purpose === "owner" ? `#owner:${relative}` : relative;
	return relative;
}

/** A planned question path; an owner node the plan names (each in
 *  `plannedOwnerPaths` by its path from the data root) as `#owner:` and
 *  that path, so which open action names which node is compared by name;
 *  a sibling Nova's print names in place of its question (`siblings`), as
 *  that question. */
function plannedPath(
	form: DraftForm,
	path: unknown,
	plannedOwnerPaths: ReadonlySet<string>,
	siblings: ReadonlyMap<string, string>,
): string | null {
	if (typeof path !== "string" || path === "") return null;
	const root = form.xform?.parsed.dataRoot.name ?? "data";
	const relative = path.startsWith(`/${root}/`)
		? path.slice(root.length + 2)
		: path;
	return plannedOwnerPaths.has(relative)
		? `#owner:${relative}`
		: (siblings.get(relative) ?? relative);
}

/** The purposes of a sibling an action names in place of its question. */
const ACTION_SIBLINGS: ReadonlySet<GeneratedNodePurpose> = new Set([
	"trimmed",
	"url",
	"datetime",
]);

/**
 * Each sibling Nova's print of the form's actions names in place of its
 * question (an open action's name's or external id's `nova_trimmed_`, a
 * capture's `nova_url_`, a date and time's `nova_datetime_`), by its path from
 * the data root, to that question's path, through Nova's own plan of the
 * form's generated nodes (`xform/generatedNodes.ts::planGeneratedNodes`).
 * Where CommCare HQ's Case Management names the question itself, the source
 * holds no such sibling, and the source's own siblings are read to their
 * questions by `ownerPathOf`; the plan never gives a sibling an authored
 * question's name, so no path that reads a question of the person's own moves.
 */
function plannedSiblings(
	doc: BlueprintDoc,
	form: DraftForm,
): ReadonlyMap<string, string> {
	const siblings = new Map<string, string>();
	const xform = form.xform;
	if (xform === null || xform === undefined) return siblings;
	const pathOf = new Map<string, readonly string[]>();
	const walk = (parent: DraftField | null) => {
		for (const field of xform.childrenOf(parent)) {
			if (field.uuid !== undefined) pathOf.set(field.uuid, field.node.path);
			walk(field);
		}
	};
	walk(null);
	for (const node of planGeneratedNodes(doc, form.uuid).nodes) {
		if (!ACTION_SIBLINGS.has(node.purpose)) continue;
		const owner = pathOf.get(node.owner);
		if (owner === undefined) continue;
		siblings.set([...owner.slice(0, -1), node.name].join("/"), owner.join("/"));
	}
	return siblings;
}

function conditionShape(
	stored: unknown,
	mapPath: (path: unknown) => string | null,
): unknown {
	const value = object(stored);
	const type = value.type ?? "never";
	if (type !== "if") return type;
	const operator = value.operator ?? "=";
	return {
		question: mapPath(value.question),
		// HQ's build reads no answer beside `boolean_true` (`noteBooleanAnswer`).
		answer: operator === "boolean_true" ? null : (value.answer ?? null),
		operator,
	};
}

/**
 * A condition's answer stored beside `boolean_true`, which HQ's build never reads
 * (`xform.py::XForm.action_relevance` writes the question's path alone) and Nova writes none of:
 * the first publish respells it, recorded at the condition's `answer` under `entry`, as a basic
 * form's is (`basicActions.ts::noteConditionQuestion`).
 */
function noteBooleanAnswer(
	ctx: ReadContext,
	stored: unknown,
	entry: string,
	pointer: string,
): void {
	if (
		isJsonObject(stored) &&
		stored.type === "if" &&
		stored.operator === "boolean_true" &&
		stored.answer !== null &&
		stored.answer !== undefined
	)
		ctx.facts.sameStateRewrites.push({
			entry,
			path: `${pointer}/answer`,
			register: "case-settings-respelled",
		});
}

function propertiesShape(
	stored: unknown,
	mapPath: (path: unknown) => string | null,
	applied: boolean,
): unknown {
	return Object.entries(object(stored))
		.map(([key, update]) => {
			const one = object(update);
			return [
				key,
				mapPath(one.question_path),
				one.update_mode === "edit" && applied ? "edit" : "always",
			];
		})
		.sort(([a], [b]) =>
			String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
		);
}

/** An advanced form's actions as the comparison reads them: the loads'
 *  tags and lists left to the chain test, preloads read as defaults, each
 *  `name_update`'s mode left out, and every question path mapped to its
 *  question. */
function comparableActions(
	actions: unknown,
	mapPath: (path: unknown) => string | null,
	applied: boolean,
): unknown {
	const stored = object(actions);
	const loads = Array.isArray(stored.load_update_cases)
		? stored.load_update_cases
		: [];
	const opens = Array.isArray(stored.open_cases) ? stored.open_cases : [];
	return {
		loads: loads.map((one) => {
			const load = object(one);
			return {
				case_properties: propertiesShape(
					load.case_properties,
					mapPath,
					applied,
				),
				close_condition: conditionShape(load.close_condition, mapPath),
				auto_select: isJsonObject(load.auto_select)
					? object(load.auto_select).mode
					: null,
			};
		}),
		opens: opens.map((one) => {
			const open = object(one);
			const indices = Array.isArray(open.case_indices) ? open.case_indices : [];
			return {
				case_type: open.case_type,
				case_tag: open.case_tag,
				name: mapPath(object(open.name_update).question_path),
				case_properties: propertiesShape(
					open.case_properties,
					mapPath,
					applied,
				),
				repeat_context: mapPath(open.repeat_context),
				case_indices: indices.map((index) => {
					const value = object(index);
					return {
						tag: value.tag,
						reference_id: value.reference_id || "parent",
						relationship: value.relationship ?? "child",
					};
				}),
				open_condition: conditionShape(open.open_condition, mapPath),
				close_condition: conditionShape(open.close_condition, mapPath),
			};
		}),
	};
}

/**
 * Accepts one advanced form over the bound document: its conditions stated
 * back, its loads Nova's (`judgeLoads`), its actions the stored ones, every
 * placement held where it was read, and the owner nodes the plan names the
 * ones the form reader folded.
 */
export function settleAdvancedForm(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined || doc.forms[form.uuid] === undefined) return;
	const operationConditions = reading.operations.map((one) => one.condition);
	// A create whose condition is refused is refused whole: the scalar check its name and external
	// id questions carry stands under that finding, as a refused basic child's does.
	const refuseCreatesOf = (condition: ProposedCondition) => {
		for (const one of reading.operations) {
			const governed =
				one.condition === condition ||
				(one.action === "own" && condition === reading.openCondition);
			if (!governed) continue;
			if (one.name !== undefined)
				reading.refusedScalarFields.push(one.name.field);
			for (const write of one.writes)
				if (write.property === "external_id")
					reading.refusedScalarFields.push(write.value.field);
		}
	};
	for (const proposal of [
		...operationConditions,
		reading.openCondition,
		reading.closeCondition,
	]) {
		if (proposal === undefined) continue;
		const scope = { own: false, repeat: proposal.repeat?.uuid };
		const read = readActionCondition(proposal.stored, scope, form);
		if (read.kind !== "if") continue;
		const stated = statedBack(doc, form.uuid, read.expression, scope);
		if (stated.reasons.length > 0) {
			const claim = conditionFinding(stated.reasons, false);
			if (claim !== undefined)
				ctx.accounting.findingAt(claim, proposal.place, proposal.pointer);
			else
				ctx.accounting.circumstance("unrecognized", form.place, {
					name: "schema:FormActionCondition.question",
				});
			refuseCreatesOf(proposal);
			return;
		}
	}
	const inputs = readProjectionInputs(ctx);
	let planned: ReturnType<typeof planFormCaseWire>;
	try {
		planned = planFormCaseWire(doc, form.uuid, {
			identity: inputs.identity,
			attachmentTarget: inputs.attachmentTarget,
		});
	} catch (error) {
		rethrowWorkStop(error);
		// The planner throws only over a draft the reader built wrong: the reader's own defect,
		// behind the finding at the form's actions.
		ctx.accounting.defect(
			form.place,
			`schema:${form.docType}.actions`,
			readerDefect.emissionThrew(form.place, "planFormCaseWire"),
		);
		return;
	}
	if (planned.kind !== "advanced") {
		// A menu whose kind Nova cannot hold already stands as its one finding
		// at the menu; a basic plan for any other cause is a reading Nova
		// would write another way.
		const menu = ctx.draft.modules.find((one) => one.forms.includes(form));
		if (menu === undefined || !ctx.accounting.hasFindingAt(menu.place))
			ctx.accounting.circumstance("unrecognized", form.place, {
				name: "schema:Form.actions",
			});
		return;
	}
	// A form whose loads the refusal at its menu's case list covers has its finding there.
	const ownMenu = ctx.draft.modules.find((one) => one.forms.includes(form));
	const underListFormRules =
		ownMenu !== undefined && listFormRulesPlace(ctx, ownMenu) !== undefined;
	if (ownMenu) {
		const problems = physicalEntrySupplyProblems(
			doc,
			formLinkProjectionContext(doc, { entryMetadataOnly: true }),
			ownMenu.uuid,
			form.uuid,
		);
		for (const issue of problems) {
			const before = ctx.accounting.findingCount();
			ctx.accounting.finding(
				issue.kind === "duplicate-key"
					? ADVANCED_CLAIMS.duplicateEntryKey
					: ADVANCED_CLAIMS.alignedConnection,
				form.place,
				{ name: issue.name },
			);
			const raised = ctx.accounting.findingRaised(before);
			// Two opening values sharing one session name refuse the form's
			// opening values whole: its loads, their tags and its calculations.
			const sites = OPENING_SITES.get(form);
			if (issue.kind === "duplicate-key" && raised && sites) {
				ctx.accounting.cover(
					{ json: sites.actions, key: "load_update_cases" },
					raised,
				);
				for (const load of sites.loads)
					ctx.accounting.cover({ json: load, key: "case_tag" }, raised);
				if (form.json.peek("arbitrary_datums") !== undefined)
					ctx.accounting.cover(
						{ json: form.json, key: "arbitrary_datums" },
						raised,
					);
			}
		}
		if (problems.length) return;
	}

	const emittedActions = advancedActionsWithEntry(
		planned.actions,
		ownMenu
			? entrySessionDatums(
					doc,
					formLinkProjectionContext(doc, { lookupNaming: inputs.lookupNaming }),
					ownMenu.uuid,
					form.uuid,
				)
			: [],
	);
	const verdict =
		doc.forms[form.uuid]?.caseSelections !== undefined && ownMenu
			? judgeExplicitLoads(
					form.json.peek("actions"),
					emittedActions,
					menusById(ctx),
					ownMenu,
				)
			: judgeLoads(planned.loads, reading.chosen, reading.worker, (uuid) =>
					inputs.identity.moduleUniqueId(uuid),
				);
	if (verdict.kind !== "same") {
		if (!ctx.accounting.hasFindingAt(form.place) && !underListFormRules)
			ctx.accounting.circumstance("unrecognized", form.place, {
				name: "schema:AdvancedFormActions.load_update_cases",
			});
		return;
	}
	const applied = ctx.input.saveOnlyEditedApplied === true;
	const plannedOwnerPaths = new Set(
		planned.generated.map((node) =>
			// `/<root>/...`: the path from the data root.
			node.scope.child(node.name).toXPath().split("/").slice(2).join("/"),
		),
	);
	// One map of Nova's siblings for both sides, as the stored actions name a
	// sibling the form reader has not yet settled as generated by its own name.
	const siblings = plannedSiblings(doc, form);
	if (
		!sameJson(
			comparableActions(
				form.json.peek("actions"),
				(path) => {
					const read = ownerPathOf(form, path);
					return read === null ? null : (siblings.get(read) ?? read);
				},
				applied,
			),
			comparableActions(
				emittedActions,
				(path) => plannedPath(form, path, plannedOwnerPaths, siblings),
				true,
			),
		)
	) {
		// What the first pass refused is missing from the reading, so the actions differ by it;
		// its finding at the form already says so, and the difference is no second cause. So
		// does the finding of loads whose entry differs from the one Nova's emission gives
		// (`index.ts::compareEntryFacts`), which the stored actions carry.
		if (
			!(
				(reading.refused === true ||
					ctx.facts.entryFactsRefused.includes(form.uuid)) &&
				(ctx.accounting.hasFindingAt(form.place) || underListFormRules)
			)
		)
			ctx.accounting.circumstance("unrecognized", form.place, {
				name: "schema:AdvancedForm.actions",
			});
		return;
	}
	const plan = planPlacements(doc, form.uuid);
	const operations = doc.forms[form.uuid]?.caseOperations ?? [];
	// A close with no placement shares the place of the action it was read
	// from: the create it closes, or its load's update.
	const sharedWith = (uuid: Uuid): Uuid | undefined =>
		reading.operations.find((one) => one.uuid === uuid)?.shares;
	const held =
		plan.inexpressible.length === 0 &&
		operations.every((operation) => {
			const placed = plan.placements.get(operation.uuid);
			if (operation.placement !== undefined) return placed?.held === true;
			const shares = sharedWith(operation.uuid);
			return shares !== undefined && placed?.sharesWith === shares;
		});
	// The own close, where the form closes its own case, shares the own arm's place.
	const own = operations.find((operation) => operation.action === "own");
	const formDoc = doc.forms[form.uuid];
	const closesOwn =
		formDoc?.type === "close" ||
		(formDoc?.type === "registration" && formDoc.closeCondition !== undefined);
	const ownCloseHeld =
		!closesOwn ||
		own === undefined ||
		formDoc?.ownClosePlacement !== undefined ||
		plan.placements.get("own-close")?.sharesWith === own.uuid;
	// The owner nodes the plan names are the ones the form reader folded, one to one by the
	// operation each serves.
	const folded = (form.xform?.generated ?? [])
		.filter((node) => node.purpose === "owner")
		.map((node) => node.owner.slice(node.owner.lastIndexOf("#") + 1))
		.sort();
	const plannedOwners = planned.generated
		.map(
			(node) =>
				operations.find((operation) => operation.uuid === node.operationUuid)
					?.id ?? "",
		)
		.sort();
	if (!held || !ownCloseHeld || !sameJson(folded, plannedOwners))
		ctx.accounting.circumstance("unrecognized", form.place, {
			name: "schema:AdvancedForm.actions",
		});
}

/** One `parent` index an open action's reading took, to the type it reaches. */
interface ParentIndexRead {
	readonly cursor: JsonCursor;
	readonly place: DraftForm["place"];
	readonly childType: string;
	readonly parentType: string;
	readonly relationship: "child" | "extension";
}

const PARENT_INDICES_READ = new WeakMap<ReadContext, ParentIndexRead[]>();

function parentIndicesRead(ctx: ReadContext): ParentIndexRead[] {
	let read = PARENT_INDICES_READ.get(ctx);
	if (read === undefined) {
		read = [];
		PARENT_INDICES_READ.set(ctx, read);
	}
	return read;
}

/**
 * Over the final document: each `parent` index an open action's reading took
 * that reaches another case type than a parent selection of a menu of the
 * open action's type chooses through, or reaches it as an extension, is
 * claimed under its own entry beside the ordinary index's. Nova holds the
 * index as the create's link and the selection as the menu's
 * (`Module.parentCaseModuleUuid`): neither follows the catalog
 * (`caseParentSelection.ts::caseParentSelectionVerdict`), and HQ's build
 * writes each as it stands, the index from the open action's
 * `case_indices` and the selection's filter from the load's own index
 * (`entries.py::get_parent_filter_by_ref_id`). The catalog then gives the
 * type no single parent (`catalog.ts::noteParents`), which only authoring
 * reads.
 */
export function claimParentIndicesAgainstSelections(
	ctx: ReadContext,
	doc: BlueprintDoc,
): void {
	const read = PARENT_INDICES_READ.get(ctx) ?? [];
	if (read.length === 0) return;
	const selectedParents = new Map<string, Set<string>>();
	for (const module of Object.values(doc.modules)) {
		const parentUuid = module.parentCaseModuleUuid;
		const parentType =
			parentUuid === undefined ? undefined : doc.modules[parentUuid]?.caseType;
		if (module.caseType === undefined || parentType === undefined) continue;
		const types = selectedParents.get(module.caseType) ?? new Set<string>();
		types.add(parentType);
		selectedParents.set(module.caseType, types);
	}
	for (const index of read) {
		const selected = selectedParents.get(index.childType);
		if (selected === undefined) continue;
		const against =
			index.relationship !== "child" ||
			[...selected].some((type) => type !== index.parentType);
		if (!against) continue;
		ctx.accounting.claimEntryClass(
			{ json: index.cursor, key: "tag" },
			ADVANCED_CLAIMS.openIndexAgainstSelection.entry,
			"schema:CaseIndex.tag",
			index.place,
		);
	}
}

/** A menu read with a held kind that Nova would write basic: one finding at the menu. */
export function settleAdvancedMenu(
	ctx: ReadContext,
	doc: BlueprintDoc,
	module: DraftModule,
): void {
	if (
		module.docType !== "AdvancedModule" ||
		doc.modules[module.uuid] === undefined
	)
		return;
	if (advancedKindBlockers(doc, module.uuid).length > 0)
		ctx.accounting.finding(ADVANCED_CLAIMS.kindBlocked, module.place);
}

function readExplicitAutoSource(
	ctx: ReadContext,
	form: DraftForm,
	L: JsonCursor,
	load: Record<string, unknown>,
	choice: FormCaseSelection,
) {
	if (isJsonObject(load.auto_select)) {
		const mode = load.auto_select.mode;
		const claim =
			mode === "usercase"
				? ADVANCED_CLAIMS.usercase
				: mode === "raw"
					? ADVANCED_CLAIMS.heldRaw
					: mode === "user"
						? ADVANCED_CLAIMS.heldUser
						: mode === "fixture"
							? ADVANCED_CLAIMS.heldFixture
							: ADVANCED_CLAIMS.heldCase;
		if (mode === "raw") {
			const auto = L.object("auto_select", "AutoSelectCase", claim);
			consume(auto.take("mode", ADVANCED_CLAIMS.heldRawMode, (v) => v));
			if (auto.used("value_source") && load.auto_select.value_source === "")
				consume(
					auto.take(
						"value_source",
						ADVANCED_CLAIMS.heldRawUnusedSource,
						(value) => value,
					),
				);
			if (typeof load.auto_select.value_key === "string")
				ctx.pending.register(
					{
						ref: {
							entity: "form",
							uuid: form.uuid,
							slot: "form_selection_source",
							member: { supplyUuid: choice.uuid },
						},
						text: load.auto_select.value_key,
						mode: { target: "hq-json", interpolation: "none" },
						place: form.place,
						key: "schema:AutoSelectCase.value_key",
					},
					{ json: auto, key: "value_key" },
				);
		} else consume(L.take("auto_select", claim, (value) => value));
	}
}

const SHARED = defineClaims("caseManagement.sharedEntry", {
	extras: take(
		`${F}/extra-actions-load-update-cases-repeating-a-parent-tag-overrides`,
		"schema:ShadowForm.extra_actions",
	),
	loads: take(
		`${F}/extra-actions-load-update-cases-repeating-a-parent-tag-overrides`,
		"schema:AdvancedFormActions.load_update_cases",
	),
	replacement: take(
		`${F}/extra-actions-load-update-cases-repeating-a-parent-tag-overrides`,
		"schema:LoadUpdateAction.case_tag",
	),
	extra: take(
		`${F}/extra-actions-load-update-cases-with-a-tag-absent-from-the`,
		"schema:LoadUpdateAction.case_tag",
	),
	opens: drop(
		`${F}/extra-actions-open-cases-non-empty`,
		"schema:AdvancedFormActions.open_cases",
	),
	writes: drop(
		`${F}/a-shadow-s-own-extra-actions-load-update-cases-case-properties`,
		"schema:LoadUpdateAction.case_properties",
	),
	preload: drop(
		`${F}/a-shadow-s-own-extra-actions-load-update-cases-case-properties`,
		"schema:LoadUpdateAction.preload",
	),
	close: drop(
		`${F}/a-shadow-s-own-extra-actions-load-update-cases-case-properties`,
		"schema:LoadUpdateAction.close_condition",
	),
	stock: refuse(
		`${F}/extra-actions-load-update-cases-show-product-stock-true-or-a-non`,
		"schema:LoadUpdateAction.show_product_stock",
	),
	program: refuse(
		`${F}/extra-actions-load-update-cases-show-product-stock-true-or-a-non`,
		"schema:LoadUpdateAction.product_program",
	),
	scheduleOff: drop(
		`${F}/advancedform-schedule-with-enabled-false`,
		"schema:ShadowForm.schedule",
	),
	scheduleOn: refuse(
		`${F}/advancedform-schedule-with-enabled-true-visits-transition`,
		"schema:ShadowForm.schedule",
	),
	datums: take(
		`${F}/arbitrary-datums-datum-id-datum-function`,
		"schema:ShadowForm.arbitrary_datums",
	),
	missingSupply: refuse(
		`${F}/a-parent-load-tag-not-repeated-in-extra-actions-where-the-parent`,
		"schema:ShadowForm.extra_actions",
	),
});

/** The parent can occur later. Its reads, placements and implicit choices
 * are available only once case management has visited every ordinary form. */
export function readSharedEntries(ctx: ReadContext) {
	const doc = provisionalDocument(ctx);
	const menus = menusById(ctx);
	const drafts = new Map(
		ctx.draft.modules.flatMap((module) =>
			module.forms.map((form) => [form.uuid, form] as const),
		),
	);
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const shared = form.form.shadowOf;
			if (!shared) continue;
			const parent = doc.forms[shared.form];
			const content = drafts.get(shared.form);
			if (!parent || !content) continue;
			const schedule = form.json.peek("schedule");
			if (isJsonObject(schedule)) {
				if (schedule.enabled === true)
					form.json.refuse("schedule", SHARED.scheduleOn);
				else form.json.drop("schedule", SHARED.scheduleOff);
			}
			readEntryValues(ctx, form);
			const inherited = new Map(
				formCaseSelections(doc, parent.uuid).map((row) => [row.tag, row]),
			);
			const raw = object(form.json.peek("extra_actions"));
			const extra = form.json.object(
				"extra_actions",
				"AdvancedFormActions",
				SHARED.extras,
			);
			extra.drop("open_cases", SHARED.opens);
			const loads = objectMembers(raw.load_update_cases) ?? [];
			const cursors = extra.list(
				"load_update_cases",
				"LoadUpdateAction",
				SHARED.loads,
			);
			const parsed = explicitFormChoices(
				ctx,
				form,
				module,
				menus,
				loads,
				false,
				objectMembers(object(content.json.peek("actions")).open_cases) ?? [],
				{ rows: inherited, content },
			);
			const choices = parsed?.choices;
			cursors.forEach((cursor, index) => {
				const row = loads[index];
				if (!row) return;
				const unread = parsed?.unread.get(index);
				if (unread) {
					cursor.refuseWhole(unread.issue, { name: unread.name });
					return;
				}
				const tag = typeof row.case_tag === "string" ? row.case_tag : "";
				const invalid = tagFinding(tag, false);
				if (invalid) cursor.refuse("case_tag", invalid);
				else
					consume(
						cursor.take(
							"case_tag",
							inherited.has(tag) ? SHARED.replacement : SHARED.extra,
							(value) => value,
						),
					);
				for (const [key, claim] of [
					["case_properties", SHARED.writes],
					["preload", SHARED.preload],
					["close_condition", SHARED.close],
				] as const)
					cursor.drop(key, claim);
				if (row.show_product_stock === true)
					cursor.refuse("show_product_stock", SHARED.stock);
				else if (cursor.used("show_product_stock"))
					cursor.drop("show_product_stock", ADVANCED_CLAIMS.productStockOff);
				if (
					typeof row.product_program === "string" &&
					row.product_program !== ""
				)
					cursor.refuse("product_program", SHARED.program);
				else if (cursor.used("product_program"))
					cursor.drop("product_program", ADVANCED_CLAIMS.productProgramOff);
				if (row.load_case_from_fixture)
					cursor.refuse("load_case_from_fixture", ADVANCED_CLAIMS.fromFixture);
				const choice = choices?.get(index);
				if (!choice) return;
				consume(
					cursor.take("case_type", ADVANCED_CLAIMS.caseType, (value) => value),
				);
				consume(
					cursor.take(
						"details_module",
						ADVANCED_CLAIMS.detailsModule,
						(value) => value,
					),
				);
				consume(
					cursor.take(
						"case_index",
						ADVANCED_CLAIMS.caseIndex,
						(value) => value,
					),
				);
				readExplicitAutoSource(ctx, form, cursor, row, choice);
			});
			for (const choice of choices?.values() ?? []) {
				const question = parsed?.questions.get(choice.uuid)?.uuid;
				if (question && choice.source.kind === "choose" && choice.source.under)
					choice.source.under.relationship = { question };
			}
			ctx.writeDraft(() => {
				form.form.type = parent.type;
				// Each tag CommCare HQ keeps for this entry is held, as an ordinary
				// advanced form's are, so a later edit that would rename one shows.
				const held = [...(choices?.values() ?? [])].map(
					(row) => [row.uuid, row.tag] as [Uuid, string],
				);
				if (held.length) form.form.heldSelectionTags = recordFromEntries(held);
				form.form.shadowOf = {
					form: parent.uuid,
					selections: [...(choices?.values() ?? [])].map((row) =>
						inherited.has(row.tag)
							? {
									kind: "replace",
									selection: row.uuid,
									caseType: row.caseType,
									source: row.source,
								}
							: { kind: "add", ...row },
					),
				};
			});
		}
}

/** A shadow's own actions are not rendered. Judge the parent's bound reads
 * against the datums that this particular command supplies. */
export function settleSharedEntry(
	ctx: ReadContext,
	doc: BlueprintDoc,
	menu: Uuid,
	form: DraftForm,
): void {
	const entry = doc.forms[form.uuid];
	if (!entry?.shadowOf) return;
	const context = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const missing = sharedFormDependencies(doc, entry, menu, context);
	if (missing.length)
		ctx.accounting.findingAt(
			SHARED.missingSupply,
			form.place,
			`${form.json.pointer}/extra_actions`,
			undefined,
			{ atDefault: !form.json.used("extra_actions") },
		);
}
