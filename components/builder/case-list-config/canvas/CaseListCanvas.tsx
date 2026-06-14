// components/builder/case-list-config/canvas/CaseListCanvas.tsx
//
// The case-list tab's canvas: the case list ITSELF, rendered as a
// live table over real case-store rows, is the configuration surface.
// Clicking a thing configures that thing in the inspector rail —
// column headers and cells select their column, the title selects the
// list panel (sort order + menu-link appearance), the filter
// affordance selects the filter. Headers drag to reorder columns; a
// dashed ghost cell appends one.
//
// Every column renders regardless of `visibleInList` — hidden ones
// dim with an eye-off glyph so the full structure stays reachable for
// editing (the same rule the form editor applies to
// relevance-hidden fields). The app-true rendering is the Preview
// mode's `CaseListScreen`.
//
// The table never crushes: columns have a readable minimum and the
// card pans horizontally instead, matching the runtime list on small
// screens.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { Tooltip } from "@/components/ui/Tooltip";
import type { CaseListConfig, Column } from "@/lib/domain";
import { renderColumnCell } from "../columnCellRenderer";
import { summarizeFilter } from "../predicateSummary";
import { GenerateSampleDataButton } from "../SampleDataButton";
import { describeSortOrder, sortPositionByUuid } from "../sortPriority";
import type { CaseListPreviewState } from "../useCaseListPreview";
import type { SampleDataAction } from "../useSampleData";
import type { WorkspaceSelection } from "../workspaceSelection";
import {
	activateOnKeyDown,
	CanvasNotice,
	ColumnDragPreview,
	previewNotice,
} from "./canvasChrome";

/** Readable per-column floor — below this the card pans instead. */
const COLUMN_MIN_WIDTH = 150;
/** Width of the trailing add-column ghost cell. */
const ADD_CELL_WIDTH = 48;

export interface CaseListCanvasProps {
	readonly config: CaseListConfig;
	/** The case list's title — the module IS the case-list title (no
	 *  separate title slot). */
	readonly moduleName: string;
	readonly preview: CaseListPreviewState;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddColumn: () => void;
	/** Disabled-add hint — `undefined` means add is enabled. */
	readonly addColumnDisabledReason: string | undefined;
	readonly onReorderColumns: (next: readonly Column[]) => void;
	/** A preview reload is in flight while the rows on screen are the
	 *  previous settle — the table dims instead of unmounting. */
	readonly refreshing?: boolean;
	/** Populate-sample-data action — surfaced in the table's empty
	 *  state so an empty store never dead-ends the canvas. */
	readonly generateSampleData: SampleDataAction;
}

export function CaseListCanvas({
	config,
	moduleName,
	preview,
	selection,
	onSelect,
	onAddColumn,
	addColumnDisabledReason,
	onReorderColumns,
	refreshing = false,
	generateSampleData,
}: CaseListCanvasProps) {
	const containerKey = useId();
	const columns = config.columns;
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;

	const { pendingDrop } = useReorderableList<Column>({
		containerKey,
		containerKind: "case-list-canvas-columns",
		items: columns,
		onReorder: onReorderColumns,
	});

	const sortPositions = sortPositionByUuid(columns);
	const filterPhrase = summarizeFilter(config.filter);
	const hasFilter = config.filter !== undefined;
	const filterSelected = selection?.type === "filter";
	const panelSelected = selection?.type === "list-panel";

	const template =
		columns.map(() => `minmax(${COLUMN_MIN_WIDTH}px, 1fr)`).join(" ") +
		` ${ADD_CELL_WIDTH}px`;
	const tableMinWidth = columns.length * COLUMN_MIN_WIDTH + ADD_CELL_WIDTH;

	const rows = preview.kind === "rows" ? preview.rows : [];
	const sortSummary = describeSortOrder(columns);

	return (
		<ContentFrame width="5xl" className="px-6 pt-6 pb-24">
			<p className="mb-5 text-[13px] text-nova-text-muted">
				The case list, live from your data — click a column to set it up, or
				drag headers to reorder.
			</p>

			{/* Title row — the list-panel selection target — plus the
			 *  human-language filter affordance. */}
			<div className="flex items-center gap-3 mb-4 min-h-10">
				<Tooltip content="List settings — sort order and sample data">
					<button
						type="button"
						onClick={() => onSelect({ type: "list-panel" })}
						className={`px-2 py-1 -ml-2 min-h-11 rounded-lg text-left transition-all cursor-pointer border ${
							panelSelected
								? "border-nova-violet bg-nova-violet/[0.10] shadow-[0_0_14px_rgba(139,92,246,0.25)]"
								: "border-transparent hover:bg-white/[0.03]"
						}`}
					>
						<h1 className="font-display font-bold text-2xl tracking-tight text-nova-text">
							{moduleName}
						</h1>
					</button>
				</Tooltip>
				<button
					type="button"
					onClick={() => onSelect({ type: "filter" })}
					className={`ml-auto inline-flex items-center gap-2 px-3 min-h-11 max-w-[55%] rounded-lg cursor-pointer border transition-all text-xs ${
						filterSelected
							? "border-nova-violet bg-nova-violet/[0.14] shadow-[0_0_14px_rgba(139,92,246,0.25)]"
							: "border-transparent hover:bg-white/[0.03]"
					} ${hasFilter ? "text-nova-text-secondary" : "text-nova-text-muted"}`}
				>
					<Icon
						icon={tablerFilter}
						width="15"
						height="15"
						className={
							hasFilter ? "text-nova-violet-bright" : "text-nova-text-muted"
						}
					/>
					<span className="truncate first-letter:uppercase">
						{filterPhrase ?? "Filter"}
					</span>
				</button>
			</div>

			{/* The table — dims (never unmounts) while a reload settles. The
			 *  header (and live rows) pan horizontally inside the inner
			 *  scroller; every non-rows state renders as a notice BELOW it, at
			 *  the card's visible width, so an empty / loading message stays
			 *  centered in view instead of across the off-screen scroll width
			 *  when the columns overflow. */}
			<div
				className={`rounded-lg border border-nova-border bg-nova-surface/40 overflow-hidden transition-opacity ${refreshing ? "opacity-70" : "opacity-100"}`}
			>
				<div className="overflow-x-auto">
					<div style={{ minWidth: tableMinWidth }}>
						{/* Header row */}
						<div
							className="grid bg-nova-deep/70 border-b border-nova-border"
							style={{ gridTemplateColumns: template }}
						>
							{columns.map((col, i) => (
								<ReorderableRow
									key={col.uuid}
									index={i}
									containerKey={containerKey}
									containerKind="case-list-canvas-columns"
									pendingDrop={pendingDrop}
									axis="horizontal"
									preview={<ColumnDragPreview column={col} index={i} />}
								>
									{({
										wrapperRef,
										setHandleEl,
										closestEdge,
										previewPortal,
										beingMoved,
									}) => (
										<div
											ref={wrapperRef}
											className={`relative ${beingMoved ? "opacity-50" : ""}`}
										>
											{closestEdge !== null && (
												<div
													aria-hidden="true"
													className="absolute top-1 bottom-1 w-0.5 bg-nova-violet rounded-full z-10"
													style={{
														left: closestEdge === "left" ? -1 : undefined,
														right: closestEdge === "right" ? -1 : undefined,
													}}
												/>
											)}
											<HeaderCell
												column={col}
												selected={selectedColumnUuid === col.uuid}
												isFirst={i === 0}
												sortPosition={sortPositions.get(col.uuid)}
												setHandleEl={setHandleEl}
												onClick={() =>
													onSelect({ type: "column", uuid: col.uuid })
												}
											/>
											{previewPortal}
										</div>
									)}
								</ReorderableRow>
							))}
							<Tooltip content={addColumnDisabledReason ?? "Add a Column"}>
								<button
									type="button"
									onClick={onAddColumn}
									disabled={addColumnDisabledReason !== undefined}
									aria-label="Add a Column"
									className="grid place-items-center min-h-11 border-l border-dashed border-nova-border-bright text-nova-violet-bright hover:bg-nova-violet/[0.08] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
								>
									<Icon icon={tablerPlus} width="16" height="16" />
								</button>
							</Tooltip>
						</div>

						{/* Live rows align to the header grid. Every non-rows state —
						 *  and a column-less config, whose rows would be empty grids —
						 *  renders as a notice below, outside this scroller. */}
						{columns.length > 0 &&
							preview.kind === "rows" &&
							rows.map((row) => (
								<div
									key={row.case_id}
									className="grid border-t border-nova-violet/[0.07]"
									style={{ gridTemplateColumns: template }}
								>
									{columns.map((col) => {
										const hidden = col.visibleInList === false;
										const isSel = selectedColumnUuid === col.uuid;
										const select = () =>
											onSelect({ type: "column", uuid: col.uuid });
										return (
											/* Cells mirror their header's affordance. They stay
											 * out of the tab order (tabIndex -1) — the header
											 * carries the keyboard path so a 6×50 table doesn't
											 * add 300 tab stops. */
											// biome-ignore lint/a11y/useSemanticElements: can't use <button> — cell content may include interactive media, and buttons can't nest
											<div
												key={col.uuid}
												role="button"
												tabIndex={-1}
												onClick={select}
												onKeyDown={activateOnKeyDown(select)}
												className={`px-3.5 py-2.5 min-h-11 flex items-center text-[13px] text-nova-text-secondary whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer border-r border-nova-violet/[0.06] last:border-r-0 ${
													isSel ? "bg-nova-violet/[0.06]" : ""
												} ${hidden ? "opacity-35" : ""} ${col.kind === "calculated" ? "font-mono text-xs" : ""}`}
											>
												{renderColumnCell(col, row)}
											</div>
										);
									})}
									<div aria-hidden="true" />
								</div>
							))}
					</div>
				</div>

				{/* State arms — pinned to the card's visible width (outside the
				 *  scroller), so the message centers in view even when the
				 *  columns overflow horizontally. */}
				{columns.length === 0 ? (
					<CanvasNotice tone="muted">
						No columns yet — add one to choose what the list shows about each
						case.
					</CanvasNotice>
				) : preview.kind === "rows" ? (
					rows.length === 0 ? (
						<CanvasNotice tone="muted">
							No cases match the current filter.
						</CanvasNotice>
					) : null
				) : preview.kind === "empty" ? (
					/* An empty case store would dead-end every live surface —
					 * the populate action lives right where the gap shows. */
					<div className="px-5 py-9 text-center">
						<p className="text-xs text-nova-text-muted mb-3.5">
							No cases yet — generate sample data to see this list with
							realistic rows.
						</p>
						<GenerateSampleDataButton generate={generateSampleData} />
					</div>
				) : (
					<PreviewStateNotice preview={preview} />
				)}
			</div>

			{/* Status line — only when live rows are on screen; the body's
			 *  state arms explain every other situation themselves. */}
			{preview.kind === "rows" && (
				<div className="flex items-center gap-2.5 mt-2.5 text-xs text-nova-text-muted">
					<span className="font-mono text-[9px] tracking-[0.13em] text-nova-violet-bright/70">
						LIVE
					</span>
					<span>
						{rows.length} {rows.length === 1 ? "case" : "cases"}
						{hasFilter ? " · filtered" : ""}
						{sortSummary ? ` · sorted by ${sortSummary}` : ""}
					</span>
					{refreshing && (
						<Icon
							icon={tablerLoader2}
							width="12"
							height="12"
							className="animate-spin"
							aria-label="Updating"
						/>
					)}
				</div>
			)}
		</ContentFrame>
	);
}

// ── Header cell ───────────────────────────────────────────────────

interface HeaderCellProps {
	readonly column: Column;
	readonly selected: boolean;
	/** Whether this header occupies the table's top-left corner — the
	 *  one spot where the cell's shape includes the container's curve. */
	readonly isFirst: boolean;
	readonly sortPosition: number | undefined;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onClick: () => void;
}

function HeaderCell({
	column,
	selected,
	isFirst,
	sortPosition,
	setHandleEl,
	onClick,
}: HeaderCellProps) {
	const hidden = column.visibleInList === false;
	const label =
		column.kind === "calculated"
			? column.header || "untitled"
			: column.header || column.field || "untitled";
	const direction = column.sort?.direction;
	return (
		<Tooltip content="Click to set up · drag to reorder">
			<button
				type="button"
				ref={setHandleEl}
				onClick={onClick}
				className={`flex items-center gap-1.5 px-3.5 min-h-11 w-full text-left font-semibold text-[13px] whitespace-nowrap overflow-hidden cursor-pointer border-r border-nova-border last:border-r-0 transition-colors ${
					selected
						? /* The ring traces the cell's TRUE shape: square corners
						   everywhere, except the first cell's top-left — the one
						   corner the container's rounded clip actually curves —
						   which matches the wrapper's inner radius (rounded-lg
						   outer minus its 1px border). */
							`bg-nova-violet/[0.14] shadow-[inset_0_0_0_1.5px_var(--nova-violet)] text-nova-text ${isFirst ? "rounded-tl-[calc(var(--radius)-1px)]" : ""}`
						: "text-nova-text hover:bg-white/[0.03]"
				} ${hidden ? "opacity-50" : ""}`}
			>
				{hidden && (
					<span
						role="img"
						className="inline-flex shrink-0"
						aria-label="Hidden from the case list"
					>
						<Icon
							icon={tablerEyeOff}
							width="13"
							height="13"
							className="text-nova-text-muted"
						/>
					</span>
				)}
				<span
					className={`overflow-hidden text-ellipsis ${column.header ? "" : "italic text-nova-text-muted"}`}
				>
					{label}
				</span>
				{direction !== undefined && (
					<span
						role="img"
						className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-sm bg-nova-violet/15 border border-nova-violet/20 text-nova-violet-bright font-mono text-[10px] shrink-0"
						aria-label={`Sorted ${direction === "asc" ? "ascending" : "descending"}, sort key ${sortPosition}`}
					>
						{direction === "asc" ? "↑" : "↓"}
						{sortPosition}
					</span>
				)}
			</button>
		</Tooltip>
	);
}

// ── Preview state arm ─────────────────────────────────────────────

function PreviewStateNotice({
	preview,
}: {
	readonly preview: Exclude<CaseListPreviewState, { kind: "rows" }>;
}) {
	if (preview.kind === "idle" || preview.kind === "loading") {
		return (
			<div className="flex items-center justify-center gap-2 py-10 text-xs text-nova-text-muted">
				<Icon
					icon={tablerLoader2}
					width="14"
					height="14"
					className="animate-spin"
				/>
				<span>Loading cases…</span>
			</div>
		);
	}
	const notice = previewNotice(preview);
	return <CanvasNotice tone={notice.tone}>{notice.text}</CanvasNotice>;
}
