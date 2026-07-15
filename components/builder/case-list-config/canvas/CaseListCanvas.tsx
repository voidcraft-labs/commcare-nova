// components/builder/case-list-config/canvas/CaseListCanvas.tsx
//
// The Case List authoring canvas is a vertical screen outline, not a
// spreadsheet. Only fields actually visible in the running list occupy
// the primary layout; supporting/detail-only fields live in a clearly
// named secondary inventory. This keeps the normal two-sidebar canvas
// readable at any column count and prevents wire-level invisible fields
// from looking like accidental user-facing columns.
//
// The global Preview toggle remains the app-true table run-through. In
// edit mode each field row carries a live value from the first real case,
// so the author still sees the consequence of formatting choices without
// making horizontal table geometry the configuration mechanism. Rows select
// fields only; the right inspector owns the one complete order shared with
// case detail.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerListDetails from "@iconify-icons/tabler/list-details";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { CaseListConfig, Column } from "@/lib/domain";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { renderColumnCell } from "../columnCellRenderer";
import { summarizeFilter } from "../predicateSummary";
import { GenerateSampleDataButton } from "../SampleDataButton";
import { describeSortOrder, sortPositionByUuid } from "../sortPriority";
import type { CaseListPreviewState } from "../useCaseListPreview";
import type { SampleDataAction } from "../useSampleData";
import { projectCaseWorkspaceColumns } from "../workspaceProjection";
import type { WorkspaceSelection } from "../workspaceSelection";
import {
	columnLabel,
	columnSource,
	SupportingColumnInventory,
} from "./ColumnInventory";
import { AddGhostButton, CanvasNotice, previewNotice } from "./canvasChrome";

export interface CaseListCanvasProps {
	readonly config: CaseListConfig;
	readonly brokenColumns: ReadonlySet<string>;
	readonly moduleName: string;
	readonly preview: CaseListPreviewState;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddColumn: () => void;
	readonly addColumnDisabledReason: string | undefined;
	readonly refreshing?: boolean;
	readonly generateSampleData: SampleDataAction;
}

export function CaseListCanvas({
	config,
	brokenColumns,
	moduleName,
	preview,
	selection,
	onSelect,
	onAddColumn,
	addColumnDisabledReason,
	refreshing = false,
	generateSampleData,
}: CaseListCanvasProps) {
	const projection = projectCaseWorkspaceColumns(config.columns);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;
	const sampleRow = preview.kind === "rows" ? preview.rows[0] : undefined;

	const sortPositions = sortPositionByUuid(projection.ordered);
	const filterPhrase = summarizeFilter(config.filter);
	const hasFilter = config.filter !== undefined;
	const filterSelected = selection?.type === "filter";
	const panelSelected = selection?.type === "list-panel";
	const sortSummary = describeSortOrder(projection.ordered);

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<div data-case-list-layout>
				<div className="mb-5 flex items-start gap-3">
					<span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-nova-border bg-nova-surface/40 text-nova-violet-bright">
						<Icon icon={tablerListDetails} width="17" height="17" />
					</span>
					<div className="min-w-0">
						<h1 className="font-display text-lg font-semibold tracking-tight text-nova-text">
							Case list layout
						</h1>
						<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
							Choose the information people scan in each result. Field order is
							shared with case detail and arranged in the right panel.
						</p>
					</div>
				</div>

				<div className="mb-3 flex min-h-11 items-center gap-3">
					<SimpleTooltip content="List settings — field order, sort order, and sample data">
						<button
							type="button"
							onClick={() => onSelect({ type: "list-panel" })}
							className={`-ml-2 min-h-11 min-w-0 cursor-pointer rounded-lg border px-2 py-1 text-left transition-colors ${
								panelSelected
									? "border-nova-violet bg-nova-violet/[0.10]"
									: "border-transparent hover:bg-white/[0.03]"
							}`}
						>
							<span className="block truncate font-display text-xl font-bold tracking-tight text-nova-text">
								{moduleName}
							</span>
						</button>
					</SimpleTooltip>
					<button
						type="button"
						onClick={() => onSelect({ type: "filter" })}
						className={`ml-auto inline-flex min-h-11 max-w-[52%] cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs transition-colors ${
							filterSelected
								? "border-nova-violet bg-nova-violet/[0.12]"
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
							{filterPhrase ?? "Filter cases"}
						</span>
					</button>
				</div>

				<div className="overflow-hidden rounded-xl border border-nova-border bg-nova-surface/35">
					<div className="flex items-center gap-3 border-b border-nova-border bg-nova-deep/45 px-4 py-2.5">
						<div className="min-w-0 flex-1">
							<p className="text-[13px] font-semibold text-nova-text">
								Fields in this list
							</p>
							<p className="text-[11px] leading-relaxed text-nova-text-muted">
								Only these fields appear as list columns.
							</p>
						</div>
						<button
							type="button"
							onClick={() => onSelect({ type: "list-panel" })}
							className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-[11px] text-nova-violet-bright transition-colors hover:border-nova-violet/25 hover:bg-nova-violet/[0.08]"
						>
							<Icon icon={tablerArrowsSort} width="14" height="14" />
							Arrange fields
						</button>
						<span className="rounded-full border border-nova-border px-2 py-0.5 font-mono text-[10px] text-nova-text-muted">
							{projection.listVisible.length} shown
						</span>
					</div>

					{projection.listVisible.length === 0 ? (
						<CanvasNotice tone="muted">
							No fields are shown in the list. Open a field below and turn on
							Case List visibility, or add a new one.
						</CanvasNotice>
					) : (
						<div>
							{projection.listVisible.map((column) => (
								<ListFieldRow
									key={column.uuid}
									column={column}
									sampleRow={sampleRow}
									selected={selectedColumnUuid === column.uuid}
									broken={brokenColumns.has(column.uuid)}
									sortPosition={sortPositions.get(column.uuid)}
									onSelect={() =>
										onSelect({ type: "column", uuid: column.uuid })
									}
								/>
							))}
						</div>
					)}

					<div className="border-t border-nova-border/80 p-3">
						<AddGhostButton
							label="Add List Field"
							onClick={onAddColumn}
							disabledReason={addColumnDisabledReason}
							className="w-full"
						/>
					</div>
				</div>

				<PreviewDataStatus
					preview={preview}
					refreshing={refreshing}
					hasFields={projection.listVisible.length > 0}
					hasFilter={hasFilter}
					sortSummary={sortSummary}
					generateSampleData={generateSampleData}
				/>

				<SupportingColumnInventory
					columns={projection.listHidden}
					surface="list"
					selectedUuid={selectedColumnUuid}
					brokenColumns={brokenColumns}
					onSelect={(column) => onSelect({ type: "column", uuid: column.uuid })}
				/>
			</div>
		</ContentFrame>
	);
}

interface ListFieldRowProps {
	readonly column: Column;
	readonly sampleRow: CaseRowWithCalculated | undefined;
	readonly selected: boolean;
	readonly broken: boolean;
	readonly sortPosition: number | undefined;
	readonly onSelect: () => void;
}

function ListFieldRow({
	column,
	sampleRow,
	selected,
	broken,
	sortPosition,
	onSelect,
}: ListFieldRowProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={`group/field flex min-h-16 w-full cursor-pointer items-stretch border-b border-nova-violet/[0.07] px-4 text-left transition-colors last:border-b-0 ${
				selected
					? "bg-nova-violet/[0.09] shadow-[inset_0_0_0_1.5px_var(--nova-violet)]"
					: "hover:bg-white/[0.025]"
			}`}
			data-case-field-role="visible"
			data-column-uuid={column.uuid}
		>
			<span className="min-w-0 flex-1 py-2.5">
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<span className="min-w-0 truncate text-[13px] font-semibold text-nova-text">
						{columnLabel(column)}
					</span>
					{column.visibleInDetail !== false && (
						<span className="rounded-full border border-nova-border px-1.5 py-px text-[9px] text-nova-text-muted">
							Detail too
						</span>
					)}
					{sortPosition !== undefined && (
						<span className="rounded-full border border-nova-violet/20 bg-nova-violet/[0.1] px-1.5 py-px font-mono text-[9px] text-nova-violet-bright">
							Sort {sortPosition}
						</span>
					)}
					{broken && (
						<span
							role="img"
							className="size-1.5 shrink-0 rounded-full bg-nova-rose"
							aria-label="This field has a configuration error"
						/>
					)}
				</span>
				<span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-nova-text-muted">
					<span className="max-w-[42%] shrink-0 truncate font-mono">
						{columnSource(column)}
					</span>
					<span aria-hidden="true">·</span>
					<span className="min-w-0 truncate text-nova-text-secondary">
						{sampleRow === undefined
							? "No sample value yet"
							: renderColumnCell(column, sampleRow)}
					</span>
				</span>
			</span>
		</button>
	);
}

function PreviewDataStatus({
	preview,
	refreshing,
	hasFields,
	hasFilter,
	sortSummary,
	generateSampleData,
}: {
	readonly preview: CaseListPreviewState;
	readonly refreshing: boolean;
	readonly hasFields: boolean;
	readonly hasFilter: boolean;
	readonly sortSummary: string;
	readonly generateSampleData: SampleDataAction;
}) {
	/* An all-hidden list needs neither live-row metadata nor a sample-data
	 * prompt, but a paused/error notice still carries the only explanation for
	 * a broken filter. Keep that verdict visible so a badged List tab always
	 * points at a findable problem. */
	if (!hasFields) {
		if (
			preview.kind === "rows" ||
			preview.kind === "empty" ||
			preview.kind === "idle" ||
			preview.kind === "loading"
		) {
			return null;
		}
		const notice = previewNotice(preview);
		return (
			<div className="mt-3 overflow-hidden rounded-xl border border-nova-border">
				<CanvasNotice tone={notice.tone}>{notice.text}</CanvasNotice>
			</div>
		);
	}

	if (preview.kind === "rows") {
		return (
			<div className="mt-3 flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1 px-1 text-xs text-nova-text-muted">
				<span className="font-mono text-[9px] tracking-[0.13em] text-nova-violet-bright">
					LIVE
				</span>
				<span>
					{preview.rows.length} {preview.rows.length === 1 ? "case" : "cases"}
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
				{preview.rows.length === 0 && (
					<span>No cases match the current filter.</span>
				)}
			</div>
		);
	}

	if (preview.kind === "empty") {
		return (
			<div className="mt-3 rounded-xl border border-dashed border-nova-border-bright px-5 py-5 text-center">
				<p className="mb-3 text-xs leading-relaxed text-nova-text-muted">
					Generate realistic cases to see live values beside every field.
				</p>
				<GenerateSampleDataButton generate={generateSampleData} />
			</div>
		);
	}

	if (preview.kind === "idle" || preview.kind === "loading") {
		return (
			<div className="mt-3 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-nova-border text-xs text-nova-text-muted">
				<Icon
					icon={tablerLoader2}
					width="14"
					height="14"
					className="animate-spin"
				/>
				Loading live values…
			</div>
		);
	}

	const notice = previewNotice(preview);
	return (
		<div className="mt-3 overflow-hidden rounded-xl border border-nova-border">
			<CanvasNotice tone={notice.tone}>{notice.text}</CanvasNotice>
		</div>
	);
}
