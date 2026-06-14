// components/preview/screens/CaseListScreen.tsx
//
// The case list as the running app shows it — the preview-mode screen
// for every case-list workspace URL (`cases` / `search-config` /
// `detail-config`). Search and detail are facets of the same list, so
// preview always shows the assembled artifact: the real
// `SearchInputForm` widgets query the real case store as you type, the
// list narrows through its own filter box (the same per-word,
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
// the running app follows, so authors never pick an export mode.
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
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import tablerWand from "@iconify-icons/tabler/wand";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { renderColumnCell } from "@/components/builder/case-list-config/columnCellRenderer";
import { effectiveModeKind } from "@/components/builder/case-list-config/searchInputResolution";
import { useSampleData } from "@/components/builder/case-list-config/useSampleData";
import {
	ListFilterBox,
	rowMatchesFilterText,
} from "@/components/preview/shared/listFilter";
import { SearchInputForm } from "@/components/preview/shared/SearchInputForm";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import {
	CASE_LOADING_FORM_TYPES,
	type CaseListConfig,
	effectiveDataType,
	fuzzyMode,
	SEARCH_MODE_PROPERTY_TYPES,
	type SimpleSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import { PreviewMarkdown } from "@/lib/markdown";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useCases } from "@/lib/preview/hooks/useCaseDataBinding";
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
	const caseTypes = useCaseTypes();
	const appId = useAppId() ?? "";
	const docApi = useBlueprintDocApi();
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
	const searchConfig = mod?.caseSearchConfig;

	// `pickBlueprintDoc` strips action methods + non-schema keys off the
	// doc-store state so the projection survives Next's RSC serializer.
	const blueprint = useMemo(
		() => pickBlueprintDoc(docApi.getState()),
		[docApi.getState],
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
	const [inputValues, setInputValues] = useState<SearchInputValues>(
		() => new Map(),
	);
	const [filterText, setFilterText] = useState("");
	const [openCase, setOpenCase] = useState<CaseRowWithCalculated | null>(null);
	/** When set, the case has been picked (and confirmed) and the running app
	 *  is on the form menu — choosing among the module's case-loading forms.
	 *  Only reached on a case-first entry with more than one such form. */
	const [formMenuCase, setFormMenuCase] =
		useState<CaseRowWithCalculated | null>(null);

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
		blueprint,
		caseListConfig: config,
		inputValues,
	});

	const { generate } = useSampleData({
		appId,
		caseType: caseType?.name,
		onDone: reload,
	});

	const restart = () => {
		setInputValues(new Map());
		setFilterText("");
		setOpenCase(null);
		setFormMenuCase(null);
	};

	const visibleColumns = (config?.columns ?? []).filter(
		(col) => col.visibleInList ?? true,
	);
	const detailColumns = (config?.columns ?? []).filter(
		(col) => col.visibleInDetail !== false,
	);
	const hasSearch = (config?.searchInputs.length ?? 0) > 0;
	const queryActive = [...inputValues.values()].some((v) => v !== "");

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
				if ((inputValues.get(s.name)?.trim() ?? "") === "") return false;
				if (effectiveModeKind(s) !== "exact") return false;
				const def = caseType?.properties.find((p) => p.name === s.property);
				if (def === undefined) return false;
				return (
					SEARCH_MODE_PROPERTY_TYPES.fuzzy?.includes(effectiveDataType(def)) ??
					true
				);
			}),
		[config?.searchInputs, inputValues, caseType],
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

	const title = searchConfig?.searchScreenTitle ?? "Search";
	const subtitle = searchConfig?.searchScreenSubtitle;

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
			</div>
			{subtitle !== undefined && (
				<div className="mb-2 preview-markdown text-xs text-nova-text-muted">
					<PreviewMarkdown>{subtitle}</PreviewMarkdown>
				</div>
			)}
			<SearchInputForm
				searchInputs={config?.searchInputs ?? []}
				caseType={caseType}
				value={inputValues}
				onChange={setInputValues}
			/>
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
			<div className="rounded-lg border border-pv-input-border bg-pv-surface overflow-hidden">
				{detailColumns.map((col, i) => {
					const label =
						col.kind === "calculated"
							? col.header || "untitled"
							: col.header || col.field || "untitled";
					return (
						<div
							key={col.uuid}
							className={`flex items-center gap-2.5 px-4 py-3 ${i > 0 ? "border-t border-nova-violet/[0.08]" : ""}`}
						>
							<span className="w-[140px] shrink-0 text-[13px] text-nova-text-muted">
								{label}
							</span>
							<span className="min-w-0 text-[13px] text-nova-text-secondary overflow-hidden text-ellipsis whitespace-nowrap">
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
					className="mt-4 inline-flex items-center gap-2 px-4 min-h-11 rounded-lg bg-nova-violet text-white text-[13px] font-semibold hover:brightness-110 transition-all cursor-pointer"
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
							className="text-nova-text-muted group-hover:text-pv-accent transition-colors shrink-0"
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
				<button
					type="button"
					onClick={restart}
					className="inline-flex items-center gap-1.5 px-3 min-h-11 rounded-lg border border-nova-border text-xs text-nova-text-muted hover:text-nova-text hover:border-nova-border-bright transition-colors cursor-pointer"
				>
					<Icon icon={tablerRefresh} width="13" height="13" />
					Restart
				</button>
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

function ResultsBody({
	state,
	fetching,
	rows,
	filterActive,
	visibleColumns,
	queryActive,
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
	readonly rowAction: "detail" | "form" | "none";
	readonly onOpenCase: (row: CaseRowWithCalculated) => void;
	readonly generate: ReturnType<typeof useSampleData>["generate"];
	readonly strictTextInputs: readonly SimpleSearchInputDef[];
	readonly onMakeFuzzy: () => void;
}) {
	if (state.kind === "idle" || state.kind === "loading") {
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

	if (state.kind === "error") {
		return (
			<div className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] px-5 py-6 text-center text-xs text-nova-rose/90">
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
		// The case type has no rows at all — a dead-end preview, so the
		// populate action lives right here.
		return (
			<div className="rounded-lg border border-dashed border-nova-border-bright px-6 py-10 text-center">
				<p className="text-sm text-nova-text-secondary mb-1">No cases yet</p>
				<p className="text-xs text-nova-text-muted mb-4">
					Generate sample data to try these screens with realistic rows.
				</p>
				<button
					type="button"
					onClick={generate.run}
					disabled={generate.status.kind === "running"}
					className="inline-flex items-center gap-2 px-4 min-h-11 text-[13px] font-medium rounded-lg bg-nova-violet text-white hover:brightness-110 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
				>
					<Icon
						icon={
							generate.status.kind === "running"
								? tablerLoader2
								: tablerSparkles
						}
						width="14"
						height="14"
						className={
							generate.status.kind === "running" ? "animate-spin" : undefined
						}
					/>
					{generate.status.kind === "running"
						? "Generating…"
						: "Generate Sample Data"}
				</button>
				{generate.status.kind === "error" && (
					<p className="mt-3 text-xs text-nova-rose/90 whitespace-pre-line">
						{generate.status.message}
					</p>
				)}
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
			className={`transition-opacity ${fetching ? "opacity-60" : "opacity-100"}`}
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

// ── Results table ─────────────────────────────────────────────────

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
	return (
		<div className="rounded-lg border border-pv-input-border bg-pv-surface overflow-x-auto">
			<div style={{ minWidth: visibleColumns.length * 140 + 36 }}>
				<div
					className="grid bg-pv-bg/60 border-b border-pv-input-border"
					style={{
						gridTemplateColumns: `${visibleColumns.map(() => "minmax(140px, 1fr)").join(" ")} 36px`,
					}}
				>
					{visibleColumns.map((col) => (
						<div
							key={col.uuid}
							className="px-3.5 py-2.5 text-[13px] font-semibold text-nova-text whitespace-nowrap overflow-hidden text-ellipsis"
						>
							{col.kind === "calculated"
								? col.header || "untitled"
								: col.header || col.field || "untitled"}
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
						className={`grid w-full text-left border-t border-nova-violet/[0.07] transition-colors ${
							clickable
								? "hover:bg-nova-violet/[0.05] cursor-pointer"
								: "cursor-default"
						}`}
						style={{
							gridTemplateColumns: `${visibleColumns.map(() => "minmax(140px, 1fr)").join(" ")} 36px`,
						}}
					>
						{visibleColumns.map((col) => (
							<span
								key={col.uuid}
								className="px-3.5 py-2.5 min-h-11 inline-flex items-center text-[13px] text-nova-text-secondary whitespace-nowrap overflow-hidden text-ellipsis"
							>
								{renderColumnCell(col, row)}
							</span>
						))}
						<span className="grid place-items-center text-nova-text-muted">
							{clickable && (
								<Icon icon={tablerChevronRight} width="14" height="14" />
							)}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
