"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import {
	type MouseEvent as ReactMouseEvent,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { FormTypeButton } from "@/components/builder/detail/FormDetail";
import { FormSettingsButton } from "@/components/builder/detail/formSettings/FormSettingsButton";
import { EditableTitle } from "@/components/builder/EditableTitle";
import {
	useBuilderLanguage,
	useLocalizedField,
	useLocalizedText,
	useTranslationUnitEditor,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { ChoiceAnswerCheck } from "@/components/preview/shared/ChoiceAnswerCheck";
import {
	PinnedCaseTile,
	usePinnedCaseTile,
} from "@/components/preview/shared/PinnedCaseTile";
import { PreviewDataRefusalPanel } from "@/components/preview/shared/PreviewDataRefusal";
import { reportClientError } from "@/lib/clientErrorReporter";
import { useReconcilerContext } from "@/lib/collab/context";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import {
	useForm as useFormEntity,
	useModule as useModuleEntity,
} from "@/lib/doc/hooks/useEntity";
import { useEffectivePostSubmit } from "@/lib/doc/hooks/useFormLinkFacts";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { Uuid } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseType,
	caseSelectionCardinality,
	effectivePostSubmit,
	type FormLink,
	type FormType,
	makeTranslationUnitId,
	materializableCaseTypes as materializableCaseTypesFromDoc,
	moduleFormsReadSearch,
	POST_SUBMIT_DESTINATIONS,
	type PostSubmitDestination,
	reachableCaseTypes,
} from "@/lib/domain";
import { unhandledKindMessage } from "@/lib/domain/expression/errors";
import type { LanguageTag } from "@/lib/domain/localization";
import {
	afterSubmitFrameLanding,
	afterSubmitRoute,
	afterSubmitTargetVisibility,
	appHomeLanding,
	automaticLinkedCaseCollection,
	carriedCasesFromPatch,
	type PreviewAfterSubmitFrame,
	previewMenuSelectionsAfterTargetCases,
	previewTargetHasSelectedCase,
	settleAfterSubmitRoute,
} from "@/lib/preview/afterSubmitRouting";
import {
	afterSubmitPath,
	completeAfterSubmit,
	completeAfterSubmitWithOwnFrame,
	EMPTY_AFTER_SUBMIT_STACK,
	type PendingAfterSubmitFrame,
} from "@/lib/preview/afterSubmitStack";
import {
	caseListActionCreatedDatum,
	caseListActionReturn,
	caseListRegistrationAdmission,
	caseListRegistrationRefusalCopy,
	formOpensSearchScreen,
	readFormSearchAnswers,
	registeredCaseOnDevice,
	selectionsAfterRegistrationReturn,
} from "@/lib/preview/caseListRegistration";
import { parentCaseConstraint } from "@/lib/preview/caseSelectionNavigation";
import type { SetvalueRefusalDetails } from "@/lib/preview/engine/answerCast";
import { submitFormAction } from "@/lib/preview/engine/caseDataBinding";
import {
	blueprintRevisionDigest,
	caseDatabaseToFormPreloads,
	caseRowsToFormPreloads,
	pickBlueprintDoc,
	viewerTimeZone,
} from "@/lib/preview/engine/caseDataBindingClient";
import type { SubmissionResult } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	overlayCaseDatabasePatch,
	submissionWorkerValues,
} from "@/lib/preview/engine/caseDatabasePatch";
import { previewDataRefusalOf } from "@/lib/preview/engine/dataRefusal";
import type { EngineValidationCompletion } from "@/lib/preview/engine/engineController";
import {
	afterSubmitSessionDatums,
	type EntrySessionData,
} from "@/lib/preview/engine/entrySessionData";
import type { InvalidFieldTarget } from "@/lib/preview/engine/formEngine";
import {
	type CarriedSubmission,
	carriedCaseFromSelections,
	createFormLinkWorkerWorld,
	evaluateAfterSubmitAsync,
	frameChoiceEntry,
	type PostSubmissionCaseData,
	projectTargetCaseSelectionsAsync,
	submittedEntryPath,
} from "@/lib/preview/engine/formLinkEvaluation";
import {
	firstMenuSelections,
	linkedFirstMenuCases,
	moduleFirstMenuCases,
} from "@/lib/preview/engine/frameLanding";
import {
	previewSessionValues,
	type ResolvedPreviewIdentity,
} from "@/lib/preview/engine/identity";
import { withNavigationWidth } from "@/lib/preview/engine/previewDevice";
import {
	resolvePreviousTask,
	selectionsForModuleTask,
	selectionsForStaticModuleTask,
} from "@/lib/preview/engine/previousTask";
import { moduleSearchReadsCaseDatabase } from "@/lib/preview/engine/searchCsqlRuntime";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import {
	type PreviewLookupStatus,
	usePreviewLookupReload,
	usePreviewLookupStatus,
} from "@/lib/preview/engine/useLookupPreviewData";
import {
	useDeviceCaseDatabaseLoad,
	useNavigationDeviceCases,
} from "@/lib/preview/engine/useNavigationDeviceCases";
import {
	type CaseDatabaseSnapshot,
	formReadsSearchResults,
} from "@/lib/preview/engine/xpathInstances";
import {
	invalidateCaseData,
	useCaseDataReplacementRevision,
} from "@/lib/preview/hooks/caseDataInvalidation";
import { showFrameFirstMenu } from "@/lib/preview/hooks/showFrameFirstMenu";
import { useCaseData, useCases } from "@/lib/preview/hooks/useCaseDataBinding";
import { useEngineEntry } from "@/lib/preview/hooks/useEngineEntry";
import { useFormEngine } from "@/lib/preview/hooks/useFormEngine";
import {
	usePresentationFormIsSectioned,
	usePresentationHasFields,
} from "@/lib/preview/hooks/usePresentationDocument";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import {
	usePreviewStandingSearchState,
	useSetPreviewStandingSearchState,
} from "@/lib/preview/hooks/usePreviewStandingSearch";
import { useRestoreScopeKey } from "@/lib/preview/hooks/useRestoreScopeKey";
import {
	searchWorld,
	useCaseListStepSession,
} from "@/lib/preview/hooks/useSearchCsqlRuntime";
import { useSearchResultsSnapshot } from "@/lib/preview/hooks/useSearchResultsSnapshot";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import {
	previewCaseFirstModuleUuids,
	previewCaseListReturn,
	previewMenuCaseContext,
	previewSelectionsBefore,
} from "@/lib/preview/menuProjection";
import { refusalCopy, runtimeMessage } from "@/lib/preview/runtimeMessages";
import {
	type PreviewSubmitOffer,
	type PreviewSubmitState,
	previewSubmitAccess,
	previewSubmitOffer,
} from "@/lib/preview/submitOffer";
import { formChangesSessionCase } from "@/lib/preview/unheldCaseSubmit";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { endPreviewStandingSearches } from "@/lib/routing/useClientPath";
import {
	useAccessPhase,
	useAppId,
	useBuilderIsReady,
	useCanEdit,
	useEditMode,
	usePreviewCaseListRegistrationEntry,
	usePreviewCaseTarget,
	usePreviewDevice,
	usePreviewEntryPointLaunch,
	usePreviewMenuCaseSelections,
	usePreviewPersonaUuid,
	usePreviewPlatformRules,
	useProjectId,
	useProjectScopeEpoch,
	useSetPreviewAtDeviceHome,
	useSetPreviewCaseTarget,
	useSetPreviewing,
	useSetPreviewMenuCaseSelection,
	useSetPreviewSelectedCase,
} from "@/lib/session/hooks";
import { recordRegisteredCase } from "@/lib/session/previewSearchState";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type {
	PreviewCaseChoice,
	PreviewCaseListRegistrationEntry,
} from "@/lib/session/types";
import { onNewFocusIntent } from "@/lib/ui/hooks/useDeferredFocus";
import { showToast } from "@/lib/ui/toastStore";
import {
	type FormLayoutHandle,
	FormLayoutProvider,
} from "../form/FormLayoutContext";
import { FormRenderer } from "../form/FormRenderer";
import { AttachmentInvariantRecoveryPanel } from "../form/fields/attachment/AttachmentInvariantRecoveryPanel";
import {
	AttachmentNotReadyError,
	hasAttachmentEntryWriteAuthority,
	reconcileAttachmentAuthoredPathMigration,
	reconcileAttachmentRepeatCompaction,
	retireAttachmentEntry,
	runFormAttachmentBarrier,
	setAttachmentEntryAuthority,
} from "../form/fields/attachment/attachmentClient";
import { RepeatAddPrompt } from "../form/RepeatAddPrompt";
import { ScreenPage } from "../form/sections/ScreenPage";
import { SectionPage } from "../form/sections/SectionPage";
import { SectionStepper } from "../form/sections/SectionPagerControls";
import { useFormPaging } from "../form/sections/useFormPaging";
import { useScrolledSection } from "../form/sections/useScrolledSection";
import {
	FORM_PRIMARY_ACTION_CLS,
	FORM_QUIET_ACTION_CLS,
} from "./formActionButtonStyles";
import { openModuleLanding } from "./moduleLanding";

/**
 * Failure arms of `SubmissionResult`: the complement of the success
 * set. Pulling the union as a type so `describeSubmitError`'s switch
 * stays exhaustive against any future arm added to the result type.
 * Success arms mirror `SubmissionMutation`'s `FormType` discriminator
 * (one per `FormType`); the handler short-circuits on those and routes
 * everything else through this failure shape. Keying the `Exclude` off
 * `FormType` itself (rather than the four literals inline) keeps the
 * partition aligned with the source-of-truth `FormType` union, a new
 * form type landing in `FORM_TYPES` re-narrows this type automatically.
 */
type SubmissionFailure = Exclude<SubmissionResult, { kind: FormType }>;
/** The success arms: the submission landed and the app moves on. */
type SubmissionSuccess = Extract<SubmissionResult, { kind: FormType }>;

/**
 * The line under the submit row that says why Submit is not offered. A form
 * still opening says so in its own getting-ready state, and a fault replaces
 * the screen, so neither has a line. Worker-facing waits speak the worker's
 * language; the case-data failure and the member's access are Nova's own
 * diagnostics and stay in English.
 */
function submitOfferLine(
	offer: PreviewSubmitOffer,
	language: LanguageTag,
): string | undefined {
	switch (offer.kind) {
		case "offered":
		case "fault":
			return undefined;
		case "busy":
			return runtimeMessage(
				language,
				offer.reason === "submitting" ? "answersLocked" : "freshFormStarting",
			);
		case "waiting":
			switch (offer.reason) {
				case "form-initializing":
					return undefined;
				case "case-data-refreshing":
					return runtimeMessage(language, "caseDataRefreshing");
				case "record-loading":
					return runtimeMessage(language, "selectedRecordLoading");
				case "form-rebuilding":
					return runtimeMessage(language, "formPreparing");
				case "repeat-updating":
					return runtimeMessage(language, "repeatUpdating");
				case "access-checking":
					return "Checking your access to this app. Your answers are still here.";
			}
			break;
		case "unavailable":
			return offer.reason === "case-data-failed"
				? "Case data could not refresh. Your answers are still here. Return to Edit to try Preview again."
				: "Submitting saves case data, which needs edit access to this app.";
	}
	return undefined;
}

/**
 * Shape a `SubmissionResult` failure arm into the inline error string
 * rendered below the submit row. Mirrors `CaseListScreen`'s
 * `describePopulateError` shape: typed errors get readable text that
 * names the affected entity so the user can amend without parsing the
 * case-store's vocabulary. `case-properties-validation` renders the
 * per-field failure list one line per failure.
 */
function describeSubmitError(result: SubmissionFailure): string {
	switch (result.kind) {
		case "unauthenticated":
			return "Sign in to submit this form.";
		case "persona-unavailable":
		case "platform-unavailable":
		case "language-unavailable":
			return result.message;
		case "blueprint-changed":
			return result.message;
		case "case-not-found":
			return "The case you were editing no longer exists. Refresh and try again.";
		case "case-properties-validation": {
			/* AJV's `path` is the JSONB pointer (`/age`, or `""` for the
			 * document root); strip the leading slash for readability and
			 * substitute `<root>` for the empty path: same shape
			 * `describePopulateError` uses so the two surfaces stay
			 * visually consistent. The header names `result.caseType` so
			 * registration forms with multi-case fan-out tell the user
			 * WHICH case type rejected (a child case's properties failing
			 * is otherwise indistinguishable from the primary's). */
			const lines = result.failures.map((f) => {
				const field = f.path === "" ? "<root>" : f.path.replace(/^\//, "");
				return `${field}: ${f.message}`;
			});
			return `Some fields on case type '${result.caseType}' didn't match its schema:\n${lines.join("\n")}`;
		}
		case "missing-case-type":
			return `Case type '${result.caseType}' is no longer in the blueprint. Refresh the page and try again.`;
		case "schema-not-synced":
			return `Case type '${result.caseType}' isn't ready yet. Try again in a moment.`;
		case "submission-rejected":
			return describeSubmissionRejection(result.rejection);
		case "error":
			return result.message;
	}
}

/**
 * Person-readable copy for the atomic envelope's typed rejections:
 * the whole submission rolled back, matching the device's transaction
 * failure. Each sentence says what went wrong and what to look at; the
 * operation uuid stays out of the prose (it names nothing a worker
 * recognizes; authors find the operation through the form's automation
 * settings).
 */
function describeSubmissionRejection(
	rejection: Extract<
		SubmissionFailure,
		{ kind: "submission-rejected" }
	>["rejection"],
): string {
	switch (rejection.kind) {
		case "expression":
			return `Nothing was saved: a calculation in ${rejection.operationId} could not run. An app editor can review ${rejection.slot} and its source answers.`;
		case "selection": {
			switch (rejection.reason) {
				case "empty":
					return "Nothing was saved: choose at least one case before submitting this form.";
				case "too-many":
					return `Nothing was saved: this form can work with at most ${rejection.maximum ?? "the configured number of"} cases. Return to Results and remove some cases.`;
				case "duplicate":
					return "Nothing was saved: the same case was selected more than once. Return to Results and choose each case once.";
				case "not-found-or-out-of-scope":
					return "Nothing was saved: one of the selected cases is no longer available. Return to Results and review the selection.";
				case "case-type-mismatch":
					return "Nothing was saved: one of the selected cases no longer belongs to this case list. Return to Results and choose the cases again.";
				case "program-selection-mismatch":
				case "authored-key-create-not-supported":
				case "session-link-not-supported":
					return "Nothing was saved: this form has a case action that cannot run over several selected cases. Ask an app editor to review the form's case actions.";
			}
			return "Nothing was saved because the selected cases no longer match this form. Return to Results and choose the cases again.";
		}
		case "authored-key":
			return rejection.reason === "blank"
				? "Nothing was saved: a case automation on this form needs its identifying answer filled in before it can create or find its case."
				: `Nothing was saved: a case automation's identifying answer is too long (the limit is ${rejection.maxKeyLength} characters). Shorten it and submit again.`;
		case "text-value": {
			const facet =
				rejection.facet === "owner"
					? "case owner"
					: rejection.facet === "rename"
						? "new case name"
						: "case name";
			return rejection.reason === "blank"
				? `Nothing was saved: a case automation computed an empty ${facet}. Check the answers it builds that value from and submit again.`
				: `Nothing was saved: a case automation computed a ${facet} that is too long. Shorten the answers it builds that value from and submit again.`;
		}
		case "target":
			return rejection.reason === "not-found-or-out-of-scope"
				? "Nothing was saved: a case automation points at a case that no longer exists or moved out of reach. Refresh and try again."
				: "Nothing was saved: a case automation points at a case whose type no longer matches what the automation expects.";
		case "sequence":
			return rejection.reason === "case-link-target-is-self"
				? "Nothing was saved: a case automation tried to connect a case to itself."
				: "Nothing was saved: this form's case automations disagree about a case's type partway through the submission. Review the automations' order and types.";
		case "new-case":
			return "A case already uses this ID. You can start another form or reopen the deep link with a different new case ID.";
		case "retype-not-portable": {
			const lines = rejection.failures.map((f) => {
				const field = f.path === "" ? "<root>" : f.path.replace(/^\//, "");
				return `${field}: ${f.message}`;
			});
			return `Nothing was saved: changing the case to type '${rejection.toCaseType}' would leave saved values that don't fit it:\n${lines.join("\n")}`;
		}
		default: {
			const _exhaustive: never = rejection;
			return `Nothing was saved: the submission was rejected (${String(
				(_exhaustive as { kind?: unknown })?.kind,
			)}).`;
		}
	}
}

/**
 * Submit lifecycle. Mirrors `CaseListScreen`'s `populateStatus`:
 * three arms covering idle, in-flight, and per-arm error. The error
 * arm carries the already-shaped user-facing string so the render
 * layer doesn't re-walk the failure shape.
 */
type SubmitStatus =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "error"; message: string };

interface SubmissionContextSnapshot {
	readonly scopeEpoch: number;
	readonly appId: string | undefined;
	readonly formUuid: Uuid | undefined;
	readonly moduleUuid: Uuid | undefined;
	readonly entryKey: string | undefined;
	readonly personaUuid: string | undefined;
	readonly caseIds: readonly string[] | undefined;
	readonly cases: readonly PreviewCaseChoice[] | undefined;
	readonly formType: FormType | undefined;
	readonly destination: PostSubmitDestination | undefined;
	/** The module's case type: the type of the case the submission loaded,
	 *  which the after-submit read asks for again once the write has landed. */
	readonly moduleCaseType: string | undefined;
	/** The form's after-submit links from the revision paired with the write. */
	readonly links: readonly FormLink[] | undefined;
	/** The Register launch that opened this entry of the form, when one did. */
	readonly caseListRegistrationLaunch:
		| PreviewCaseListRegistrationEntry
		| undefined;
}

interface SubmittedContextSnapshot extends SubmissionContextSnapshot {
	/** One immutable authoring revision. Links, printing, datum projection, and
	 * target routing must never mix it with a collaborator's later edit. */
	readonly doc: BlueprintDoc;
	/** The exact device casedb captured when this form entry opened. */
	readonly caseDatabase: CaseDatabaseSnapshot;
	/** The entry's session map: what the form read as `session/data`. */
	readonly entrySession: EntrySessionData | undefined;
	/** The worker whose session the entry ran in when it was submitted. Every
	 *  after-submit read (the links, where a target lands, whether it waits)
	 *  reads this one session, as a device's does not change when the form
	 *  closes. `null` where no worker had arrived. */
	readonly identity: ResolvedPreviewIdentity | null;
	/** The materializable catalog from the same submit-time revision. */
	readonly caseTypes: readonly CaseType[];
}

interface FormScreenProps {
	/** Stable identity passed by PreviewShell so an Activity-retained form never
	 * starts reading a newer route's module, form, or selected case. */
	screen: Extract<PreviewScreen, { type: "form" }>;
}

function previewCaseChoiceIdsEqual(
	left: readonly { readonly caseId: string }[] | undefined,
	right: readonly { readonly caseId: string }[] | undefined,
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.length === right.length &&
			left.every((choice, index) => choice.caseId === right[index]?.caseId))
	);
}

function stringArrayValuesEqual(
	left: readonly string[] | undefined,
	right: readonly string[] | undefined,
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.length === right.length &&
			left.every((value, index) => value === right[index]))
	);
}

/**
 * Form screen. Activates the EngineController by URL-derived form
 * UUID. A one-case entry routes its preload through `useCaseData`, then
 * `caseRowsToFormPreloads` flattens the bound case and its ancestor chain into
 * the per-case-type map the form engine consumes. A several-case entry passes
 * no primary case-data map and keeps the complete casedb snapshot separate.
 */
/** The focusable control inside an invalid question, or the question itself. */
const INVALID_CONTROL_SELECTOR =
	'[aria-invalid="true"], input:not([type="hidden"]), select, textarea, button, [role="textbox"], [tabindex]:not([tabindex="-1"])';

export function FormScreen({ screen }: FormScreenProps) {
	const { formUuid, moduleUuid } = screen;
	const explicitCases = screen.cases;
	const loc = useLocation();
	const navigate = useNavigate();
	const { inline } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const setPreviewing = useSetPreviewing();
	const appId = useAppId();
	const projectId = useProjectId();
	const scopeEpoch = useProjectScopeEpoch();
	const accessPhase = useAccessPhase();
	const personaUuid = usePreviewPersonaUuid();
	const previewCaseTarget = usePreviewCaseTarget();
	const menuSource = usePreviewMenuSource();
	const registrationEntry = usePreviewCaseListRegistrationEntry();
	const caseListRegistrationLaunch =
		registrationEntry?.moduleUuid === moduleUuid &&
		registrationEntry.formUuid === formUuid
			? registrationEntry
			: undefined;
	const heldMenuCases = usePreviewMenuCaseSelections();
	const menuCaseSelections =
		caseListRegistrationLaunch?.selections ?? heldMenuCases;
	// The worker's restore is derived from their assignment and the place tree,
	// neither of which is an argument to these reads. See `useRestoreScopeKey`.
	const restoreScopeKey = useRestoreScopeKey(personaUuid);
	const previewIdentity = useSelectedPreviewIdentity();
	/* The device the running form plays: its after-submit landing, its
	 * session values and the submission's (`lib/preview/platform.ts`). */
	const previewDevice = usePreviewDevice();
	const entryPointLaunch = usePreviewEntryPointLaunch();
	const platformRules = usePreviewPlatformRules();
	const setPreviewAtDeviceHome = useSetPreviewAtDeviceHome();
	const session = useBuilderSessionApi();
	const collab = useReconcilerContext();
	/* A viewer may preview the running app but not WRITE case data (submit a
	 * form, generate sample cases): those server actions are edit-gated, so
	 * disable their controls rather than let a viewer hit a server error.
	 * (Distinct from the `canEdit` below, which is preview-vs-edit MODE.) */
	const mayWriteCaseData = useCanEdit();
	/* The MATERIALIZABLE view: the exact shape `case_type_schemas`
	 * validates against. Submission coercion must agree with the insert
	 * schema's writer-derived property types. */
	const caseTypes = useMaterializableCaseTypes();

	/* `form-condition`, `form-operations`, and `form-links` are this form's
	 * own configuration URLs, and Preview runs a configuration URL's owning
	 * item, so they identify the same form here. None carries a field
	 * selection. */
	const atForm =
		loc.kind === "form" ||
		loc.kind === "form-condition" ||
		loc.kind === "form-operations" ||
		loc.kind === "form-links";
	/* Every route from this form back to a case list goes to the list that
	 * chose its case, leaving the target that list continues with
	 * (`menuProjection.ts::previewCaseListReturn`), read when it runs. */
	const caseListReturn = () =>
		previewCaseListReturn(session.getState().previewCaseTarget, {
			moduleUuid,
			formUuid,
		});
	const routeMatchesScreen =
		atForm && loc.formUuid === formUuid && loc.moduleUuid === moduleUuid;
	const selectedUuid =
		loc.kind === "form" && routeMatchesScreen ? loc.selectedUuid : undefined;

	const mod = useModuleEntity(moduleUuid);
	const form = useFormEntity(formUuid);
	const severalCaseForm =
		form !== undefined &&
		CASE_LOADING_FORM_TYPES.has(form.type) &&
		mod !== undefined &&
		caseSelectionCardinality(mod) === "multiple";
	const menuCaseContext = useMemo(
		() => previewMenuCaseContext(menuSource, moduleUuid, menuCaseSelections),
		[menuCaseSelections, menuSource, moduleUuid],
	);
	/* A case list registration form is admitted only through the Register
	 * action on its module's empty search (`caseListRegistration.ts`): the launch on
	 * the case target names the search attempt that offered it, and the
	 * module's search context says whether that search found nothing. The
	 * admitted answers are what `#search/<name>` reads in the engine. */
	const searchState = usePreviewStandingSearchState(moduleUuid);
	const setPreviewSearchState = useSetPreviewStandingSearchState();
	/* A submission ends the searches the form was opened under on the screen
	 * it lands on: Web Apps clears the query data of the address it pushes
	 * after a submission (`app.js`'s submit handler, `CloudcareUrl.onSubmit`)
	 * and Android's frame ends with the form, so a list the landing opens
	 * runs its menu's default search, or asks again. The entries before the
	 * landing keep theirs, so Back returns to them, as it returns to Web
	 * Apps' earlier addresses. A landing that runs a menu's search again
	 * keyed to a case writes that search afresh, and carries it on
	 * (`lib/routing/previewSearchHistory.ts`). */
	const letSubmittedSearchesGo = endPreviewStandingSearches;
	const searchLaunch =
		previewCaseTarget?.formUuid === formUuid
			? previewCaseTarget.searchLaunch
			: undefined;
	/* The case list whose Register action opened this entry of this form,
	 * which decides where it returns (`caseListActionReturn`). The
	 * launch names the form it opened and ends at any location off its path,
	 * so this form reached any other way reads none. */
	const noMatchesAdmission = useMemo(
		() =>
			caseListRegistrationAdmission({
				doc: menuSource.doc,
				formUuid,
				moduleUuid,
				launch: searchLaunch,
				actionHost: caseListRegistrationLaunch?.hostModuleUuid,
				searchState,
			}),
		[
			menuSource.doc,
			formUuid,
			moduleUuid,
			searchLaunch,
			caseListRegistrationLaunch?.hostModuleUuid,
			searchState,
		],
	);
	/* The search context keeps the screen's answers (a date range as its
	 * two bounds); the engine's search-input instance holds one field per
	 * prompt, as the device's does. A case list registration form reads its
	 * launch's answers; a form of a menu whose forms read the search reads
	 * the completed search's, or each Search field's starting value when a
	 * link or an entry point opened it with no search behind it. */
	const hostSearchInputs = mod?.caseListConfig?.searchInputs;
	const formsReadSearch = mod !== undefined && moduleFormsReadSearch(mod);
	const openedByLink =
		previewCaseTarget?.formUuid === formUuid &&
		previewCaseTarget.openedByLink === true;
	/* The starting values read the device's cases and lookups, so a form that
	 * reads them waits for both before its entry starts, as the Search screen's
	 * own search does (`useSearchCsqlRuntime.ts::searchWorld`): the engine
	 * captures its search answers once, at activation. */
	const readsSearchDefaults =
		mode === "preview" &&
		formOpensSearchScreen({
			admission: noMatchesAdmission,
			formsReadSearch,
			searchState,
			openedByLink,
		});
	const searchDefaultsLookup = usePreviewLookupStatus();
	const searchDefaultsCases = useNavigationDeviceCases(menuSource.caseTypes);
	const searchDefaultsCasesLoad = useDeviceCaseDatabaseLoad();
	const searchDefaultsSession = useMemo(
		() =>
			previewSessionValues(previewIdentity, withNavigationWidth(previewDevice)),
		[previewIdentity, previewDevice],
	);
	const searchDefaultsReady =
		!readsSearchDefaults ||
		searchWorld({
			session: searchDefaultsSession,
			readsCaseDatabase:
				mod !== undefined && moduleSearchReadsCaseDatabase(mod),
			deviceCases: searchDefaultsCases.snapshot,
			deviceCasesLoad: searchDefaultsCasesLoad.status,
			lookup: searchDefaultsLookup,
		}) !== "waiting";
	const searchDefaultsStep = useCaseListStepSession(
		menuSource.doc,
		formsReadSearch ? moduleUuid : undefined,
	);
	/* The menu's Search screen opens once its world is there
	 * (`searchDefaultsReady`): the worker, the lookups and the device's
	 * cases. It opens as the Search screen itself does, reading every
	 * starting value, hidden value, required condition and check a starting
	 * value answers (`caseListRegistration.ts::readFormSearchAnswers`). A read
	 * of data the device lacks (a place key of a worker assigned nowhere) is
	 * the refusal a device meets building the search the form reads, held as
	 * the screen's state and shown in place of the form, never an error
	 * leaving the render. */
	const searchAnswersRead = useMemo(() => {
		if (mode !== "preview") return undefined;
		return readFormSearchAnswers({
			searchInputs: hostSearchInputs ?? [],
			admission: noMatchesAdmission,
			formsReadSearch,
			searchState,
			openedByLink,
			world:
				moduleUuid !== undefined && searchDefaultsReady
					? {
							session: searchDefaultsSession,
							environment: {
								doc: menuSource.doc,
								moduleUuid,
								...(searchDefaultsLookup.kind === "data" && {
									lookup: searchDefaultsLookup.data,
								}),
								sessionData: searchDefaultsStep.data,
								caseDatabase: searchDefaultsCases.snapshot,
							},
						}
					: undefined,
		});
	}, [
		mode,
		noMatchesAdmission,
		hostSearchInputs,
		formsReadSearch,
		searchDefaultsReady,
		openedByLink,
		moduleUuid,
		searchState,
		searchDefaultsSession,
		menuSource.doc,
		searchDefaultsLookup,
		searchDefaultsStep.data,
		searchDefaultsCases.snapshot,
	]);
	const searchAnswers =
		searchAnswersRead?.kind === "read" ? searchAnswersRead.value : undefined;
	const searchDefaultsRefusal =
		searchAnswersRead?.kind === "refused"
			? searchAnswersRead.refusal
			: undefined;
	const language = useBuilderLanguage();
	/* A form of a menu whose forms read the search that reads what it found
	 * opens with that search's results, as a device's session holds them on
	 * its query step. With no completed search the form has none to read, so
	 * it shows the way back to Search instead (`searchResultsRefused`). */
	const readsSearchResults = useMemo(
		() =>
			mode === "preview" &&
			mod !== undefined &&
			formUuid !== undefined &&
			moduleFormsReadSearch(mod) &&
			formReadsSearchResults(menuSource.doc, formUuid),
		[mode, mod, formUuid, menuSource.doc],
	);
	const searchResultsRefused =
		readsSearchResults && searchState?.kind !== "completed";
	const searchParentCase = useMemo(
		() =>
			parentCaseConstraint(
				menuSource.doc,
				moduleUuid,
				menuCaseContext.parentCase,
			),
		[menuSource.doc, moduleUuid, menuCaseContext.parentCase],
	);
	const searchResults = useSearchResultsSnapshot({
		enabled: readsSearchResults,
		appId,
		doc: menuSource.doc,
		moduleUuid,
		searchState,
		...(searchParentCase === undefined ? {} : { parentCase: searchParentCase }),
		caseTypes,
		language: language.language,
	});
	const searchResultsSnapshot =
		searchResults.state.kind === "data"
			? searchResults.state.snapshot
			: undefined;
	const searchResultsReady =
		!readsSearchResults || searchResultsSnapshot !== undefined;
	const formNameUnitId = makeTranslationUnitId(
		"form",
		formUuid ?? "missing",
		"name",
	);
	const localizedFormName = useLocalizedText(formNameUnitId);
	const formNameEditor = useTranslationUnitEditor(formNameUnitId);

	/** Returns `false` for undefined `formUuid` so FormScreen can mount while the URL is parsing. */
	const hasFields = useHasFieldsInForm(formUuid);
	const presentationHasFields = usePresentationHasFields(formUuid);

	/* Direct preview of a case-loading form with no case in hand (jumped here
	 * from the structure tree, not walked through the case list): auto-bind
	 * the first available case so the form is usable. Nothing should block
	 * previewing the screen you're editing: same stance as the case list,
	 * which runs against real sample data rather than gating on navigation.
	 * The query stays idle (no caseType) unless we're actually auto-selecting.
	 * Only an ABSENT case id auto-selects: an empty one is a case the
	 * navigation did bind, to nothing (an after-submit link whose session
	 * value was blank), and the form must show that rather than pick a case
	 * the device would not have opened. */
	const autoSelectCase =
		mode === "preview" &&
		form !== undefined &&
		CASE_LOADING_FORM_TYPES.has(form.type) &&
		mod?.caseListConfig?.selection === undefined &&
		explicitCases === undefined &&
		menuCaseContext.selectedCase === undefined;
	const autoSelectParentCase = useMemo(() => {
		if (!autoSelectCase) return undefined;
		return parentCaseConstraint(
			menuSource.doc,
			moduleUuid,
			menuCaseContext.parentCase,
		);
	}, [autoSelectCase, menuSource.doc, moduleUuid, menuCaseContext.parentCase]);
	const autoCases = useCases({
		appId,
		caseType: autoSelectCase ? mod?.caseType : undefined,
		parentCase: autoSelectParentCase,
		requestScopeKey: `${moduleUuid ?? ""}\u0000${formUuid ?? ""}\u0000${restoreScopeKey}`,
	});
	const autoRow =
		autoSelectCase && autoCases.state.kind === "rows"
			? autoCases.state.rows[0]
			: undefined;
	/** The case actually bound to this form: an explicit navigation target wins;
	 *  otherwise the menu's exact own-type selection (including deliberate
	 *  same-type structural inheritance) wins before the first auto-selected
	 *  row. A different-type menu parent constrains that fallback query above. */
	const effectiveCases = useMemo(
		() =>
			explicitCases ??
			menuCaseContext.selectedCase?.cases ??
			(autoRow === undefined
				? undefined
				: [
						{
							caseId: autoRow.case_id,
							caseName: autoRow.case_name || "Case",
						},
					]),
		[autoRow, explicitCases, menuCaseContext.selectedCase?.cases],
	);
	const effectiveCaseIds = useMemo(
		() => effectiveCases?.map((choice) => choice.caseId),
		[effectiveCases],
	);
	/* Authored cardinality, not observed selection size, decides whether one
	 * row may become the primary preload. A Several-cases form with one chosen
	 * row is still one shared batch form, never a temporarily singular form. */
	const effectiveCaseId =
		!severalCaseForm && effectiveCaseIds?.length === 1
			? effectiveCaseIds[0]
			: undefined;
	/* The cases this form's session holds, in the order they were chosen:
	 * those chosen before its own, then its own, chosen on the list a menu
	 * after its case names, else the list that chose the menu's case, else
	 * its own module's. They pin the case tile above the form
	 * (`lib/preview/pinnedCaseTile.ts`), in Preview only: edit mode has no
	 * bound case, and a band that appeared while authoring would claim a case
	 * the author never chose. */
	const heldCases = useMemo(() => {
		if (mode !== "preview") return [];
		const ownListModuleUuid =
			(explicitCases !== undefined
				? previewCaseTarget?.formUuid === formUuid
					? previewCaseTarget.formChosenAfterCase?.caseListModuleUuid
					: undefined
				: menuCaseContext.selectedByModuleUuid) ?? moduleUuid;
		const before = previewSelectionsBefore(
			menuSource,
			moduleUuid,
			menuCaseSelections,
		).filter((selection) => selection.moduleUuid !== ownListModuleUuid);
		return effectiveCases === undefined || severalCaseForm
			? before
			: [...before, { moduleUuid: ownListModuleUuid, cases: effectiveCases }];
	}, [
		effectiveCases,
		explicitCases,
		formUuid,
		menuCaseContext.selectedByModuleUuid,
		menuCaseSelections,
		menuSource,
		mode,
		moduleUuid,
		previewCaseTarget,
		severalCaseForm,
	]);
	const pinnedTile = usePinnedCaseTile(heldCases, "form");
	const carriedTargetMatches =
		previewCaseTarget?.formUuid === formUuid &&
		previewCaseChoiceIdsEqual(previewCaseTarget.cases, effectiveCases);
	const carriedCaseData = carriedTargetMatches
		? previewCaseTarget?.caseData
		: undefined;
	const carriedCaseDatabase = carriedTargetMatches
		? previewCaseTarget?.caseDatabase
		: undefined;
	const replacementRevision = useCaseDataReplacementRevision(
		appId,
		mod?.caseType,
	);
	/* A form retained by Activity may outlive the case population it was
	 * opened from. Associate the replacement revision with the current case
	 * identity; a new selection establishes a new baseline, while a replacement
	 * of the SAME identity invalidates it synchronously on the next render. */
	const bindingRevisionRef = useRef({
		scopeEpoch,
		caseIdsKey: JSON.stringify(effectiveCaseIds),
		revision: replacementRevision,
	});
	const effectiveCaseIdsKey = JSON.stringify(effectiveCaseIds);
	if (
		bindingRevisionRef.current.scopeEpoch !== scopeEpoch ||
		bindingRevisionRef.current.caseIdsKey !== effectiveCaseIdsKey
	) {
		bindingRevisionRef.current = {
			scopeEpoch,
			caseIdsKey: effectiveCaseIdsKey,
			revision: replacementRevision,
		};
	}
	const caseBindingReplaced =
		(effectiveCaseIds?.length ?? 0) > 0 &&
		bindingRevisionRef.current.revision !== replacementRevision;

	/* The form's readable case-type chain, which `#<type>/<prop>`
	 * namespace binds to which parent-hop depth, and how deep the
	 * server-side ancestor walk needs to go. Serialized to a string so
	 * its identity tracks CONTENT: the catalog array is a fresh
	 * reference on every doc snapshot, and letting that identity flow
	 * into the `caseData` memo would recreate the engine (wiping
	 * live-preview input) on every unrelated edit. */
	const reachableChainKey = useMemo(
		() =>
			JSON.stringify(
				reachableCaseTypes(mod?.caseType, caseTypes).map((t) => [
					t.name,
					t.depth,
				]),
			),
		[mod?.caseType, caseTypes],
	);
	const reachableChain = useMemo(
		() =>
			(JSON.parse(reachableChainKey) as [string, number][]).map(
				([name, depth]) => ({ name, depth }),
			),
		[reachableChainKey],
	);

	/* Keyed on `effectiveCaseId` (not just the nav-provided `caseId`) so an
	 * auto-selected case also gets its full row + ancestor chain loaded:
	 * ancestor refs (`#<parent_type>/<prop>`) need the parent rows, which
	 * the auto-select list query doesn't carry. */
	const { state: caseDataState } = useCaseData({
		appId,
		caseType: mod?.caseType,
		caseId: effectiveCaseId,
		ancestorDepth: Math.max(0, reachableChain.length - 1),
		// A case-loading form runs on the worker's device, so it may only
		// preload from a case that device holds.
		deviceScoped: true,
		scopeKey: restoreScopeKey,
	});

	/* The settled row arm alone: NOT the whole load state, keys the
	 * preload memo. The idle→loading transition would otherwise mint a
	 * data-identical map whose fresh identity re-fires useFormEngine's
	 * effect and rebuilds the engine, wiping anything typed in the
	 * window. */
	const settledCase = caseDataState.kind === "row" ? caseDataState : undefined;

	/** Preload from the loaded case + its ancestors in one-case mode; the bare auto-selected
	 *  row bridges the load window (own-type data only, ancestors follow
	 *  when the load settles: that one re-supply recreates the engine,
	 *  the same shape as the nav path's load settling). Every other arm
	 *  leaves the form rendering against defaults. */
	const caseData = useMemo(() => {
		/* Undefined is the honest absence of a scalar preload and, unlike a new
		 * empty map value, does not ask useFormEngine to start a second rebuild
		 * beside the controller's cardinality-change rebuild. */
		if (severalCaseForm) return undefined;
		if (carriedCaseData !== undefined) return carriedCaseData;
		if (settledCase)
			return caseRowsToFormPreloads(
				settledCase.row,
				settledCase.ancestors,
				reachableChain,
			);
		if (autoRow) return caseRowsToFormPreloads(autoRow, [], reachableChain);
		return undefined;
	}, [severalCaseForm, carriedCaseData, settledCase, autoRow, reachableChain]);

	const requiresCaseBinding =
		form !== undefined && CASE_LOADING_FORM_TYPES.has(form.type);
	const needsBoundCase = mode === "preview" && requiresCaseBinding;
	// Edit uses this same engine. It must not capture one-time defaults or query
	// membership before Preview selects a record; the canvas can render without
	// an active entry. Returning to Edit retains an already initialized entry.
	const caseBindingReady =
		!requiresCaseBinding ||
		(severalCaseForm &&
			(effectiveCaseIds?.length ?? 0) > 0 &&
			!caseBindingReplaced) ||
		carriedCaseData !== undefined ||
		(effectiveCaseId !== undefined &&
			!caseBindingReplaced &&
			caseDataState.kind === "row" &&
			caseDataState.row.case_id === effectiveCaseId);

	const editable = isReady;

	/* What the worker typed into the case list's filter before choosing the
	 * case, which the entry's session holds as `stringquery`. */
	const caseListSearchText =
		previewCaseTarget?.formUuid === formUuid
			? previewCaseTarget.caseListSearchText
			: undefined;
	/* The running session the entry starts from: its bound cases and the
	 * menu's choices. The controller builds the entry's session map, which
	 * the form reads as `session/data` and its links read after submit. */
	const entrySupplies =
		previewCaseTarget?.formUuid === formUuid
			? previewCaseTarget.entrySupplies
			: undefined;
	const entrySession = useMemo(
		() =>
			appId === undefined || mode !== "preview"
				? undefined
				: {
						appId,
						boundCases: effectiveCases ?? [],
						menuSelections: menuCaseSelections,
						...(entrySupplies && { entrySupplies }),
						...(searchResultsSnapshot === undefined
							? {}
							: { searchResults: searchResultsSnapshot }),
						...(caseListSearchText === undefined ? {} : { caseListSearchText }),
					},
		[
			appId,
			mode,
			effectiveCases,
			menuCaseSelections,
			searchResultsSnapshot,
			caseListSearchText,
			entrySupplies,
		],
	);
	const controller = useFormEngine(
		formUuid,
		caseData,
		carriedCaseDatabase,
		searchAnswers,
		caseBindingReady &&
			searchResultsReady &&
			!searchResultsRefused &&
			searchDefaultsReady &&
			searchDefaultsRefusal === undefined,
		entrySession,
	);
	const engineEntry = useEngineEntry();
	const runtimeFault =
		engineEntry.fault?.formUuid === formUuid ? engineEntry.fault : undefined;
	const entryRefusal =
		engineEntry.refusal?.formUuid === formUuid
			? engineEntry.refusal
			: undefined;
	const formRefusal =
		entryRefusal?.kind === "setvalue" ? entryRefusal.details : undefined;
	const dataRefusal = entryRefusal?.kind === "data" ? entryRefusal : undefined;
	const caseDatabaseWait =
		engineEntry.caseDatabaseWait?.formUuid === formUuid
			? engineEntry.caseDatabaseWait
			: undefined;
	const lookupWait =
		engineEntry.lookupWait?.formUuid === formUuid
			? engineEntry.lookupWait
			: undefined;
	const reloadLookupData = usePreviewLookupReload();
	const entryKey =
		engineEntry.formUuid === formUuid ? engineEntry.entryKey : undefined;
	const engineReady =
		engineEntry.formUuid === formUuid &&
		engineEntry.ready &&
		entryKey !== undefined;
	const engineRebuilding =
		engineEntry.formUuid === formUuid && engineEntry.rebuilding;
	const engineInitializing =
		mode === "preview" && !engineReady && !engineRebuilding;
	let attachmentEntryReady = false;
	if (entryKey !== undefined) {
		setAttachmentEntryAuthority({
			entryKey,
			snapshot: {
				appId,
				entryKey,
				formUuid,
				projectId,
				actorUserId: previewIdentity?.actorUserId,
				ownerId: previewIdentity?.ownerId,
				scopeEpoch,
				accessPhase,
				canEdit: mayWriteCaseData,
			},
			readCurrent: () => {
				const current = session.getState();
				return {
					appId: current.appId,
					entryKey: controller.entryKey,
					formUuid: controller.formUuid,
					projectId: current.projectId,
					actorUserId: previewIdentity?.actorUserId,
					ownerId: previewIdentity?.ownerId,
					scopeEpoch: current.scopeEpoch,
					accessPhase: current.accessPhase,
					canEdit: current.canEdit,
				};
			},
		});
		attachmentEntryReady = hasAttachmentEntryWriteAuthority(entryKey);
	}
	const postSubmitDestination = useEffectivePostSubmit(form?.uuid);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	/* The live lookup status and worker, for the after-submit route: a link
	 * target whose menu visibility is still pending (lookup data loading)
	 * waits for the next change, as the menus' own visibility reads do. The
	 * route reads the session of the entry it routes
	 * (`SubmittedContextSnapshot.identity`), never the running worker's: a
	 * running worker who is no longer that one makes the waiting route stale
	 * (`afterSubmitRouting.ts::settleAfterSubmitRoute`). Unmounting releases a
	 * waiting route, which then finds its attempt stale. */
	const lookupStatus = usePreviewLookupStatus();
	const visibilityInputsRef = useRef({ lookupStatus, previewIdentity });
	const visibilityWaitersRef = useRef(new Set<() => void>());
	useEffect(() => {
		visibilityInputsRef.current = { lookupStatus, previewIdentity };
		const waiters = [...visibilityWaitersRef.current];
		visibilityWaitersRef.current.clear();
		for (const wake of waiters) wake();
	}, [lookupStatus, previewIdentity]);
	useEffect(() => {
		const waiters = visibilityWaitersRef.current;
		return () => {
			const pending = [...waiters];
			waiters.clear();
			for (const wake of pending) wake();
		};
	}, []);
	const nextVisibilityInputs = (): Promise<void> =>
		new Promise((resolve) => {
			visibilityWaitersRef.current.add(resolve);
		});
	const submissionContextRef = useRef<SubmissionContextSnapshot>({
		scopeEpoch,
		appId,
		formUuid,
		moduleUuid,
		entryKey,
		personaUuid,
		caseIds: effectiveCaseIds,
		cases: effectiveCases,
		formType: form?.type,
		destination: postSubmitDestination,
		moduleCaseType: mod?.caseType,
		links: form?.formLinks,
		caseListRegistrationLaunch,
	});
	submissionContextRef.current = {
		scopeEpoch,
		appId,
		formUuid,
		moduleUuid,
		entryKey,
		personaUuid,
		caseIds: effectiveCaseIds,
		cases: effectiveCases,
		formType: form?.type,
		destination: postSubmitDestination,
		moduleCaseType: mod?.caseType,
		links: form?.formLinks,
		caseListRegistrationLaunch,
	};
	useEffect(() => {
		if (appId === undefined || entryKey === undefined) return;
		return () => {
			retireAttachmentEntry({
				appId,
				entryKey,
			});
		};
	}, [appId, entryKey]);

	useEffect(
		() =>
			controller.subscribeRepeatCompaction((event) => {
				if (appId === undefined) return;
				void reconcileAttachmentRepeatCompaction({
					appId,
					entryKey: event.entryKey,
					compaction: event,
				});
			}),
		[appId, controller],
	);

	useEffect(
		() =>
			controller.subscribeAuthoredCapturePathMigration((event) => {
				if (appId === undefined) return;
				void reconcileAttachmentAuthoredPathMigration({
					appId,
					entryKey: event.entryKey,
					migration: event,
				});
			}),
		[appId, controller],
	);

	const prevModeRef = useRef(mode);
	useEffect(() => {
		if (prevModeRef.current === "preview" && mode !== "preview") {
			controller.resetValidation();
		}
		prevModeRef.current = mode;
	}, [mode, controller]);

	const formBodyElRef = useRef<HTMLDivElement>(null);
	const formLayoutRef = useRef<FormLayoutHandle>(null);
	/* A reveal waits here until the form is live. Submit's refusal arrives
	 * while the form is still frozen (its running state commits back to idle
	 * in the same render as the refusal), and a control inside the inert,
	 * disabled body ignores `focus()`, so focusing on a timer alone lands
	 * nowhere whenever that commit is slower than the timer. */
	const pendingFocusRef = useRef<
		{ focus: () => void; stopWatching: () => void } | undefined
	>(undefined);
	const cancelPendingFocus = useCallback(() => {
		pendingFocusRef.current?.stopWatching();
		pendingFocusRef.current = undefined;
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a reveal belongs to this form entry and mode.
	useLayoutEffect(
		() => cancelPendingFocus,
		[cancelPendingFocus, entryKey, formUuid, mode],
	);
	const [focusRequest, setFocusRequest] = useState(0);
	const requestFocus = useCallback(
		(focus: () => void): void => {
			cancelPendingFocus();
			pendingFocusRef.current = {
				focus,
				stopWatching: onNewFocusIntent(cancelPendingFocus),
			};
			setFocusRequest((request) => request + 1);
		},
		[cancelPendingFocus],
	);

	const formBodyRef = useCallback(
		(el: HTMLDivElement | null) => {
			formBodyElRef.current = el;
			if (!el || mode !== "preview") return;
			if (!selectedUuid) return;
			const cancel = () => {
				cancelAnimationFrame(frame);
				stopWatching();
			};
			const stopWatching = onNewFocusIntent(cancel);
			const frame = requestAnimationFrame(() => {
				stopWatching();
				const qEl = el.querySelector(`[data-field-uuid="${selectedUuid}"]`);
				const input = qEl?.querySelector(
					'input, select, textarea, button, [role="textbox"], [tabindex]:not([tabindex="-1"])',
				) as HTMLElement | null;
				input?.focus();
			});
			return cancel;
		},
		[mode, selectedUuid],
	);

	/* Submit lifecycle + post-submit dispatch live above the early-
	 * return gates so the hooks run on every render: moving them
	 * below the conditional returns would violate the rules of hooks
	 * during the transient mount window when `form` resolves from
	 * undefined to defined. The `form?.` reads tolerate the undefined
	 * window; `dispatchPostSubmit` is only invoked from `handleSubmit`,
	 * which itself only fires when the test-mode submit row is mounted,
	 * which itself requires `form` to be defined. */
	const [submitStatus, setSubmitStatus] = useState<SubmitStatus>({
		kind: "idle",
	});
	const [validationAnnouncement, setValidationAnnouncement] = useState<
		| {
				readonly serial: number;
				readonly kind: "literal";
				readonly message: string;
		  }
		| { readonly serial: number; readonly kind: "review" }
		| undefined
	>();
	/* Each announcement gets its own serial so the same sentence said twice
	 * (two failed Next presses) re-renders the alert node and is read twice. */
	const announcementSerialRef = useRef(0);
	const announce = useCallback((message: string): void => {
		setValidationAnnouncement({
			serial: ++announcementSerialRef.current,
			kind: "literal",
			message,
		});
	}, []);
	/* Keep platform feedback as intent: the same entry may change language
	 * while this alert is still present. Authored/server messages stay literal. */
	const announceReview = useCallback((): void => {
		setValidationAnnouncement({
			serial: ++announcementSerialRef.current,
			kind: "review",
		});
	}, []);
	const [clearRevision, setClearRevision] = useState(0);
	/* Clear form runs from the press until the fresh entry's key is the one
	 * the screen shows: `starting` before the controller has handed the key
	 * back, `awaiting-entry` once it has. Both are the busy state, so Submit
	 * never looks ready while a press on it would land on the retired entry. */
	const [clearState, setClearState] = useState<
		| { readonly kind: "idle" }
		| { readonly kind: "starting" }
		| { readonly kind: "awaiting-entry"; readonly entryKey: string }
	>({ kind: "idle" });
	const clearInFlightRef = useRef(false);
	const clearRunning = clearState.kind !== "idle";
	const repeatTopologySettling =
		engineEntry.formUuid === formUuid && engineEntry.topologySettling;
	/* What Submit offers (`lib/preview/submitOffer.ts`): rendered as Submit's
	 * disabled state and its reason, and read again when a press lands. */
	const submitState: PreviewSubmitState = {
		afterSubmitKnown:
			form === undefined ||
			form.formLinks !== undefined ||
			postSubmitDestination !== undefined,
		submitting: submitStatus.kind === "running",
		clearing: clearRunning,
		entry: engineInitializing
			? "initializing"
			: engineRebuilding
				? "rebuilding"
				: "ready",
		caseDatabase:
			caseDatabaseWait === undefined
				? "ready"
				: caseDatabaseWait.status === "error"
					? "failed"
					: "refreshing",
		repeatSettling: repeatTopologySettling,
		caseBindingReady,
		access: previewSubmitAccess({
			accessPhase,
			canEdit: mayWriteCaseData,
			sameApp: true,
			entryAuthorityCurrent: appId === undefined || attachmentEntryReady,
		}),
	};
	const submitOffer = previewSubmitOffer(submitState);
	/* A form that names nowhere to go after it is submitted breaches
	 * `effectivePostSubmit`'s guarantee: the screen shows its fault state, and
	 * the breach is reported once, never swallowed. */
	const submitFault =
		mode === "preview" && submitOffer.kind === "fault"
			? submitOffer.reason
			: undefined;
	useEffect(() => {
		if (submitFault === undefined) return;
		const error = new Error(
			"Preview found a form with nowhere to go after it is submitted.",
		);
		reportClientError(
			{
				message: error.message,
				stack: error.stack,
				source: "manual",
				url: typeof window === "undefined" ? "" : window.location.origin,
				diagnostics: {
					component: "preview-form-screen",
					operation: "submit-offer",
					failureKind: submitFault,
				},
			},
			error,
		);
	}, [submitFault]);
	const submissionAttemptRef = useRef(0);
	const setPreviewCaseTarget = useSetPreviewCaseTarget();
	const setPreviewMenuCaseSelection = useSetPreviewMenuCaseSelection();
	const setPreviewSelectedCase = useSetPreviewSelectedCase();
	/* Capture imperatively at the final write boundary. Post-write routing keeps
	 * that revision even if a collaborator edits while the action is in flight. */
	const docApi = useBlueprintDocApi();
	const submissionIdentityKey = JSON.stringify([
		scopeEpoch,
		appId,
		formUuid,
		moduleUuid,
		entryKey,
		personaUuid,
		effectiveCaseIds,
		form?.type,
		postSubmitDestination,
	]);
	useEffect(() => {
		void submissionIdentityKey;
		/* Every material submission identity boundary invalidates the old
		 * attempt. Entry identity is controller-reactive, so a collaborator
		 * changing the selected persona's data (same UUID, different worker
		 * projection) lands here even when no route/session prop changed. */
		submissionAttemptRef.current += 1;
		setSubmitStatus({ kind: "idle" });
		setValidationAnnouncement(undefined);
	}, [submissionIdentityKey]);
	useEffect(() => {
		if (
			clearState.kind !== "awaiting-entry" ||
			entryKey !== clearState.entryKey
		) {
			return;
		}
		clearInFlightRef.current = false;
		setClearState({ kind: "idle" });
	}, [clearState, entryKey]);

	/* Replacing all rows destroys the identity this navigation frame carries.
	 * Leave the stale form with `replace` (so browser Back cannot re-enter it),
	 * but preserve the destination form as the Results screen's continue target.
	 * The render-time `caseBindingReplaced` guard disables Submit before this
	 * effect runs. */
	useEffect(() => {
		if (
			!caseBindingReplaced ||
			explicitCases === undefined ||
			!moduleUuid ||
			!formUuid
		)
			return;
		setSubmitStatus({ kind: "idle" });
		setPreviewSelectedCase(undefined);
		const back = previewCaseListReturn(session.getState().previewCaseTarget, {
			moduleUuid,
			formUuid,
		});
		setPreviewCaseTarget(back.target);
		navigate.replace({ kind: "cases", moduleUuid: back.moduleUuid });
	}, [
		caseBindingReplaced,
		explicitCases,
		moduleUuid,
		formUuid,
		navigate,
		session,
		setPreviewCaseTarget,
		setPreviewSelectedCase,
	]);

	const dispatchPostSubmit = useCallback(
		(
			dest: PostSubmitDestination,
			submittedModuleUuid: Uuid | undefined,
			submitted: SubmittedContextSnapshot,
			deviceCases: CaseDatabaseSnapshot = submitted.caseDatabase,
		): void => {
			const submittedDoc = submitted.doc;
			/* Open a module with the selections its frame keeps: its own for
			 * `module`, the parent's for `parentMenu`. */
			const openModuleTask = (targetModuleUuid: Uuid): void => {
				const selections = selectionsForStaticModuleTask(
					submittedDoc,
					targetModuleUuid,
					session.getState().previewMenuCaseSelections,
					submitted.entrySession?.values,
					deviceCases,
				);
				setPreviewMenuCaseSelection(
					targetModuleUuid,
					selections[targetModuleUuid],
				);
				const prefix = moduleFirstMenuCases(submittedDoc, targetModuleUuid);
				for (const root of prefix) {
					setPreviewMenuCaseSelection(
						root.moduleUuid,
						selections[root.moduleUuid],
					);
					for (const recipient of root.destinationConsumers)
						setPreviewMenuCaseSelection(recipient, selections[recipient]);
				}
				const home = firstMenuSelections(prefix, selections, platformRules);
				if (home) showFrameFirstMenu(navigate, session, home);
				navigate.openModule(targetModuleUuid);
			};
			switch (dest) {
				case "module":
					if (submittedModuleUuid) openModuleTask(submittedModuleUuid);
					return;
				case "parentMenu": {
					const parentUuid =
						submittedModuleUuid === undefined
							? undefined
							: submittedDoc.modules[submittedModuleUuid]?.parentModuleUuid;
					if (parentUuid !== undefined) openModuleTask(parentUuid);
					else navigate.goHome();
					return;
				}
				/* `app_home` opens the app's first screen in Web Apps and the
				 * phone's home screen on Android (`postSubmitAppHome`);
				 * `firstMenu` opens the app's first screen on both. */
				case "app_home":
					navigate.goHome();
					if (appHomeLanding(platformRules) === "device-home")
						setPreviewAtDeviceHome(true);
					return;
				case "firstMenu":
					navigate.goHome();
					return;
				case "previous":
					throw new Error(
						"The preceding task must be resolved from the submitted entry.",
					);
				default: {
					/* Exhaustive switch: a future `PostSubmitDestination`
					 * arm landing without a case here surfaces as the
					 * standard `unhandledKindMessage` shape rather than
					 * silently choosing an unrelated destination. */
					const _exhaustive: never = dest;
					throw new Error(
						unhandledKindMessage({
							where: "preview.FormScreen.dispatchPostSubmit",
							family: "PostSubmitDestination",
							received: _exhaustive,
							knownKinds: [...POST_SUBMIT_DESTINATIONS],
						}),
					);
				}
			}
		},
		[
			navigate,
			platformRules,
			session,
			setPreviewAtDeviceHome,
			setPreviewMenuCaseSelection,
		],
	);

	/**
	 * Where the app goes once a submission has landed.
	 *
	 * The submission pushes its frames the way the device does
	 * (`lib/preview/engine/formLinkEvaluation.ts::evaluateAfterSubmitAsync`):
	 * every destination whose condition and carried-case guards hold after the
	 * form has closed, against the case rows AS THEY ARE NOW, then the
	 * otherwise when none that may not run does; a form without destinations
	 * pushes its after-submit destination's frame. The platform's stack
	 * (`lib/preview/afterSubmitStack.ts`, `rules.afterSubmitFrames`) then pops
	 * the frame that opens: on Android the top one, with the rest pending
	 * until it finishes; on Web Apps the top one alone. Nothing left is the
	 * app home. Typed case hashtags and `#user` read from the exact rows returned by
	 * the submission transaction. The structural casedb starts from the exact
	 * device snapshot captured at form entry and applies that committed row/index
	 * patch. A fresh
	 * restore is not the same thing: it can omit a case the device just closed
	 * or reassigned but still retains locally until sync. Registration-created
	 * cases and operation effects enter through the same patch; an effect-free
	 * survey contributes none.
	 *
	 * The write is announced to the rest of the running app (`announceWrite`)
	 * only once the route no longer depends on this form's case binding:
	 * announcing first would reload the bound case under the form mid-read,
	 * and a close form's now-closed case would resolve missing and abandon
	 * the route as stale.
	 *
	 * The submit row stays in its running state until the next screen is
	 * pushed: the write has landed, and a second press must not land it
	 * again.
	 */
	const dispatchAfterSubmit = async (args: {
		readonly submitted: SubmittedContextSnapshot & {
			readonly appId: string;
		};
		readonly result: SubmissionSuccess;
		readonly isCurrent: () => boolean;
		readonly settleAttempt: (status: SubmitStatus) => void;
		/** Announce the landed write to every surface reading case data. */
		readonly announceWrite: () => void;
	}): Promise<void> => {
		const { submitted, result, isCurrent, settleAttempt } = args;
		/* The searches as the submission found them, which a landing that
		 * keys a menu's search to the registered case carries on. */
		const searchesAtSubmit = session.getState().previewSearchStates;
		/* The write has landed, so the Register launch that opened this
		 * entry is spent: whatever opens next, this form again included, is
		 * no longer that launch. The submitted snapshot keeps it for the
		 * return decided below. */
		if (
			submitted.caseListRegistrationLaunch !== undefined &&
			session.getState().previewCaseListRegistrationEntry ===
				submitted.caseListRegistrationLaunch
		)
			session.getState().setPreviewCaseListRegistrationEntry(undefined);
		/* Forget page memory only when this completed entry actually leaves.
		 * The next engine resolves its first visible page from fresh answers;
		 * choosing a page now would use the submitted entry's conditionality. */
		const forgetCompletedPages = (destinationFormUuid?: Uuid): void => {
			if (submitted.formUuid !== undefined) {
				session.getState().forgetActiveSection(submitted.formUuid);
			}
			if (destinationFormUuid !== undefined) {
				session.getState().forgetActiveSection(destinationFormUuid);
			}
		};
		let announced = false;
		const announceWrite = (): void => {
			if (announced) return;
			announced = true;
			args.announceWrite();
		};
		const retireCompletedTask = (): void => {
			session.getState().setPreviewTaskContinuation(undefined);
			session.getState().setPreviewParentCaseRequest(undefined);
			setPreviewCaseTarget(undefined);
			letSubmittedSearchesGo();
		};
		/* Both list actions return through the frames for the host that
		 * opened this entry. The form's own navigation takes precedence. */
		const hostUuid = submitted.caseListRegistrationLaunch?.hostModuleUuid;
		const createdDatum =
			hostUuid && submitted.formUuid
				? caseListActionCreatedDatum(
						submitted.doc,
						hostUuid,
						submitted.formUuid,
					)
				: undefined;
		const registeredCaseId =
			createdDatum === undefined
				? undefined
				: submitted.entrySession?.data[createdDatum];
		const createdCase =
			registeredCaseId && hostUuid
				? registeredCaseOnDevice(
						result.caseDatabasePatch,
						registeredCaseId,
						submitted.doc.modules[hostUuid]?.caseType,
					)
				: undefined;
		const registrationLanding =
			submitted.formUuid === undefined
				? undefined
				: caseListActionReturn(
						submitted.doc,
						submitted.formUuid,
						submitted.caseListRegistrationLaunch,
						createdCase?.caseId,
					);
		if (
			registrationLanding !== undefined &&
			submitted.caseListRegistrationLaunch !== undefined
		) {
			const hostModuleUuid =
				submitted.caseListRegistrationLaunch.hostModuleUuid;
			retireCompletedTask();
			announceWrite();
			const current = session.getState().previewMenuCaseSelections;
			const next = selectionsAfterRegistrationReturn(
				current,
				registrationLanding,
				hostModuleUuid,
				submitted.doc.modules[hostModuleUuid]?.caseType ?? "",
				createdCase,
				submitted.moduleCaseType && submitted.cases
					? { caseType: submitted.moduleCaseType, cases: submitted.cases }
					: undefined,
				(operationUuid, caseType) => {
					const datumId = registrationLanding.createdSelections?.find(
						(row) => row.operationUuid === operationUuid,
					)?.datumId;
					const caseId =
						datumId === undefined
							? undefined
							: submitted.entrySession?.data[datumId];
					return caseId === undefined
						? undefined
						: registeredCaseOnDevice(
								result.caseDatabasePatch,
								caseId,
								caseType,
							);
				},
			);
			for (const moduleUuid of Object.keys(current))
				if (next[moduleUuid] === undefined)
					setPreviewMenuCaseSelection(moduleUuid as Uuid, undefined);
			for (const [moduleUuid, selection] of Object.entries(next))
				setPreviewMenuCaseSelection(moduleUuid as Uuid, selection);
			/* Where the frame runs a menu's search again keyed to the
			 * registered case (a host whose forms read the search), that
			 * search now holds that case alone: its Results list it, or
			 * nothing where the form created no case, and its forms read it
			 * as what the search found. */
			if (registeredCaseId !== undefined)
				for (const moduleUuid of registrationLanding.newCaseSearchModuleUuids)
					setPreviewSearchState(
						moduleUuid,
						recordRegisteredCase(
							searchesAtSubmit[moduleUuid],
							registeredCaseId,
							createdCase !== undefined,
						),
					);
			setPreviewSelectedCase(undefined);
			/* The return frame is pushed and opens like any other frame, so
			 * what was pending stays only while the worker is on its path. */
			const landingScreen = registrationLanding.screen;
			if (
				submitted.formUuid !== undefined &&
				submitted.moduleUuid !== undefined
			)
				session.getState().setPreviewAfterSubmitStack(
					completeAfterSubmitWithOwnFrame(
						session.getState().previewAfterSubmitStack,
						submittedEntryPath({
							doc: submitted.doc,
							moduleUuid: submitted.moduleUuid,
							formUuid: submitted.formUuid,
							caseIdsOf: (moduleUuid) =>
								current[moduleUuid]?.cases.map((choice) => choice.caseId) ?? [],
						}),
						landingScreen.kind === "first-menu"
							? []
							: afterSubmitPath(
									submitted.doc,
									{ moduleUuid: landingScreen.moduleUuid },
									Object.entries(next).map(([moduleUuid, selection]) => ({
										moduleUuid: moduleUuid as Uuid,
										caseIds: selection.cases.map((choice) => choice.caseId),
									})),
								),
						platformRules.afterSubmitFrames,
					),
				);
			settleAttempt({ kind: "idle" });
			forgetCompletedPages();
			const home = firstMenuSelections(
				registrationLanding.firstMenuCases,
				next,
				platformRules,
			);
			if (home) showFrameFirstMenu(navigate, session, home);
			if (landingScreen.kind !== "first-menu")
				navigate.openModule(landingScreen.moduleUuid);
			else if (!home) navigate.goHome();
			return;
		}
		/* A form without destinations, with nothing pending, goes straight to
		 * its after-submit destination: its one frame is the stack. */
		if (
			submitted.links === undefined &&
			submitted.destination !== undefined &&
			submitted.destination !== "previous" &&
			session.getState().previewAfterSubmitStack.pending.length === 0
		) {
			retireCompletedTask();
			announceWrite();
			settleAttempt({ kind: "idle" });
			forgetCompletedPages();
			session.getState().setPreviewAfterSubmitStack(EMPTY_AFTER_SUBMIT_STACK);
			dispatchPostSubmit(
				submitted.destination,
				submitted.moduleUuid,
				submitted,
				result.caseDatabasePatch
					? overlayCaseDatabasePatch(
							submitted.caseDatabase,
							result.caseDatabasePatch,
						)
					: submitted.caseDatabase,
			);
			return;
		}
		const sourceFormUuid = submitted.formUuid;
		const sourceModuleUuid = submitted.moduleUuid;
		const sourceEntryKey = submitted.entryKey;
		const failAfterSave = (message: string, failureCode: string): void => {
			announceWrite();
			/* The route may have handled authored XPath and private case/session
			 * data. Emit only a bounded operation code: never attach the caught
			 * error, stack, route URL, form identity, expression, or data value. */
			reportClientError({
				message: "Preview after-submit routing failed.",
				source: "manual",
				url: "",
				diagnostics: {
					component: "preview-form-link",
					operation: "after-submit-route",
					failureKind: failureCode,
				},
			});
			settleAttempt({ kind: "error", message });
		};
		if (
			sourceEntryKey === undefined ||
			sourceFormUuid === undefined ||
			sourceModuleUuid === undefined
		) {
			failAfterSave(
				"Your answers were saved, but the next screen could not be chosen. Reload the app and try again.",
				"missing-entry-scope",
			);
			return;
		}

		const caseDatabasePatch = result.caseDatabasePatch;
		if (caseDatabasePatch === undefined) {
			failAfterSave(
				"Your answers were saved, but the next screen could not be chosen from the saved case state. Reload the app and try again.",
				"missing-submission-snapshot",
			);
			return;
		}
		/* The links, and every routing read after them, read the session the
		 * entry ran in when it was submitted: the device's session does not
		 * change when the form closes. An entry opens only once the worker has
		 * arrived (`EngineController.setPreviewIdentityPending`), so an entry
		 * submitted with no worker belongs to a controller no shell gave one,
		 * and nothing is left to route. */
		const entryIdentity = submitted.identity;
		if (entryIdentity === null) {
			announceWrite();
			settleAttempt({ kind: "idle" });
			return;
		}
		const refreshedCaseDatabase = overlayCaseDatabasePatch(
			submitted.caseDatabase,
			caseDatabasePatch,
		);
		const postSubmissionUsercase = submissionWorkerValues(
			caseDatabasePatch,
			entryIdentity.ownerId,
			entryIdentity.usercase,
		);

		let caseData: PostSubmissionCaseData = new Map();
		let boundCaseName: string | undefined;
		const resultCaseIds =
			result.kind === "survey"
				? []
				: result.kind === "registration"
					? [result.caseId]
					: result.caseIds;
		if (resultCaseIds.length === 1 && resultCaseIds[0] !== undefined) {
			const caseType = submitted.moduleCaseType;
			if (caseType === undefined) {
				failAfterSave(
					"Your answers were saved, but the case could not be read back to choose the next screen. Reload the app and try again.",
					"missing-case-type",
				);
				return;
			}
			const chain = reachableCaseTypes(caseType, submitted.caseTypes);
			const readBack = caseDatabaseToFormPreloads(
				refreshedCaseDatabase,
				resultCaseIds[0],
				chain,
			);
			/* The patch holds every case the submission touched, so a
			 * registration's case is missing from it only when the form's open
			 * condition did not create one. The session still names the id it
			 * minted, as a device's does, and no case reads back from it. */
			if (readBack === undefined && result.kind !== "registration") {
				failAfterSave(
					"Your answers were saved, but the saved case was not available to choose the next screen. Reload the app and try again.",
					"source-case-unavailable",
				);
				return;
			}
			if (readBack !== undefined) {
				caseData = readBack;
				boundCaseName = readBack.get(caseType)?.get("case_name");
			}
		}
		try {
			const doc = submitted.doc;
			const routeMenuSource = {
				doc,
				modules: doc.modules,
				moduleOrder: doc.moduleOrder,
				caseTypes: doc.caseTypes ?? [],
				forms: doc.forms,
				formOrder: doc.formOrder,
			};
			const caseFirstModules = previewCaseFirstModuleUuids(doc);
			const submission: CarriedSubmission = {
				...(resultCaseIds.length === 1 && { caseId: resultCaseIds[0] }),
				...(boundCaseName !== undefined && { caseName: boundCaseName }),
				childCases: carriedCasesFromPatch({
					caseDatabasePatch,
					primaryCaseIds: resultCaseIds,
				}),
			};
			const input = {
				doc,
				formUuid: sourceFormUuid,
				routeMenuUuid: sourceModuleUuid,
				session: previewSessionValues(entryIdentity, previewDevice),
				usercase: postSubmissionUsercase,
				/* The entry's own session map: the device's session does not
				 * change when the form closes, so a link reads the ids its form
				 * read, created cases included. */
				sessionDatums: afterSubmitSessionDatums(
					submitted.entrySession,
					submission,
					result.kind === "registration" ? result.caseId : undefined,
				),
				caseDatabase: refreshedCaseDatabase,
				lookupData: controller.previewLookupDataSnapshot,
				...(submitted.entrySession?.searchResults === undefined
					? {}
					: { searchResults: submitted.entrySession.searchResults }),
			};
			const evaluatedFrames = await controller.evaluateFormLinkXPaths(
				sourceEntryKey,
				async (evaluateLink) => {
					const world = createFormLinkWorkerWorld(
						input,
						`form-link-${uuidv4()}`,
					);
					/* Every frame and every carried value reads the one
					 * post-submit world, as Core evaluates a form's stack
					 * operations in one context. */
					const choices = await evaluateAfterSubmitAsync({
						input,
						evaluate: evaluateLink,
						world,
					});
					const frames = [];
					for (const choice of choices) {
						const entry = frameChoiceEntry(choice);
						frames.push({
							choice,
							projectedSelections:
								entry === undefined
									? []
									: await projectTargetCaseSelectionsAsync(
											input,
											sourceFormUuid,
											entry,
											evaluateLink,
											world,
										),
						});
					}
					return frames;
				},
			);
			if (!isCurrent()) {
				announceWrite();
				settleAttempt({ kind: "idle" });
				return;
			}
			/* The menu reads the live lookup snapshot; the form's own capture
			 * stands in until one arrives. */
			const targetLookup = (): PreviewLookupStatus => {
				const live = visibilityInputsRef.current.lookupStatus;
				if (live.kind === "data") return live;
				const captured = input.lookupData;
				return captured === null || captured === undefined
					? live
					: { kind: "data", data: captured };
			};
			const mode = platformRules.afterSubmitFrames;
			/* Each frame's route and landing are fixed as it is pushed. Web Apps
			 * opens the frame on top and keeps nothing beneath it, so only that
			 * one is routed there: a frame that never opens never waits on the
			 * menu's data. */
			const routable =
				mode === "top" ? evaluatedFrames.slice(-1) : evaluatedFrames;
			const pushed: PendingAfterSubmitFrame<PreviewAfterSubmitFrame>[] = [];
			for (const { choice, projectedSelections } of routable) {
				const collection = automaticLinkedCaseCollection({
					choice,
					doc,
					sourceModuleUuid,
					sourceFormType: submitted.formType,
					sourceFormUuid,
					submittedCases: submitted.cases,
					resultCaseIds,
					caseDatabase: refreshedCaseDatabase,
				});
				const collections = collection === undefined ? [] : [collection];
				const routeOnce = () =>
					afterSubmitRoute({
						sourceModuleUuid,
						previousTask: () =>
							resolvePreviousTask({
								platform: previewDevice.platform,
								doc,
								formUuid: sourceFormUuid,
								submittedCaseIds: resultCaseIds,
								selections: menuCaseSelections,
								caseDatabase: refreshedCaseDatabase,
							}),
						choice,
						sourceFormUuid,
						doc,
						caseFirstModules,
						hasSelectedCase: (targetModuleUuid, selections) =>
							previewTargetHasSelectedCase({
								menuSource: routeMenuSource,
								current: selectionsForModuleTask(
									doc,
									targetModuleUuid,
									menuCaseSelections,
								),
								targetModuleUuid,
								projected: selections,
								collections,
							}),
						carriedCase: (entry) =>
							carriedCaseFromSelections(input, entry, projectedSelections),
						caseSelections: () => projectedSelections,
						rules: platformRules,
						targetVisibility: (target) =>
							afterSubmitTargetVisibility({
								doc,
								target,
								session: previewSessionValues(entryIdentity, previewDevice),
								lookup: targetLookup(),
								deviceCases: {
									snapshot: refreshedCaseDatabase,
									caseTypes: submitted.caseTypes,
								},
								caseSelections: projectedSelections,
							}),
					});
				const settled = await settleAfterSubmitRoute({
					route: routeOnce,
					lookup: targetLookup,
					nextInputs: nextVisibilityInputs,
					isCurrent,
					runningIdentity: () => visibilityInputsRef.current.previewIdentity,
					entryIdentity,
				});
				if (settled.kind === "lookup-unavailable") {
					failAfterSave(
						"Your answers were saved, but the next screen depends on lookup data that didn't load. Reload the app and try again.",
						"target-lookup-unavailable",
					);
					return;
				}
				if (settled.kind === "stale") {
					announceWrite();
					settleAttempt({ kind: "idle" });
					return;
				}
				const frameRoute = settled.route;
				if (frameRoute.kind === "unresolvable") {
					failAfterSave(
						"Your answers were saved, but the next screen could not be found. Reload the app and try again.",
						"route-unresolvable",
					);
					return;
				}
				pushed.push({
					route: {
						route: frameRoute,
						...(collection === undefined ? {} : { collection }),
					},
					landing: afterSubmitFrameLanding({
						doc,
						route: frameRoute,
						collection,
						sourceModuleUuid,
						selections: menuCaseSelections,
					}),
				});
			}
			/* The entry the worker submitted, as the path its frame took: the
			 * stack keeps what is pending only while that path begins with the
			 * last frame's landing (`CommCareSession.java::cleanStack`). */
			const completed = completeAfterSubmit(
				session.getState().previewAfterSubmitStack,
				submittedEntryPath({
					doc,
					moduleUuid: sourceModuleUuid,
					formUuid: sourceFormUuid,
					caseIdsOf: (moduleUuid) =>
						moduleUuid === sourceModuleUuid
							? (submitted.caseIds ?? [])
							: (menuCaseSelections[moduleUuid]?.cases.map(
									(choice) => choice.caseId,
								) ?? []),
				}),
				pushed,
				mode,
			);
			session.getState().setPreviewAfterSubmitStack(completed.state);
			const next = completed.next;
			if (next === undefined) {
				/* Nothing left to run: the app home, the app's first screen in
				 * Web Apps and the phone's home screen on Android. */
				retireCompletedTask();
				announceWrite();
				settleAttempt({ kind: "idle" });
				forgetCompletedPages();
				dispatchPostSubmit("app_home", sourceModuleUuid, submitted);
				return;
			}
			const { route } = next;
			const linkedCaseCollection = next.collection;
			const linkedCaseCollections =
				linkedCaseCollection === undefined ? [] : [linkedCaseCollection];
			let targetCaseData = caseData;
			let targetFormCaseData: ReturnType<typeof caseDatabaseToFormPreloads>;
			if (route.kind === "module" || route.kind === "form") {
				const hydratedCases = new Set<string>();
				for (const [caseType, properties] of targetCaseData) {
					const caseId = properties.get("case_id");
					if (caseId !== undefined && caseId !== "") {
						hydratedCases.add(`${caseType}\0${caseId}`);
					}
				}
				for (const selection of route.caseSelections) {
					if (selection.caseId === "") continue;
					const selectionKey = `${selection.caseType}\0${selection.caseId}`;
					if (hydratedCases.has(selectionKey)) continue;
					const chain = reachableCaseTypes(
						selection.caseType,
						submitted.caseTypes,
					);
					const loaded = caseDatabaseToFormPreloads(
						refreshedCaseDatabase,
						selection.caseId,
						chain,
					);
					if (loaded === undefined) {
						failAfterSave(
							"Your answers were saved, but the next case was not in the saved device state. Reload the app and try again.",
							"target-case-unavailable",
						);
						return;
					}
					targetCaseData = new Map([...targetCaseData, ...loaded]);
					for (const [loadedCaseType, properties] of loaded) {
						const loadedCaseId = properties.get("case_id");
						if (loadedCaseId !== undefined && loadedCaseId !== "") {
							hydratedCases.add(`${loadedCaseType}\0${loadedCaseId}`);
						}
					}
				}
				targetFormCaseData =
					route.kind === "form" &&
					route.carried.kind === "carried" &&
					route.carried.caseId !== ""
						? caseDatabaseToFormPreloads(
								refreshedCaseDatabase,
								route.carried.caseId,
								reachableCaseTypes(
									doc.modules[route.moduleUuid]?.caseType,
									submitted.caseTypes,
								),
							)
						: undefined;
				if (
					route.kind === "form" &&
					route.carried.kind === "carried" &&
					route.carried.caseId !== "" &&
					targetFormCaseData === undefined
				) {
					failAfterSave(
						"Your answers were saved, but the linked form's case was not in the saved device state. Reload the app and try again.",
						"carried-case-unavailable",
					);
					return;
				}
			}
			/* Target hydration no longer depends on the source form or its case
			 * binding. Invalidation may now rebuild/clear that source safely. */
			if (route.kind !== "previous-task" && route.kind !== "unresolvable")
				retireCompletedTask();
			announceWrite();
			const applyCaseSelections = (): void => {
				if (route.kind !== "module" && route.kind !== "form") return;
				const projectedSelections = previewMenuSelectionsAfterTargetCases(
					routeMenuSource,
					menuCaseSelections,
					route.caseSelections,
					targetCaseData,
					linkedCaseCollections,
				);
				const nextSelections =
					route.kind === "module"
						? selectionsForModuleTask(
								doc,
								route.moduleUuid,
								projectedSelections,
							)
						: projectedSelections;
				const home = firstMenuSelections(
					linkedFirstMenuCases(route.caseSelections),
					projectedSelections,
					platformRules,
				);
				if (home) showFrameFirstMenu(navigate, session, home);
				for (const selectedModuleUuid of routeMenuSource.moduleOrder) {
					const current = menuCaseSelections[selectedModuleUuid];
					const next = nextSelections[selectedModuleUuid];
					const installsExactCollection = linkedCaseCollections.some(
						(collection) => collection.moduleUuid === selectedModuleUuid,
					);
					if (
						!installsExactCollection &&
						current?.caseType === next?.caseType &&
						previewCaseChoiceIdsEqual(current?.cases, next?.cases)
					) {
						continue;
					}
					setPreviewMenuCaseSelection(selectedModuleUuid, next);
				}
			};
			switch (route.kind) {
				case "previous-task": {
					letSubmittedSearchesGo();
					for (const uuid of routeMenuSource.moduleOrder)
						setPreviewMenuCaseSelection(uuid, route.task.selections[uuid]);
					setPreviewSelectedCase(undefined);
					setPreviewCaseTarget(undefined);
					const next = route.task.destination;
					session.getState().setPreviewParentCaseRequest(undefined);
					session.getState().setPreviewTaskContinuation(
						next.kind === "home"
							? undefined
							: {
									moduleUuid: next.moduleUuid,
									...(next.kind === "record-selection" && {
										formUuid: next.formUuid,
									}),
									selectingModuleUuids:
										next.kind === "record-selection"
											? next.selectingModuleUuids
											: [],
									caseDatabase: route.task.caseDatabase,
								},
					);
					settleAttempt({ kind: "idle" });
					forgetCompletedPages();
					if (next.kind === "home") {
						showFrameFirstMenu(navigate, session, route.task.selections);
					} else if (next.kind === "menu") navigate.openModule(next.moduleUuid);
					else {
						setPreviewCaseTarget({
							formUuid: next.formUuid,
							caseDatabase: refreshedCaseDatabase,
						});
						const [first, ...remaining] = next.selectingModuleUuids;
						if (first === undefined)
							throw new Error("The preceding record selector is unavailable.");
						if (remaining.length > 0 || first !== next.moduleUuid)
							session.getState().setPreviewParentCaseRequest({
								selectingModuleUuid: first,
								returnModuleUuids:
									remaining.length > 0 ? remaining : [next.moduleUuid],
								resumeLocation:
									remaining.length > 0
										? { kind: "cases", moduleUuid: next.moduleUuid }
										: {
												kind: "form",
												moduleUuid: next.moduleUuid,
												formUuid: next.formUuid,
											},
								cancelLocation: { kind: "module", moduleUuid: next.moduleUuid },
							});
						navigate.openCaseList(first);
					}
					return;
				}
				case "post-submit":
					settleAttempt({ kind: "idle" });
					forgetCompletedPages();
					dispatchPostSubmit(
						route.destination,
						submitted.moduleUuid,
						submitted,
						refreshedCaseDatabase,
					);
					return;
				case "module":
					applyCaseSelections();
					settleAttempt({ kind: "idle" });
					forgetCompletedPages();
					openModuleLanding(navigate, route.moduleUuid, route.landing);
					return;
				case "form":
					forgetCompletedPages(route.formUuid);
					applyCaseSelections();
					/* The target's case binding is rewritten BEFORE the push, so
					 * the form mounts already bound (or already bound to nothing)
					 * rather than auto-selecting a case for one render. */
					setPreviewSelectedCase(undefined);
					setPreviewCaseTarget({
						formUuid: route.formUuid,
						openedByLink: true,
						...(linkedCaseCollection !== undefined
							? { cases: linkedCaseCollection.cases }
							: route.carried.kind === "carried"
								? {
										cases:
											route.carried.caseId === ""
												? []
												: [
														{
															caseId: route.carried.caseId,
															...(route.carried.caseName !== undefined && {
																caseName: route.carried.caseName,
															}),
														},
													],
										...(targetFormCaseData === undefined
											? {}
											: { caseData: targetFormCaseData }),
									}
								: {}),
						caseDatabase: refreshedCaseDatabase,
					});
					settleAttempt({ kind: "idle" });
					navigate.openForm(route.moduleUuid, route.formUuid);
					return;
				/* Neither is ever pushed: each fails as its frame is routed. */
				case "unresolvable":
				case "pending":
					failAfterSave(
						"Your answers were saved, but the next screen could not be found. Reload the app and try again.",
						"route-unresolvable",
					);
					return;
				default: {
					const _exhaustive: never = route;
					throw new Error(
						unhandledKindMessage({
							where: "preview.FormScreen.dispatchAfterSubmit",
							family: "AfterSubmitRoute",
							received: _exhaustive,
							knownKinds: [
								"post-submit",
								"previous-task",
								"module",
								"form",
								"results-with-registered-case",
								"unresolvable",
								"pending",
							],
						}),
					);
				}
			}
		} catch (error) {
			/* The links read data a phone holds none of. The engine holds that
			 * refusal and this screen shows it; it is the Project's data, not a
			 * fault, so nothing is reported. */
			if (previewDataRefusalOf(error) !== undefined) {
				announceWrite();
				settleAttempt({ kind: "idle" });
				return;
			}
			failAfterSave(
				"Your answers were saved, but the next screen could not be chosen. Reload the app and try again.",
				"evaluation-failed",
			);
		}
	};

	const revealAndFocusTarget = useCallback(
		(
			target: InvalidFieldTarget,
			controlSelector: string,
			requireInvalid: boolean,
		): void => {
			formLayoutRef.current?.expandContainers(target.ancestorUuids);
			requestFocus(() => {
				const body = formBodyElRef.current;
				if (body === null) return;
				const field = [
					...body.querySelectorAll<HTMLElement>("[data-instance-path]"),
				].find(
					(element) =>
						element.dataset.instancePath === target.instancePath &&
						element.dataset.fieldUuid === target.fieldUuid &&
						(!requireInvalid || element.dataset.invalid === "true"),
				);
				if (field === undefined) return;
				const reducedMotion =
					typeof window.matchMedia === "function" &&
					window.matchMedia("(prefers-reduced-motion: reduce)").matches;
				field.scrollIntoView?.({
					behavior: reducedMotion ? "auto" : "smooth",
					block: "center",
				});
				const control = field.querySelector<HTMLElement>(controlSelector);
				(control ?? field).focus();
			});
		},
		[requestFocus],
	);

	const revealInvalidOnPage = useCallback(
		(target: InvalidFieldTarget): void =>
			revealAndFocusTarget(target, INVALID_CONTROL_SELECTOR, true),
		[revealAndFocusTarget],
	);
	/* The running form pages on the platform Preview plays
	 * (`useFormPaging`): Web Apps draws the whole form on one screen, sections
	 * as titled groups; Android pages a sectioned form one section at a time
	 * and any other form one field-list group or question at a time. The hook
	 * is inert in edit mode, where the canvas shows every page at once. */
	const formIsSectioned = usePresentationFormIsSectioned(formUuid);
	const paging = useFormPaging({
		formUuid,
		mode:
			mode !== "preview" || platformRules.formScreens === "one-screen"
				? "none"
				: formIsSectioned
					? "sections"
					: "screens",
		revealInvalid: revealInvalidOnPage,
		refuse: announceReview,
	});
	/* On one screen no pager writes the remembered page, so the section in
	 * view does, and a flip to edit mode opens on it. */
	useScrolledSection({
		formUuid,
		enabled:
			mode === "preview" &&
			platformRules.formScreens === "one-screen" &&
			formIsSectioned,
		bodyRef: formBodyElRef,
	});
	/** Turn to the page holding a question before revealing it, so the
	 *  reveal's DOM query finds it mounted. A no-op on one screen. */
	const showPageOf = paging.showPageOf;
	const showFirstPage = paging.showFirst;

	const focusAttachmentInvariantRecovery = useCallback(
		(fieldUuid: string | undefined): void => {
			requestFocus(() => {
				const candidates = [
					...(formBodyElRef.current?.querySelectorAll<HTMLElement>(
						"[data-attachment-recovery-field-uuid]",
					) ?? []),
				];
				const recovery =
					candidates.find(
						(candidate) =>
							fieldUuid === undefined ||
							candidate.dataset.attachmentRecoveryFieldUuid === fieldUuid,
					) ?? candidates[0];
				recovery?.scrollIntoView?.({ block: "center" });
				recovery?.focus();
			});
		},
		[requestFocus],
	);

	const handleSubmit = async (): Promise<void> => {
		/* The press reads what Submit offers from the state at this moment: the
		 * entry store and the session move ahead of the render this handler
		 * belongs to, and a queued click can land after a synchronous reset but
		 * before React commits it. Where the offer is anything but `offered`,
		 * Submit's next render is disabled for that same reason (or busy), so
		 * the press is not lost on a Submit that looks ready. */
		const currentEntry = controller.entryStore.getState();
		const start = session.getState();
		const pressOffer = previewSubmitOffer({
			...submitState,
			clearing: submitState.clearing || clearInFlightRef.current,
			entry:
				submitState.entry === "ready" && currentEntry.rebuilding
					? "rebuilding"
					: submitState.entry,
			caseDatabase:
				currentEntry.caseDatabaseWait === undefined
					? submitState.caseDatabase
					: currentEntry.caseDatabaseWait.status === "error"
						? "failed"
						: "refreshing",
			repeatSettling:
				submitState.repeatSettling || currentEntry.topologySettling,
			access: previewSubmitAccess({
				accessPhase: start.accessPhase,
				canEdit: start.canEdit,
				sameApp: start.appId === appId,
				entryAuthorityCurrent:
					appId === undefined ||
					(entryKey !== undefined &&
						hasAttachmentEntryWriteAuthority(entryKey)),
			}),
		});
		if (pressOffer.kind !== "offered") return;

		/* The press is taken: Submit is busy from here, through the save
		 * barrier, until the attempt settles. */
		const attempt = ++submissionAttemptRef.current;
		const attemptIsCurrent = () => submissionAttemptRef.current === attempt;
		const settleAttempt = (status: SubmitStatus): void => {
			if (attemptIsCurrent()) setSubmitStatus(status);
		};
		/* Clear any prior error state up-front. Two reasons:
		 *
		 *   1. A stale server-error header from a previous submit would
		 *      otherwise stay visible while the user is on a *different*
		 *      failure path (validate-fail or appId-guard) whose actual
		 *      remediation surfaces in a different UI element (per-field
		 *      required indicators).
		 *   2. A second submit after a server error must replace, not
		 *      augment: the alert always reflects the latest attempt. */
		settleAttempt({ kind: "running" });
		setValidationAnnouncement(undefined);
		// Mouse activation retains focus until this point so validation cannot
		// move the button mid-click. Now let the field commit its local draft.
		const active = document.activeElement;
		if (
			active instanceof HTMLElement &&
			formBodyElRef.current?.contains(active)
		)
			active.blur();
		const submittedBase = { ...submissionContextRef.current };
		/* A submission program is derived from the committed blueprint, while
		 * answers and after-submit routing come from this tab's document. Flush
		 * local edits first; the digest fence below then refuses any collaborator
		 * or save race that lands between this snapshot and the server lock. */
		const saveOutcome = await collab?.reconciler.waitForHumanSaveBarrier();
		if (saveOutcome !== undefined && saveOutcome.kind !== "saved") {
			settleAttempt({
				kind: "error",
				message:
					"This app couldn't finish saving. Reload it before submitting the form.",
			});
			return;
		}
		/* From here a press can only go stale: the worker moved, the entry
		 * changed, or access changed while the app saved. The screen already
		 * shows the new state (a different entry, or Submit disabled with its
		 * reason), so the attempt settles back to idle and writes nothing. */
		const afterSave = session.getState();
		if (
			afterSave.accessPhase !== "authorized" ||
			!afterSave.canEdit ||
			afterSave.appId !== appId ||
			afterSave.scopeEpoch !== start.scopeEpoch
		) {
			settleAttempt({ kind: "idle" });
			return;
		}
		const afterSaveContext = submissionContextRef.current;
		if (
			afterSaveContext.scopeEpoch !== submittedBase.scopeEpoch ||
			afterSaveContext.appId !== submittedBase.appId ||
			afterSaveContext.formUuid !== submittedBase.formUuid ||
			afterSaveContext.moduleUuid !== submittedBase.moduleUuid ||
			afterSaveContext.entryKey !== submittedBase.entryKey ||
			afterSaveContext.personaUuid !== submittedBase.personaUuid ||
			!stringArrayValuesEqual(afterSaveContext.caseIds, submittedBase.caseIds)
		) {
			settleAttempt({ kind: "idle" });
			return;
		}
		const submittedSnapshot = (doc: BlueprintDoc): SubmittedContextSnapshot => {
			const submittedForm =
				submittedBase.formUuid === undefined
					? undefined
					: doc.forms[submittedBase.formUuid];
			return {
				...submittedBase,
				formType: submittedForm?.type,
				destination:
					submittedBase.formUuid === undefined
						? undefined
						: effectivePostSubmit(doc, submittedBase.formUuid),
				moduleCaseType:
					submittedBase.moduleUuid === undefined
						? undefined
						: doc.modules[submittedBase.moduleUuid]?.caseType,
				links: submittedForm?.formLinks,
				doc,
				caseDatabase: controller.previewCaseDatabaseSnapshot,
				entrySession: controller.entrySession,
				identity: controller.previewIdentitySnapshot,
				caseTypes: materializableCaseTypesFromDoc(doc),
			};
		};
		let submittedDocState = docApi.getState();
		let submissionRevisionFinal = false;
		let submitted = submittedSnapshot(
			structuredClone(pickBlueprintDoc(submittedDocState)),
		);
		/* The committed document no longer holds the form (a collaborator
		 * removed it while the app saved, and location recovery is moving the
		 * screen), or the entry is gone: stale, never a fault, since a form the
		 * document holds always names where it goes (`submitOffer.ts`). */
		if (
			submitted.scopeEpoch !== start.scopeEpoch ||
			submitted.formUuid === undefined ||
			submitted.entryKey === undefined ||
			(submitted.links === undefined && submitted.destination === undefined)
		) {
			settleAttempt({ kind: "idle" });
			return;
		}
		const submittedEntryKey = submitted.entryKey;
		const isCurrent = () => {
			const current = session.getState();
			const latest = submissionContextRef.current;
			return (
				attemptIsCurrent() &&
				current.scopeEpoch === submitted.scopeEpoch &&
				current.accessPhase === "authorized" &&
				current.canEdit &&
				latest.scopeEpoch === submitted.scopeEpoch &&
				latest.appId === submitted.appId &&
				latest.formUuid === submitted.formUuid &&
				latest.moduleUuid === submitted.moduleUuid &&
				latest.entryKey === submitted.entryKey &&
				latest.personaUuid === submitted.personaUuid &&
				stringArrayValuesEqual(latest.caseIds, submitted.caseIds) &&
				latest.formType === submitted.formType &&
				latest.destination === submitted.destination &&
				latest.moduleCaseType === submitted.moduleCaseType &&
				(!submissionRevisionFinal || docApi.getState() === submittedDocState) &&
				controller.entryKey === submitted.entryKey &&
				controller.formUuid === submitted.formUuid &&
				/* Leaving the screen while a read is in flight means the person
				 * went somewhere else; the route must not follow them there. */
				mountedRef.current
			);
		};
		/* `appId` is provided by the builder route; the test-mode submit
		 * button only mounts under a builder session, so a missing slot
		 * is an upstream contract failure. Guard explicitly so a
		 * stale-mount path surfaces a readable inline message rather
		 * than reaching the server action with `undefined`. */
		const submittedAppId = submitted.appId;
		if (!submittedAppId) {
			settleAttempt({
				kind: "error",
				message:
					"This app isn't fully loaded yet. Wait a moment and try again.",
			});
			return;
		}
		/* Access changed while the app saved: Submit's render now reads the
		 * access check (or no edit access) as its reason. */
		if (!hasAttachmentEntryWriteAuthority(submittedEntryKey)) {
			settleAttempt({ kind: "idle" });
			return;
		}

		/* The mutation that landed, kept beside the result: the after-submit
		 * links need the case types of the children it created, which the
		 * result reports only by id. */
		let validation: EngineValidationCompletion | undefined;
		try {
			const submitStableAnswers = async (): Promise<
				SubmissionResult | "invalid" | "save-failed" | "stale" | "not-processed"
			> => {
				if (!isCurrent()) return "stale";
				validation = await controller.validateAllAsync();
				if (!controller.isValidationCurrent(validation)) return "stale";
				if (validation.kind === "invalid") return "invalid";
				if (validation.kind !== "valid") return "stale";
				/* Android opened this form for a case the phone does not hold, and
				 * the form updates or closes it: Core's `loadCase` throws, and the
				 * phone keeps the form from HQ (`entryPointUnheldCaseSubmit`).
				 * Nothing is written. */
				const submittedFormUuid = submitted.formUuid;
				const blankCaseIds = entryPointLaunch?.blankCaseIds ?? [];
				if (
					platformRules.entryPointUnheldCaseSubmit === "not-processed" &&
					submittedFormUuid !== undefined &&
					(submitted.caseIds ?? []).some((caseId) =>
						blankCaseIds.includes(caseId),
					) &&
					formChangesSessionCase(
						submitted.doc,
						submittedFormUuid,
						controller.ownCloseHolds(),
					)
				)
					return "not-processed";
				const submission = await controller.computeSubmissionMutationAsync(
					{ caseIds: submitted.caseIds },
					submittedEntryKey,
					validation,
				);
				if (submission === undefined) return "stale";
				const { mutation, documentState: finalDocState } = submission;
				/* The controller returns the exact Zustand state its reconciled engine
				 * consumed while constructing this mutation. Do not recapture here: a
				 * queued collaborator publication can run between promise resolution and
				 * this continuation. Require that paired revision through the save barrier,
				 * digest, and action dispatch. A retained FormScreen may be hidden while an
				 * author edits elsewhere, so route identity alone cannot fence this
				 * boundary. */
				if (docApi.getState() !== finalDocState) return "stale";
				const finalDoc = structuredClone(pickBlueprintDoc(finalDocState));
				const finalSubmitted = submittedSnapshot(finalDoc);
				if (mutation.formUuid !== finalSubmitted.formUuid) return "stale";
				if (
					finalSubmitted.links === undefined &&
					finalSubmitted.destination === undefined
				)
					return "stale";
				const finalSaveOutcome =
					await collab?.reconciler.waitForHumanSaveBarrier();
				if (
					finalSaveOutcome !== undefined &&
					finalSaveOutcome.kind !== "saved"
				) {
					return "save-failed";
				}
				if (
					docApi.getState() !== finalDocState ||
					!controller.isValidationCurrent(validation)
				)
					return "stale";
				const finalBlueprintDigest = await blueprintRevisionDigest(finalDoc);
				if (
					docApi.getState() !== finalDocState ||
					!controller.isValidationCurrent(validation)
				)
					return "stale";
				submittedDocState = finalDocState;
				submitted = finalSubmitted;
				submissionRevisionFinal = true;
				if (!isCurrent()) return "stale";
				/* The persona rides the WRITE, not just the reads. Its uuid is the
				 * `owner_id` stamped on every case this submission creates, so
				 * dropping it here would quietly give a persona's work to the
				 * signed-in member while every read still looked persona-scoped. */
				return await submitFormAction(
					entrySupplies ? { ...mutation, entrySupplies } : mutation,
					submittedAppId,
					finalBlueprintDigest,
					viewerTimeZone(),
					submitted.personaUuid,
					/* The places the entry opened with: an owner moved to a place
					 * is resolved among the ones the form read. */
					submitted.caseDatabase.locations?.map((place) => place.id),
					previewDevice,
				);
			};
			const result = await runFormAttachmentBarrier(
				submittedEntryKey,
				submitStableAnswers,
				{
					classifySlot: ({ instancePath }) =>
						controller.attachmentPathDisposition(instancePath),
				},
			);
			if (!isCurrent()) {
				if (
					result !== "stale" &&
					result !== "invalid" &&
					result !== "save-failed" &&
					result !== "not-processed" &&
					(result.kind === "registration" ||
						result.kind === "followup" ||
						result.kind === "close" ||
						(result.kind === "survey" &&
							(result.caseDatabasePatch?.rows.length ?? 0) > 0))
				) {
					for (const caseType of new Set([
						...submitted.caseTypes.map(({ name }) => name),
						...(result.caseDatabasePatch?.rows.map(
							({ case_type }) => case_type,
						) ?? []),
					])) {
						invalidateCaseData(submittedAppId, caseType);
					}
				}
				settleAttempt({ kind: "idle" });
				return;
			}
			if (result === "stale") {
				settleAttempt({ kind: "idle" });
				return;
			}
			if (result === "save-failed") {
				settleAttempt({
					kind: "error",
					message:
						"This app couldn't finish saving. Reload it before submitting the form.",
				});
				return;
			}
			if (result === "not-processed") {
				settleAttempt({ kind: "idle" });
				showToast(
					"error",
					runtimeMessage(language.language, "formNotProcessedTitle"),
					runtimeMessage(language.language, "formNotProcessedDetail"),
				);
				/* The phone leaves the form and lands where its after-submit
				 * destination lands; with no write there is no earlier task to
				 * return to, so `previous` lands on the form's module. A form
				 * with destinations evaluates none of them with nothing saved,
				 * and lands on the app home. Its session ends with the form, and
				 * its searches with it. */
				letSubmittedSearchesGo();
				dispatchPostSubmit(
					submitted.destination === undefined
						? "app_home"
						: submitted.destination === "previous"
							? "module"
							: submitted.destination,
					submitted.moduleUuid,
					submitted,
				);
				return;
			}
			if (result === "invalid") {
				settleAttempt({ kind: "idle" });
				if (
					validation?.kind !== "invalid" ||
					!controller.isValidationCurrent(validation) ||
					validation.target === undefined
				)
					return;
				// The focused question supplies the specific correction.
				announceReview();
				showPageOf(validation.target);
				revealInvalidOnPage(validation.target);
				return;
			}
			if (
				result.kind === "registration" ||
				result.kind === "followup" ||
				result.kind === "close" ||
				result.kind === "survey"
			) {
				await dispatchAfterSubmit({
					submitted: {
						...submitted,
						appId: submittedAppId,
					},
					result,
					isCurrent,
					settleAttempt,
					announceWrite: () => {
						if (
							result.kind === "survey" &&
							(result.caseDatabasePatch?.rows.length ?? 0) === 0
						)
							return;
						/* A case-bearing submission may update the primary case plus
						 * operation-created or related cases. Announce the settled
						 * write against the live materializable catalog before
						 * leaving the form so Results, Details, bound forms, and the
						 * Case data count all converge from the same shared revision
						 * signal. */
						for (const caseType of new Set([
							...submitted.caseTypes.map(({ name }) => name),
							...(result.caseDatabasePatch?.rows.map(
								({ case_type }) => case_type,
							) ?? []),
						])) {
							invalidateCaseData(submittedAppId, caseType);
						}
					},
				});
				return;
			}
			settleAttempt({
				kind: "error",
				message: describeSubmitError(result),
			});
		} catch (error) {
			if (!isCurrent()) {
				settleAttempt({ kind: "idle" });
				return;
			}
			if (error instanceof AttachmentNotReadyError) {
				settleAttempt({ kind: "idle" });
				announce(`Attachment needs attention. ${error.message}`);
				const hasInvariantRecovery = [
					...(formBodyElRef.current?.querySelectorAll<HTMLElement>(
						"[data-attachment-recovery-field-uuid]",
					) ?? []),
				].some(
					(candidate) =>
						error.fieldUuid === undefined ||
						candidate.dataset.attachmentRecoveryFieldUuid === error.fieldUuid,
				);
				if (hasInvariantRecovery) {
					focusAttachmentInvariantRecovery(error.fieldUuid);
					return;
				}
				const target = controller.fieldTarget(
					error.instancePath,
					error.fieldUuid,
				);
				if (target !== undefined) {
					showPageOf(target);
					revealAndFocusTarget(target, "[data-attachment-recovery]", false);
				} else {
					focusAttachmentInvariantRecovery(error.fieldUuid);
				}
				return;
			}
			/* Wire-level failures (RSC serialization, transport rejects)
			 * and any invariant throw the action / engine surfaces collapse
			 * to one user-facing line. The throw's message body carries
			 * implementation jargon (compiler-bug invariants, framework
			 * stack traces) that doesn't belong on the user's screen, so
			 * we deliberately ignore it and emit the same generic line
			 * `CaseListScreen.handleGenerate` uses for its sibling case. */
			settleAttempt({
				kind: "error",
				message: "Could not submit form. Try again.",
			});
		}
	};

	/* Clear-form button: retire the whole prior entry, synchronously mount a
	 * fresh idempotency scope, and reset the submit lifecycle. Staged-row
	 * cleanup is best effort and cannot later wipe answers entered here. */
	const handleClear = useCallback(
		async (event: ReactMouseEvent<HTMLButtonElement>): Promise<void> => {
			const authority = session.getState();
			if (
				authority.accessPhase !== "authorized" ||
				!authority.canEdit ||
				authority.appId !== appId ||
				event.detail > 1 ||
				clearInFlightRef.current ||
				submitStatus.kind === "running"
			) {
				return;
			}
			clearInFlightRef.current = true;
			setClearState({ kind: "starting" });
			setSubmitStatus({ kind: "idle" });
			setValidationAnnouncement(undefined);
			showFirstPage();
			const settleClear = (): void => {
				clearInFlightRef.current = false;
				setClearState({ kind: "idle" });
			};
			try {
				if (entryKey === undefined) {
					await controller.resetAsync();
					setClearRevision((revision) => revision + 1);
					settleClear();
					return;
				}
				if (appId !== undefined) {
					retireAttachmentEntry({ appId, entryKey });
				}
				const nextEntryKey = await controller.restartActiveEntryAsync();
				if (nextEntryKey === undefined) {
					settleClear();
					return;
				}
				setClearState({ kind: "awaiting-entry", entryKey: nextEntryKey });
			} catch (error) {
				/* A restart that failed leaves no fresh entry to wait for; Submit
				 * must not stay busy behind it. */
				settleClear();
				throw error;
			}
		},
		[appId, controller, entryKey, session, showFirstPage, submitStatus.kind],
	);

	// A fresh entry waits for its selected record and ancestor preloads before
	// running one-time defaults and query snapshots. An existing entry can
	// retain its settled inputs while an equivalent own-row read refreshes;
	// submission still requires the current authoritative binding.
	const selectedCaseLoading =
		needsBoundCase &&
		(effectiveCaseIds?.length ?? 0) > 0 &&
		!caseBindingReady &&
		(caseData === undefined ||
			caseBindingReplaced ||
			reachableChain.length > 1);
	// Runtime readiness freezes worker interactions, never the authoring canvas.
	// An edit can mount a text editor while the background engine is rebuilding;
	// making that canvas inert drops its one-shot autofocus on the floor.
	const formFrozen =
		mode === "preview" &&
		(submitStatus.kind === "running" ||
			clearRunning ||
			engineInitializing ||
			engineRebuilding ||
			selectedCaseLoading ||
			caseDatabaseWait !== undefined ||
			repeatTopologySettling);
	const blockFrozenInteraction = useCallback(
		(event: SyntheticEvent): void => {
			if (!formFrozen) return;
			event.preventDefault();
			event.stopPropagation();
		},
		[formFrozen],
	);
	/* A frozen form keeps every key its controls take as input, as it keeps
	 * every click. Escape is no input to any of them (the form's popups sit
	 * outside it, in their portals), so it goes on to the page's shortcuts,
	 * which hear a key last and leave alone one something already took
	 * (`lib/ui/keyboardManager.ts`): Escape leaves Preview while the form
	 * rebuilds, as the Preview button beside it does. */
	const blockFrozenKey = useCallback(
		(event: SyntheticEvent<HTMLElement, KeyboardEvent>): void => {
			if (event.nativeEvent.key === "Escape") return;
			blockFrozenInteraction(event);
		},
		[blockFrozenInteraction],
	);
	/* The latest reveal runs once the form is live, two frames after the
	 * commit that unfroze it: an expansion is a React state commit, and the
	 * frames let nested collapsed ancestors mount before the concrete
	 * repeated question is resolved. A form frozen again in those frames
	 * keeps the reveal for the next time it is live. */
	useEffect(() => {
		const request = pendingFocusRef.current;
		if (focusRequest === 0 || formFrozen || request === undefined) return;
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => {
				if (pendingFocusRef.current !== request) return;
				if (formBodyElRef.current?.closest("[inert]")) return;
				cancelPendingFocus();
				request.focus();
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [cancelPendingFocus, focusRequest, formFrozen]);

	if (!form || !formUuid || !moduleUuid) return null;

	/* A fault here means Nova admitted a document its own runtime could not
	 * execute. It is an internal invariant breach, never an editable invalid
	 * draft. Keep the Builder available in Edit, but do not render or submit a
	 * running form against guessed/blank semantics. */
	/* The running app refuses a no-matches registration form that did not
	 * arrive through the Register action on an empty search: the device has
	 * no other door to it (`<menu relevant="false()">`), so neither does
	 * Preview. Edit mode keeps the authoring surface. */
	if (mode === "preview" && noMatchesAdmission.kind === "refused") {
		const copy = caseListRegistrationRefusalCopy(noMatchesAdmission.reason);
		return (
			<div className="flex h-full items-center justify-center px-6 py-10">
				<div
					role="status"
					data-no-matches-refusal={noMatchesAdmission.reason}
					className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
				>
					<div className="space-y-2">
						<h2 className="text-lg font-semibold text-nova-text">
							{copy.title}
						</h2>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							{copy.description}
						</p>
					</div>
					<button
						type="button"
						onClick={() => {
							if (moduleUuid !== undefined) navigate.openCaseList(moduleUuid);
						}}
						className={FORM_PRIMARY_ACTION_CLS}
					>
						Go to Search
					</button>
				</div>
			</div>
		);
	}

	/* A device reaches this form only through its search, so with no
	 * completed search the engine does not activate and the form offers the
	 * way back to Search, as the no-matches form's refusal does. A search
	 * whose inputs or settings refuse it fails the same way every time, so
	 * it says why and offers Search too, never a retry. */
	const invalidSearch =
		readsSearchResults && searchResults.state.kind === "invalid-search"
			? searchResults.state
			: undefined;
	if (mode === "preview" && (searchResultsRefused || invalidSearch)) {
		return (
			<div className="flex h-full items-center justify-center px-6 py-10">
				<div
					role="status"
					data-search-results-refusal={
						searchResultsRefused ? "no-completed-search" : "invalid-search"
					}
					className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
				>
					<div className="space-y-2">
						<h2 className="text-lg font-semibold text-nova-text">
							{runtimeMessage(
								language.language,
								searchResultsRefused
									? "searchResultsRefusalTitle"
									: "searchResultsInvalidTitle",
							)}
						</h2>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							{invalidSearch !== undefined && !searchResultsRefused
								? invalidSearch.message
								: runtimeMessage(language.language, "searchResultsRefusalBody")}
						</p>
					</div>
					<button
						type="button"
						onClick={() => navigate.openCaseList(moduleUuid)}
						className={FORM_PRIMARY_ACTION_CLS}
					>
						{runtimeMessage(language.language, "goToSearch")}
					</button>
				</div>
			</div>
		);
	}

	if (
		mode === "preview" &&
		(runtimeFault !== undefined || submitFault !== undefined)
	) {
		return (
			<div className="flex h-full items-center justify-center px-6 py-10">
				<div
					role="alert"
					data-form-fault={
						runtimeFault !== undefined ? "runtime" : "no-after-submit"
					}
					className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
				>
					<div className="space-y-2">
						<h2 className="text-lg font-semibold text-nova-text">
							This form couldn't open
						</h2>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							{runtimeFault !== undefined
								? "Nova hit an internal problem while preparing this form. Return to Edit to keep working."
								: "Nova hit an internal problem: it couldn't tell where this form goes once it's submitted. Return to Edit to keep working."}
						</p>
					</div>
					<button
						type="button"
						onClick={() => setPreviewing(false)}
						className={FORM_PRIMARY_ACTION_CLS}
					>
						Return to Edit
					</button>
				</div>
			</div>
		);
	}

	/* CommCare refuses to open this form: a setvalue's cast turned away the
	 * selected record's saved value or a question's starting value. The
	 * running app shows no form, so neither does Preview; the next edit or
	 * case-data change opens it again. */
	if (mode === "preview" && formRefusal !== undefined) {
		const caseName =
			effectiveCases?.find((choice) => choice.caseId === formRefusal.caseId)
				?.caseName ?? effectiveCases?.[0]?.caseName;
		return (
			<FormRefusalPanel
				refusal={formRefusal}
				caseName={caseName}
				onChooseAnotherRecord={() => {
					setPreviewSelectedCase(undefined);
					const back = caseListReturn();
					setPreviewCaseTarget(back.target);
					navigate.replace({ kind: "cases", moduleUuid: back.moduleUuid });
				}}
				onBackToList={() => {
					setPreviewSelectedCase(undefined);
					const back = caseListReturn();
					setPreviewCaseTarget(back.target);
					navigate.openCaseList(back.moduleUuid);
				}}
				onBack={() => navigate.openModule(moduleUuid)}
			/>
		);
	}

	/* Building the search this form reads, the device read a starting value
	 * over data it holds none of (a place key of a worker assigned nowhere),
	 * so a phone stops there and never opens the form. An edit or the worker
	 * changing reads it again. */
	if (mode === "preview" && searchDefaultsRefusal !== undefined) {
		return (
			<PreviewDataRefusalPanel
				surface="search"
				reason={searchDefaultsRefusal.reason}
				{...(moduleUuid === undefined ? {} : { moduleUuid })}
				action={{
					label: runtimeMessage(language.language, "back"),
					onClick: () => navigate.openModule(moduleUuid),
				}}
			/>
		);
	}

	/* The device holds none of the data this form read (no places, a table
	 * with no rows), so a phone stops here. At open, rows or places added, or
	 * an edit, open it again; at the links the form is already saved, so
	 * Back is the next step. */
	if (mode === "preview" && dataRefusal !== undefined) {
		return (
			<PreviewDataRefusalPanel
				surface={dataRefusal.stage}
				reason={dataRefusal.reason}
				action={{
					label: runtimeMessage(language.language, "back"),
					onClick: () => navigate.openModule(moduleUuid),
				}}
			/>
		);
	}

	/* A form whose logic reads a data table opens once the session's lookup
	 * snapshot covers it (`EngineController.awaitsLookupCoverage`). A failed
	 * load can be read again; a table the snapshot still lacks is the form's
	 * to change. */
	if (mode === "preview" && lookupWait !== undefined && !engineReady) {
		const copy =
			lookupWait.status === "error"
				? {
						title: "Data tables couldn't load",
						body: "This form reads a data table that didn't load. You can try again.",
					}
				: lookupWait.status === "unavailable"
					? {
							title: "A data table this form reads isn't available",
							body: "This form reads a data table or column this Project doesn't have. You can return to Edit to change what the form reads.",
						}
					: {
							title: "Preparing data tables",
							body: "This form will open when the data tables it reads are ready.",
						};
		return (
			<div className="flex h-full items-center justify-center px-6 py-10">
				<div
					role="status"
					data-lookup-wait={lookupWait.status}
					className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
				>
					<div className="space-y-2">
						<h2 className="text-lg font-semibold text-nova-text">
							{copy.title}
						</h2>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							{copy.body}
						</p>
					</div>
					{lookupWait.status === "error" ? (
						<button
							type="button"
							onClick={reloadLookupData}
							className={FORM_PRIMARY_ACTION_CLS}
						>
							Try again
						</button>
					) : lookupWait.status === "unavailable" ? (
						<button
							type="button"
							onClick={() => setPreviewing(false)}
							className={FORM_PRIMARY_ACTION_CLS}
						>
							Return to Edit
						</button>
					) : null}
				</div>
			</div>
		);
	}

	if (mode === "preview" && caseDatabaseWait !== undefined && !engineReady) {
		const loadFailed = caseDatabaseWait.status === "error";
		return (
			<div className="flex h-full items-center justify-center px-6 py-10">
				<div
					role="status"
					className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
				>
					<div className="space-y-2">
						<h2 className="text-lg font-semibold text-nova-text">
							{loadFailed ? "Case data couldn't load" : "Preparing case data"}
						</h2>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							{loadFailed
								? "Return to Edit to keep working, then try Preview again."
								: "This form will open when its case data is ready."}
						</p>
					</div>
					{loadFailed ? (
						<button
							type="button"
							onClick={() => setPreviewing(false)}
							className={FORM_PRIMARY_ACTION_CLS}
						>
							Return to Edit
						</button>
					) : null}
				</div>
			</div>
		);
	}

	if (
		needsBoundCase &&
		!severalCaseForm &&
		effectiveCaseId !== undefined &&
		carriedCaseData === undefined &&
		caseDataState.kind === "missing"
	) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 px-6">
				<div role="status" className="max-w-xs space-y-2 text-center">
					<h3 className="text-sm font-medium text-nova-text">
						This record is no longer available
					</h3>
					<p className="text-sm text-nova-text-muted">
						The record may have changed or moved out of this worker's access.
						Another record can be selected to continue.
					</p>
				</div>
				<button
					type="button"
					className={FORM_PRIMARY_ACTION_CLS}
					onClick={() => {
						setPreviewSelectedCase(undefined);
						const back = caseListReturn();
						setPreviewCaseTarget(back.target);
						navigate.replace({ kind: "cases", moduleUuid: back.moduleUuid });
					}}
				>
					Choose another record
				</button>
			</div>
		);
	}

	/** A NAV-bound singular case-loading form hitting an auth or transport
	 * failure must surface it. Multi-case forms deliberately have no scalar
	 * preload, so only the one-case arm participates in this read guard. */
	if (
		mode === "preview" &&
		CASE_LOADING_FORM_TYPES.has(form.type) &&
		!severalCaseForm &&
		explicitCases?.length === 1 &&
		effectiveCaseId !== undefined &&
		carriedCaseData === undefined
	) {
		if (caseDataState.kind === "persona-unavailable") {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-4 px-6">
					<div className="max-w-xs space-y-2 text-center">
						<h3 className="text-sm font-medium text-nova-text">
							Choose who Preview runs as
						</h3>
						<p className="text-sm text-nova-text-muted">
							{caseDataState.message}
						</p>
					</div>
				</div>
			);
		}
		if (caseDataState.kind === "unauthenticated") {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-4 px-6">
					<div className="text-center space-y-2">
						<h3 className="text-sm font-medium text-nova-text">
							Sign in to load case data
						</h3>
						<p className="text-sm text-nova-text-muted max-w-xs">
							Your session expired while loading this case. Sign in again to
							continue.
						</p>
					</div>
				</div>
			);
		}
		if (caseDataState.kind === "error") {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-4 px-6">
					<div className="text-center space-y-2">
						<h3 className="text-sm font-medium text-nova-text">
							Could not load case data
						</h3>
						<p className="text-sm text-nova-rose max-w-xs">
							{caseDataState.message}
						</p>
					</div>
				</div>
			);
		}
	}

	/* A cold case-loading entry cannot initialize against an absent target.
	 * Distinguish a settled empty selection from a selected row still loading. */
	const caseMissing =
		needsBoundCase &&
		(effectiveCaseIds === undefined || effectiveCaseIds.length === 0);
	const noSampleCases = caseMissing && autoCases.state.kind === "empty";
	/* An after-submit link opened this form with an EMPTY case id: the device
	 * opens the form bound to nothing, and so does the preview, saying so in
	 * place of the submit row (nothing loads, and Submit has no case to
	 * write). */
	const caseCarriedBlank = needsBoundCase && explicitCases?.length === 0;

	if (
		engineInitializing &&
		(caseCarriedBlank || noSampleCases || (caseMissing && !autoSelectCase))
	) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 px-6">
				<div role="status" className="max-w-xs space-y-2 text-center">
					<h3 className="text-sm font-medium text-nova-text">
						No record selected
					</h3>
					<p className="text-sm text-nova-text-muted">
						{caseCarriedBlank
							? "The link that opened this form carried no record. Another record can be selected from Results."
							: "This form needs an existing record. Results shows the records available to this worker."}
					</p>
				</div>
				<button
					type="button"
					className={FORM_PRIMARY_ACTION_CLS}
					onClick={() => navigate.openCaseList(moduleUuid)}
				>
					Go to Results
				</button>
			</div>
		);
	}

	const canEdit = mode === "edit" && editable;

	const formBody = (
		<>
			{/* `data-form-header` is queried by `InlineTextEditor` as the clamp floor for the floating label toolbar, preserve the attribute if this block is refactored. */}
			<div
				data-form-header
				className="px-6 pt-5 pb-4 border-b border-pv-input-border"
			>
				<div className="flex items-center gap-2">
					<FormTypeButton
						moduleUuid={moduleUuid}
						formUuid={formUuid}
						editable={canEdit}
					/>
					{canEdit ? (
						<EditableTitle
							value={localizedFormName ?? form.name}
							ariaLabel="Form name"
							/* Forward the gated dispatch's outcome: a refused rename
							 * keeps the editor open with the draft and surfaces the
							 * finding inline; the saved checkmark only fires on a
							 * committed rename. */
							onSave={(name) =>
								formUuid
									? language.isSource
										? inline.updateForm(formUuid, { name })
										: formNameEditor.saveTarget(name)
									: undefined
							}
						/>
					) : (
						<EditableTitle
							value={localizedFormName ?? form.name}
							readOnly
							ariaLabel="Form name"
						/>
					)}
					{canEdit && (
						<FormSettingsButton moduleUuid={moduleUuid} formUuid={formUuid} />
					)}
				</div>
			</div>
			{runtimeFault !== undefined ? (
				<div
					role="alert"
					className="mx-6 mt-4 rounded-lg border border-nova-amber/30 bg-nova-amber/[0.06] px-3 py-2 text-sm leading-relaxed text-nova-text-secondary"
				>
					Nova couldn't prepare this form. This is an internal error. You can
					keep editing or open another form.
				</div>
			) : null}
			{readsSearchResults && searchResults.state.kind === "loading" ? (
				<div
					role="status"
					className="mx-6 mt-4 rounded-lg border border-pv-input-border bg-pv-surface px-3 py-2 text-sm leading-relaxed text-nova-text-secondary"
				>
					{runtimeMessage(language.language, "searchResultsLoading")}
				</div>
			) : null}
			{readsSearchResults && searchResults.state.kind === "error" ? (
				<div
					role="alert"
					className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg border border-nova-amber/30 bg-nova-amber/[0.06] px-3 py-2 text-sm leading-relaxed text-nova-text-secondary"
				>
					<span>
						{runtimeMessage(
							language.language,
							searchResults.state.reason === "device-cases"
								? "searchDeviceCasesLoadFailed"
								: "searchResultsLoadFailed",
						)}
					</span>
					<button
						type="button"
						onClick={searchResults.retry}
						className="shrink-0 font-medium text-nova-text underline-offset-2 hover:underline"
					>
						{runtimeMessage(language.language, "tryAgain")}
					</button>
				</div>
			) : null}
			{searchResultsSnapshot !== undefined &&
			searchResultsSnapshot.totalMatches > searchResultsSnapshot.rows.length ? (
				<div
					role="status"
					data-search-results-cap={searchResultsSnapshot.totalMatches}
					className="mx-6 mt-4 rounded-lg border border-pv-input-border bg-pv-surface px-3 py-2 text-sm leading-relaxed text-nova-text-secondary"
				>
					{runtimeMessage(language.language, "searchResultsCap", {
						count: searchResultsSnapshot.totalMatches,
					})}
				</div>
			) : null}
			{caseDatabaseWait !== undefined ? (
				<div
					role="status"
					className="mx-6 mt-4 rounded-lg border border-pv-input-border bg-pv-surface px-3 py-2 text-sm leading-relaxed text-nova-text-secondary"
				>
					{caseDatabaseWait.status === "error"
						? "Case data couldn't load. You can keep editing and try Preview again."
						: "Nova is preparing the case data this form uses. You can keep editing."}
				</div>
			) : null}

			{/* Unified `pt-4` for flipbook parity: edit-mode `insertion(0)` row + live-mode `pt-6` both land the first field at Y = 40px so toggling modes never shifts reading position. Bottom symmetric via `insertion(N+1)` in edit / last field's `mb-6` in live. */}
			<div
				ref={formBodyRef}
				className="flex-1 pt-4"
				data-preview-engine-state={
					mode === "preview" ? (engineReady ? "ready" : "loading") : "edit"
				}
				data-preview-engine-ready={engineReady ? "true" : "false"}
				aria-busy={formFrozen}
				inert={formFrozen ? true : undefined}
				onBeforeInputCapture={blockFrozenInteraction}
				onChangeCapture={blockFrozenInteraction}
				onClickCapture={blockFrozenInteraction}
				onInputCapture={blockFrozenInteraction}
				onKeyDownCapture={blockFrozenKey}
				onPointerDownCapture={blockFrozenInteraction}
			>
				<fieldset
					key={`${entryKey ?? "inactive"}:${clearRevision}`}
					disabled={formFrozen}
					className="contents"
				>
					{(mode === "preview" ? presentationHasFields : hasFields) ? (
						engineInitializing ? (
							<div
								role="status"
								className="flex items-center justify-center gap-2 py-12 text-sm text-nova-text-muted"
							>
								<Icon
									icon={tablerLoader2}
									width="18"
									className="animate-spin"
								/>
								{runtimeMessage(language.language, "formGettingReady")}
							</div>
						) : /* Clear form intentionally remounts uncontrolled browser controls.
						 * A transient access refresh only suspends authority: keeping this
						 * fieldset mounted preserves focus, File inputs, signature ink,
						 * and other browser-owned drafts for the same app/form/worker. A
						 * confirmed app/form/Project/worker boundary rotates the entry
						 * key and retires browser-local continuations with it. */
						paging.enabled ? (
							paging.current !== undefined ? (
								paging.mode === "sections" || formUuid === undefined ? (
									<SectionPage
										key={paging.current.uuid}
										page={paging.current}
										index={paging.index}
										count={paging.count}
										takeFocusOnMount={paging.takeFocusOnMount}
									/>
								) : (
									<ScreenPage
										key={paging.current.path}
										formUuid={formUuid}
										page={paging.current}
										index={paging.index}
										takeFocusOnMount={paging.takeFocusOnMount}
									/>
								)
							) : (
								<div className="text-center text-nova-text-muted py-8">
									{paging.mode === "sections"
										? "Nothing to answer right now. Every section is empty or hidden by a display condition."
										: "Nothing to answer right now. Every question is hidden by a display condition."}
								</div>
							)
						) : (
							<FormRenderer parentEntityId={formUuid} />
						)
					) : (
						<div className="text-center text-nova-text-muted py-8">
							This form has no fields.
						</div>
					)}
					{mode === "preview" &&
					appId !== undefined &&
					engineReady &&
					entryKey !== undefined ? (
						<AttachmentInvariantRecoveryPanel
							appId={appId}
							entryKey={entryKey}
						/>
					) : null}
				</fieldset>
			</div>

			{/* Hidden in design mode where it's non-functional. The form above
			 *  always renders; this row adapts to whether a case is bound. */}
			{mode === "preview" && (
				<div className="border-t border-pv-input-border bg-pv-surface">
					{paging.mode === "sections" && paging.count > 0 ? (
						<SectionStepper paging={paging} disabled={formFrozen} />
					) : null}
					<RepeatAddPrompt
						prompt={paging.prompt}
						onAdd={() => void paging.addRepeatEntry()}
						onDecline={() => void paging.declineRepeatEntry()}
						onGoBack={paging.closeRepeatPrompt}
					/>
					{noSampleCases ? (
						<div className="px-6 py-4 text-xs leading-relaxed text-nova-text-muted">
							This form opens an existing case. Start from Results and choose a
							case before continuing.
						</div>
					) : caseCarriedBlank ? (
						<div className="px-6 py-4 text-xs leading-relaxed text-nova-text-muted">
							The link that opened this form carried no case, so there is
							nothing here to edit. Go back and open it from Results instead.
						</div>
					) : (
						<div className="flex flex-wrap items-center justify-between gap-2 px-6 py-3">
							<div className="flex flex-wrap items-center gap-2">
								{paging.canGoBack ? (
									<button
										type="button"
										onClick={paging.goBack}
										disabled={formFrozen}
										className={FORM_QUIET_ACTION_CLS}
									>
										<Icon
											icon={tablerChevronLeft}
											width="16"
											height="16"
											aria-hidden="true"
										/>
										{runtimeMessage(language.language, "back")}
									</button>
								) : null}
								{paging.isLast ? (
									<button
										type="button"
										onClick={handleSubmit}
										onMouseDown={(event) => {
											// Keep blur validation from moving Submit between press
											// and release. Submission validates and focuses the answer.
											if (
												event.button === 0 &&
												formBodyElRef.current?.contains(document.activeElement)
											) {
												event.preventDefault();
											}
										}}
										/* Submit is enabled exactly where a press submits
										 * (`submitOffer.ts`); anywhere else it is disabled and
										 * the line below says why, or it shows itself busy. */
										disabled={submitOffer.kind !== "offered"}
										data-submit-offer={
											submitOffer.kind === "offered"
												? "offered"
												: `${submitOffer.kind}:${submitOffer.reason}`
										}
										className={FORM_PRIMARY_ACTION_CLS}
									>
										{submitStatus.kind === "running" && (
											<Icon
												icon={tablerLoader2}
												width="14"
												height="14"
												className="animate-spin"
												aria-hidden="true"
											/>
										)}
										{runtimeMessage(
											language.language,
											submitStatus.kind === "running"
												? "submitting"
												: platformRules.submitLabel,
										)}
									</button>
								) : (
									<button
										type="button"
										onClick={paging.goNext}
										disabled={formFrozen}
										className={FORM_PRIMARY_ACTION_CLS}
									>
										{runtimeMessage(language.language, "next")}
										<Icon
											icon={tablerChevronRight}
											width="16"
											height="16"
											aria-hidden="true"
										/>
									</button>
								)}
							</div>
							<button
								type="button"
								onClick={handleClear}
								disabled={
									submitStatus.kind === "running" ||
									clearRunning ||
									!mayWriteCaseData
								}
								className={FORM_QUIET_ACTION_CLS}
							>
								<Icon
									icon={tablerRefresh}
									width="14"
									height="14"
									className={clearRunning ? "animate-spin" : undefined}
									aria-hidden="true"
								/>
								{runtimeMessage(
									language.language,
									clearRunning ? "startingFresh" : "clearForm",
								)}
							</button>
						</div>
					)}
					{validationAnnouncement ? (
						<p
							key={validationAnnouncement.serial}
							role="alert"
							className="sr-only"
						>
							{validationAnnouncement.kind === "review"
								? runtimeMessage(language.language, "reviewHighlightedQuestion")
								: validationAnnouncement.message}
						</p>
					) : null}
					{submitOfferLine(submitOffer, language.language) !== undefined ? (
						<p
							role="status"
							data-submit-offer-reason={
								submitOffer.kind === "offered" ? undefined : submitOffer.reason
							}
							className="px-6 pb-3 text-xs text-nova-text-muted"
						>
							{submitOfferLine(submitOffer, language.language)}
						</p>
					) : null}
					{/* Inline error sits BELOW the submit row so the user's
					 *  amend-then-resubmit loop keeps the action affordance
					 *  steady in place: the row doesn't reflow when an error
					 *  appears or clears. `whitespace-pre-line` honors the
					 *  per-field newline list `describeSubmitError` emits for
					 *  the validation-failure arm. */}
					{submitStatus.kind === "error" && (
						<p
							role="alert"
							className="px-6 pb-3 text-sm text-nova-rose whitespace-pre-line"
						>
							{submitStatus.message}
						</p>
					)}
				</div>
			)}
		</>
	);

	/* The pinned case tile: the same tile Results draws, kept on screen
	 * above the form while its session holds the case (`heldCases`). It
	 * carries no motion of its own, so a reduced-motion preference has
	 * nothing to suppress; it adds a uniform offset above the field list,
	 * which the flipbook's anchor-based scroll sync already corrects for on a
	 * mode flip. */
	const persistentTile =
		pinnedTile !== undefined &&
		/* A case the phone lacks has no tile there: Android's breadcrumb
		 * builds no context tile for a case it does not hold. */
		!(entryPointLaunch?.blankCaseIds ?? []).includes(pinnedTile.caseId) ? (
			<PinnedCaseTile pinned={pinnedTile} />
		) : null;

	/* The band is the only reason this frame grows. A sticky element can
	 * travel no further than its containing block, so while a persistent
	 * tile is on screen that block has to span the form's real height:
	 * and the frame still fills a short form (it is the flex child that
	 * grows), so the submit row keeps its footer position.
	 *
	 * With no band there is nothing to keep sticky, and growing COSTS the
	 * edit canvas its height: `VirtualFormList` sizes its scroller with
	 * `h-full` under `contain: strict`, so an auto-height ancestor leaves
	 * that percentage unresolved and containment settles it at zero. The
	 * virtualizer then measures an empty viewport and renders no rows at
	 * all. The band is preview-only by construction, so edit mode always
	 * takes the definite-height branch its virtualized canvas requires:
	 * which is also the inner scroller `builder/CLAUDE.md` documents as
	 * the edit-mode one, and the surface the flipbook's scroll restore
	 * reads its offset and measurements back from. */
	const content = (
		<div className={persistentTile ? "flex min-h-full flex-col" : "h-full"}>
			{persistentTile}
			<ContentFrame
				width="5xl"
				className={
					persistentTile ? "flex flex-1 flex-col" : "flex h-full flex-col"
				}
			>
				{/* FormLayoutProvider owns the group/repeat collapse set, shared across edit and live modes so a folded group stays folded when the user flips. */}
				<FormLayoutProvider ref={formLayoutRef}>{formBody}</FormLayoutProvider>
			</ContentFrame>
		</div>
	);
	return mode === "preview" ? (
		<ChoiceAnswerCheck
			moduleUuid={moduleUuid}
			formUuid={formUuid}
			caseType={caseTypes.find((type) => type.name === mod?.caseType)}
			selectedRecord={
				effectiveCases?.length === 1 ? effectiveCases[0] : undefined
			}
			{...(needsBoundCase
				? {
						onChooseAnotherRecord: () => {
							setPreviewSelectedCase(undefined);
							const back = caseListReturn();
							setPreviewCaseTarget(back.target);
							navigate.replace({ kind: "cases", moduleUuid: back.moduleUuid });
						},
					}
				: {})}
		>
			{content}
		</ChoiceAnswerCheck>
	) : (
		content
	);
}

/** The refused-entry screen: what CommCare turned away, and a way on. */
function FormRefusalPanel({
	refusal,
	caseName,
	onChooseAnotherRecord,
	onBackToList,
	onBack,
}: {
	readonly refusal: SetvalueRefusalDetails;
	readonly caseName: string | undefined;
	readonly onChooseAnotherRecord: () => void;
	readonly onBackToList: () => void;
	readonly onBack: () => void;
}) {
	const { language } = useBuilderLanguage();
	const projectProse = useProseProjection();
	const question = useLocalizedField(refusal.fieldUuid);
	const caseTypes = useMaterializableCaseTypes();
	const property = caseTypes
		.find((type) => type.name === refusal.caseType)
		?.properties.find((candidate) => candidate.name === refusal.property);
	const questionLabel =
		question !== undefined && "label" in question && question.label
			? projectProse(question.label)
			: undefined;
	const propertyLabel =
		property === undefined
			? undefined
			: (property.label ? projectProse(property.label) : "") || property.name;
	const copy = refusalCopy(language, refusal, {
		...(caseName ? { caseName } : {}),
		...(propertyLabel ? { property: propertyLabel } : {}),
		...(questionLabel ? { question: questionLabel } : {}),
	});
	return (
		<div className="flex h-full items-center justify-center px-6 py-10">
			<div
				role="alert"
				data-form-refusal={refusal.cause}
				className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
			>
				<div className="space-y-2">
					<h2 className="text-lg font-semibold text-nova-text">{copy.title}</h2>
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{copy.body}
					</p>
				</div>
				{refusal.cause === "preload" ? (
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={onChooseAnotherRecord}
							className={FORM_PRIMARY_ACTION_CLS}
						>
							{runtimeMessage(language, "chooseAnotherRecord")}
						</button>
						<button
							type="button"
							onClick={onBackToList}
							className={FORM_QUIET_ACTION_CLS}
						>
							{runtimeMessage(language, "backToList")}
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={onBack}
						className={FORM_PRIMARY_ACTION_CLS}
					>
						{runtimeMessage(language, "back")}
					</button>
				)}
			</div>
		</div>
	);
}
