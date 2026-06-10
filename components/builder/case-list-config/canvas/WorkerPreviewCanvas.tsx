// components/builder/case-list-config/canvas/WorkerPreviewCanvas.tsx
//
// The Preview tab — a first-class worker run-through, never a modal
// and never a cursor mode. Everything is live from the current
// config: the real `SearchInputForm` widgets filter the real case
// store as the worker types, rows open the case detail IN PLACE
// (mirroring the worker's tap), and the chat rail stays alive beside
// it so the author can ask Nova for changes while previewing.
//
// Composition is this tab's job: search beside the results when the
// canvas is wide, stacked when it isn't — width decides, exactly as
// it does for workers, so authors never pick an export mode.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import tablerWand from "@iconify-icons/tabler/wand";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchInputForm } from "@/components/preview/shared/SearchInputForm";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type CaseListConfig,
	type CaseSearchConfig,
	type CaseType,
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
import { useCases } from "@/lib/preview/hooks/useCaseDataBinding";
import { renderColumnCell } from "../columnCellRenderer";
import { effectiveModeKind } from "../searchInputResolution";
import { useSampleData } from "../useSampleData";

/** Canvas width where search sits beside the results instead of above
 *  them — the same responsive truth the worker's screen follows. */
const SPLIT_MIN_WIDTH = 760;

export interface WorkerPreviewCanvasProps {
	readonly moduleName: string;
	readonly config: CaseListConfig;
	readonly searchConfig: CaseSearchConfig | undefined;
	readonly caseType: CaseType | undefined;
	readonly appId: string;
	readonly onConfigChange: (next: CaseListConfig) => void;
}

export function WorkerPreviewCanvas({
	moduleName,
	config,
	searchConfig,
	caseType,
	appId,
	onConfigChange,
}: WorkerPreviewCanvasProps) {
	const docApi = useBlueprintDocApi();
	const blueprint = useMemo(
		() => pickBlueprintDoc(docApi.getState()),
		[docApi.getState],
	);

	// ── Responsive split — the canvas's own width decides ──
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			setWidth(entries[0]?.contentRect.width ?? 0);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const split = width >= SPLIT_MIN_WIDTH;

	// ── Live worker state ──
	const [inputValues, setInputValues] = useState<SearchInputValues>(
		() => new Map(),
	);
	const [openCase, setOpenCase] = useState<CaseRowWithCalculated | null>(null);

	const { state, reload } = useCases({
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
		setOpenCase(null);
	};

	const visibleColumns = config.columns.filter(
		(col) => col.visibleInList ?? true,
	);
	const detailColumns = config.columns.filter(
		(col) => col.visibleInDetail !== false,
	);
	const hasSearch = config.searchInputs.length > 0;
	const queryActive = [...inputValues.values()].some((v) => v !== "");

	/* A zero-match against a letter-for-letter text input is the single
	 * most common "search is broken" experience — the worker typed a
	 * lowercase or partial name into an exact-match field. Spot that
	 * shape (typed-into, text, exact mode, property admits fuzzy) so
	 * the no-match state can name the cause and fix it in one click. */
	const strictTextInputs = useMemo(
		() =>
			config.searchInputs.filter((s): s is SimpleSearchInputDef => {
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
		[config.searchInputs, inputValues, caseType],
	);
	const makeForgiving = () => {
		const strict = new Set(strictTextInputs.map((s) => s.uuid));
		onConfigChange({
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
		});
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
				searchInputs={config.searchInputs}
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
				className="inline-flex items-center gap-1.5 -ml-2 mb-3 px-2 py-1.5 min-h-10 rounded-md text-[13px] text-nova-violet-bright hover:bg-nova-violet/[0.08] transition-colors cursor-pointer"
			>
				<Icon icon={tablerChevronLeft} width="15" height="15" />
				Back to results
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
			<p className="mt-3 text-xs text-nova-text-muted">
				From here the worker continues into the form.
			</p>
		</div>
	);

	const resultsPane = (
		<div className="flex-1 min-w-0">
			<div className="flex items-baseline gap-3 mb-3">
				<h2 className="font-display font-bold text-xl tracking-tight text-nova-text">
					{moduleName}
				</h2>
				{state.kind === "rows" && (
					<span className="ml-auto text-xs text-nova-text-muted whitespace-nowrap">
						{state.rows.length} {state.rows.length === 1 ? "case" : "cases"}
					</span>
				)}
			</div>
			<ResultsBody
				state={state}
				visibleColumns={visibleColumns}
				queryActive={queryActive}
				onOpenCase={setOpenCase}
				generate={generate}
				strictTextInputs={strictTextInputs}
				onMakeForgiving={makeForgiving}
			/>
			{state.kind === "rows" && state.rows.length > 0 && (
				<p className="mt-2.5 text-xs text-nova-text-muted">
					Tap a row to open the case.
				</p>
			)}
		</div>
	);

	return (
		<div ref={containerRef} className="max-w-5xl mx-auto px-8 pt-6 pb-24">
			<div className="flex items-center gap-2.5 mb-5">
				<span className="font-mono text-[10px] tracking-[0.14em] text-nova-violet-bright">
					WORKER PREVIEW
				</span>
				<span className="text-xs text-nova-text-muted">
					— live from this config, fully interactive
				</span>
				<button
					type="button"
					onClick={restart}
					className="ml-auto inline-flex items-center gap-1.5 px-3 min-h-9 rounded-md border border-nova-border text-xs text-nova-text-muted hover:text-nova-text hover:border-nova-border-bright transition-colors cursor-pointer"
				>
					<Icon icon={tablerRefresh} width="13" height="13" />
					Restart
				</button>
			</div>
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
	visibleColumns,
	queryActive,
	onOpenCase,
	generate,
	strictTextInputs,
	onMakeForgiving,
}: {
	readonly state: ReturnType<typeof useCases>["state"];
	readonly visibleColumns: CaseListConfig["columns"];
	readonly queryActive: boolean;
	readonly onOpenCase: (row: CaseRowWithCalculated) => void;
	readonly generate: ReturnType<typeof useSampleData>["generate"];
	readonly strictTextInputs: readonly SimpleSearchInputDef[];
	readonly onMakeForgiving: () => void;
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
				onMakeForgiving={onMakeForgiving}
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
					Generate sample data to try the worker experience with realistic rows.
				</p>
				<button
					type="button"
					onClick={generate.run}
					disabled={generate.status.kind === "running"}
					className="inline-flex items-center gap-2 px-4 py-2 text-[13px] font-medium rounded-lg bg-nova-violet text-white hover:brightness-110 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
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
						: "Generate sample data"}
				</button>
				{generate.status.kind === "error" && (
					<p className="mt-3 text-xs text-nova-rose/90 whitespace-pre-line">
						{generate.status.message}
					</p>
				)}
			</div>
		);
	}

	if (state.rows.length === 0) {
		if (queryActive) {
			return (
				<NoMatchNotice
					strictTextInputs={strictTextInputs}
					onMakeForgiving={onMakeForgiving}
				/>
			);
		}
		return (
			<div className="rounded-lg border border-pv-input-border px-5 py-8 text-center text-xs text-nova-text-muted">
				No cases match the current filter.
			</div>
		);
	}

	return (
		<ResultsTable
			state={state}
			visibleColumns={visibleColumns}
			onOpenCase={onOpenCase}
		/>
	);
}

// ── No-match state ────────────────────────────────────────────────

/**
 * The zero-results card. When the miss is explained by a
 * letter-for-letter text input the worker typed into, the card says
 * so in plain words and offers the one-click fix — switching those
 * inputs to forgiving match IS a config edit (visible in the
 * inspector, undoable), so the preview result updates live.
 */
function NoMatchNotice({
	strictTextInputs,
	onMakeForgiving,
}: {
	readonly strictTextInputs: readonly SimpleSearchInputDef[];
	readonly onMakeForgiving: () => void;
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
						{list} {names.length === 1 ? "matches" : "match"} letter-for-letter
						— a lowercase, partial, or misspelled entry returns nothing.
					</p>
					<button
						type="button"
						onClick={onMakeForgiving}
						className="inline-flex items-center gap-1.5 px-3 min-h-9 rounded-md border border-nova-border-bright bg-nova-violet/[0.12] text-xs font-medium text-nova-violet-bright hover:bg-nova-violet/[0.2] transition-colors cursor-pointer"
					>
						<Icon icon={tablerWand} width="13" height="13" />
						Switch to forgiving match
					</button>
				</div>
			)}
		</div>
	);
}

// ── Results table ─────────────────────────────────────────────────

function ResultsTable({
	state,
	visibleColumns,
	onOpenCase,
}: {
	readonly state: Extract<
		ReturnType<typeof useCases>["state"],
		{ kind: "rows" }
	>;
	readonly visibleColumns: CaseListConfig["columns"];
	readonly onOpenCase: (row: CaseRowWithCalculated) => void;
}) {
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
				{state.rows.map((row) => (
					<button
						type="button"
						key={row.case_id}
						onClick={() => onOpenCase(row)}
						className="grid w-full text-left border-t border-nova-violet/[0.07] hover:bg-nova-violet/[0.05] transition-colors cursor-pointer"
						style={{
							gridTemplateColumns: `${visibleColumns.map(() => "minmax(140px, 1fr)").join(" ")} 36px`,
						}}
					>
						{visibleColumns.map((col) => (
							<span
								key={col.uuid}
								className="px-3.5 py-2.5 text-[13px] text-nova-text-secondary whitespace-nowrap overflow-hidden text-ellipsis"
							>
								{renderColumnCell(col, row)}
							</span>
						))}
						<span className="grid place-items-center text-nova-text-muted">
							<Icon icon={tablerChevronRight} width="14" height="14" />
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
