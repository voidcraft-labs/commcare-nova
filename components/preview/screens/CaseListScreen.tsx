// components/preview/screens/CaseListScreen.tsx
//
// The case list as the running app shows it — the preview-mode screen
// for every case-list workspace URL (`cases` / `search-config` /
// `detail-config`). Search and detail are facets of the same list, so
// preview always shows the assembled artifact: the real
// `SearchInputForm` widgets query the real case store as you type, the
// list narrows through its own filter box (the same per-word,
// case-insensitive narrowing CommCare's case list runs), and rows open
// the case detail IN PLACE. From the detail, Continue opens the
// module's first form — the same case-select → confirm → form flow the
// shipped app runs. Modules with no detail fields skip the confirm
// step and go straight to the form, exactly as CommCare does.
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
import { useCallback, useMemo, useRef, useState } from "react";
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
import { useFirstFormForModule } from "@/lib/doc/hooks/useFirstFormForModule";
import {
	type CaseListConfig,
	effectiveDataType,
	fuzzyMode,
	SEARCH_MODE_PROPERTY_TYPES,
	type SimpleSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { PreviewMarkdown } from "@/lib/markdown";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useCases } from "@/lib/preview/hooks/useCaseDataBinding";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { useAppId } from "@/lib/session/hooks";

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

	/** The detail's Continue (and detail-less row clicks) open the
	 *  module's first form — the case-loading form. */
	const firstForm = useFirstFormForModule(moduleUuid);
	const firstFormUuid = firstForm?.uuid;

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

	const openFirstForm = () => {
		if (!moduleUuid || !firstFormUuid) return;
		navigate.openForm(moduleUuid, firstFormUuid);
	};

	/* The running app's row click: a configured detail opens the
	 * confirm step in place; no detail fields means the row continues
	 * straight into the form; a case-list-only module with no detail
	 * has nowhere to go. */
	const rowAction: "detail" | "form" | "none" =
		detailColumns.length > 0
			? "detail"
			: firstFormUuid !== undefined
				? "form"
				: "none";
	const handleOpenCase = (row: CaseRowWithCalculated) => {
		if (rowAction === "detail") setOpenCase(row);
		else if (rowAction === "form") openFirstForm();
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
			{/* The running app's confirm step ends in Continue — straight
			 *  into the module's first form with this case in hand. A
			 *  case-list-only module has no form, so the detail is the
			 *  end of the road and no button renders. */}
			{firstFormUuid !== undefined && (
				<button
					type="button"
					onClick={openFirstForm}
					className="mt-4 inline-flex items-center gap-2 px-4 min-h-11 rounded-lg bg-nova-violet text-white text-[13px] font-semibold hover:brightness-110 transition-all cursor-pointer"
				>
					Continue
					<Icon icon={tablerArrowRight} width="15" height="15" />
				</button>
			)}
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
						{fetching && (
							<Icon
								icon={tablerLoader2}
								width="12"
								height="12"
								className="animate-spin"
							/>
						)}
						{filteredRows.length} {filteredRows.length === 1 ? "case" : "cases"}
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

	return (
		<div ref={containerRef} className="max-w-5xl mx-auto px-8 pt-6 pb-24">
			<div
				className={`flex gap-5 ${split ? "flex-row items-start" : "flex-col"}`}
			>
				{/* Stacked + detail open = the narrow experience: the detail
				 *  takes the whole canvas, search waits behind Back. */}
				{(split || openCase === null) && searchPane}
				{openCase !== null ? detailPane : resultsPane}
			</div>
		</div>
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
