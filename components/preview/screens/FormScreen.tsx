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
	useMemo,
	useRef,
	useState,
} from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { FormTypeButton } from "@/components/builder/detail/FormDetail";
import { FormSettingsButton } from "@/components/builder/detail/formSettings/FormSettingsButton";
import { EditableTitle } from "@/components/builder/EditableTitle";
import {
	useBuilderLanguage,
	useLocalizedText,
	useTranslationUnitEditor,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { PersistentCaseTile } from "@/components/preview/shared/PersistentCaseTile";
import { reportClientError } from "@/lib/clientErrorReporter";
import { useReconcilerContext } from "@/lib/collab/context";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import {
	useForm as useFormEntity,
	useModule as useModuleEntity,
} from "@/lib/doc/hooks/useEntity";
import { useFormIsSectioned } from "@/lib/doc/hooks/useFormSections";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import type { Uuid } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseType,
	caseSelectionCanFlowBetweenModules,
	caseSelectionCardinality,
	defaultPostSubmit,
	effectivePostSubmit,
	type FormLink,
	type FormType,
	isNoMatchesForm,
	makeTranslationUnitId,
	materializableCaseTypes as materializableCaseTypesFromDoc,
	menuFormUuidsOf,
	moduleIsCaseFirst,
	moduleOpensOnSearch,
	POST_SUBMIT_DESTINATIONS,
	type PostSubmitDestination,
	reachableCaseTypes,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import { submitFormAction } from "@/lib/preview/engine/caseDataBinding";
import {
	blueprintRevisionDigest,
	caseDatabaseToFormPreloads,
	caseRowsToFormPreloads,
	caseRowToFormPreload,
	pickBlueprintDoc,
	viewerTimeZone,
} from "@/lib/preview/engine/caseDataBindingClient";
import type {
	CreatedChildCaseReceipt,
	SubmissionMutation,
	SubmissionResult,
} from "@/lib/preview/engine/caseDataBindingTypes";
import type { InvalidFieldTarget } from "@/lib/preview/engine/formEngine";
import {
	type AfterSubmitChoice,
	type CarriedSubmission,
	carriedCaseFromSelections,
	createFormLinkWorkerWorld,
	evaluateFormLinksAsync,
	type PostSubmissionCaseData,
	projectTargetCaseSelectionsAsync,
	type SelectedCaseSessionValue,
	sourceSessionDatums,
} from "@/lib/preview/engine/formLinkEvaluation";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import { searchInputInstanceValues } from "@/lib/preview/engine/runtimeBindings";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import {
	invalidateCaseData,
	useCaseDataReplacementRevision,
} from "@/lib/preview/hooks/caseDataInvalidation";
import { useCaseData, useCases } from "@/lib/preview/hooks/useCaseDataBinding";
import { useEngineEntry } from "@/lib/preview/hooks/useEngineEntry";
import { useFormEngine } from "@/lib/preview/hooks/useFormEngine";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useRestoreScopeKey } from "@/lib/preview/hooks/useRestoreScopeKey";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import { previewMenuCaseContext } from "@/lib/preview/menuProjection";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	useAccessPhase,
	useAppId,
	useBuilderIsReady,
	useCanEdit,
	useEditMode,
	usePreviewCaseTarget,
	usePreviewMenuCaseSelections,
	usePreviewPersonaUuid,
	usePreviewSearchState,
	useProjectId,
	useProjectScopeEpoch,
	useSetPreviewCaseTarget,
	useSetPreviewing,
	useSetPreviewMenuCaseSelection,
	useSetPreviewSearchState,
	useSetPreviewSelectedCase,
} from "@/lib/session/hooks";
import { recordRegisteredCase } from "@/lib/session/previewSearchState";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { PreviewCaseChoice } from "@/lib/session/types";
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
import { SectionPage } from "../form/sections/SectionPage";
import { SectionStepper } from "../form/sections/SectionPagerControls";
import { useSectionPaging } from "../form/sections/useSectionPaging";
import {
	afterSubmitRoute,
	type PreviewTargetCaseCollection,
	previewMenuSelectionsAfterTargetCases,
	previewTargetHasSelectedCase,
} from "./afterSubmitRouting";
import {
	FORM_PRIMARY_ACTION_CLS,
	FORM_QUIET_ACTION_CLS,
} from "./formActionButtonStyles";
import { openModuleLanding } from "./moduleLanding";
import { noMatchesFormAdmission, noMatchesRefusalCopy } from "./noMatchesForm";

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
}

interface SubmittedContextSnapshot extends SubmissionContextSnapshot {
	/** One immutable authoring revision. Links, printing, datum projection, and
	 * target routing must never mix it with a collaborator's later edit. */
	readonly doc: BlueprintDoc;
	/** The exact device casedb captured when this form entry opened. */
	readonly caseDatabase: CaseDatabaseSnapshot;
	/** The materializable catalog from the same submit-time revision. */
	readonly caseTypes: readonly CaseType[];
}

interface FormScreenProps {
	/** Stable identity passed by PreviewShell so an Activity-retained form never
	 * starts reading a newer route's module, form, or selected case. */
	screen: Extract<PreviewScreen, { type: "form" }>;
	/** BuilderLayout's back handler: also the fallback post-submit destination for `previous` forms. */
	onBack: () => void;
}

/** Join concrete created-child ids to their authored metadata through the
 * durable receipt's explicit authored-child index. `undefined` is the
 * deliberate historical-receipt path: the old flat ids are replayable but do
 * not prove metadata, so they contribute no carried child cases. */
export function carriedChildCasesFromReceipt(args: {
	readonly createdChildren: readonly CreatedChildCaseReceipt[] | undefined;
	readonly authoredChildren: readonly {
		readonly caseType: string;
		readonly caseName?: string;
	}[];
	readonly parentCaseIds: readonly string[];
}): CarriedSubmission["childCases"] {
	if (args.createdChildren === undefined) return [];
	const expectedCount =
		args.authoredChildren.length * args.parentCaseIds.length;
	if (args.createdChildren.length !== expectedCount) {
		throw new Error(
			"The accepted submission returned an incomplete created-child receipt.",
		);
	}
	const expectedPairs = new Set(
		args.authoredChildren.flatMap((_child, authoredChildIndex) =>
			args.parentCaseIds.map(
				(parentCaseId) => `${authoredChildIndex}\u0000${parentCaseId}`,
			),
		),
	);
	const seenPairs = new Set<string>();
	return args.createdChildren.map((createdChild) => {
		const child = args.authoredChildren[createdChild.authoredChildIndex];
		const pair = `${createdChild.authoredChildIndex}\u0000${createdChild.parentCaseId}`;
		if (
			child === undefined ||
			!expectedPairs.has(pair) ||
			seenPairs.has(pair)
		) {
			throw new Error(
				"The accepted submission returned an invalid created-child receipt.",
			);
		}
		seenPairs.add(pair);
		return {
			caseType: child.caseType,
			caseId: createdChild.caseId,
			...(child.caseName !== undefined && { caseName: child.caseName }),
		};
	});
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

/** Preserve the selected-entities collection across an automatic compatible
 * several-case link. The ordinary frame projector is scalar by design; using
 * its first value here would lose order and every case after the first. The
 * exact post-submit device snapshot supplies even a case the submission just
 * closed and a fresh restore would omit. */
function automaticLinkedCaseCollection(args: {
	readonly choice: AfterSubmitChoice;
	readonly doc: BlueprintDoc;
	readonly sourceModuleUuid: Uuid | undefined;
	readonly sourceFormType: FormType | undefined;
	readonly submittedCases: readonly PreviewCaseChoice[] | undefined;
	readonly resultCaseIds: readonly string[];
	readonly caseDatabase: CaseDatabaseSnapshot;
}): PreviewTargetCaseCollection | undefined {
	if (
		args.choice.kind !== "link" ||
		/* HQ's flat module frame contains only the module command. It does not
		 * carry a case-selection datum, so entering that module must begin its
		 * ordinary Results journey instead of inheriting Preview's collection. */
		args.choice.link.target.type !== "form" ||
		args.choice.link.datums !== undefined ||
		args.sourceModuleUuid === undefined ||
		args.sourceFormType === undefined ||
		!CASE_LOADING_FORM_TYPES.has(args.sourceFormType)
	) {
		return undefined;
	}
	const sourceModule = args.doc.modules[args.sourceModuleUuid];
	const targetModule = args.doc.modules[args.choice.link.target.moduleUuid];
	if (
		sourceModule?.caseListConfig?.selection?.kind !== "multiple" ||
		targetModule?.caseListConfig?.selection?.kind !== "multiple" ||
		sourceModule.caseType === undefined ||
		!caseSelectionCanFlowBetweenModules(sourceModule, targetModule)
	) {
		return undefined;
	}
	if (
		!CASE_LOADING_FORM_TYPES.has(
			args.doc.forms[args.choice.link.target.formUuid]?.type ?? "survey",
		)
	) {
		return undefined;
	}
	if (
		args.resultCaseIds.length === 0 ||
		args.resultCaseIds.length > targetModule.caseListConfig.selection.maximum
	) {
		throw new Error(
			"A compatible several-case link received a selection outside its target limit.",
		);
	}
	const submittedById = new Map(
		(args.submittedCases ?? []).map(
			(choice) => [choice.caseId, choice] as const,
		),
	);
	const rowById = new Map(
		args.caseDatabase.rows.map((row) => [row.case_id, row] as const),
	);
	const cases = args.resultCaseIds.map((caseId) => {
		const row = rowById.get(caseId);
		if (row === undefined || row.case_type !== sourceModule.caseType) {
			throw new Error(
				"A selected case was missing from the carried post-submit device snapshot.",
			);
		}
		const previous = submittedById.get(caseId);
		return {
			caseId,
			caseName: row.case_name || previous?.caseName || "Case",
			caseProperties: Object.fromEntries(caseRowToFormPreload(row)),
		};
	});
	return {
		moduleUuid: args.choice.link.target.moduleUuid,
		caseType: sourceModule.caseType,
		cases,
	};
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

export function FormScreen({ screen, onBack }: FormScreenProps) {
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
	const menuCaseSelections = usePreviewMenuCaseSelections();
	// The worker's restore is derived from their assignment and the place tree,
	// neither of which is an argument to these reads. See `useRestoreScopeKey`.
	const restoreScopeKey = useRestoreScopeKey(personaUuid);
	const previewIdentity = useSelectedPreviewIdentity();
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
	const formUuid = screen.formUuid;
	const moduleUuid = screen.moduleUuid;
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
	/* A no-matches registration form is admitted only through the Register
	 * action on its module's empty search (`noMatchesForm.ts`): the launch on
	 * the case target names the search attempt that offered it, and the
	 * module's search context says whether that search found nothing. The
	 * admitted answers are what `#search/<name>` reads in the engine. */
	const searchState = usePreviewSearchState(moduleUuid);
	const setPreviewSearchState = useSetPreviewSearchState();
	const searchLaunch =
		previewCaseTarget?.formUuid === formUuid
			? previewCaseTarget.searchLaunch
			: undefined;
	const noMatchesAdmission = useMemo(
		() =>
			noMatchesFormAdmission({
				form,
				moduleUuid,
				launch: searchLaunch,
				searchState,
			}),
		[form, moduleUuid, searchLaunch, searchState],
	);
	/* The search context keeps the screen's answers (a date range as its
	 * two bounds); the engine's search-input instance holds one field per
	 * prompt, as the device's does. */
	const hostSearchInputs = mod?.caseListConfig?.searchInputs;
	const searchAnswers = useMemo(
		() =>
			mode === "preview" && noMatchesAdmission.kind === "admitted"
				? searchInputInstanceValues(
						hostSearchInputs ?? [],
						new Map(Object.entries(noMatchesAdmission.answers)),
					)
				: undefined,
		[mode, noMatchesAdmission, hostSearchInputs],
	);
	const language = useBuilderLanguage();
	const formNameUnitId = makeTranslationUnitId(
		"form",
		formUuid ?? "missing",
		"name",
	);
	const localizedFormName = useLocalizedText(formNameUnitId);
	const formNameEditor = useTranslationUnitEditor(formNameUnitId);

	/** Returns `false` for undefined `formUuid` so FormScreen can mount while the URL is parsing. */
	const hasFields = useHasFieldsInForm(formUuid);

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
		const parentSelection = menuCaseContext.parentCase;
		if (!autoSelectCase || parentSelection === undefined) return undefined;
		return {
			caseType: parentSelection.caseType,
			caseIds: parentSelection.cases.map((selectedCase) => selectedCase.caseId),
		};
	}, [autoSelectCase, menuCaseContext.parentCase]);
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

	const editable = isReady;

	const controller = useFormEngine(
		formUuid,
		caseData,
		carriedCaseDatabase,
		searchAnswers,
	);
	const engineEntry = useEngineEntry();
	const runtimeFault =
		engineEntry.fault?.formUuid === formUuid ? engineEntry.fault : undefined;
	const caseDatabaseWait =
		engineEntry.caseDatabaseWait?.formUuid === formUuid
			? engineEntry.caseDatabaseWait
			: undefined;
	const entryKey =
		engineEntry.formUuid === formUuid ? engineEntry.entryKey : undefined;
	const engineReady =
		engineEntry.formUuid === formUuid &&
		engineEntry.ready &&
		entryKey !== undefined;
	const engineInitializing = mode === "preview" && !engineReady;
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
	const postSubmitDestination =
		form === undefined
			? undefined
			: (form.postSubmit ??
				defaultPostSubmit(form.type, {
					searchFirst: mod !== undefined && moduleOpensOnSearch(mod),
				}));
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
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
	const invalidFocusRafRef = useRef<number | undefined>(undefined);

	const formBodyRef = useCallback(
		(el: HTMLDivElement | null) => {
			formBodyElRef.current = el;
			if (!el || mode !== "preview") return;
			if (!selectedUuid) return;
			const raf = requestAnimationFrame(() => {
				const qEl = el.querySelector(`[data-field-uuid="${selectedUuid}"]`);
				const input = qEl?.querySelector(
					'input, select, textarea, button, [role="textbox"], [tabindex]:not([tabindex="-1"])',
				) as HTMLElement | null;
				input?.focus();
			});
			return () => cancelAnimationFrame(raf);
		},
		[mode, selectedUuid],
	);

	useEffect(
		() => () => {
			if (invalidFocusRafRef.current !== undefined) {
				cancelAnimationFrame(invalidFocusRafRef.current);
			}
		},
		[],
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
		{ readonly serial: number; readonly message: string } | undefined
	>();
	/* Each announcement gets its own serial so the same sentence said twice
	 * (two failed Next presses) re-renders the alert node and is read twice. */
	const announcementSerialRef = useRef(0);
	const announce = useCallback((message: string): void => {
		setValidationAnnouncement({
			serial: ++announcementSerialRef.current,
			message,
		});
	}, []);
	const [clearRevision, setClearRevision] = useState(0);
	const [clearTargetEntryKey, setClearTargetEntryKey] = useState<
		string | undefined
	>();
	const clearInFlightRef = useRef(false);
	const clearRunning = clearTargetEntryKey !== undefined;
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
		if (clearTargetEntryKey === undefined || entryKey !== clearTargetEntryKey) {
			return;
		}
		clearInFlightRef.current = false;
		setClearTargetEntryKey(undefined);
	}, [clearTargetEntryKey, entryKey]);

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
		setPreviewCaseTarget({ formUuid });
		navigate.replace({ kind: "cases", moduleUuid });
	}, [
		caseBindingReplaced,
		explicitCases,
		moduleUuid,
		formUuid,
		navigate,
		setPreviewCaseTarget,
		setPreviewSelectedCase,
	]);

	const needsBoundCase =
		mode === "preview" &&
		form !== undefined &&
		CASE_LOADING_FORM_TYPES.has(form.type);
	const caseBindingReady =
		!needsBoundCase ||
		(severalCaseForm &&
			(effectiveCaseIds?.length ?? 0) > 0 &&
			!caseBindingReplaced) ||
		carriedCaseData !== undefined ||
		(effectiveCaseId !== undefined &&
			!caseBindingReplaced &&
			caseDataState.kind === "row" &&
			caseDataState.row.case_id === effectiveCaseId);

	const dispatchPostSubmit = useCallback(
		(
			dest: PostSubmitDestination,
			submittedModuleUuid: Uuid | undefined,
		): void => {
			switch (dest) {
				case "module":
					if (submittedModuleUuid) navigate.openModule(submittedModuleUuid);
					return;
				case "app_home":
					navigate.goHome();
					return;
				case "previous":
					/* Return to whatever screen sent the user here. `onBack`
					 * reads from BuilderLayout, which holds the back-stack and
					 * falls through to the module home when the stack is
					 * empty. */
					onBack();
					return;
				default: {
					/* Exhaustive switch: a future `PostSubmitDestination`
					 * arm landing without a case here surfaces as the
					 * standard `unhandledKindMessage` shape rather than
					 * silently routing to `onBack()`. */
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
		[navigate, onBack],
	);

	/**
	 * Where the app goes once a submission has landed.
	 *
	 * A form with no after-submit links goes to its post-submit destination,
	 * exactly as before. A form WITH links runs them the way the device does
	 * (`lib/preview/engine/formLinkEvaluation.ts`): a link condition is
	 * evaluated after the form has closed, against the case rows AS THEY ARE
	 * NOW. Typed case hashtags and `#user` read from the exact rows returned by
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
			readonly destination: PostSubmitDestination;
		};
		readonly result: SubmissionSuccess;
		readonly mutation: SubmissionMutation | undefined;
		readonly isCurrent: () => boolean;
		readonly settleAttempt: (status: SubmitStatus) => void;
		/** Announce the landed write to every surface reading case data. */
		readonly announceWrite: () => void;
	}): Promise<void> => {
		const { submitted, result, mutation, isCurrent, settleAttempt } = args;
		let announced = false;
		const announceWrite = (): void => {
			if (announced) return;
			announced = true;
			args.announceWrite();
		};
		/* A no-matches registration form returns to its module as the wire's
		 * return frame does; the gate keeps such a form free of links, so
		 * this is decided first. A host with menu forms lands on Results
		 * showing the case it registered (the frame re-keys the search to
		 * that case); a host without any has no frame beyond its command
		 * (`caseListFormReturnFrame`), so the search context retires and the
		 * module opens the way it first did: on Search, or on an automatic
		 * Results when there is nothing to answer. */
		const landOnResultsWithRegisteredCase = (
			moduleUuid: Uuid,
			caseId: string,
		): void => {
			announceWrite();
			setPreviewSearchState(
				moduleUuid,
				menuFormUuidsOf(submitted.doc, moduleUuid).length > 0
					? recordRegisteredCase(
							session.getState().previewSearchStates[moduleUuid],
							caseId,
						)
					: undefined,
			);
			setPreviewSelectedCase(undefined);
			setPreviewCaseTarget(undefined);
			settleAttempt({ kind: "idle" });
			navigate.openCaseList(moduleUuid);
		};
		const submittedForm =
			submitted.formUuid === undefined
				? undefined
				: submitted.doc.forms[submitted.formUuid];
		const noMatchesRegistration =
			submittedForm !== undefined &&
			isNoMatchesForm(submittedForm) &&
			result.kind === "registration" &&
			submitted.moduleUuid !== undefined
				? { moduleUuid: submitted.moduleUuid, caseId: result.caseId }
				: undefined;
		if (noMatchesRegistration !== undefined) {
			landOnResultsWithRegisteredCase(
				noMatchesRegistration.moduleUuid,
				noMatchesRegistration.caseId,
			);
			return;
		}
		const links = submitted.links;
		if (
			links === undefined ||
			links.length === 0 ||
			submitted.formUuid === undefined
		) {
			announceWrite();
			settleAttempt({ kind: "idle" });
			dispatchPostSubmit(submitted.destination, submitted.moduleUuid);
			return;
		}
		const sourceFormUuid = submitted.formUuid;
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
		if (sourceEntryKey === undefined) {
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
		const affectedCaseIds = new Set(
			caseDatabasePatch.rows.map((row) => row.case_id),
		);
		const patchedRowsByCaseId = new Map(
			caseDatabasePatch.rows.map((row) => [row.case_id, row] as const),
		);
		const existingCaseIds = new Set(
			submitted.caseDatabase.rows.map((row) => row.case_id),
		);
		const hasPropertyTypes =
			submitted.caseDatabase.propertyTypes !== undefined ||
			caseDatabasePatch.propertyTypes !== undefined;
		const refreshedCaseDatabase: CaseDatabaseSnapshot = {
			rows: [
				...submitted.caseDatabase.rows.map(
					(row) => patchedRowsByCaseId.get(row.case_id) ?? row,
				),
				...caseDatabasePatch.rows.filter(
					(row) => !existingCaseIds.has(row.case_id),
				),
			],
			indices: [
				...submitted.caseDatabase.indices.filter(
					(index) => !affectedCaseIds.has(index.case_id),
				),
				...caseDatabasePatch.indices,
			],
			...(hasPropertyTypes
				? {
						propertyTypes: {
							...(submitted.caseDatabase.propertyTypes ?? {}),
							...(caseDatabasePatch.propertyTypes ?? {}),
						},
					}
				: {}),
		};
		const committedUsercase = caseDatabasePatch.rows.find(
			(row) =>
				row.case_type === USERCASE_CASE_TYPE &&
				(previewIdentity?.ownerId === undefined ||
					row.case_id === previewIdentity.ownerId),
		);
		const postSubmissionUsercase =
			committedUsercase === undefined
				? (previewIdentity?.usercase ?? {})
				: {
						...(previewIdentity?.usercase ?? {}),
						...Object.fromEntries(caseRowToFormPreload(committedUsercase)),
					};

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
			if (readBack === undefined) {
				failAfterSave(
					"Your answers were saved, but the saved case was not available to choose the next screen. Reload the app and try again.",
					"source-case-unavailable",
				);
				return;
			}
			caseData = readBack;
			boundCaseName = readBack.get(caseType)?.get("case_name");
		}
		try {
			const doc = submitted.doc;
			const routeMenuSource = {
				modules: doc.modules,
				moduleOrder: doc.moduleOrder,
				caseTypes: doc.caseTypes ?? [],
				forms: doc.forms,
				formOrder: doc.formOrder,
			};
			const caseFirstModules = new Set(
				doc.moduleOrder.filter((moduleUuid) =>
					moduleIsCaseFirst(doc, moduleUuid),
				),
			);
			const createdChildren =
				result.kind === "survey" ? [] : result.createdChildren;
			const children =
				mutation !== undefined && "children" in mutation
					? mutation.children
					: [];
			const submission: CarriedSubmission = {
				...(resultCaseIds.length === 1 && { caseId: resultCaseIds[0] }),
				...(result.kind === "registration" &&
					mutation?.kind === "registration" &&
					mutation.primary.caseName !== undefined && {
						caseName: mutation.primary.caseName,
					}),
				...(boundCaseName !== undefined && { caseName: boundCaseName }),
				childCases: carriedChildCasesFromReceipt({
					createdChildren,
					authoredChildren: children,
					parentCaseIds: resultCaseIds,
				}),
			};
			/* Form-link evaluation consumes module-keyed CASE SESSION values, not
			 * raw menu ancestry. The canonical menu projection resolves same-type
			 * structural inheritance and case-type parent selection first; the wire
			 * projection then maps those stable module identities to final datum ids. */
			const selectedCases = new Map<Uuid, SelectedCaseSessionValue>();
			for (const selectedModuleUuid of routeMenuSource.moduleOrder) {
				const selected = previewMenuCaseContext(
					routeMenuSource,
					selectedModuleUuid,
					menuCaseSelections,
				).selectedCase;
				const selectedChoice = selected?.cases[0];
				if (
					selected === undefined ||
					selected.cases.length !== 1 ||
					selectedChoice === undefined
				)
					continue;
				selectedCases.set(selectedModuleUuid, {
					caseType: selected.caseType,
					value: selectedChoice.caseId,
					caseName: selectedChoice.caseName,
				});
			}
			const input = {
				doc,
				session: previewSessionValues(previewIdentity),
				usercase: postSubmissionUsercase,
				sessionDatums: sourceSessionDatums(
					doc,
					sourceFormUuid,
					submission,
					selectedCases,
				),
				caseData,
				caseDatabase: refreshedCaseDatabase,
				lookupData: controller.previewLookupDataSnapshot,
			};
			const { choice, projectedSelections } =
				await controller.evaluateFormLinkXPaths(
					sourceEntryKey,
					async (evaluateLink) => {
						const world = createFormLinkWorkerWorld(
							input,
							`form-link-${crypto.randomUUID()}`,
						);
						const choice = await evaluateFormLinksAsync({
							links,
							fallback: submitted.destination,
							input,
							evaluate: evaluateLink,
							world,
						});
						const projectedSelections =
							choice.kind === "link"
								? await projectTargetCaseSelectionsAsync(
										input,
										sourceFormUuid,
										choice.link,
										evaluateLink,
										world,
									)
								: [];
						return { choice, projectedSelections };
					},
				);
			if (!isCurrent()) {
				announceWrite();
				settleAttempt({ kind: "idle" });
				return;
			}
			const linkedCaseCollection = automaticLinkedCaseCollection({
				choice,
				doc,
				sourceModuleUuid: submitted.moduleUuid,
				sourceFormType: submitted.formType,
				submittedCases: submitted.cases,
				resultCaseIds,
				caseDatabase: refreshedCaseDatabase,
			});
			const linkedCaseCollections =
				linkedCaseCollection === undefined ? [] : [linkedCaseCollection];
			const route = afterSubmitRoute({
				choice,
				doc,
				caseFirstModules,
				hasSelectedCase: (targetModuleUuid, projectedSelections) => {
					return previewTargetHasSelectedCase({
						menuSource: routeMenuSource,
						current: menuCaseSelections,
						targetModuleUuid,
						projected: projectedSelections,
						collections: linkedCaseCollections,
					});
				},
				carriedCase: (link) =>
					carriedCaseFromSelections(input, link, projectedSelections),
				caseSelections: () => projectedSelections,
			});
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
			announceWrite();
			const applyCaseSelections = (): void => {
				if (route.kind !== "module" && route.kind !== "form") return;
				const nextSelections = previewMenuSelectionsAfterTargetCases(
					routeMenuSource,
					menuCaseSelections,
					route.caseSelections,
					targetCaseData,
					linkedCaseCollections,
				);
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
				case "post-submit":
					settleAttempt({ kind: "idle" });
					dispatchPostSubmit(route.destination, submitted.moduleUuid);
					return;
				case "module":
					applyCaseSelections();
					settleAttempt({ kind: "idle" });
					openModuleLanding(navigate, route.moduleUuid, route.landing);
					return;
				case "form":
					applyCaseSelections();
					/* The target's case binding is rewritten BEFORE the push, so
					 * the form mounts already bound (or already bound to nothing)
					 * rather than auto-selecting a case for one render. */
					setPreviewSelectedCase(undefined);
					setPreviewCaseTarget({
						formUuid: route.formUuid,
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
				case "unresolvable":
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
								"module",
								"form",
								"results-with-registered-case",
								"unresolvable",
							],
						}),
					);
				}
			}
		} catch {
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
			if (invalidFocusRafRef.current !== undefined) {
				cancelAnimationFrame(invalidFocusRafRef.current);
			}
			// Expansion is a React state commit. Two frames let nested collapsed
			// ancestors mount before resolving the concrete repeated question.
			invalidFocusRafRef.current = requestAnimationFrame(() => {
				invalidFocusRafRef.current = requestAnimationFrame(() => {
					invalidFocusRafRef.current = undefined;
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
			});
		},
		[],
	);

	const revealAndFocusFirstInvalid = useCallback((): void => {
		const target = controller.firstInvalidFieldTarget();
		if (target === undefined) return;
		revealAndFocusTarget(target, INVALID_CONTROL_SELECTOR, true);
	}, [controller, revealAndFocusTarget]);

	const revealInvalidOnPage = useCallback(
		(target: InvalidFieldTarget): void =>
			revealAndFocusTarget(target, INVALID_CONTROL_SELECTOR, true),
		[revealAndFocusTarget],
	);
	/* A sectioned form previews one page at a time (`useSectionPaging`). The
	 * hook is inert for a single-page form and in edit mode, where the
	 * canvas shows every page at once. */
	const formIsSectioned = useFormIsSectioned(formUuid);
	const paging = useSectionPaging({
		formUuid,
		enabled: mode === "preview" && formIsSectioned,
		revealInvalid: revealInvalidOnPage,
		refuse: announce,
	});
	/** Turn to the page holding a question before revealing it: an invalid
	 *  question's first ancestor is its section, so the reveal's DOM query
	 *  finds it mounted. A no-op on a single-page form. */
	const showPageOf = (target: InvalidFieldTarget): void => {
		const first = target.ancestorUuids[0];
		if (first !== undefined) paging.showPage(first);
	};
	const showFirstPage = paging.showFirst;

	const focusAttachmentInvariantRecovery = useCallback(
		(fieldUuid: string | undefined): void => {
			if (invalidFocusRafRef.current !== undefined) {
				cancelAnimationFrame(invalidFocusRafRef.current);
			}
			invalidFocusRafRef.current = requestAnimationFrame(() => {
				invalidFocusRafRef.current = requestAnimationFrame(() => {
					invalidFocusRafRef.current = undefined;
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
			});
		},
		[],
	);

	const handleSubmit = async (): Promise<void> => {
		if (clearInFlightRef.current) return;
		const start = session.getState();
		/* Authority is read imperatively at the mutation boundary. A queued click
		 * can run after the synchronous reset but before React commits fresh props. */
		if (
			start.accessPhase !== "authorized" ||
			!start.canEdit ||
			start.appId !== appId
		)
			return;
		const submittedBase = { ...submissionContextRef.current };
		/* A submission program is derived from the committed blueprint, while
		 * answers and after-submit routing come from this tab's document. Flush
		 * local edits first; the digest fence below then refuses any collaborator
		 * or save race that lands between this snapshot and the server lock. */
		const saveOutcome = await collab?.reconciler.waitForHumanSaveBarrier();
		if (saveOutcome !== undefined && saveOutcome.kind !== "saved") {
			setSubmitStatus({
				kind: "error",
				message:
					"This app couldn't finish saving. Reload it before submitting the form.",
			});
			return;
		}
		const afterSave = session.getState();
		if (
			afterSave.accessPhase !== "authorized" ||
			!afterSave.canEdit ||
			afterSave.appId !== appId ||
			afterSave.scopeEpoch !== start.scopeEpoch
		) {
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
				caseTypes: materializableCaseTypesFromDoc(doc),
			};
		};
		let submittedDocState = docApi.getState();
		let submissionRevisionFinal = false;
		let submitted = submittedSnapshot(
			structuredClone(pickBlueprintDoc(submittedDocState)),
		);
		if (
			submitted.scopeEpoch !== start.scopeEpoch ||
			submitted.formUuid === undefined ||
			submitted.entryKey === undefined ||
			submitted.destination === undefined
		) {
			return;
		}
		const submittedEntryKey = submitted.entryKey;
		const attempt = ++submissionAttemptRef.current;
		const attemptIsCurrent = () => submissionAttemptRef.current === attempt;
		const settleAttempt = (status: SubmitStatus): void => {
			if (attemptIsCurrent()) setSubmitStatus(status);
		};
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
		/* Clear any prior error state up-front. Two reasons:
		 *
		 *   1. A stale server-error header from a previous submit would
		 *      otherwise stay visible while the user is on a *different*
		 *      failure path (validate-fail or appId-guard) whose actual
		 *      remediation surfaces in a different UI element (per-field
		 *      required indicators).
		 *   2. A second submit after a server error must replace, not
		 *      augment: the alert always reflects the latest attempt. */
		settleAttempt({ kind: "idle" });
		setValidationAnnouncement(undefined);

		/* This repeats the disabled-button condition at the mutation boundary.
		 * A queued click or stale event handler must never submit after a case-data
		 * replacement, while the row is reloading, or after it resolved missing. */
		if (!caseBindingReady) {
			settleAttempt({
				kind: "error",
				message:
					"This case is no longer available. Return to Results and choose a case.",
			});
			return;
		}

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
		if (!hasAttachmentEntryWriteAuthority(submittedEntryKey)) return;

		settleAttempt({ kind: "running" });
		/* The mutation that landed, kept beside the result: the after-submit
		 * links need the case types of the children it created, which the
		 * result reports only by id. */
		let landedMutation: SubmissionMutation | undefined;
		try {
			const submitStableAnswers = async (): Promise<
				SubmissionResult | "invalid" | "save-failed" | "stale"
			> => {
				if (!isCurrent()) return "stale";
				const valid = await controller.validateAllAsync();
				if (!valid) return "invalid";
				const submission = await controller.computeSubmissionMutationAsync(
					{
						caseIds: submitted.caseIds,
						/* The zone a datetime answer is stamped with. The device
						 * stamps its own; in Preview the author's browser stands in
						 * for it, the same substitution the case-data reads make. */
						viewerTimeZone: viewerTimeZone(),
					},
					submittedEntryKey,
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
				if (finalSubmitted.destination === undefined) return "stale";
				const finalSaveOutcome =
					await collab?.reconciler.waitForHumanSaveBarrier();
				if (
					finalSaveOutcome !== undefined &&
					finalSaveOutcome.kind !== "saved"
				) {
					return "save-failed";
				}
				if (docApi.getState() !== finalDocState) return "stale";
				const finalBlueprintDigest = await blueprintRevisionDigest(finalDoc);
				if (docApi.getState() !== finalDocState) return "stale";
				submittedDocState = finalDocState;
				submitted = finalSubmitted;
				submissionRevisionFinal = true;
				if (!isCurrent()) return "stale";
				landedMutation = mutation;
				/* The persona rides the WRITE, not just the reads. Its uuid is the
				 * `owner_id` stamped on every case this submission creates, so
				 * dropping it here would quietly give a persona's work to the
				 * signed-in member while every read still looked persona-scoped. */
				return await submitFormAction(
					mutation,
					submittedAppId,
					finalBlueprintDigest,
					viewerTimeZone(),
					submitted.personaUuid,
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
			if (result === "invalid") {
				settleAttempt({ kind: "idle" });
				// Deliberately does not name the reason. Submit is blocked by
				// a missing required answer, an authored validation rule, OR
				// a temporal answer that is not yet a value of its type, and
				// the focused question announces its OWN message a moment
				// later: naming one of the three here would contradict the
				// other two.
				announce("Review the highlighted question.");
				const firstInvalid = controller.firstInvalidFieldTarget();
				if (firstInvalid !== undefined) showPageOf(firstInvalid);
				revealAndFocusFirstInvalid();
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
						destination: submitted.destination,
					},
					result,
					mutation: landedMutation,
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
			setSubmitStatus({ kind: "idle" });
			setValidationAnnouncement(undefined);
			showFirstPage();
			if (entryKey === undefined) {
				await controller.resetAsync();
				setClearRevision((revision) => revision + 1);
				clearInFlightRef.current = false;
				return;
			}
			if (appId !== undefined) {
				retireAttachmentEntry({ appId, entryKey });
			}
			const nextEntryKey = await controller.restartActiveEntryAsync();
			if (nextEntryKey === undefined) {
				clearInFlightRef.current = false;
				return;
			}
			setClearTargetEntryKey(nextEntryKey);
		},
		[appId, controller, entryKey, session, showFirstPage, submitStatus.kind],
	);

	const repeatTopologySettling =
		engineEntry.formUuid === formUuid && engineEntry.topologySettling;
	const formFrozen =
		submitStatus.kind === "running" ||
		clearRunning ||
		engineInitializing ||
		repeatTopologySettling;
	const blockFrozenInteraction = useCallback(
		(event: SyntheticEvent): void => {
			if (!formFrozen) return;
			event.preventDefault();
			event.stopPropagation();
		},
		[formFrozen],
	);

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
		const copy = noMatchesRefusalCopy(noMatchesAdmission.reason);
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

	if (mode === "preview" && runtimeFault !== undefined) {
		return (
			<div className="flex h-full items-center justify-center px-6 py-10">
				<div
					role="alert"
					className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
				>
					<div className="space-y-2">
						<h2 className="text-lg font-semibold text-nova-text">
							This form couldn't open
						</h2>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							Nova hit an internal problem while preparing this form. Return to
							Edit to keep working.
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

	if (mode === "preview" && caseDatabaseWait !== undefined) {
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

	/* The form ALWAYS renders: flipping to preview keeps it in place and the
	 * case data loads IN; it is never swapped for a loading/empty interstitial
	 * (that multi-stage flash is the antithesis of the flipbook). The only
	 * thing a directly-previewed case-loading form gates on a bound case is
	 * the submit action: `computeSubmissionMutation` needs the caseId, so
	 * `caseMissing` drives the submit row below, not the whole screen. */
	const caseMissing =
		needsBoundCase &&
		(effectiveCaseIds === undefined || effectiveCaseIds.length === 0);
	const noSampleCases = caseMissing && autoCases.state.kind === "empty";
	/* An after-submit link opened this form with an EMPTY case id: the device
	 * opens the form bound to nothing, and so does the preview, saying so in
	 * place of the submit row (nothing loads, and Submit has no case to
	 * write). */
	const caseCarriedBlank = needsBoundCase && explicitCases?.length === 0;

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
				onKeyDownCapture={blockFrozenInteraction}
				onPointerDownCapture={blockFrozenInteraction}
			>
				<fieldset
					key={`${entryKey ?? "inactive"}:${clearRevision}`}
					disabled={formFrozen}
					className="contents"
				>
					{hasFields ? (
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
								This form is getting ready.
							</div>
						) : /* Clear form intentionally remounts uncontrolled browser controls.
						 * A transient access refresh only suspends authority: keeping this
						 * fieldset mounted preserves focus, File inputs, signature ink,
						 * and other browser-owned drafts for the same app/form/worker. A
						 * confirmed app/form/Project/worker boundary rotates the entry
						 * key and retires browser-local continuations with it. */
						paging.enabled ? (
							paging.current !== undefined ? (
								<SectionPage
									key={paging.current.uuid}
									page={paging.current}
									index={paging.index}
									count={paging.count}
									takeFocusOnMount={paging.takeFocusOnMount}
								/>
							) : (
								<div className="text-center text-nova-text-muted py-8">
									Nothing to answer right now. Every section is empty or hidden
									by a display condition.
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
					{paging.count > 0 ? (
						<SectionStepper paging={paging} disabled={formFrozen} />
					) : null}
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
										Back
									</button>
								) : null}
								{paging.isLast ? (
									<button
										type="button"
										onClick={handleSubmit}
										disabled={
											submitStatus.kind === "running" ||
											clearRunning ||
											!caseBindingReady ||
											(appId !== undefined && !attachmentEntryReady) ||
											!mayWriteCaseData
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
										{submitStatus.kind === "running" ? "Submitting" : "Submit"}
									</button>
								) : (
									<button
										type="button"
										onClick={paging.goNext}
										disabled={formFrozen}
										className={FORM_PRIMARY_ACTION_CLS}
									>
										Next
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
								{clearRunning ? "Starting fresh" : "Clear form"}
							</button>
						</div>
					)}
					{validationAnnouncement ? (
						<p
							key={validationAnnouncement.serial}
							role="alert"
							className="sr-only"
						>
							{validationAnnouncement.message}
						</p>
					) : null}
					{formFrozen && !engineInitializing ? (
						<p role="status" className="px-6 pb-3 text-xs text-nova-text-muted">
							{clearRunning
								? "A fresh form entry is ready."
								: repeatTopologySettling
									? "Answers are paused while this repeat updates."
									: "Answers are locked while this submission finishes."}
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

	/* The module's persistent case tile: the same tile Results draws, kept
	 * on screen above every form in the module (`persistOnForms`). Preview
	 * only: edit mode has no bound case, and a band that appeared while
	 * authoring would claim a case the author never chose. It carries no
	 * motion of its own, so a reduced-motion preference has nothing to
	 * suppress; it adds a uniform offset above the field list, which the
	 * flipbook's anchor-based scroll sync already corrects for on a mode
	 * flip. */
	const persistentTile =
		mode === "preview" &&
		mod?.caseListConfig?.tile?.persistOnForms === true &&
		effectiveCaseId !== undefined ? (
			<PersistentCaseTile
				appId={appId}
				caseType={mod.caseType}
				caseId={effectiveCaseId}
				config={mod.caseListConfig}
				caseTypes={caseTypes}
				fallbackProperties={
					caseTypes.find((candidate) => candidate.name === mod.caseType)
						?.properties ?? []
				}
				restoreScopeKey={restoreScopeKey}
			/>
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
	return (
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
}
