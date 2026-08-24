// components/preview/screens/CaseListScreen.tsx
//
// The case list as the running app shows it: the preview-mode screen
// for every case-list workspace URL (`results` / `search` / `details`).
// Search and detail are facets of the same list, so
// preview always shows the assembled artifact: the real
// `SearchInputForm` widgets submit to the real case store with the
// authored button, the list narrows through its own filter box (the same per-word,
// case-insensitive narrowing CommCare's case list runs), and rows open
// the case detail IN PLACE. From the detail, Continue carries the
// selected case into a CASE-LOADING form (followup / close, never
// registration), the same case-select → confirm → form flow the shipped
// app runs. When the module has more than one case-loading form and no
// specific form was chosen first (a case-first entry), Continue lands on
// a FORM MENU: the running app's post-selection "which form?" screen.
// Modules with no detail fields skip the confirm step; modules with no
// case-loading form have nowhere to continue, so the list is
// informational. The destination is read from the running app's
// navigation, never defaulted: see the `seededFormUuid` / `proceedWithCase`
// derivation and `isCaseFirstModule`.
//
// Composition is width-driven: search beside the results when the
// canvas is wide, stacked when it isn't: the same responsive truth
// the running app follows, so authors never pick an export mode. The
// result rows respond to THEIR OWN remaining width: compact canvases
// show labelled case cards, while roomy panes retain aligned columns.
//
// Two flicker guards, both deliberate:
//   - the canvas measures its width synchronously in the ref callback
//     (before first paint), so the side-by-side layout never flashes
//     through the stacked one;
//   - `useCases` keeps the previous rows rendered while a re-query is
//     in flight (`fetching`), so typing narrows the table in place
//     instead of blanking it to a spinner.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerLogin2 from "@iconify-icons/tabler/login-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerX from "@iconify-icons/tabler/x";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import {
	type ColumnDisplayContext,
	projectColumnDisplay,
	renderColumnCell,
} from "@/components/builder/case-list-config/columnCellRenderer";
import { summarizeFilter } from "@/components/builder/case-list-config/predicateSummary";
import {
	useLocalizedModule,
	useLocalizedValues,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { CaseTile } from "@/components/preview/shared/CaseTile";
import { CaseTileGroup } from "@/components/preview/shared/CaseTileGroup";
import { caseColumnLabel } from "@/components/preview/shared/caseColumnLabel";
import { HiddenItemsReveal } from "@/components/preview/shared/HiddenItemsReveal";
import {
	ListFilterBox,
	rowMatchesFilterText,
} from "@/components/preview/shared/listFilter";
import {
	type PreviewWorkerLabel,
	RestoreScopeNote,
	restoreScopeEmptyCopy,
} from "@/components/preview/shared/RestoreScopeNote";
import { SearchInputForm } from "@/components/preview/shared/SearchInputForm";
import { useColumnDisplayContext } from "@/components/preview/shared/useColumnDisplayContext";
import { Button } from "@/components/shadcn/button";
import { Skeleton } from "@/components/shadcn/skeleton";
import { useAuth } from "@/lib/auth/hooks/useAuth";
import {
	useEffectiveCaseTypes,
	useMaterializableCaseTypes,
} from "@/lib/doc/hooks/useCaseTypes";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { usePersonas } from "@/lib/doc/hooks/useUserCollections";
import type { Uuid } from "@/lib/doc/types";
import {
	CASE_LOADING_FORM_TYPES,
	type CaseListConfig,
	type CaseProperty,
	type Column,
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	makeTranslationUnitId,
	orderedColumns,
	SEARCH_INPUT_RUNTIME_VALUE_TYPES,
	SEARCH_RUNTIME_VALIDATION_MESSAGES,
} from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import {
	effectiveFilterForEmission,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import { PreviewMarkdown } from "@/lib/markdown";
import {
	type GroupedTileProjection,
	splitTileGridByGroupHeader,
} from "@/lib/preview/caseTileGrouping";
import {
	projectTileGrid,
	type TileGridProjection,
} from "@/lib/preview/caseTileLayout";
import {
	type TileResultsColumn,
	tileResultsColumns,
} from "@/lib/preview/caseTileRendering";
import { caseRowToFormPreload } from "@/lib/preview/engine/caseDataBindingClient";
import type {
	CaseQueryConstraintContext,
	CaseRowWithCalculated,
} from "@/lib/preview/engine/caseDataBindingTypes";
import { formDisplayVisibility } from "@/lib/preview/engine/displayConditionEvaluation";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import { predicateLookupsCovered } from "@/lib/preview/engine/lookupEvaluation";
import { evaluatePreviewSearchPredicate } from "@/lib/preview/engine/searchExpressionEvaluation";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import { useCaseDataReplacementRevision } from "@/lib/preview/hooks/caseDataInvalidation";
import {
	useCaseCount,
	useCaseData,
	useCases,
} from "@/lib/preview/hooks/useCaseDataBinding";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useRestoreScopeKey } from "@/lib/preview/hooks/useRestoreScopeKey";
import { useSearchInputRunState } from "@/lib/preview/hooks/useSearchInputRunState";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import {
	moduleHasChildren,
	previewCaseDescendantModuleUuids,
	previewMenuCaseContext,
	previewMenuModuleUuids,
} from "@/lib/preview/menuProjection";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	useAccessPhase,
	useAppId,
	useCanEdit,
	usePreviewCaseTarget,
	usePreviewMenuCaseSelections,
	usePreviewParentCaseRequest,
	usePreviewPersonaUuid,
	useProjectScopeEpoch,
	useSetPreviewCaseTarget,
	useSetPreviewMenuCaseSelection,
	useSetPreviewParentCaseRequest,
	useSetPreviewSelectedCase,
} from "@/lib/session/hooks";

/** Canvas width where search sits beside the results instead of above
 *  them: the same responsive truth the running app follows. */
const SPLIT_MIN_WIDTH = 760;
/** Keep real case populations bounded in both the SQL payload and the DOM. */
const CASE_LIST_PAGE_SIZE = 50;
const EMPTY_SEARCH_INPUT_VALUES: ReadonlyMap<string, string> = new Map();
/** Stable empty catalog slice: a fresh `[]` per render would defeat the
 *  display context's memo. */
const NO_CASE_PROPERTIES: readonly CaseProperty[] = [];

interface CaseListScreenProps {
	/** Passed from PreviewShell so the component stays valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "caseList" }>;
}

export function CaseListScreen({ screen }: CaseListScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const menuSource = usePreviewMenuSource();
	const menuCaseSelections = usePreviewMenuCaseSelections();
	const setPreviewMenuCaseSelection = useSetPreviewMenuCaseSelection();
	const previewParentCaseRequest = usePreviewParentCaseRequest();
	const setPreviewParentCaseRequest = useSetPreviewParentCaseRequest();
	/* The MATERIALIZABLE case-type view: derived property types
	 * included, implicit standard entries excluded. The same shape the
	 * running-app query compiler and stored insert schema derive from,
	 * so the list sorts/filters with the same casts and the sample
	 * generator emits keys the row validation accepts. */
	const caseTypes = useMaterializableCaseTypes();
	const effectiveCaseTypes = useEffectiveCaseTypes();
	const appId = useAppId() ?? "";
	const canEdit = useCanEdit();
	const scopeEpoch = useProjectScopeEpoch();
	const accessPhase = useAccessPhase();

	/* All three case-list workspace URLs (`results` / `search` / `details`)
	 * render this screen in preview mode: search and
	 * detail are facets of the same case list, so the live preview is
	 * always the assembled artifact. */
	const moduleUuid =
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config"
			? loc.moduleUuid
			: screen.moduleUuid;
	const routeCaseId = loc.kind === "cases" ? loc.caseId : undefined;

	/* Where selecting a case leads: read from the running app's own
	 * navigation, not a default. Selecting a case always continues into a
	 * CASE-LOADING form (followup / close: the form types that consume a
	 * case), never registration or survey:
	 *
	 *   - Forms-first entry (the worker tapped a specific case-loading form in
	 *     the module menu): `previewCaseTarget` names that form, and we go
	 *     straight to it. This is the mixed-module path (registration + a
	 *     case-loading form), where the form is chosen before the case.
	 *   - Case-first entry (an all-case-loading module's landing, or Preview
	 *     entered from the case workspace): no form was chosen yet. With exactly
	 *     one case-loading form we go straight to it; with more than one, the
	 *     app shows a FORM MENU after the case is picked (CommCare hoists the
	 *     shared case datum, then asks which form: see `isCaseFirstModule`),
	 *     so we render that menu.
	 *
	 * A module with no case-loading form has nowhere to continue, so the
	 * list reads as informational. */
	const orderedForms = useOrderedForms(moduleUuid);
	const previewCaseTarget = usePreviewCaseTarget();
	const setPreviewCaseTarget = useSetPreviewCaseTarget();
	const caseLoadingForms = useMemo(
		() => orderedForms.filter((f) => CASE_LOADING_FORM_TYPES.has(f.type)),
		[orderedForms],
	);
	/** The form a forms-first entry tapped to get here, when it's a real
	 *  case-loading form in this module: otherwise undefined (case-first). */
	const seededFormUuid = useMemo(() => {
		const seeded = previewCaseTarget?.formUuid;
		return seeded && caseLoadingForms.some((f) => f.uuid === seeded)
			? seeded
			: undefined;
	}, [previewCaseTarget?.formUuid, caseLoadingForms]);
	const hasChildren = moduleUuid
		? moduleHasChildren(menuSource, moduleUuid)
		: false;
	const selectsForParentRequest =
		moduleUuid !== undefined &&
		previewParentCaseRequest?.selectingModuleUuid === moduleUuid;
	const selectsForMenu =
		seededFormUuid === undefined && (hasChildren || selectsForParentRequest);
	/** Whether selecting a case can continue at all. */
	const canContinue =
		selectsForMenu ||
		seededFormUuid !== undefined ||
		caseLoadingForms.length > 0;

	const mod = useLocalizedModule(moduleUuid);
	const menuCaseContext = useMemo(
		() =>
			moduleUuid
				? previewMenuCaseContext(menuSource, moduleUuid, menuCaseSelections)
				: undefined,
		[menuCaseSelections, menuSource, moduleUuid],
	);
	const cancelParentCaseSelection = useCallback(() => {
		if (!selectsForParentRequest || !previewParentCaseRequest) return;
		setPreviewParentCaseRequest(undefined);
		setPreviewCaseTarget(undefined);
		navigate.replace(
			previewParentCaseRequest.cancelLocation ?? { kind: "home" },
		);
	}, [
		navigate,
		previewParentCaseRequest,
		selectsForParentRequest,
		setPreviewCaseTarget,
		setPreviewParentCaseRequest,
	]);
	const localizedValues = useLocalizedValues();
	const caseType = caseTypes.find((ct) => ct.name === mod?.caseType);
	const config = mod?.caseListConfig;
	const searchConfig = mod ? effectiveCaseSearchConfig(mod) : undefined;
	const columnDisplayContext = useColumnDisplayContext(
		config,
		mod?.caseType,
		caseType?.properties ?? NO_CASE_PROPERTIES,
	);
	const projectProse = useProseProjection();
	const { signIn } = useAuth();
	/* Whoever Preview is running as: the member, or the persona they
	 * picked. The hook owns the hydration rule, so search defaults and the
	 * assigned-case exclusion resolve against one identity. */
	const identity = useSelectedPreviewIdentity();
	const searchSession = useMemo(
		() => previewSessionValues(identity),
		[identity],
	);
	const lookupStatus = usePreviewLookupStatus();
	/* Case-first form conditions evaluate at THIS screen, against the
	 * SELECTED row's projection: the wire's `<command relevant>` locus
	 * (a case-first module's form menu renders after selection). The
	 * decided list drives the auto-continue AND the post-selection menu,
	 * so a false condition suppresses both. Edit-mode canvases never
	 * reach this running-app pane, so no edit gate is needed here. */
	const decideCaseLoadingForms = useCallback(
		(row: CaseRowWithCalculated) => {
			const projection = caseRowToFormPreload(row);
			return caseLoadingForms.map((form) => ({
				form,
				visibility: formDisplayVisibility({
					condition: form.displayCondition,
					session: searchSession,
					...(caseType !== undefined && { currentCaseType: caseType.name }),
					caseProjection: projection,
					lookup: lookupStatus,
				}),
			}));
		},
		[caseLoadingForms, searchSession, caseType, lookupStatus],
	);
	const searchTypeContext = useMemo<TypeContext>(
		() => ({
			caseTypes: [...effectiveCaseTypes],
			knownInputs: (config?.searchInputs ?? []).map((input) => ({
				uuid: input.uuid,
				name: input.name,
				data_type: SEARCH_INPUT_RUNTIME_VALUE_TYPES[input.type],
			})),
			...(caseType !== undefined && { currentCaseType: caseType.name }),
		}),
		[caseType, config?.searchInputs, effectiveCaseTypes],
	);

	// ── Responsive split: the canvas's own width decides ──
	// Measured synchronously in the ref callback so the very first
	// paint already has the real width; the ResizeObserver keeps it
	// fresh afterwards. (An effect-mounted observer measures only
	// AFTER first paint, which made the layout visibly jump from
	// stacked to side-by-side on every visit.)
	const [width, setWidth] = useState(0);
	const observerRef = useRef<ResizeObserver | null>(null);
	const containerRef = useCallback((el: HTMLDivElement | null) => {
		observerRef.current?.disconnect();
		observerRef.current = null;
		if (!el) return;
		setWidth(el.getBoundingClientRect().width);
		const ro = new ResizeObserver((entries) => {
			setWidth(entries[0]?.contentRect.width ?? 0);
		});
		ro.observe(el);
		observerRef.current = ro;
	}, []);
	const split = width >= SPLIT_MIN_WIDTH;

	// ── Live state ──
	const searchRun = useSearchInputRunState({
		scopeKey: `${scopeEpoch}:${moduleUuid ?? ""}`,
		searchInputs: config?.searchInputs ?? [],
		session: searchSession,
		...(lookupStatus.kind === "data" && { lookupData: lookupStatus.data }),
	});
	const hasSearchInputs = (config?.searchInputs.length ?? 0) > 0;
	const searchButtonCondition = searchConfig?.searchButtonDisplayCondition;
	/* CommCare evaluates this predicate on the case-list Search action, before
	 * the prompt screen exists. Preview's combined Search + Results composition
	 * therefore gates the whole Search pane from the same session/global context;
	 * it must never make the pane's submit button react to its own draft. */
	/* No legacy fallback: the commit gate rejects a condition the on-device
	 * emitter can't lower, and stored pre-gate documents are migrated rather
	 * than tolerated, so a throw here is a Nova bug and must surface, not
	 * fail the action closed. */
	const searchActionIsRelevant =
		searchConfig !== undefined &&
		(searchButtonCondition === undefined ||
			(!predicateLookupsCovered(
				searchButtonCondition,
				lookupStatus.kind === "data" ? lookupStatus.data : undefined,
			)
				? /* A condition whose carriers the held snapshot doesn't cover
					 * (still loading, or a valid edit the stale snapshot predates)
					 * is undecided: keep the Search pane withheld rather than
					 * flashing a surface the decided value may retract. */
					false
				: evaluatePreviewSearchPredicate(
						searchButtonCondition,
						config?.searchInputs ?? [],
						searchSession,
						EMPTY_SEARCH_INPUT_VALUES,
						lookupStatus.kind === "data" ? lookupStatus.data : undefined,
					)));
	/* A retained flipbook submission belongs to the Search action. If a live
	 * session/config edit makes that action irrelevant, show the ordinary case
	 * list instead of silently keeping an inaccessible remote-search query. The
	 * retained draft/submission resumes if the action becomes relevant again. */
	const activeSearchInputValues = searchActionIsRelevant
		? searchRun.submitted
		: undefined;
	/* Assigned-case exclusions constrain the Results population itself. They
	 * therefore apply on the first load, with or without a visible Search
	 * screen, and remain active when a worker clears or removes Search fields.
	 * Read the stored rule rather than the effective Search action: the private
	 * `searchActionEnabled: false` provenance marker suppresses Search without
	 * suppressing this independent Results rule. */
	const excludedOwnerIdsExpression = mod?.caseSearchConfig?.excludedOwnerIds;
	const replacementRevision = useCaseDataReplacementRevision(
		appId,
		caseType?.name,
	);
	const [filterText, setFilterText] = useState("");
	/* Paging belongs to the effective module query. A newly submitted Search or
	 * authored config changes that query identity and synchronously derives page
	 * zero; no effect-frame can briefly request a stale far-away page. */
	const [pageSelection, setPageSelection] = useState<{
		readonly scopeEpoch: number;
		readonly moduleUuid: Uuid | undefined;
		readonly caseTypeName: string | undefined;
		readonly config: CaseListConfig | undefined;
		readonly submitted: typeof activeSearchInputValues;
		readonly excludedOwnerIdsExpression: ValueExpression | undefined;
		readonly replacementRevision: number;
		readonly index: number;
	}>({
		scopeEpoch,
		moduleUuid,
		caseTypeName: caseType?.name,
		config,
		submitted: activeSearchInputValues,
		excludedOwnerIdsExpression,
		replacementRevision,
		index: 0,
	});
	const pageScopeMatches =
		pageSelection.scopeEpoch === scopeEpoch &&
		pageSelection.moduleUuid === moduleUuid &&
		pageSelection.caseTypeName === caseType?.name &&
		pageSelection.config === config &&
		pageSelection.submitted === activeSearchInputValues &&
		pageSelection.excludedOwnerIdsExpression === excludedOwnerIdsExpression &&
		pageSelection.replacementRevision === replacementRevision;
	const requestedPageIndex = pageScopeMatches ? pageSelection.index : 0;
	const casePage = useMemo(
		() => ({
			offset: requestedPageIndex * CASE_LIST_PAGE_SIZE,
			limit: CASE_LIST_PAGE_SIZE,
		}),
		[requestedPageIndex],
	);
	const choosePage = useCallback(
		(index: number) => {
			setPageSelection({
				scopeEpoch,
				moduleUuid,
				caseTypeName: caseType?.name,
				config,
				submitted: activeSearchInputValues,
				excludedOwnerIdsExpression,
				replacementRevision,
				index: Math.max(0, index),
			});
			requestAnimationFrame(() => resultsTitleRef.current?.focus());
		},
		[
			caseType?.name,
			config,
			excludedOwnerIdsExpression,
			moduleUuid,
			replacementRevision,
			scopeEpoch,
			activeSearchInputValues,
		],
	);
	const [openCase, setOpenCase] = useState<CaseRowWithCalculated | null>(null);
	/** When set, the case has been picked (and confirmed) and the running app
	 *  is on the form menu: choosing among the module's case-loading forms.
	 *  Only reached on a case-first entry with more than one such form. */
	const [formMenuCase, setFormMenuCase] =
		useState<CaseRowWithCalculated | null>(null);
	const surfaceRef = useRef<HTMLDivElement>(null);
	const searchPaneRef = useRef<HTMLDivElement>(null);
	const detailBackRef = useRef<HTMLButtonElement>(null);
	const formMenuBackRef = useRef<HTMLButtonElement>(null);
	const routeBackRef = useRef<HTMLButtonElement>(null);
	const routeFallbackElementRef = useRef<HTMLDivElement>(null);
	const routeFallbackOwnedFocusRef = useRef<string | null>(null);
	const resultsTitleRef = useRef<HTMLHeadingElement>(null);
	const originatingCaseIdRef = useRef<string | null>(null);
	const previousRouteCaseIdRef = useRef(routeCaseId);
	const previousRouteModuleUuidRef = useRef(moduleUuid);
	const explicitRouteCloseRef = useRef<string | null>(null);
	const routeDrivenExit =
		previousRouteCaseIdRef.current !== undefined && routeCaseId === undefined;
	const focusNextFrame = useCallback((target: () => HTMLElement | null) => {
		requestAnimationFrame(() => target()?.focus());
	}, []);
	const routeFallbackPaneRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (element === null) return;
			routeFallbackElementRef.current = element;
			const caseId = routeCaseId;
			return () => {
				if (caseId !== undefined && element.contains(document.activeElement)) {
					routeFallbackOwnedFocusRef.current = caseId;
				}
				if (routeFallbackElementRef.current === element) {
					routeFallbackElementRef.current = null;
				}
			};
		},
		[routeCaseId],
	);
	const restoreResultsFocus = useCallback(() => {
		focusNextFrame(() => {
			const actions = Array.from(
				surfaceRef.current?.querySelectorAll<HTMLButtonElement>(
					"[data-case-result-action]",
				) ?? [],
			);
			return (
				actions.find(
					(action) =>
						action.dataset.caseResultAction === originatingCaseIdRef.current,
				) ??
				actions[0] ??
				resultsTitleRef.current
			);
		});
	}, [focusNextFrame]);
	const focusFirstSearchControl = useCallback(() => {
		focusNextFrame(
			() =>
				searchPaneRef.current?.querySelector<HTMLElement>(
					"[data-search-input-card] input:not([disabled]), [data-search-input-card] button:not([disabled]), [data-search-input-card] [tabindex='0']",
				) ?? null,
		);
	}, [focusNextFrame]);
	/* The list stays mounted inside React Activity while authoring is visible.
	 * A record opened from Results therefore leaves its optimistic local row in
	 * memory after a URL-only preview exit unless we clear it when the record
	 * segment disappears. Without this boundary, re-entering Preview could show
	 * the old record under the plain `/results` URL. */
	useEffect(() => {
		const previousRouteCaseId = previousRouteCaseIdRef.current;
		const previousRouteModuleUuid = previousRouteModuleUuidRef.current;
		const exitedRouteDetail =
			previousRouteCaseId !== undefined && routeCaseId === undefined;
		previousRouteCaseIdRef.current = routeCaseId;
		previousRouteModuleUuidRef.current = moduleUuid;
		if (routeCaseId !== undefined) return;
		setOpenCase(null);
		setFormMenuCase(null);
		if (exitedRouteDetail && previousRouteModuleUuid === moduleUuid) {
			const explicitlyClosed =
				explicitRouteCloseRef.current === previousRouteCaseId;
			explicitRouteCloseRef.current = null;
			if (!explicitlyClosed) restoreResultsFocus();
		}
	}, [moduleUuid, restoreResultsFocus, routeCaseId]);
	const routeRevisionRef = useRef({
		caseId: routeCaseId,
		revision: replacementRevision,
	});
	if (routeRevisionRef.current.caseId !== routeCaseId) {
		routeRevisionRef.current = {
			caseId: routeCaseId,
			revision: replacementRevision,
		};
	}
	const routeCaseReplaced =
		routeCaseId !== undefined &&
		routeRevisionRef.current.revision !== replacementRevision;
	const stateScopeKey = `${scopeEpoch}:${moduleUuid ?? ""}`;
	const stateScopeRef = useRef({ scopeEpoch, moduleUuid });
	const stateBelongsToModule =
		stateScopeRef.current.scopeEpoch === scopeEpoch &&
		stateScopeRef.current.moduleUuid === moduleUuid;
	useEffect(() => {
		const previous = stateScopeRef.current;
		if (
			previous.scopeEpoch === scopeEpoch &&
			previous.moduleUuid === moduleUuid
		)
			return;
		stateScopeRef.current = { scopeEpoch, moduleUuid };
		/* Quick-filter text can itself contain a copied case name or other source
		 * value. Clear it with rows/selections on every Project generation, even
		 * when a same-app move leaves the module UUID unchanged. */
		setFilterText("");
		setOpenCase(null);
		setFormMenuCase(null);
		originatingCaseIdRef.current = null;
		routeFallbackOwnedFocusRef.current = null;
	}, [moduleUuid, scopeEpoch]);

	const setPreviewSelectedCase = useSetPreviewSelectedCase();
	useEffect(() => {
		if (!routeCaseReplaced || !moduleUuid) return;
		setOpenCase(null);
		setFormMenuCase(null);
		setPreviewSelectedCase(undefined);
		navigate.replace({ kind: "cases", moduleUuid });
	}, [routeCaseReplaced, moduleUuid, navigate, setPreviewSelectedCase]);

	const previewPersonaUuid = usePreviewPersonaUuid();
	// What this worker's device holds is derived from their assignment and the
	// place tree, and neither is an argument to the read. Sign both into the
	// request so an assignment edit or a place move re-asks instead of serving
	// the previous worker's rows.
	const restoreScopeKey = useRestoreScopeKey(previewPersonaUuid);
	const {
		state,
		fetching,
		queryConstraintSource,
		reload: reloadCases,
	} = useCases({
		appId,
		caseType: caseType?.name,
		caseListConfig: config,
		inputValues: activeSearchInputValues,
		excludedOwnerIdsExpression,
		// The live case-type catalog: the schema slice the SQL compiler
		// casts the config's predicate/sort/calc against. Sent with the
		// config so a property rename/retype reaches both together, and a
		// fresh `caseTypes` reference re-fires the load on a schema edit.
		caseTypes,
		parentCase: menuCaseContext?.parentCase,
		page: casePage,
		requestScopeKey: `${stateScopeKey}\u0000${restoreScopeKey}`,
	});
	/* The Results query can be empty because there is no data OR because the
	 * authored/search conditions exclude an existing population. Keep those
	 * states distinct: only the first should invite an author to create sample
	 * cases. The count deliberately bypasses every module-level condition and
	 * only runs when a constrained empty result needs that distinction. */
	const authoredMatchingCount =
		state.kind === "empty" ? state.authoredMatchingCount : undefined;
	/* Cases the same query matches that this worker's device would not hold.
	 * Present only while previewing as a persona whose restore actually left
	 * something out, so the note appears exactly when there is something to
	 * say. */
	const outsideRestoreCount =
		state.kind === "rows" || state.kind === "empty"
			? state.outsideRestoreCount
			: undefined;
	const personas = usePersonas();
	/* A discriminant, not a name: previewing as yourself reads in the second
	 * person and previewing as a persona in the third, so one interpolated
	 * string cannot serve both. */
	const previewWorker = useMemo<PreviewWorkerLabel>(() => {
		if (previewPersonaUuid === undefined) return { kind: "me" };
		// A selected persona whose record is momentarily absent is still not
		// you: falling back to the second person would tell an author their
		// OWN device is missing cases that a worker's device is missing.
		const name = personas.find(
			(persona) => persona.uuid === previewPersonaUuid,
		)?.name;
		return { kind: "persona", name: name ?? "this worker" };
	}, [personas, previewPersonaUuid]);
	const workerSearchProvesUnderlyingRows =
		queryConstraintSource === "worker-search" &&
		authoredMatchingCount !== undefined &&
		authoredMatchingCount > 0;
	const needsUnfilteredCount =
		state.kind === "empty" &&
		queryConstraintSource !== "unconstrained" &&
		!workerSearchProvesUnderlyingRows;
	const { state: unfilteredCountState, reload: reloadUnfilteredCount } =
		useCaseCount({
			appId: needsUnfilteredCount ? appId : undefined,
			caseType: needsUnfilteredCount ? caseType?.name : undefined,
		});
	/* A record deep link must not depend on the row surviving the authored
	 * Results filter or current 50-row page. Load it directly by identity while
	 * sending the same display config/catalog solely for calculated projection;
	 * when the list query also contains the row, prefer that existing projection. */
	const { state: routeCaseState, reload: reloadRouteCase } = useCaseData({
		appId,
		caseType: caseType?.name,
		caseId: routeCaseId,
		parentCaseId: menuCaseContext?.parentCase?.caseId,
		ancestorDepth: 0,
		caseListConfig: config,
		caseTypes,
		// A canonical Details URL loads its case by identity rather than off
		// the page, so this is the one read that could otherwise open a case
		// the worker's device does not hold.
		deviceScoped: true,
		scopeKey: restoreScopeKey,
	});
	const retryCasesWithFocus = useCallback(async () => {
		const pending = reloadCases();
		focusNextFrame(() => resultsTitleRef.current);
		await pending;
		focusNextFrame(() => resultsTitleRef.current);
	}, [focusNextFrame, reloadCases]);
	const retryCountWithFocus = useCallback(async () => {
		const pending = reloadUnfilteredCount();
		focusNextFrame(() => resultsTitleRef.current);
		await pending;
		focusNextFrame(() => resultsTitleRef.current);
	}, [focusNextFrame, reloadUnfilteredCount]);
	const retryRouteCaseWithFocus = useCallback(
		async (trigger?: HTMLButtonElement) => {
			const pending = reloadRouteCase();
			await pending;
			focusNextFrame(
				() =>
					detailBackRef.current ??
					routeFallbackElementRef.current?.querySelector<HTMLButtonElement>(
						"[data-case-list-empty-action]",
					) ??
					(trigger?.isConnected ? trigger : routeBackRef.current),
			);
		},
		[focusNextFrame, reloadRouteCase],
	);

	/* Clear what the worker typed into the authored Search fields. The list's
	 * quick filter owns its own adjacent clear button; coupling the two produced
	 * two distant-looking ways to clear one filter and made the surfaces feel
	 * interchangeable when they are not. */
	const clearSearch = () => {
		searchRun.clear();
		focusFirstSearchControl();
	};

	// Results and Details are independent compositions: each reads its OWN
	// sequence, so rearranging one running-app screen cannot silently
	// rearrange the other.
	const listOrderedColumns =
		config === undefined ? [] : orderedColumns(config, "list");
	const visibleColumns = listOrderedColumns.filter(
		(col) => col.visibleInList ?? true,
	);
	/* A tile carries the columns the short detail emits: the visible ones
	 * PLUS any hidden column that still orders the list. The hidden one holds
	 * NO square (the wire gives it no `<style>`, so the device draws an empty
	 * zero-size item); it is carried only so ordering keeps working, which is
	 * why the set is derived here rather than from `visibleColumns`. */
	const tileColumns = tileResultsColumns(listOrderedColumns, config?.tile);
	const tileProjection = projectTileGrid(tileColumns.map((c) => c.column));
	/* Presence of the layout is the switch; an unplaced tile has no geometry
	 * to draw, so Results keeps the row layout rather than rendering an empty
	 * grid. The commit gate places every emitted column, so this only guards
	 * a config whose columns are all gone. */
	const tileActive =
		config?.tile !== undefined && tileProjection.cells.length > 0;
	/* Grouping is a slot inside the tile layout, so a grouped list is always a
	 * tile list. The split is derived once here — the same geometry, cut into
	 * the header a group draws once and the body every member repeats. */
	const tileGrouping = config?.tile?.grouping;
	const resultsTileLayout: ResultsTileLayout | undefined = !tileActive
		? undefined
		: {
				projection: tileProjection,
				columns: tileColumns,
				...(tileGrouping !== undefined && {
					grouped: splitTileGridByGroupHeader(
						tileProjection,
						tileGrouping.headerRows,
					),
				}),
			};
	const detailColumns = (
		config === undefined ? [] : orderedColumns(config, "detail")
	).filter((col) => col.visibleInDetail !== false);
	const queryActive = searchRun.queryActive;
	const draftActive = searchRun.draftActive;
	const loadedRows = state.kind === "rows" ? state.rows : [];
	const totalMatchingCases =
		state.kind === "rows" ? (state.totalCount ?? loadedRows.length) : 0;
	/* Present exactly when the case list groups its tile. `loadedRows` is
	 * still the flat page in clustered order, so everything that reads rows
	 * keeps working; this is the clustering on top of it. */
	const groupedResult = state.kind === "rows" ? state.grouped : undefined;
	/* A grouped list PAGES BY GROUP, so the pager's unit changes with it —
	 * `EntityListResponse::getEntitiesForCurrentPage` counts group
	 * boundaries, not rows. The window therefore comes off the grouped slot,
	 * whose numbers count groups, while `totalMatchingCases` keeps counting
	 * cases. A grouped page is unbounded in rows by construction: N groups
	 * arrive with however many cases they hold. */
	const settledPageOffset =
		groupedResult?.pageOffset ??
		(state.kind === "rows"
			? (state.pageOffset ?? requestedPageIndex * CASE_LIST_PAGE_SIZE)
			: requestedPageIndex * CASE_LIST_PAGE_SIZE);
	const settledPageSize =
		groupedResult?.pageSize ??
		(state.kind === "rows" ? (state.pageSize ?? CASE_LIST_PAGE_SIZE) : 0);
	const settledPageIndex =
		settledPageSize > 0
			? Math.floor(settledPageOffset / settledPageSize)
			: requestedPageIndex;
	/** What the pager counts: groups when the list is grouped, cases when not. */
	const pagedUnitTotal = groupedResult?.totalGroupCount ?? totalMatchingCases;
	const pagedUnitCount = groupedResult?.groups.length ?? loadedRows.length;
	const pageStart = pagedUnitCount === 0 ? 0 : settledPageOffset + 1;
	const pageEnd = settledPageOffset + pagedUnitCount;
	const pageLocalFilter = pagedUnitTotal > pagedUnitCount;
	const routeCase = useMemo<CaseRowWithCalculated | null>(() => {
		if (!routeCaseId || routeCaseReplaced) return null;
		const projected = loadedRows.find((row) => row.case_id === routeCaseId);
		/* Results already came from the exact selected-parent population. The
		 * identity read below carries the same server-side case-index constraint,
		 * so neither path guesses membership from denormalized parent_case_id. */
		if (projected) return projected;
		if (routeCaseState.kind !== "row") return null;
		return routeCaseState.row;
	}, [routeCaseId, routeCaseReplaced, loadedRows, routeCaseState]);
	/* A deep-linked case first owns a loading/error fallback pane. If its Back
	 * action had focus when the automatic case read succeeds, transfer that
	 * ownership to the equivalent Back action in Details instead of letting the
	 * unmounted fallback drop focus to the document body. */
	useEffect(() => {
		if (
			routeCase === null ||
			routeCaseId === undefined ||
			routeFallbackOwnedFocusRef.current !== routeCaseId
		) {
			return;
		}
		routeFallbackOwnedFocusRef.current = null;
		focusNextFrame(() => detailBackRef.current);
	}, [focusNextFrame, routeCase, routeCaseId]);
	const displayedOpenCase = routeCaseId
		? routeCase
		: stateBelongsToModule && !routeDrivenExit
			? openCase
			: null;
	const displayedFormMenuCase =
		stateBelongsToModule && !routeDrivenExit ? formMenuCase : null;
	/* Mirror the URL-backed or local selection into session so the sibling
	 * breadcrumb names the same record the screen is actually showing. */
	const selectedCase = stateBelongsToModule
		? (displayedFormMenuCase ?? displayedOpenCase)
		: null;
	useEffect(() => {
		setPreviewSelectedCase(
			selectedCase
				? {
						caseId: selectedCase.case_id,
						caseName: selectedCase.case_name || "Case",
					}
				: undefined,
		);
	}, [selectedCase, setPreviewSelectedCase]);
	const filteredRows = useMemo(
		() =>
			filterText === ""
				? loadedRows
				: loadedRows.filter((row) =>
						rowMatchesFilterText(
							visibleColumns,
							row,
							filterText,
							columnDisplayContext,
						),
					),
		[loadedRows, visibleColumns, filterText, columnDisplayContext],
	);
	/* The same narrowing, applied inside each group. A group whose members all
	 * fail the filter disappears; the ones that survive keep drawing their
	 * header from the group's OWN first case, because the header names the
	 * group rather than one of the matches. */
	const filteredGroups = useMemo<
		readonly ResultsTileGroup[] | undefined
	>(() => {
		if (groupedResult === undefined) return undefined;
		return groupedResult.groups.flatMap<ResultsTileGroup>((group) => {
			const header = group.rows[0];
			if (header === undefined) return [];
			const rows =
				filterText === ""
					? group.rows
					: group.rows.filter((row) =>
							rowMatchesFilterText(
								visibleColumns,
								row,
								filterText,
								columnDisplayContext,
							),
						);
			return rows.length === 0 ? [] : [{ key: group.key, header, rows }];
		});
	}, [groupedResult, visibleColumns, filterText, columnDisplayContext]);
	const caseWord = (count: number) => (count === 1 ? "case" : "cases");
	const groupWord = (count: number) => (count === 1 ? "group" : "groups");
	const visibleResultCount =
		filterText !== ""
			? `${filteredRows.length.toLocaleString()} of ${loadedRows.length.toLocaleString()} ${caseWord(loadedRows.length)}${pageLocalFilter ? " on this page" : ""}`
			: groupedResult !== undefined
				? pageLocalFilter
					? `${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${pagedUnitTotal.toLocaleString()} ${groupWord(pagedUnitTotal)}`
					: `${totalMatchingCases.toLocaleString()} ${caseWord(totalMatchingCases)} in ${pagedUnitTotal.toLocaleString()} ${groupWord(pagedUnitTotal)}`
				: pageLocalFilter
					? `${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${totalMatchingCases.toLocaleString()} cases`
					: `${totalMatchingCases.toLocaleString()} ${caseWord(totalMatchingCases)}`;
	/** The pager's own line. It counts the same unit the pager steps through,
	 *  so a grouped list never reports a page of cases it did not page by. */
	const pagerSummary =
		groupedResult !== undefined
			? `Showing ${groupWord(pagedUnitTotal)} ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${pagedUnitTotal.toLocaleString()}`
			: `Showing ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${totalMatchingCases.toLocaleString()} cases`;
	const announcedResultCount =
		filterText !== ""
			? visibleResultCount
			: pageLocalFilter
				? `Showing ${visibleResultCount}`
				: `${visibleResultCount} found`;
	const title =
		(localizedValues.get(
			makeTranslationUnitId("module", moduleUuid ?? "missing", "search-title"),
		) as string | undefined) ??
		searchConfig?.searchScreenTitle ??
		DEFAULT_CASE_SEARCH_TITLE;
	const subtitle =
		(localizedValues.get(
			makeTranslationUnitId(
				"module",
				moduleUuid ?? "missing",
				"search-subtitle",
			),
		) as string | undefined) ?? searchConfig?.searchScreenSubtitle;
	const searchButtonLabel =
		(localizedValues.get(
			makeTranslationUnitId("module", moduleUuid ?? "missing", "search-button"),
		) as string | undefined) ??
		searchConfig?.searchButtonLabel ??
		DEFAULT_CASE_SEARCH_BUTTON_LABEL;
	const localizedSearchValidationMessages = useMemo(
		() =>
			new Map(
				SEARCH_RUNTIME_VALIDATION_MESSAGES.map((message) => [
					message.message,
					(localizedValues.get(
						makeTranslationUnitId("system", "search-validation", message.key),
					) as string | undefined) ?? message.message,
				]),
			),
		[localizedValues],
	);
	const localizeSearchValidationMessage = useCallback(
		(source: string) => localizedSearchValidationMessages.get(source) ?? source,
		[localizedSearchValidationMessages],
	);
	const effectiveSearchFilter = effectiveFilterForEmission(config?.filter);
	const hasEffectiveSearchFilter = effectiveSearchFilter !== undefined;
	const zeroInputSearchActionIsRelevant =
		!hasSearchInputs && searchActionIsRelevant;
	const automaticallyLaunchesZeroInputSearch =
		zeroInputSearchActionIsRelevant && hasEffectiveSearchFilter;
	const automaticSearchToken = automaticallyLaunchesZeroInputSearch
		? JSON.stringify({
				scopeEpoch,
				moduleUuid,
				filter: effectiveSearchFilter,
				condition: searchButtonCondition,
			})
		: undefined;
	const launchedAutomaticSearchRef = useRef<string | undefined>(undefined);
	const submitSearch = searchRun.submit;
	useEffect(() => {
		if (
			automaticSearchToken === undefined ||
			launchedAutomaticSearchRef.current === automaticSearchToken
		) {
			return;
		}

		/* CommCare auto-launches an input-free Search only when its Results
		 * filter actually narrows the population and the action is relevant. The
		 * ref makes that launch idempotent under React's development effect replay
		 * while still allowing a changed module/filter to launch as a new action. */
		launchedAutomaticSearchRef.current = automaticSearchToken;
		submitSearch(EMPTY_SEARCH_INPUT_VALUES);
	}, [automaticSearchToken, submitSearch]);
	if (mod === undefined) {
		return (
			<ContentFrame width="5xl" className="px-6 pt-6 pb-24">
				<CaseListEmptyNotice
					headingLevel={1}
					title="This module is no longer available"
					description="Return to edit mode and choose another module"
				/>
			</ContentFrame>
		);
	}
	if (caseType === undefined) {
		return (
			<ContentFrame width="5xl" className="px-6 pt-6 pb-24">
				<CaseListEmptyNotice
					headingLevel={1}
					title="Results need a case type"
					description="Return to edit mode and choose one in module settings"
				/>
			</ContentFrame>
		);
	}
	if (visibleColumns.length === 0) {
		return (
			<ContentFrame width="5xl" className="px-6 pt-6 pb-24">
				<CaseListEmptyNotice
					headingLevel={1}
					title="Results need information"
					description="Return to edit mode and add information to Results"
				/>
			</ContentFrame>
		);
	}

	/* Open a specific case-loading form with the selected case in hand:
	 * record the case datum on the preview target so PreviewShell preloads
	 * the form, then navigate. The preview's equivalent of CommCare passing
	 * the selected case down the navigation stack.
	 *
	 * Collapse the detail / form-menu sub-screens first: they're the
	 * transient steps of THIS case selection, not a destination. The case
	 * list is retained (React 19 `<Activity>`), so without this reset,
	 * navigating back from the form would reveal the stale detail-confirm
	 * instead of the list: the running app pops back to the case list to
	 * re-select, never to the confirm screen. Search/filter persist (the
	 * list remembers what you were looking at). */
	const openFormWithCase = (formUuid: Uuid, row: CaseRowWithCalculated) => {
		if (!moduleUuid) return;
		setOpenCase(null);
		setFormMenuCase(null);
		setPreviewCaseTarget({
			formUuid,
			caseId: row.case_id,
			caseName: row.case_name || "Case",
		});
		navigate.openForm(moduleUuid, formUuid);
	};

	/* Proceed once a case is chosen (after the detail confirm, or directly
	 * when there's no detail). Forms-first → straight into the tapped form;
	 * case-first → the single case-loading form, or the form menu when there
	 * are several. */
	const proceedWithCase = (row: CaseRowWithCalculated) => {
		if (selectsForMenu && moduleUuid && mod.caseType) {
			setOpenCase(null);
			setFormMenuCase(null);
			setPreviewSelectedCase(undefined);
			setPreviewCaseTarget(undefined);
			setPreviewMenuCaseSelection(moduleUuid, {
				caseType: mod.caseType,
				caseId: row.case_id,
				caseName: row.case_name || "Case",
				caseProperties: Object.fromEntries(caseRowToFormPreload(row)),
			});
			const staleSelectionModuleUuids = new Set([
				...previewMenuModuleUuids(menuSource, moduleUuid),
				...previewCaseDescendantModuleUuids(menuSource, mod.caseType),
			]);
			for (const staleModuleUuid of staleSelectionModuleUuids) {
				setPreviewMenuCaseSelection(staleModuleUuid, undefined);
			}
			if (selectsForParentRequest && previewParentCaseRequest) {
				const [nextModuleUuid, ...remainingModuleUuids] =
					previewParentCaseRequest.returnModuleUuids;
				setPreviewParentCaseRequest(
					nextModuleUuid && remainingModuleUuids.length > 0
						? {
								selectingModuleUuid: nextModuleUuid,
								returnModuleUuids: remainingModuleUuids,
								...(previewParentCaseRequest.resumeLocation !== undefined && {
									resumeLocation: previewParentCaseRequest.resumeLocation,
								}),
								...(previewParentCaseRequest.cancelLocation !== undefined && {
									cancelLocation: previewParentCaseRequest.cancelLocation,
								}),
							}
						: undefined,
				);
				if (
					nextModuleUuid &&
					remainingModuleUuids.length === 0 &&
					previewParentCaseRequest.resumeLocation !== undefined
				) {
					navigate.replace(previewParentCaseRequest.resumeLocation);
				} else if (nextModuleUuid && remainingModuleUuids.length > 0) {
					navigate.replace({
						kind: "module",
						moduleUuid: nextModuleUuid,
					});
				} else if (nextModuleUuid) {
					navigate.openModule(nextModuleUuid);
				} else {
					navigate.openModule(moduleUuid);
				}
			} else {
				navigate.openModule(moduleUuid);
			}
			return;
		}
		const decided = decideCaseLoadingForms(row);
		const seeded =
			seededFormUuid === undefined
				? undefined
				: decided.find((entry) => entry.form.uuid === seededFormUuid);
		if (seeded?.visibility === "shown") {
			openFormWithCase(seeded.form.uuid, row);
			return;
		}
		/* A seeded target whose condition is false for THIS case falls
		 * through to the ordinary decision rather than opening a form the
		 * running app would not offer. */
		const shown = decided.filter((entry) => entry.visibility === "shown");
		const undecided = decided.some((entry) => entry.visibility === "pending");
		if (!undecided && shown.length === 1) {
			/* The single-form skip applies to the CONDITION-ELIGIBLE set:
			 * a false condition suppresses the auto-continue too. */
			openFormWithCase(shown[0].form.uuid, row);
		} else if (decided.length > 0) {
			/* Several eligible forms, still-loading conditions, or none
			 * eligible at all land on the menu: it renders placeholders and
			 * the hidden-items reveal honestly. */
			setFormMenuCase(row);
			focusNextFrame(() => formMenuBackRef.current);
		}
	};

	/* The running app's row click: a configured detail opens the confirm
	 * step in place; no detail fields means the row proceeds straight on;
	 * a module with no case-loading form has nowhere to go (the list is
	 * informational). */
	const rowAction: "detail" | "form" | "none" =
		detailColumns.length > 0 ? "detail" : canContinue ? "form" : "none";
	const handleOpenCase = (
		row: CaseRowWithCalculated,
		trigger: HTMLButtonElement,
	) => {
		originatingCaseIdRef.current =
			trigger.dataset.caseResultAction ?? row.case_id;
		if (rowAction === "detail") {
			setOpenCase(row);
			if (moduleUuid) navigate.openCaseDetail(moduleUuid, row.case_id);
			focusNextFrame(() => detailBackRef.current);
		} else if (rowAction === "form") proceedWithCase(row);
	};
	const closeCaseDetail = () => {
		if (routeCaseId !== undefined) {
			explicitRouteCloseRef.current = routeCaseId;
		}
		setOpenCase(null);
		setFormMenuCase(null);
		if (moduleUuid) navigate.openCaseList(moduleUuid);
		restoreResultsFocus();
	};

	// ── Panes ──

	const searchPane =
		hasSearchInputs && searchActionIsRelevant ? (
			<div
				ref={searchPaneRef}
				className={`${split ? "w-72 shrink-0" : "w-full"} grid self-start gap-4 rounded-lg border border-pv-input-border bg-pv-surface p-4`}
			>
				<div>
					<div className="flex min-h-11 min-w-0 items-center gap-2">
						<Icon
							icon={tablerSearch}
							width="16"
							height="16"
							className="shrink-0 text-nova-text-secondary"
						/>
						<div
							data-search-pane-title
							className="min-w-0 flex-1 whitespace-normal break-words font-display tracking-tighter text-[15px] font-semibold leading-snug text-nova-text [overflow-wrap:anywhere]"
						>
							{title}
						</div>
						{/* Clear what was typed: lives WITH the search (where you'd
						 *  reach to start over) and only appears when there's an active
						 *  query to clear. */}
						{(queryActive || draftActive) && (
							<Button
								type="button"
								variant="ghost"
								onClick={clearSearch}
								className="ml-auto shrink-0 gap-1 rounded-md px-2 text-[14px] text-nova-text-muted not-disabled:hover:bg-transparent"
							>
								<Icon icon={tablerX} width="13" height="13" />
								Clear search
							</Button>
						)}
					</div>
					{subtitle !== undefined && (
						<div className="preview-markdown mt-1 text-sm text-nova-text-secondary">
							<PreviewMarkdown>{subtitle}</PreviewMarkdown>
						</div>
					)}
				</div>
				{accessPhase === "authorized" && (
					<SearchInputForm
						key={`${scopeEpoch}:${moduleUuid}`}
						landmarkLabel={title}
						scopeKey={moduleUuid}
						searchInputs={config?.searchInputs ?? []}
						filter={config?.filter}
						caseType={caseType}
						session={searchSession}
						typeContext={searchTypeContext}
						value={searchRun.draft}
						onChange={searchRun.changeDraft}
						onSubmit={searchRun.submit}
						submitLabel={searchButtonLabel}
						localizeValidationMessage={localizeSearchValidationMessage}
					/>
				)}
				{state.kind === "invalid-search" && (
					<div
						role="alert"
						className="rounded-lg border border-nova-amber/30 bg-nova-amber/[0.06] p-3"
					>
						<p className="text-sm font-semibold text-nova-text">
							Search needs attention
						</p>
						<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
							{localizeSearchValidationMessage(state.message)}
						</p>
						<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
							{state.repair === "inputs"
								? "Change the Search information, then search again"
								: "Return to edit mode and review Search settings"}
						</p>
					</div>
				)}
			</div>
		) : null;

	const detailPane = displayedOpenCase !== null && (
		<div className="max-w-lg min-w-0 flex-1">
			<Button
				ref={detailBackRef}
				type="button"
				variant="ghost"
				onClick={closeCaseDetail}
				className="-ml-2 mb-3 gap-1.5 rounded-md px-2 py-1.5 text-[14px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.08] not-disabled:hover:text-nova-violet-bright"
			>
				<Icon icon={tablerChevronLeft} width="15" height="15" />
				Back to results
			</Button>
			<h1
				data-case-detail-title
				className="mb-4 min-w-0 font-display font-bold text-xl whitespace-normal break-words tracking-tighter text-nova-text [overflow-wrap:anywhere]"
			>
				{displayedOpenCase.case_name || "Case"}
			</h1>
			<dl
				data-case-detail="responsive"
				className="@container/detail overflow-hidden rounded-lg border border-pv-input-border bg-pv-surface"
			>
				{detailColumns.map((col, i) => {
					const label = caseColumnLabel(col, caseType.properties, projectProse);
					return (
						<div
							key={col.uuid}
							data-case-detail-field={col.uuid}
							className={`grid grid-cols-1 items-start gap-1 px-4 py-3 @sm/detail:grid-cols-[minmax(110px,0.38fr)_minmax(0,1fr)] @sm/detail:gap-3 ${i > 0 ? "border-t border-nova-violet/[0.08]" : ""}`}
						>
							<dt className="break-words text-xs font-medium text-nova-text-muted">
								{label}
							</dt>
							<dd
								data-case-detail-value
								className="min-w-0 break-words text-[14px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
							>
								{renderColumnCell(col, displayedOpenCase, columnDisplayContext)}
							</dd>
						</div>
					);
				})}
			</dl>
			{/* The running app's confirm step ends in Continue: on to the
			 *  case-loading form (or the form menu, when the module has more
			 *  than one). A module with no case-loading form has nowhere to
			 *  continue, so the detail is the end of the road and no button
			 *  renders. */}
			{canContinue && (
				<Button
					type="button"
					onClick={() => proceedWithCase(displayedOpenCase)}
					className="mt-4 gap-2 rounded-lg bg-pv-accent px-4 text-[14px] font-semibold text-nova-void not-disabled:hover:bg-pv-accent not-disabled:hover:brightness-110"
				>
					Continue
					<Icon icon={tablerArrowRight} width="15" height="15" />
				</Button>
			)}
		</div>
	);

	const routeCaseFallbackPane = routeCaseId !== undefined &&
		routeCase === null && (
			<div ref={routeFallbackPaneRef} className="max-w-lg min-w-0 flex-1">
				<Button
					ref={routeBackRef}
					type="button"
					variant="ghost"
					onClick={closeCaseDetail}
					className="-ml-2 mb-3 gap-1.5 rounded-md px-2 py-1.5 text-[14px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.08] not-disabled:hover:text-nova-violet-bright"
				>
					<Icon icon={tablerChevronLeft} width="15" height="15" />
					Back to results
				</Button>
				{routeCaseState.kind === "missing" ? (
					<CaseListEmptyNotice
						headingLevel={1}
						title="This case is no longer available"
						description="To choose another case, return to Results"
					/>
				) : routeCaseState.kind === "error" ? (
					<CaseListEmptyNotice
						headingLevel={1}
						title="This case didn't load"
						description="Try again to view this case"
						tone="error"
						action={{
							label: "Try again",
							onClick: (trigger) => void retryRouteCaseWithFocus(trigger),
						}}
					/>
				) : routeCaseState.kind === "unauthenticated" ? (
					<SessionEndedNotice
						headingLevel={1}
						description="To view this case, sign in again"
						onSignIn={() => void signIn()}
					/>
				) : (
					<CasesLoading />
				)}
			</div>
		);

	/* Form menu: the running app's post-selection screen for a case-first
	 *  module with more than one case-loading form: the worker picked a case,
	 *  now picks which form to run for it (Follow-up / Close / …). Mirrors
	 *  CommCare resolving the shared case datum and THEN asking for the
	 *  command. Each choice carries the chosen case into the form. */
	const formMenuDecided =
		displayedFormMenuCase === null
			? []
			: decideCaseLoadingForms(displayedFormMenuCase);
	const formMenuHidden = formMenuDecided
		.filter((entry) => entry.visibility === "hidden")
		.map((entry) => ({
			key: entry.form.uuid,
			name:
				(localizedValues.get(
					makeTranslationUnitId("form", entry.form.uuid, "name"),
				) as string | undefined) ?? entry.form.name,
			summary: summarizeFilter(entry.form.displayCondition, {
				...(caseType !== undefined && { currentCaseType: caseType.name }),
				projectProse,
			}),
		}));
	const formMenuPane = displayedFormMenuCase !== null && (
		<div className="max-w-lg min-w-0 flex-1">
			{/* Back returns to whatever sits beneath the menu: the case
			 *  detail when one is configured, otherwise the results list. */}
			<Button
				ref={formMenuBackRef}
				type="button"
				variant="ghost"
				onClick={() => {
					setFormMenuCase(null);
					if (displayedOpenCase !== null) {
						focusNextFrame(() => detailBackRef.current);
					} else {
						restoreResultsFocus();
					}
				}}
				className="-ml-2 mb-3 gap-1.5 rounded-md px-2 py-1.5 text-[14px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.08] not-disabled:hover:text-nova-violet-bright"
			>
				<Icon icon={tablerChevronLeft} width="15" height="15" />
				{displayedOpenCase !== null ? "Back" : "Back to results"}
			</Button>
			<h1
				data-form-menu-case-title
				className="mb-1 min-w-0 font-display font-bold text-xl whitespace-normal break-words tracking-tighter text-nova-text [overflow-wrap:anywhere]"
			>
				{displayedFormMenuCase.case_name || "Case"}
			</h1>
			<p className="mb-4 text-[13px] text-nova-text-muted">
				Choose what to do with this case
			</p>
			<div className="grid gap-2">
				{formMenuDecided.map(({ form, visibility }) => {
					const localizedFormName =
						(localizedValues.get(
							makeTranslationUnitId("form", form.uuid, "name"),
						) as string | undefined) ?? form.name;
					if (visibility === "hidden") return null;
					if (visibility === "pending") {
						return (
							<Skeleton
								key={form.uuid}
								className="h-[58px] w-full rounded-lg"
							/>
						);
					}
					return (
						<Button
							key={form.uuid}
							type="button"
							variant="outline"
							onClick={() => openFormWithCase(form.uuid, displayedFormMenuCase)}
							className="group h-auto min-h-11 w-full justify-start gap-3 whitespace-normal rounded-lg border-pv-input-border bg-pv-surface p-3 text-left duration-200 not-disabled:hover:border-pv-input-focus not-disabled:hover:bg-pv-surface not-disabled:hover:text-foreground"
						>
							<Icon
								icon={formTypeIcons[form.type]}
								width="18"
								height="18"
								className="text-nova-text-muted group-hover:text-pv-accent-bright transition-colors shrink-0"
							/>
							<span
								data-form-menu-choice-label
								className="min-w-0 flex-1 whitespace-normal break-words text-sm font-medium text-nova-text [overflow-wrap:anywhere]"
							>
								{localizedFormName}
							</span>
							<Icon
								icon={tablerArrowRight}
								width="15"
								height="15"
								className="text-nova-text-muted shrink-0"
							/>
						</Button>
					);
				})}
			</div>
			<HiddenItemsReveal items={formMenuHidden} />
		</div>
	);

	const resultsPane = (
		<div className="flex-1 min-w-0">
			<div className="mb-3 flex min-w-0 items-baseline gap-3">
				<h1
					ref={resultsTitleRef}
					tabIndex={-1}
					data-results-title
					className="min-w-0 flex-1 font-display font-bold text-xl whitespace-normal break-words tracking-tighter text-nova-text [overflow-wrap:anywhere]"
				>
					{mod.name}
				</h1>
				{state.kind === "rows" && (
					<>
						<span
							data-results-count
							aria-hidden="true"
							className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-nova-text-muted"
						>
							{visibleResultCount}
							{/* Trailing, always-reserved spinner slot. The count text must
							 *  stay the span's FIRST flex item: the row aligns by baseline,
							 *  and a flex container's baseline comes from its first item:
							 *  an SVG's baseline is its bottom edge (~2px off the text
							 *  baseline), so a leading or unmounting spinner bounces the
							 *  count vertically every time fetching toggles. */}
							<Icon
								icon={tablerLoader2}
								width="12"
								height="12"
								className={fetching ? "animate-spin" : "invisible"}
							/>
						</span>
						<span
							role="status"
							aria-live="polite"
							aria-atomic="true"
							className="sr-only"
						>
							{fetching ? "Updating cases…" : announcedResultCount}
						</span>
					</>
				)}
			</div>
			{zeroInputSearchActionIsRelevant && !hasEffectiveSearchFilter && (
				<Button
					type="button"
					onClick={() => {
						submitSearch(EMPTY_SEARCH_INPUT_VALUES);
						focusNextFrame(() => resultsTitleRef.current);
					}}
					className="mb-4 h-auto min-h-11 max-w-full gap-2 whitespace-normal break-words rounded-lg bg-pv-accent px-4 py-2.5 text-center text-[14px] font-semibold text-nova-void not-disabled:hover:bg-pv-accent not-disabled:hover:brightness-110 [overflow-wrap:anywhere]"
				>
					<Icon icon={tablerSearch} width="16" height="16" />
					{searchButtonLabel}
				</Button>
			)}
			{state.kind === "rows" && loadedRows.length > 0 && (
				<div className="mb-3">
					<ListFilterBox
						value={filterText}
						onChange={setFilterText}
						resultCount={filterText === "" ? undefined : filteredRows.length}
						scope={pageLocalFilter ? "page" : "results"}
					/>
					{pageLocalFilter && (
						<p className="mt-2 text-xs leading-relaxed text-nova-text-muted">
							This filter checks the {loadedRows.length.toLocaleString()}{" "}
							{loadedRows.length === 1 ? "case" : "cases"} on this page. Go to
							another page to check more cases.
						</p>
					)}
				</div>
			)}
			{outsideRestoreCount !== undefined && state.kind === "rows" && (
				<RestoreScopeNote count={outsideRestoreCount} worker={previewWorker} />
			)}
			<ResultsBody
				state={state}
				unfilteredCountState={unfilteredCountState}
				authoredMatchingCount={authoredMatchingCount}
				outsideRestoreCount={outsideRestoreCount}
				previewWorker={previewWorker}
				fetching={fetching}
				onRetryCases={retryCasesWithFocus}
				onRetryCount={retryCountWithFocus}
				onSignIn={() => void signIn()}
				rows={filteredRows}
				groups={filteredGroups}
				filterActive={filterText !== ""}
				pageLocalFilter={pageLocalFilter}
				visibleColumns={visibleColumns}
				tile={resultsTileLayout}
				caseProperties={caseType.properties}
				columnDisplayContext={columnDisplayContext}
				emptyResultContext={queryConstraintSource}
				canEdit={canEdit}
				searchErrorShown={hasSearchInputs && searchActionIsRelevant}
				rowAction={rowAction}
				onOpenCase={handleOpenCase}
				busy={fetching}
			/>
			{state.kind === "rows" && pagedUnitTotal > settledPageSize && (
				<nav
					aria-label="Results pages"
					className="mt-4 flex flex-wrap items-center justify-between gap-3"
				>
					<p className="text-xs text-nova-text-muted">{pagerSummary}</p>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={fetching || settledPageOffset === 0}
							onClick={() => choosePage(settledPageIndex - 1)}
							className=""
						>
							Previous
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={fetching || pageEnd >= pagedUnitTotal}
							onClick={() => choosePage(settledPageIndex + 1)}
							className=""
						>
							Next
						</Button>
					</div>
				</nav>
			)}
			{state.kind === "rows" &&
				filteredRows.length > 0 &&
				rowAction !== "none" && (
					<p className="mt-2.5 text-xs text-nova-text-muted">
						{rowAction === "detail"
							? "To view details, select a case"
							: "To continue, select a case"}
					</p>
				)}
		</div>
	);

	/* Right-hand pane priority mirrors the running app's screen stack: the
	 * form menu (post-selection) sits above the detail confirm, which sits
	 * above the results list. */
	const onSubScreen =
		displayedFormMenuCase !== null ||
		displayedOpenCase !== null ||
		routeCaseId !== undefined;
	return (
		<ContentFrame ref={containerRef} width="5xl" className="px-6 pt-6 pb-24">
			{selectsForParentRequest && (
				<Button
					type="button"
					variant="ghost"
					onClick={cancelParentCaseSelection}
					className="-ml-2 mb-3 gap-1.5 rounded-md px-2 py-1.5 text-[14px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.08] not-disabled:hover:text-nova-violet-bright"
				>
					<Icon icon={tablerChevronLeft} width="15" height="15" />
					Back
				</Button>
			)}
			<div
				ref={surfaceRef}
				className={`flex gap-5 ${split ? "flex-row items-start" : "flex-col"}`}
			>
				{/* Stacked + a sub-screen open = the narrow experience: the
				 *  sub-screen takes the whole canvas, search waits behind Back. */}
				{(split || !onSubScreen) && searchPane}
				{displayedFormMenuCase !== null
					? formMenuPane
					: displayedOpenCase !== null
						? detailPane
						: routeCaseId !== undefined
							? routeCaseFallbackPane
							: resultsPane}
			</div>
		</ContentFrame>
	);
}

// ── Results body ──────────────────────────────────────────────────

/** The list's loading arm: shown before the first settle and while a
 *  stale-empty view revalidates. */
function CasesLoading() {
	return (
		<div
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className="flex items-center justify-center gap-2 py-12 text-sm text-nova-text-secondary"
		>
			<Icon
				icon={tablerLoader2}
				width="16"
				height="16"
				className="animate-spin"
				aria-hidden="true"
			/>
			Loading cases…
		</div>
	);
}

function ResultsBody({
	state,
	unfilteredCountState,
	authoredMatchingCount,
	outsideRestoreCount,
	previewWorker,
	fetching,
	onRetryCases,
	onRetryCount,
	onSignIn,
	rows,
	groups,
	filterActive,
	pageLocalFilter,
	visibleColumns,
	tile,
	caseProperties,
	columnDisplayContext,
	emptyResultContext,
	canEdit,
	searchErrorShown,
	rowAction,
	onOpenCase,
	busy,
}: {
	readonly state: ReturnType<typeof useCases>["state"];
	/** Complete case-type population, before Results/search conditions. Keeping
	 * the loading/error arms prevents the copy from guessing before it settles. */
	readonly unfilteredCountState: ReturnType<typeof useCaseCount>["state"];
	readonly authoredMatchingCount: number | undefined;
	/** Cases of this type the project holds that this worker would not. */
	readonly outsideRestoreCount: number | undefined;
	readonly previewWorker: PreviewWorkerLabel;
	readonly fetching: boolean;
	readonly onRetryCases: () => Promise<void>;
	readonly onRetryCount: () => Promise<void>;
	readonly onSignIn: () => void;
	/** Rows after the list filter box's narrowing. */
	readonly rows: readonly CaseRowWithCalculated[];
	/** Present exactly when the list is grouped, narrowed the same way. */
	readonly groups: readonly ResultsTileGroup[] | undefined;
	readonly filterActive: boolean;
	readonly pageLocalFilter: boolean;
	readonly visibleColumns: CaseListConfig["columns"];
	/** Present when the case list is laid out as a tile; absent keeps rows. */
	readonly tile: ResultsTileLayout | undefined;
	readonly caseProperties: readonly CaseProperty[];
	readonly columnDisplayContext: ColumnDisplayContext;
	/** Why an empty server result may differ from a truly empty case type. */
	readonly emptyResultContext: CaseQueryConstraintContext;
	readonly canEdit: boolean;
	readonly searchErrorShown: boolean;
	readonly rowAction: "detail" | "form" | "none";
	readonly onOpenCase: (
		row: CaseRowWithCalculated,
		trigger: HTMLButtonElement,
	) => void;
	readonly busy: boolean;
}) {
	if (state.kind === "idle" || state.kind === "loading") {
		return <CasesLoading />;
	}

	if (state.kind === "error") {
		return <CasesLoadFailureNotice onRetry={onRetryCases} />;
	}
	if (state.kind === "invalid-search") {
		return searchErrorShown ? (
			<CaseListEmptyNotice
				title={
					state.repair === "inputs"
						? "Change Search to see Results"
						: "Search settings need attention"
				}
				description={
					state.repair === "inputs"
						? "Change the Search information to update Results"
						: "An app editor needs to review Search settings"
				}
			/>
		) : (
			<CaseListEmptyNotice
				title="Search needs attention"
				description={`${state.message.replace(/[.!?]+$/, "")}. Return to edit mode and review Search settings`}
				tone="warning"
			/>
		);
	}

	if (state.kind === "persona-unavailable") {
		return (
			<CaseListEmptyNotice
				title="Choose who Preview runs as"
				description={state.message}
				tone="warning"
			/>
		);
	}

	if (state.kind === "unauthenticated") {
		return (
			<SessionEndedNotice
				description="To view these cases, sign in again"
				onSignIn={onSignIn}
			/>
		);
	}

	if (state.kind === "empty") {
		// A retained empty result belongs to the previous request until the
		// authoritative action settles, so do not guess its new cause mid-fetch.
		if (fetching) {
			return <CasesLoading />;
		}
		// The RESTORE first, because every cause below it is read off a
		// TENANT-wide count and would misattribute. Left later in the chain,
		// an empty restore over a populated project reports "no case data" or
		// blames the worker's Search values — beside a note on the same screen
		// saying the project holds hundreds of these cases.
		if (outsideRestoreCount !== undefined && outsideRestoreCount > 0) {
			const copy = restoreScopeEmptyCopy(outsideRestoreCount, previewWorker);
			return (
				<CaseListEmptyNotice
					title={copy.title}
					description={copy.description}
				/>
			);
		}
		// An unconstrained empty query is an unfiltered population read of what
		// the caller asked for, so with no restore in play it proves no cases
		// exist without waiting for the sibling count. The restore arm above is
		// what keeps that inference honest once a device scope narrows it.
		if (emptyResultContext === "unconstrained") {
			return <NoCaseDataNotice canEdit={canEdit} />;
		}
		if (
			emptyResultContext === "worker-search" &&
			authoredMatchingCount !== undefined &&
			authoredMatchingCount > 0
		) {
			return <NoMatchNotice />;
		}
		if (
			unfilteredCountState.kind === "idle" ||
			unfilteredCountState.kind === "loading"
		) {
			return <CasesLoading />;
		}
		if (unfilteredCountState.kind === "unauthenticated") {
			return (
				<SessionEndedNotice
					description="To view these cases, sign in again"
					onSignIn={onSignIn}
				/>
			);
		}
		if (unfilteredCountState.kind === "error") {
			return <CaseCountFailureNotice onRetry={onRetryCount} />;
		}
		if (unfilteredCountState.count === 0) {
			return <NoCaseDataNotice canEdit={canEdit} />;
		}
		if (emptyResultContext === "worker-search") {
			return authoredMatchingCount === 0 ? (
				<AvailabilityConditionsEmptyNotice canEdit={canEdit} />
			) : (
				<CaseListEmptyNotice
					title="No cases are available for this search"
					description={
						canEdit
							? "Try different Search information or review Cases available in Results"
							: "Try different Search information or ask an app editor to review Cases available"
					}
				/>
			);
		}
		if (emptyResultContext === "authored-rules") {
			return <AvailabilityConditionsEmptyNotice canEdit={canEdit} />;
		}
		return <NoCaseDataNotice canEdit={canEdit} />;
	}

	if (rows.length === 0) {
		if (filterActive) {
			return (
				<CaseListEmptyNotice
					title={
						pageLocalFilter
							? "No cases on this page match your filter"
							: "No cases match your filter"
					}
					description={
						pageLocalFilter
							? "Clear the filter, try a different phrase, or check another page"
							: "Clear the filter or try a different phrase"
					}
				/>
			);
		}
		if (emptyResultContext === "worker-search") {
			return <NoMatchNotice />;
		}
		if (emptyResultContext === "authored-rules") {
			return <AvailabilityConditionsEmptyNotice canEdit={canEdit} />;
		}
		return (
			<CaseListEmptyNotice
				title="No cases to show"
				description="Try searching again or change which cases appear in Results"
			/>
		);
	}

	return (
		<div>
			{tile === undefined ? (
				<ResultsTable
					rows={rows}
					visibleColumns={visibleColumns}
					caseProperties={caseProperties}
					columnDisplayContext={columnDisplayContext}
					rowAction={rowAction}
					onOpenCase={onOpenCase}
					busy={busy}
				/>
			) : (
				<ResultsTiles
					rows={rows}
					groups={groups}
					tile={tile}
					caseProperties={caseProperties}
					columnDisplayContext={columnDisplayContext}
					rowAction={rowAction}
					onOpenCase={onOpenCase}
					busy={busy}
				/>
			)}
		</div>
	);
}

// ── No-match state ────────────────────────────────────────────────

/** One visual grammar for every settled empty Results state. The title carries
 * the outcome; the quieter second line gives the next useful action. */
function CaseListEmptyNotice({
	headingLevel = 2,
	title,
	description,
	tone = "neutral",
	action,
}: {
	readonly headingLevel?: 1 | 2;
	readonly title: string;
	readonly description: string;
	readonly tone?: "neutral" | "warning" | "error";
	readonly action?: {
		readonly label: string;
		readonly onClick: (trigger: HTMLButtonElement) => void;
		readonly icon?: typeof tablerRefresh;
	};
}) {
	const Heading = headingLevel === 1 ? "h1" : "h2";
	return (
		<div
			data-case-list-empty-notice
			role={tone === "error" ? "alert" : "status"}
			className={`rounded-lg border px-6 py-10 text-center ${
				tone === "error"
					? "border-nova-rose/30 bg-nova-rose/[0.06]"
					: tone === "warning"
						? "border-nova-amber/30 bg-nova-amber/[0.06]"
						: "border-pv-input-border bg-pv-surface/20"
			}`}
		>
			<Heading className="text-base font-semibold text-nova-text">
				{title}
			</Heading>
			<p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-nova-text-secondary">
				{description}
			</p>
			{action && (
				<Button
					type="button"
					variant="outline"
					className="mt-4"
					data-case-list-empty-action
					onClick={(event) => action.onClick(event.currentTarget)}
				>
					<Icon icon={action.icon ?? tablerRefresh} />
					{action.label}
				</Button>
			)}
		</div>
	);
}

/** The complete case type is empty, not merely this Results query. */
function NoCaseDataNotice({ canEdit }: { readonly canEdit: boolean }) {
	return (
		<CaseListEmptyNotice
			title="No cases yet"
			description={
				canEdit
					? "Create a case or add sample cases in Case data"
					: "Ask an app editor to create a case or add sample cases"
			}
		/>
	);
}

/** Worker-facing zero-results guidance for a submitted search. */
function NoMatchNotice() {
	return (
		<CaseListEmptyNotice
			title="No cases match your search"
			description="Check your spelling, clear a field, or try a broader search"
		/>
	);
}

/** Existing cases are present, but the authored availability conditions
 * exclude all of them from this module. */
function AvailabilityConditionsEmptyNotice({
	canEdit,
}: {
	readonly canEdit: boolean;
}) {
	return (
		<CaseListEmptyNotice
			title={
				canEdit
					? "Your availability settings hide every case"
					: "No cases match this app's availability settings"
			}
			description={
				canEdit
					? "To show cases, update Cases available in Results or create a matching case"
					: "Ask an app editor to review Cases available or create a matching case"
			}
		/>
	);
}

function CasesLoadFailureNotice({
	onRetry,
}: {
	readonly onRetry: () => Promise<void>;
}) {
	return (
		<CaseListEmptyNotice
			title="This case list didn't load"
			description="Try again to view cases"
			tone="error"
			action={{ label: "Try again", onClick: () => void onRetry() }}
		/>
	);
}

function CaseCountFailureNotice({
	onRetry,
}: {
	readonly onRetry: () => Promise<void>;
}) {
	return (
		<CaseListEmptyNotice
			title="Nova couldn't check why no cases are showing"
			description="Try again to check whether cases need to be created or your availability settings are hiding them"
			tone="error"
			action={{ label: "Try again", onClick: () => void onRetry() }}
		/>
	);
}

function SessionEndedNotice({
	headingLevel = 2,
	description,
	onSignIn,
}: {
	readonly headingLevel?: 1 | 2;
	readonly description: string;
	readonly onSignIn: () => void;
}) {
	return (
		<CaseListEmptyNotice
			headingLevel={headingLevel}
			title="You're signed out"
			description={description}
			tone="error"
			action={{ label: "Sign in", onClick: onSignIn, icon: tablerLogin2 }}
		/>
	);
}

// ── Responsive results ────────────────────────────────────────────

/**
 * Container-query classes for the point where a labelled result card can
 * become an aligned table row without squeezing or scrolling its fields.
 *
 * The results pane is narrower than the canvas whenever search sits beside
 * it, so viewport breakpoints (or the canvas's split boolean) are the wrong
 * measurement. These named container variants key off the result list
 * itself. The threshold rises with the number of configured columns; seven
 * or more stay as cards because this screen's 5xl frame can never give each
 * one a useful table-cell width.
 */
interface ResultsLayoutClasses {
	readonly header: string;
	readonly row: string;
	readonly cell: string;
	readonly label: string;
	readonly arrow: string;
}

const ALWAYS_STACKED_RESULTS: ResultsLayoutClasses = {
	header: "",
	row: "",
	cell: "",
	label: "",
	arrow: "",
};

const XL_RESULTS: ResultsLayoutClasses = {
	header: "@xl/results:grid",
	row: "@xl/results:grid @xl/results:py-0 @xl/results:pr-0",
	cell: "@xl/results:flex @xl/results:min-h-11 @xl/results:py-2.5",
	label: "@xl/results:sr-only",
	arrow: "@xl/results:static @xl/results:grid",
};

const TWO_XL_RESULTS: ResultsLayoutClasses = {
	header: "@2xl/results:grid",
	row: "@2xl/results:grid @2xl/results:py-0 @2xl/results:pr-0",
	cell: "@2xl/results:flex @2xl/results:min-h-11 @2xl/results:py-2.5",
	label: "@2xl/results:sr-only",
	arrow: "@2xl/results:static @2xl/results:grid",
};

const THREE_XL_RESULTS: ResultsLayoutClasses = {
	header: "@3xl/results:grid",
	row: "@3xl/results:grid @3xl/results:py-0 @3xl/results:pr-0",
	cell: "@3xl/results:flex @3xl/results:min-h-11 @3xl/results:py-2.5",
	label: "@3xl/results:sr-only",
	arrow: "@3xl/results:static @3xl/results:grid",
};

const FOUR_XL_RESULTS: ResultsLayoutClasses = {
	header: "@4xl/results:grid",
	row: "@4xl/results:grid @4xl/results:py-0 @4xl/results:pr-0",
	cell: "@4xl/results:flex @4xl/results:min-h-11 @4xl/results:py-2.5",
	label: "@4xl/results:sr-only",
	arrow: "@4xl/results:static @4xl/results:grid",
};

/** Visible row content sits above the stretched primary button. Ordinary text
 * passes pointer input through to that button; authored cell controls opt back
 * in as independent siblings with their own focus and touch behavior. */
const INTERACTIVE_RESULT_CELL_CLASSES =
	"pointer-events-none [&_a]:pointer-events-auto [&_a]:relative [&_a]:z-20 [&_button]:pointer-events-auto [&_button]:relative [&_button]:z-20";

const INTERACTIVE_RESULT_ROW_CLASSES =
	"nova-focusable cursor-pointer transition-colors hover:bg-nova-violet/[0.05] focus-within:bg-nova-violet/[0.05] [&_a]:rounded-lg";

function resultsLayoutClasses(columnCount: number): ResultsLayoutClasses {
	if (columnCount <= 3) return XL_RESULTS;
	if (columnCount === 4) return TWO_XL_RESULTS;
	if (columnCount === 5) return THREE_XL_RESULTS;
	if (columnCount === 6) return FOUR_XL_RESULTS;
	return ALWAYS_STACKED_RESULTS;
}

function ResultsTable({
	rows,
	visibleColumns,
	caseProperties,
	columnDisplayContext,
	rowAction,
	onOpenCase,
	busy,
}: {
	readonly rows: readonly CaseRowWithCalculated[];
	readonly visibleColumns: CaseListConfig["columns"];
	readonly caseProperties: readonly CaseProperty[];
	readonly columnDisplayContext: ColumnDisplayContext;
	readonly rowAction: "detail" | "form" | "none";
	readonly onOpenCase: (
		row: CaseRowWithCalculated,
		trigger: HTMLButtonElement,
	) => void;
	readonly busy: boolean;
}) {
	const clickable = rowAction !== "none";
	const layout = resultsLayoutClasses(visibleColumns.length);
	const gridTemplateColumns = `${visibleColumns.map(() => "minmax(0, 1fr)").join(" ")} 36px`;
	return (
		<div
			data-case-results="responsive"
			data-refreshing={busy || undefined}
			aria-busy={busy}
			inert={busy ? true : undefined}
			className={`@container/results overflow-clip rounded-lg border border-pv-input-border bg-pv-surface transition-opacity ${busy ? "opacity-60" : ""}`}
		>
			<div
				data-case-results-header
				aria-hidden="true"
				className={`hidden border-b border-pv-input-border bg-pv-bg/60 ${layout.header}`}
				style={{ gridTemplateColumns }}
			>
				{visibleColumns.map((col) => (
					<div
						key={col.uuid}
						className="min-w-0 px-3.5 py-2.5 text-[13px] font-semibold text-nova-text break-words"
					>
						{caseColumnLabel(
							col,
							caseProperties,
							columnDisplayContext.projectProse,
						)}
					</div>
				))}
				<div aria-hidden="true" />
			</div>
			<ul className="m-0 list-none p-0" aria-label="Cases">
				{rows.map((row) => {
					const content = (
						<>
							{visibleColumns.map((col, index) => (
								<span
									key={col.uuid}
									data-case-result-field={col.uuid}
									className={`relative z-10 grid min-w-0 grid-cols-[minmax(84px,0.38fr)_minmax(0,1fr)] items-start gap-3 px-3.5 py-2 text-[14px] ${clickable ? INTERACTIVE_RESULT_CELL_CLASSES : ""} ${layout.cell}`}
								>
									<span
										className={`text-xs font-medium text-nova-text-muted ${layout.label}`}
									>
										{caseColumnLabel(
											col,
											caseProperties,
											columnDisplayContext.projectProse,
										)}
									</span>
									<span
										className={`min-w-0 break-words [overflow-wrap:anywhere] ${index === 0 ? "font-medium text-nova-text" : "text-nova-text-secondary"}`}
									>
										{renderColumnCell(col, row, columnDisplayContext)}
									</span>
								</span>
							))}
							<span
								aria-hidden="true"
								className={`pointer-events-none absolute top-3 right-3 z-10 grid place-items-center text-nova-text-muted ${layout.arrow}`}
							>
								{clickable && (
									<Icon icon={tablerChevronRight} width="14" height="14" />
								)}
							</span>
						</>
					);
					const rowClassName = `relative block h-auto w-full min-w-0 whitespace-normal rounded-none border-x-0 border-t-0 border-b border-nova-violet/[0.07] py-1.5 pr-9 pl-0 text-left font-normal last:border-b-0 ${layout.row}`;
					if (!clickable) {
						return (
							<li
								key={row.case_id}
								data-case-result-row="informational"
								className={rowClassName}
								style={{ gridTemplateColumns }}
							>
								{content}
							</li>
						);
					}
					const primaryActionLabel = primaryRowActionLabel(
						visibleColumns,
						row,
						columnDisplayContext,
						rowAction,
					);
					return (
						<li
							key={row.case_id}
							data-case-result-row="interactive"
							className={`${rowClassName} ${INTERACTIVE_RESULT_ROW_CLASSES}`}
							style={{ gridTemplateColumns }}
						>
							{/* Keep the primary row action and authored in-cell actions as
							 * siblings. A button cannot contain a phone link or a value-details
							 * button; the full-size action sits beneath the visible content while
							 * those cell actions opt back into pointer events above it. */}
							<Button
								type="button"
								variant="ghost"
								aria-label={primaryActionLabel}
								data-case-result-action={row.case_id}
								onClick={(event) => onOpenCase(row, event.currentTarget)}
								disabled={busy}
								className="nova-focusable-inset absolute inset-0 z-0 h-auto w-auto rounded-none border-0 p-0 not-disabled:hover:bg-transparent dark:not-disabled:hover:bg-transparent"
							/>
							{content}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/**
 * What the row's own action announces. The name comes from what the list
 * actually shows, so a worker hears the row they are choosing rather than
 * a stored id, and both row shapes (columns and tile) derive it the same
 * way, so switching layouts never changes what a screen reader says.
 */
function primaryRowActionLabel(
	columns: readonly Column[],
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
	rowAction: "detail" | "form" | "none",
): string {
	const summary = columns
		.map((column) => projectColumnDisplay(column, row, context).text.trim())
		.filter(Boolean)
		.slice(0, 3)
		.join(", ");
	const caseReference = summary || row.case_name.trim() || "this case";
	return rowAction === "detail"
		? `View details for ${caseReference}`
		: `Continue with ${caseReference}`;
}

// ── Tile results ──────────────────────────────────────────────────

/** The geometry + column set one tile-laid-out list draws every row with. */
interface ResultsTileLayout {
	readonly projection: TileGridProjection;
	readonly columns: readonly TileResultsColumn[];
	/**
	 * Present when the case list groups its tile: the same geometry split
	 * into the header the group shows once and the body every member
	 * repeats. Absent keeps one tile per case.
	 */
	readonly grouped?: GroupedTileProjection;
}

/**
 * One group as the list draws it: the case its header comes from, and the
 * members whose body rows it stacks. `header` is the group's own first
 * case even when the list filter has narrowed `rows`, because the header
 * names the group rather than one of the matches.
 */
interface ResultsTileGroup {
	readonly key: string;
	readonly header: CaseRowWithCalculated;
	readonly rows: readonly CaseRowWithCalculated[];
}

/**
 * The Results list when the case list carries a tile layout: one tile per
 * row, drawn from the authored grid instead of a row of columns.
 *
 * ## Responsive behavior
 *
 * The tile does not reflow, collapse, or scale at any width. A tile is a
 * phone-first layout: the device that runs it is 360 CSS pixels wide, and
 * a preview that rearranged the grid to fit a builder canvas would stop
 * showing what a worker sees, which is the whole point of running the app
 * here. So width changes the tile's surroundings, never its geometry:
 *
 *   - **Compact (container under 600px, Material's first boundary).** The
 *     row's gutters tighten so the pane spends its width on content. The
 *     list holds a legibility floor of 18rem: below that the list scrolls
 *     horizontally inside its own container: the same containment wide
 *     content uses everywhere, rather than squeezing a 12-column grid to
 *     roughly a character per column. A builder canvas is wider than the
 *     floor even on a 320px handset, so the floor is a guarantee, not a
 *     state a worker normally meets.
 *   - **Medium and up (600 / 840 / 1200 / 1600).** The gutters relax and
 *     the tile is capped at a 48rem measure. A 12-column tile stretched to
 *     1600px gives a single-column cell 130px, which no device draws and
 *     which turns short values into isolated islands; the extra width
 *     becomes room around the list instead. Web Apps' own case list is
 *     likewise capped until its small-screen mode goes full-width.
 */
function ResultsTiles({
	rows,
	groups,
	tile,
	caseProperties,
	columnDisplayContext,
	rowAction,
	onOpenCase,
	busy,
}: {
	readonly rows: readonly CaseRowWithCalculated[];
	/** Present exactly when the list is grouped; one entry per drawn card. */
	readonly groups: readonly ResultsTileGroup[] | undefined;
	readonly tile: ResultsTileLayout;
	readonly caseProperties: readonly CaseProperty[];
	readonly columnDisplayContext: ColumnDisplayContext;
	readonly rowAction: "detail" | "form" | "none";
	readonly onOpenCase: (
		row: CaseRowWithCalculated,
		trigger: HTMLButtonElement,
	) => void;
	readonly busy: boolean;
}) {
	const clickable = rowAction !== "none";
	/* The action name reads the values a worker can actually see; a hidden
	 * sort carrier holds a square but shows nothing, so it names nothing. */
	const spokenColumns = tile.columns
		.filter((entry) => !entry.valueHidden)
		.map((entry) => entry.column);
	/* One drawn card and the ONE case choosing it opens. Grouped or not, a
	 * card is a single target: Web Apps keeps only the group's first model in
	 * the rendered collection, so its body rows carry no id and no handler
	 * (`views.js::CaseTileGroupedListView.initialize`). */
	const groupedTile = groups === undefined ? undefined : tile.grouped;
	const cards: ReadonlyArray<{
		readonly key: string;
		readonly actionRow: CaseRowWithCalculated;
		readonly tile: ReactNode;
	}> =
		groups !== undefined && groupedTile !== undefined
			? groups.map((group) => ({
					key: `group:${group.key}`,
					actionRow: group.header,
					tile: (
						<CaseTileGroup
							projection={groupedTile}
							columns={tile.columns}
							headerRow={group.header}
							rows={group.rows}
							caseProperties={caseProperties}
							displayContext={columnDisplayContext}
							className="relative z-10"
						/>
					),
				}))
			: rows.map((row) => ({
					key: row.case_id,
					actionRow: row,
					tile: (
						<CaseTile
							projection={tile.projection}
							columns={tile.columns}
							row={row}
							caseProperties={caseProperties}
							displayContext={columnDisplayContext}
							surface="results"
							className="relative z-10"
						/>
					),
				}));
	return (
		<div
			data-case-results="tile"
			data-case-results-grouped={groupedTile !== undefined || undefined}
			data-refreshing={busy || undefined}
			aria-busy={busy}
			inert={busy ? true : undefined}
			className={`@container/results overflow-x-auto overflow-y-clip rounded-lg border border-pv-input-border bg-pv-surface transition-opacity ${busy ? "opacity-60" : ""}`}
		>
			{groupedTile !== undefined && (
				/* Said plainly, permanently, and where a worker sees it: a
				 * grouped card is one choice. The rows beneath the header are
				 * there to read. */
				<p className="border-nova-violet/[0.07] border-b px-3 py-2 text-xs text-nova-text-muted @min-[37.5rem]/results:px-5">
					Choosing a group opens its first case. The rows beneath are there to
					read.
				</p>
			)}
			<ul className="m-0 w-full min-w-[18rem] list-none p-0" aria-label="Cases">
				{cards.map(({ key, actionRow: row, tile: drawnTile }) => {
					const content = (
						<>
							{drawnTile}
							<span
								aria-hidden="true"
								className="pointer-events-none absolute top-3 right-3 z-10 grid place-items-center text-nova-text-muted"
							>
								{clickable && (
									<Icon icon={tablerChevronRight} width="14" height="14" />
								)}
							</span>
						</>
					);
					const rowClassName =
						"relative block h-auto w-full min-w-0 whitespace-normal rounded-none border-x-0 border-t-0 border-b border-nova-violet/[0.07] py-3 pr-9 pl-3 text-left font-normal last:border-b-0 @min-[37.5rem]/results:py-4 @min-[37.5rem]/results:pl-5";
					if (!clickable) {
						return (
							<li
								key={key}
								data-case-result-row="informational"
								className={rowClassName}
							>
								{content}
							</li>
						);
					}
					return (
						<li
							key={key}
							data-case-result-row="interactive"
							className={`${rowClassName} ${INTERACTIVE_RESULT_ROW_CLASSES}`}
						>
							{/* Same sibling rule the column layout follows: the full-size
							 * row action sits beneath the tile, and an authored cell
							 * control (a phone link, a value explanation) opts back into
							 * pointer events above it. A tile changes a row's shape, not
							 * what may be nested inside its primary button. */}
							<Button
								type="button"
								variant="ghost"
								aria-label={primaryRowActionLabel(
									spokenColumns,
									row,
									columnDisplayContext,
									rowAction,
								)}
								data-case-result-action={row.case_id}
								onClick={(event) => onOpenCase(row, event.currentTarget)}
								disabled={busy}
								className="nova-focusable-inset absolute inset-0 z-0 h-auto w-auto rounded-none border-0 p-0 not-disabled:hover:bg-transparent dark:not-disabled:hover:bg-transparent"
							/>
							{content}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
