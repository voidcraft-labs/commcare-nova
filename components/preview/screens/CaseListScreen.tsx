// components/preview/screens/CaseListScreen.tsx
//
// The case list as the running app shows it — the preview-mode screen
// for every case-list workspace URL (`cases` / `search-config` /
// `detail-config`). Search and detail are facets of the same list, so
// preview always shows the assembled artifact: the real
// `SearchInputForm` widgets submit to the real case store with the
// authored button, the list narrows through its own filter box (the same per-word,
// case-insensitive narrowing CommCare's case list runs), and rows open
// the case detail IN PLACE. From the detail, Continue carries the
// selected case into a CASE-LOADING form (followup / close — never
// registration), the same case-select → confirm → form flow the shipped
// app runs. When the module has more than one case-loading form and no
// specific form was chosen first (a case-first entry), Continue lands on
// a FORM MENU — the running app's post-selection "which form?" screen.
// Modules with no detail fields skip the confirm step; modules with no
// case-loading form have nowhere to continue, so the list is
// informational. The destination is read from the running app's
// navigation, never defaulted — see the `seededFormUuid` / `proceedWithCase`
// derivation and `isCaseFirstModule`.
//
// Composition is width-driven: search beside the results when the
// canvas is wide, stacked when it isn't — the same responsive truth
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
import tablerSearch from "@iconify-icons/tabler/search";
import tablerWand from "@iconify-icons/tabler/wand";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { renderColumnCell } from "@/components/builder/case-list-config/columnCellRenderer";
import { GenerateSampleDataButton } from "@/components/builder/case-list-config/SampleDataButton";
import { effectiveModeKind } from "@/components/builder/case-list-config/searchInputResolution";
import { useSampleData } from "@/components/builder/case-list-config/useSampleData";
import {
	ListFilterBox,
	rowMatchesFilterText,
} from "@/components/preview/shared/listFilter";
import { SearchInputForm } from "@/components/preview/shared/SearchInputForm";
import { useAuth } from "@/lib/auth/hooks/useAuth";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import {
	byDetailColumnOrder,
	byListColumnOrder,
} from "@/lib/doc/order/compare";
import type { Uuid } from "@/lib/doc/types";
import {
	CASE_LOADING_FORM_TYPES,
	type CaseListConfig,
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	effectiveDataType,
	fuzzyMode,
	SEARCH_MODE_PROPERTY_TYPES,
	type SimpleSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import {
	effectiveFilterForEmission,
	isMatchNone,
	simplifyForEmission,
} from "@/lib/domain/predicate";
import { PreviewMarkdown } from "@/lib/markdown";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { previewSearchSessionValues } from "@/lib/preview/engine/searchExpressionEvaluation";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useCases } from "@/lib/preview/hooks/useCaseDataBinding";
import { useSearchInputRunState } from "@/lib/preview/hooks/useSearchInputRunState";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	useAppId,
	usePreviewCaseTarget,
	useSetPreviewCaseTarget,
	useSetPreviewSelectedCase,
} from "@/lib/session/hooks";

/** Canvas width where search sits beside the results instead of above
 *  them — the same responsive truth the running app follows. */
const SPLIT_MIN_WIDTH = 760;

interface CaseListScreenProps {
	/** Passed from PreviewShell so the component stays valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "caseList" }>;
}

export function CaseListScreen({ screen: _screen }: CaseListScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	/* The MATERIALIZABLE case-type view — derived property types
	 * included, implicit standard entries excluded. The same shape the
	 * authoring preview compiles against and the stored insert schema
	 * is derived from, so the running-app list sorts/filters with the
	 * same casts and the sample generator emits keys the row
	 * validation accepts. */
	const caseTypes = useMaterializableCaseTypes();
	const appId = useAppId() ?? "";
	const { updateModule } = useBlueprintMutations();

	/* All three case-list workspace URLs (`cases` / `search-config` /
	 * `detail-config`) render this screen in preview mode — search and
	 * detail are facets of the same case list, so the live preview is
	 * always the assembled artifact. */
	const moduleUuid =
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config"
			? loc.moduleUuid
			: undefined;

	/* Where selecting a case leads — read from the running app's own
	 * navigation, not a default. Selecting a case always continues into a
	 * CASE-LOADING form (followup / close — the form types that consume a
	 * case), never registration or survey:
	 *
	 *   - Forms-first entry (the worker tapped a specific case-loading form in
	 *     the module menu): `previewCaseTarget` names that form, and we go
	 *     straight to it. This is the mixed-module path (registration + a
	 *     case-loading form), where the form is chosen before the case.
	 *   - Case-first entry (an all-case-loading module's landing, or the
	 *     workspace case-list preview): no form was chosen yet. With exactly
	 *     one case-loading form we go straight to it; with more than one, the
	 *     app shows a FORM MENU after the case is picked (CommCare hoists the
	 *     shared case datum, then asks which form — see `isCaseFirstModule`),
	 *     so we render that menu.
	 *
	 * A module with no case-loading form has nowhere to continue, so the
	 * list reads as informational. */
	const orderedForms = useOrderedForms((moduleUuid ?? "") as Uuid);
	const previewCaseTarget = usePreviewCaseTarget();
	const setPreviewCaseTarget = useSetPreviewCaseTarget();
	const caseLoadingForms = useMemo(
		() => orderedForms.filter((f) => CASE_LOADING_FORM_TYPES.has(f.type)),
		[orderedForms],
	);
	/** The form a forms-first entry tapped to get here, when it's a real
	 *  case-loading form in this module — otherwise undefined (case-first). */
	const seededFormUuid = useMemo(() => {
		const seeded = previewCaseTarget?.formUuid;
		return seeded && caseLoadingForms.some((f) => f.uuid === seeded)
			? seeded
			: undefined;
	}, [previewCaseTarget?.formUuid, caseLoadingForms]);
	/** Whether selecting a case can continue at all. */
	const canContinue =
		seededFormUuid !== undefined || caseLoadingForms.length > 0;

	const mod = useModuleEntity(moduleUuid);
	const caseType = caseTypes.find((ct) => ct.name === mod?.caseType);
	const config = mod?.caseListConfig;
	const searchConfig = mod ? effectiveCaseSearchConfig(mod) : undefined;
	const { user } = useAuth();
	// Better Auth can resolve its cached session synchronously on the browser's
	// first paint while SSR has no client session. Keep the first render on the
	// shared empty context, then apply session-backed defaults after hydration.
	const [authMounted, setAuthMounted] = useState(false);
	useEffect(() => setAuthMounted(true), []);
	const searchSession = useMemo(
		() => previewSearchSessionValues(authMounted ? user : null),
		[authMounted, user],
	);

	// ── Responsive split — the canvas's own width decides ──
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
		scopeKey: moduleUuid ?? "",
		searchInputs: config?.searchInputs ?? [],
		session: searchSession,
	});
	const hasSearch = (config?.searchInputs.length ?? 0) > 0;
	/* Ownership exclusions are part of the authored search, not the passive
	 * list load. Do not narrow the initial list before the worker actually
	 * submits Search — even an all-blank submit is intentional. A real
	 * filter-only search has no submit screen, so its effective filter is the
	 * launch and activates the exclusion immediately. */
	const filterOnlyAutoLaunch =
		!hasSearch &&
		searchConfig !== undefined &&
		effectiveFilterForEmission(config?.filter) !== undefined;
	const excludedOwnerIdsExpression =
		searchRun.hasSubmitted || filterOnlyAutoLaunch
			? searchConfig?.excludedOwnerIds
			: undefined;
	const [filterText, setFilterText] = useState("");
	const [openCase, setOpenCase] = useState<CaseRowWithCalculated | null>(null);
	/** When set, the case has been picked (and confirmed) and the running app
	 *  is on the form menu — choosing among the module's case-loading forms.
	 *  Only reached on a case-first entry with more than one such form. */
	const [formMenuCase, setFormMenuCase] =
		useState<CaseRowWithCalculated | null>(null);
	const stateScopeRef = useRef(moduleUuid);
	useEffect(() => {
		if (stateScopeRef.current === moduleUuid) return;
		stateScopeRef.current = moduleUuid;
		setFilterText("");
		setOpenCase(null);
		setFormMenuCase(null);
	}, [moduleUuid]);

	/* Mirror the locally-selected case into session so the breadcrumb can
	 * name it while we're on the list (the strip is a sibling component and
	 * can't read this local state). The detail/form-menu case is the one being
	 * looked at; clears to undefined when neither is open — including on
	 * reveal after navigating back from the form, so the list's breadcrumb
	 * drops the stale case. */
	const setPreviewSelectedCase = useSetPreviewSelectedCase();
	const selectedCase = formMenuCase ?? openCase;
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

	const { state, fetching, reload } = useCases({
		appId,
		caseType: caseType?.name,
		caseListConfig: config,
		inputValues: searchRun.submitted,
		excludedOwnerIdsExpression,
		// The live case-type catalog — the schema slice the SQL compiler
		// casts the config's predicate/sort/calc against. Sent with the
		// config so a property rename/retype reaches both together, and a
		// fresh `caseTypes` reference re-fires the load on a schema edit.
		caseTypes,
	});

	const { generate } = useSampleData({
		appId,
		caseType,
		onDone: reload,
	});

	/* Clear what the worker typed — the search panel's "Clear" affordance,
	 *  shown only when a query is active. Backing out of an open detail /
	 *  form menu is the breadcrumb + "Back to Results" job, not this one, so
	 *  this clears the search inputs and the list filter and nothing else. */
	const clearSearch = () => {
		searchRun.clear();
		setFilterText("");
	};

	// Results and Details are independent compositions. Each consumes its own
	// fractional order key (falling back to legacy `order`) so rearranging one
	// running-app screen cannot silently rearrange the other.
	const visibleColumns = [...(config?.columns ?? [])]
		.sort(byListColumnOrder)
		.filter((col) => col.visibleInList ?? true);
	const detailColumns = [...(config?.columns ?? [])]
		.sort(byDetailColumnOrder)
		.filter((col) => col.visibleInDetail !== false);
	const queryActive = searchRun.queryActive;
	const draftActive = searchRun.draftActive;
	/* The case type has no rows at all (vs. a search that matched nothing —
	 *  that's `empty` WITH an active query). The generate affordance keys off
	 *  this so it never shows over a real no-match. */
	const storeEmpty = state.kind === "empty" && !queryActive;

	const loadedRows = state.kind === "rows" ? state.rows : [];
	const filteredRows = useMemo(
		() =>
			filterText === ""
				? loadedRows
				: loadedRows.filter((row) =>
						rowMatchesFilterText(visibleColumns, row, filterText),
					),
		[loadedRows, visibleColumns, filterText],
	);

	/* A zero-match against a letter-for-letter text field is the single
	 * most common "search is broken" experience — a lowercase or
	 * partial name typed into an exact-match field. Spot that shape
	 * (typed-into, text, exact mode, property admits fuzzy) so the
	 * no-match state can name the cause and fix it in one click. */
	const strictTextInputs = useMemo(
		() =>
			(config?.searchInputs ?? []).filter((s): s is SimpleSearchInputDef => {
				if (s.kind !== "simple" || s.type !== "text" || s.via !== undefined)
					return false;
				if ((searchRun.submitted.get(s.name)?.trim() ?? "") === "")
					return false;
				if (effectiveModeKind(s) !== "exact") return false;
				const def = caseType?.properties.find((p) => p.name === s.property);
				if (def === undefined) return false;
				return (
					SEARCH_MODE_PROPERTY_TYPES.fuzzy?.includes(effectiveDataType(def)) ??
					true
				);
			}),
		[config?.searchInputs, searchRun.submitted, caseType],
	);
	const makeFuzzy = () => {
		if (moduleUuid === undefined || config === undefined) return;
		const strict = new Set(strictTextInputs.map((s) => s.uuid));
		const next: CaseListConfig = {
			...config,
			searchInputs: config.searchInputs.map((s) =>
				s.kind === "simple" && strict.has(s.uuid)
					? simpleSearchInputDef(s.uuid, s.name, s.label, s.type, s.property, {
							via: s.via,
							mode: fuzzyMode(),
							default: s.default,
						})
					: s,
			),
		};
		updateModule(moduleUuid, { caseListConfig: next });
	};

	if (!mod || !caseType || visibleColumns.length === 0) {
		return (
			<div className="p-6 text-center text-nova-text-muted">
				No case list configured for this module.
			</div>
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
	 * instead of the list — the running app pops back to the case list to
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
		if (seededFormUuid !== undefined) {
			openFormWithCase(seededFormUuid, row);
		} else if (caseLoadingForms.length === 1) {
			openFormWithCase(caseLoadingForms[0].uuid, row);
		} else if (caseLoadingForms.length > 1) {
			setFormMenuCase(row);
		}
	};

	/* The running app's row click: a configured detail opens the confirm
	 * step in place; no detail fields means the row proceeds straight on;
	 * a module with no case-loading form has nowhere to go (the list is
	 * informational). */
	const rowAction: "detail" | "form" | "none" =
		detailColumns.length > 0 ? "detail" : canContinue ? "form" : "none";
	const handleOpenCase = (row: CaseRowWithCalculated) => {
		if (rowAction === "detail") setOpenCase(row);
		else if (rowAction === "form") proceedWithCase(row);
	};

	const title = searchConfig?.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE;
	const subtitle = searchConfig?.searchScreenSubtitle;
	const searchButtonLabel =
		searchConfig?.searchButtonLabel ?? DEFAULT_CASE_SEARCH_BUTTON_LABEL;
	const buttonCondition = searchConfig?.searchButtonDisplayCondition;
	// The preview has no authoritative CommCare session/case-action context in
	// which to evaluate a dynamic predicate. It can still honor every static
	// boolean identity exactly (including nested `not` / `and` / `or`) without
	// inventing values: deeply simplify, hide only when the condition proves
	// false, and keep unresolved dynamic conditions visible.
	const showSearchButton =
		buttonCondition === undefined ||
		!isMatchNone(simplifyForEmission(buttonCondition));

	// ── Panes ──

	const searchPane = hasSearch ? (
		<div
			className={`${split ? "w-72 shrink-0" : "w-full"} self-start rounded-lg border border-pv-input-border bg-pv-surface p-4`}
		>
			<div className="flex items-center gap-2 mb-1">
				<Icon
					icon={tablerSearch}
					width="16"
					height="16"
					className="text-nova-text-secondary"
				/>
				<span className="font-display font-semibold text-[15px] text-nova-text">
					{title}
				</span>
				{/* Clear what was typed — lives WITH the search (where you'd
				 *  reach to start over) and only appears when there's an active
				 *  query to clear. */}
				{(queryActive || draftActive || filterText !== "") && (
					<button
						type="button"
						onClick={clearSearch}
						className="ml-auto inline-flex items-center gap-1 px-2 min-h-11 -my-1 rounded-md text-xs text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
					>
						<Icon icon={tablerX} width="13" height="13" />
						Clear
					</button>
				)}
			</div>
			{subtitle !== undefined && (
				<div className="mb-2 preview-markdown text-xs text-nova-text-muted">
					<PreviewMarkdown>{subtitle}</PreviewMarkdown>
				</div>
			)}
			<SearchInputForm
				searchInputs={config?.searchInputs ?? []}
				caseType={caseType}
				value={searchRun.draft}
				onChange={searchRun.changeDraft}
				onSubmit={showSearchButton ? searchRun.submit : undefined}
				submitLabel={searchButtonLabel}
			/>
			{/* No data to search yet — the generate affordance lives here, with
			 *  the search, rather than as a giant button dominating the results.
			 *  (Only when there IS a search panel; the no-search case keeps it
			 *  inline in the results body.) */}
			{storeEmpty && (
				<div className="mt-3 pt-3 border-t border-pv-input-border/60 text-center">
					<p className="text-xs text-nova-text-muted mb-2.5">
						No sample data to search yet.
					</p>
					<GenerateSampleDataButton generate={generate} className="w-full" />
				</div>
			)}
		</div>
	) : null;

	const detailPane = openCase !== null && (
		<div className="max-w-lg min-w-0 flex-1">
			<button
				type="button"
				onClick={() => setOpenCase(null)}
				className="inline-flex items-center gap-1.5 -ml-2 mb-3 px-2 py-1.5 min-h-11 rounded-md text-[13px] text-nova-violet-bright hover:bg-nova-violet/[0.08] transition-colors cursor-pointer"
			>
				<Icon icon={tablerChevronLeft} width="15" height="15" />
				Back to Results
			</button>
			<h2 className="font-display font-bold text-xl tracking-tight text-nova-text mb-4">
				{openCase.case_name || "Case"}
			</h2>
			<div
				data-case-detail="responsive"
				className="@container/detail overflow-hidden rounded-lg border border-pv-input-border bg-pv-surface"
			>
				{detailColumns.map((col, i) => {
					const label =
						col.kind === "calculated"
							? col.header || "untitled"
							: col.header || col.field || "untitled";
					return (
						<div
							key={col.uuid}
							data-case-detail-field={col.uuid}
							className={`grid grid-cols-1 items-start gap-1 px-4 py-3 @sm/detail:grid-cols-[minmax(110px,0.38fr)_minmax(0,1fr)] @sm/detail:gap-3 ${i > 0 ? "border-t border-nova-violet/[0.08]" : ""}`}
						>
							<span className="break-words text-xs font-medium text-nova-text-muted">
								{label}
							</span>
							<span
								data-case-detail-value
								className="min-w-0 break-words text-[13px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
							>
								{renderColumnCell(col, openCase)}
							</span>
						</div>
					);
				})}
			</div>
			{/* The running app's confirm step ends in Continue — on to the
			 *  case-loading form (or the form menu, when the module has more
			 *  than one). A module with no case-loading form has nowhere to
			 *  continue, so the detail is the end of the road and no button
			 *  renders. */}
			{canContinue && (
				<button
					type="button"
					onClick={() => proceedWithCase(openCase)}
					className="mt-4 inline-flex items-center gap-2 px-4 min-h-11 rounded-lg bg-pv-accent text-white text-[13px] font-semibold hover:brightness-110 transition-all cursor-pointer"
				>
					Continue
					<Icon icon={tablerArrowRight} width="15" height="15" />
				</button>
			)}
		</div>
	);

	/* Form menu — the running app's post-selection screen for a case-first
	 *  module with more than one case-loading form: the worker picked a case,
	 *  now picks which form to run for it (Follow-up / Close / …). Mirrors
	 *  CommCare resolving the shared case datum and THEN asking for the
	 *  command. Each choice carries the chosen case into the form. */
	const formMenuPane = formMenuCase !== null && (
		<div className="max-w-lg min-w-0 flex-1">
			{/* Back returns to whatever sits beneath the menu — the case
			 *  detail when one is configured, otherwise the results list. */}
			<button
				type="button"
				onClick={() => setFormMenuCase(null)}
				className="inline-flex items-center gap-1.5 -ml-2 mb-3 px-2 py-1.5 min-h-11 rounded-md text-[13px] text-nova-violet-bright hover:bg-nova-violet/[0.08] transition-colors cursor-pointer"
			>
				<Icon icon={tablerChevronLeft} width="15" height="15" />
				{openCase !== null ? "Back" : "Back to Results"}
			</button>
			<h2 className="font-display font-bold text-xl tracking-tight text-nova-text mb-1">
				{formMenuCase.case_name || "Case"}
			</h2>
			<p className="mb-4 text-[13px] text-nova-text-muted">
				Choose what to do with this case.
			</p>
			<div className="grid gap-2">
				{caseLoadingForms.map((form) => (
					<button
						key={form.uuid}
						type="button"
						onClick={() => openFormWithCase(form.uuid, formMenuCase)}
						className="w-full flex items-center gap-3 p-3 rounded-lg bg-pv-surface border border-pv-input-border hover:border-pv-input-focus transition-all duration-200 cursor-pointer text-left group"
					>
						<Icon
							icon={formTypeIcons[form.type]}
							width="18"
							height="18"
							className="text-nova-text-muted group-hover:text-pv-accent-bright transition-colors shrink-0"
						/>
						<span className="flex-1 min-w-0 text-sm font-medium text-nova-text">
							{form.name}
						</span>
						<Icon
							icon={tablerArrowRight}
							width="15"
							height="15"
							className="text-nova-text-muted shrink-0"
						/>
					</button>
				))}
			</div>
		</div>
	);

	const resultsPane = (
		<div className="flex-1 min-w-0">
			<div className="flex items-baseline gap-3 mb-3">
				<h2 className="font-display font-bold text-xl tracking-tight text-nova-text">
					{mod.name}
				</h2>
				{state.kind === "rows" && (
					<span className="ml-auto inline-flex items-center gap-1.5 text-xs text-nova-text-muted whitespace-nowrap">
						{filteredRows.length} {filteredRows.length === 1 ? "case" : "cases"}
						{/* Trailing, always-reserved spinner slot. The count text must
						 *  stay the span's FIRST flex item: the row aligns by baseline,
						 *  and a flex container's baseline comes from its first item —
						 *  an SVG's baseline is its bottom edge (~2px off the text
						 *  baseline), so a leading or unmounting spinner bounces the
						 *  count vertically every time fetching toggles. */}
						<Icon
							icon={tablerLoader2}
							width="12"
							height="12"
							className={fetching ? "animate-spin" : "invisible"}
							aria-label={fetching ? "Updating" : undefined}
							aria-hidden={!fetching}
						/>
					</span>
				)}
			</div>
			{state.kind === "rows" && loadedRows.length > 0 && (
				<div className="mb-3">
					<ListFilterBox
						value={filterText}
						onChange={setFilterText}
						resultCount={filterText === "" ? undefined : filteredRows.length}
					/>
				</div>
			)}
			<ResultsBody
				state={state}
				fetching={fetching}
				rows={filteredRows}
				filterActive={filterText !== ""}
				visibleColumns={visibleColumns}
				queryActive={queryActive}
				hasSearch={hasSearch}
				rowAction={rowAction}
				onOpenCase={handleOpenCase}
				generate={generate}
				strictTextInputs={strictTextInputs}
				onMakeFuzzy={makeFuzzy}
			/>
			{state.kind === "rows" &&
				filteredRows.length > 0 &&
				rowAction !== "none" && (
					<p className="mt-2.5 text-xs text-nova-text-muted">
						{rowAction === "detail"
							? "Click any row to open the case."
							: "Click any row to continue into the form."}
					</p>
				)}
		</div>
	);

	/* Right-hand pane priority mirrors the running app's screen stack: the
	 * form menu (post-selection) sits above the detail confirm, which sits
	 * above the results list. */
	const onSubScreen = formMenuCase !== null || openCase !== null;
	return (
		<ContentFrame ref={containerRef} width="5xl" className="px-6 pt-6 pb-24">
			<div
				className={`flex gap-5 ${split ? "flex-row items-start" : "flex-col"}`}
			>
				{/* Stacked + a sub-screen open = the narrow experience: the
				 *  sub-screen takes the whole canvas, search waits behind Back. */}
				{(split || !onSubScreen) && searchPane}
				{formMenuCase !== null
					? formMenuPane
					: openCase !== null
						? detailPane
						: resultsPane}
			</div>
		</ContentFrame>
	);
}

// ── Results body ──────────────────────────────────────────────────

/** The list's loading arm — shown before the first settle and while a
 *  stale-empty view revalidates. */
function CasesLoading() {
	return (
		<div className="flex items-center justify-center gap-2 py-12 text-xs text-nova-text-muted">
			<Icon
				icon={tablerLoader2}
				width="14"
				height="14"
				className="animate-spin"
			/>
			Loading cases…
		</div>
	);
}

function ResultsBody({
	state,
	fetching,
	rows,
	filterActive,
	visibleColumns,
	queryActive,
	hasSearch,
	rowAction,
	onOpenCase,
	generate,
	strictTextInputs,
	onMakeFuzzy,
}: {
	readonly state: ReturnType<typeof useCases>["state"];
	readonly fetching: boolean;
	/** Rows after the list filter box's narrowing. */
	readonly rows: readonly CaseRowWithCalculated[];
	readonly filterActive: boolean;
	readonly visibleColumns: CaseListConfig["columns"];
	readonly queryActive: boolean;
	/** Whether the module has a search panel — when it does, the empty-store
	 *  generate affordance lives THERE, so this body only names the gap. */
	readonly hasSearch: boolean;
	readonly rowAction: "detail" | "form" | "none";
	readonly onOpenCase: (row: CaseRowWithCalculated) => void;
	readonly generate: ReturnType<typeof useSampleData>["generate"];
	readonly strictTextInputs: readonly SimpleSearchInputDef[];
	readonly onMakeFuzzy: () => void;
}) {
	if (state.kind === "idle" || state.kind === "loading") {
		return <CasesLoading />;
	}

	if (state.kind === "error") {
		return (
			<div className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] px-5 py-6 text-center text-xs text-nova-rose">
				{state.message}
			</div>
		);
	}

	if (state.kind === "unauthenticated") {
		return (
			<div className="rounded-lg border border-pv-input-border px-5 py-6 text-center text-xs text-nova-text-muted">
				Sign in to view case data.
			</div>
		);
	}

	if (state.kind === "empty" && queryActive) {
		// The store reports `empty` for "this query matched nothing" too —
		// with a search active that means no match, not an empty store.
		return (
			<NoMatchNotice
				strictTextInputs={strictTextInputs}
				onMakeFuzzy={onMakeFuzzy}
			/>
		);
	}

	if (state.kind === "empty") {
		// Revalidating a stale "empty" — e.g. re-entering preview after rows
		// were generated elsewhere, which re-runs the load. Show the loader,
		// not a generate button that's about to be replaced by rows. A
		// user-initiated generate keeps its own "Generating…" affordance
		// (status running), so don't swallow that.
		if (fetching && generate.status.kind !== "running") {
			return <CasesLoading />;
		}
		// The case type has no rows at all — a dead-end preview. When the
		// module has a search panel the generate affordance lives THERE
		// (this body just names the gap and points at it); without one it
		// falls back to a compact inline affordance — never the old giant
		// primary button.
		return (
			<div className="rounded-lg border border-dashed border-nova-border-bright px-6 py-10 text-center">
				<p className="text-sm text-nova-text-secondary mb-1">No cases yet</p>
				<p className="text-xs text-nova-text-muted mb-4">
					{hasSearch
						? "Generate sample data from the search panel to try these screens with realistic rows."
						: "Generate sample data to try these screens with realistic rows."}
				</p>
				{!hasSearch && <GenerateSampleDataButton generate={generate} />}
			</div>
		);
	}

	if (rows.length === 0) {
		if (filterActive) {
			return (
				<div className="rounded-lg border border-pv-input-border px-5 py-8 text-center text-xs text-nova-text-muted">
					Nothing here matches the filter — clear it to see every result.
				</div>
			);
		}
		if (queryActive) {
			return (
				<NoMatchNotice
					strictTextInputs={strictTextInputs}
					onMakeFuzzy={onMakeFuzzy}
				/>
			);
		}
		return (
			<div className="rounded-lg border border-pv-input-border px-5 py-8 text-center text-xs text-nova-text-muted">
				No cases match the list's filter.
			</div>
		);
	}

	return (
		<div
			className={`transition-opacity ${fetching ? "opacity-80" : "opacity-100"}`}
		>
			<ResultsTable
				rows={rows}
				visibleColumns={visibleColumns}
				rowAction={rowAction}
				onOpenCase={onOpenCase}
			/>
		</div>
	);
}

// ── No-match state ────────────────────────────────────────────────

/**
 * The zero-results card. When the miss is explained by a
 * letter-for-letter text field someone typed into, the card says so
 * in plain words and offers the one-click fix — switching those
 * fields to fuzzy match IS a config edit (visible in the inspector,
 * undoable), so the result updates live.
 */
function NoMatchNotice({
	strictTextInputs,
	onMakeFuzzy,
}: {
	readonly strictTextInputs: readonly SimpleSearchInputDef[];
	readonly onMakeFuzzy: () => void;
}) {
	const names = strictTextInputs.map((s) => `“${s.label || s.name}”`);
	const list =
		names.length <= 1
			? names[0]
			: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
	return (
		<div className="rounded-lg border border-pv-input-border px-5 py-8 text-center">
			<p className="text-xs text-nova-text-muted">
				No cases match this search.
			</p>
			{strictTextInputs.length > 0 && (
				<div className="max-w-md mx-auto mt-4 pt-4 border-t border-nova-violet/[0.08]">
					<p className="mb-3 text-xs text-nova-text-secondary text-balance">
						{list} {names.length === 1 ? "matches" : "match"} letter for letter
						— capitalization and spelling have to be exact.
					</p>
					<button
						type="button"
						onClick={onMakeFuzzy}
						className="inline-flex items-center gap-1.5 px-3 min-h-11 rounded-lg border border-nova-border-bright bg-nova-violet/[0.12] text-xs font-medium text-nova-violet-bright hover:bg-nova-violet/[0.2] transition-colors cursor-pointer"
					>
						<Icon icon={tablerWand} width="13" height="13" />
						Switch to Fuzzy Match
					</button>
				</div>
			)}
		</div>
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

function resultsLayoutClasses(columnCount: number): ResultsLayoutClasses {
	if (columnCount <= 3) return XL_RESULTS;
	if (columnCount === 4) return TWO_XL_RESULTS;
	if (columnCount === 5) return THREE_XL_RESULTS;
	if (columnCount === 6) return FOUR_XL_RESULTS;
	return ALWAYS_STACKED_RESULTS;
}

function resultColumnLabel(col: CaseListConfig["columns"][number]): string {
	return col.kind === "calculated"
		? col.header || "untitled"
		: col.header || col.field || "untitled";
}

function ResultsTable({
	rows,
	visibleColumns,
	rowAction,
	onOpenCase,
}: {
	readonly rows: readonly CaseRowWithCalculated[];
	readonly visibleColumns: CaseListConfig["columns"];
	readonly rowAction: "detail" | "form" | "none";
	readonly onOpenCase: (row: CaseRowWithCalculated) => void;
}) {
	const clickable = rowAction !== "none";
	const layout = resultsLayoutClasses(visibleColumns.length);
	const gridTemplateColumns = `${visibleColumns.map(() => "minmax(0, 1fr)").join(" ")} 36px`;
	return (
		<div
			data-case-results="responsive"
			className="@container/results overflow-clip rounded-lg border border-pv-input-border bg-pv-surface"
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
						{resultColumnLabel(col)}
					</div>
				))}
				<div aria-hidden="true" />
			</div>
			{rows.map((row) => (
				<button
					type="button"
					key={row.case_id}
					onClick={() => onOpenCase(row)}
					disabled={!clickable}
					className={`relative block w-full border-b border-nova-violet/[0.07] py-1.5 pr-9 text-left transition-colors last:border-b-0 ${layout.row} ${
						clickable
							? "hover:bg-nova-violet/[0.05] cursor-pointer"
							: "cursor-default"
					}`}
					style={{ gridTemplateColumns }}
				>
					{visibleColumns.map((col, index) => (
						<span
							key={col.uuid}
							data-case-result-field={col.uuid}
							className={`grid min-w-0 grid-cols-[minmax(84px,0.38fr)_minmax(0,1fr)] items-start gap-3 px-3.5 py-2 text-[13px] ${layout.cell}`}
						>
							<span
								className={`text-xs font-medium text-nova-text-muted ${layout.label}`}
							>
								{resultColumnLabel(col)}
							</span>
							<span
								className={`min-w-0 break-words ${index === 0 ? "font-medium text-nova-text" : "text-nova-text-secondary"}`}
							>
								{renderColumnCell(col, row)}
							</span>
						</span>
					))}
					<span
						className={`absolute top-3 right-3 grid place-items-center text-nova-text-muted ${layout.arrow}`}
					>
						{clickable && (
							<Icon icon={tablerChevronRight} width="14" height="14" />
						)}
					</span>
				</button>
			))}
		</div>
	);
}
