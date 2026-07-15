// components/builder/case-list-config/canvas/DetailCanvas.tsx
//
// The Case Detail authoring canvas is a readable vertical outline of the
// screen that opens after choosing a case. Only fields that actually appear
// in case detail occupy the app-shaped card; list-only and fully hidden fields
// remain reachable in the supporting inventory below it. Visibility stays a
// concern of the one canonical column inspector, never a duplicated canvas
// control. The canvas links to the inspector's complete shared-order stack;
// its field rows are selection-only.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerId from "@iconify-icons/tabler/id";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { CaseListConfig, Column } from "@/lib/domain";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { renderColumnCell } from "../columnCellRenderer";
import { GenerateSampleDataButton } from "../SampleDataButton";
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

export interface DetailCanvasProps {
	readonly config: CaseListConfig;
	/** Columns with a configuration error (`configValidity.ts::
	 *  caseListConfigVerdicts`) — the row carries a rose dot +
	 *  explanation so the tab strip's dot points at something findable. */
	readonly brokenColumns: ReadonlySet<string>;
	readonly preview: CaseListPreviewState;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddDetailField: () => void;
	/** Disabled-add hint — `undefined` means add is enabled. */
	readonly addDisabledReason: string | undefined;
	/** Populate-sample-data action — surfaced at the TOP of the canvas
	 *  when the store is empty so the detail never dead-ends with a wall
	 *  of em-dashes and no way forward. */
	readonly generate: SampleDataAction;
}

export function DetailCanvas({
	config,
	brokenColumns,
	preview,
	selection,
	onSelect,
	onAddDetailField,
	addDisabledReason,
	generate,
}: DetailCanvasProps) {
	const projection = projectCaseWorkspaceColumns(config.columns);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;
	const sampleRow: CaseRowWithCalculated | undefined =
		preview.kind === "rows" ? preview.rows[0] : undefined;

	return (
		<ContentFrame width="lg" className="px-6 pb-24 pt-6">
			<div data-case-detail-layout>
				<div className="mb-5 flex items-start gap-3">
					<span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-nova-border bg-nova-surface/40 text-nova-violet-bright">
						<Icon icon={tablerId} width="17" height="17" />
					</span>
					<div className="min-w-0">
						<h1 className="font-display text-lg font-semibold tracking-tight text-nova-text">
							Case detail layout
						</h1>
						<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
							Choose what people see after opening a case. Select a field to
							configure it; shared field order lives in the right panel.
						</p>
					</div>
				</div>

				<DetailPreviewState
					preview={preview}
					hasFields={projection.detailVisible.length > 0}
					generate={generate}
				/>

				<div className="overflow-hidden rounded-xl border border-nova-border bg-nova-surface/35">
					<div className="flex min-h-20 items-center gap-3 border-b border-nova-border bg-nova-deep/45 px-4 py-3.5">
						<span className="grid size-9 shrink-0 place-items-center rounded-full border border-nova-border bg-nova-surface/50 text-nova-text-secondary">
							<Icon icon={tablerId} width="17" height="17" />
						</span>
						<div className="min-w-0 flex-1">
							<p className="truncate font-display text-lg font-semibold tracking-tight text-nova-text">
								{sampleRow?.case_name || "Case detail"}
							</p>
							<p className="mt-0.5 text-[11px] leading-relaxed text-nova-text-muted">
								{sampleRow === undefined
									? "Live values appear when case data is available."
									: "Showing the first live case."}
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
							{projection.detailVisible.length} shown
						</span>
					</div>

					{projection.detailVisible.length === 0 ? (
						<CanvasNotice tone="muted">
							No fields are shown in case detail. Open a field below and turn on
							Case Detail visibility, or add a new one.
						</CanvasNotice>
					) : (
						projection.detailVisible.map((column) => (
							<DetailFieldRow
								key={column.uuid}
								column={column}
								sampleRow={sampleRow}
								selected={selectedColumnUuid === column.uuid}
								broken={brokenColumns.has(column.uuid)}
								onSelect={() => onSelect({ type: "column", uuid: column.uuid })}
							/>
						))
					)}

					<div className="border-t border-nova-border/80 p-3">
						<AddGhostButton
							label="Add Detail Field"
							onClick={onAddDetailField}
							disabledReason={addDisabledReason}
							className="w-full"
						/>
					</div>
				</div>

				<SupportingColumnInventory
					columns={projection.detailHidden}
					surface="detail"
					selectedUuid={selectedColumnUuid}
					brokenColumns={brokenColumns}
					onSelect={(column) => onSelect({ type: "column", uuid: column.uuid })}
				/>
			</div>
		</ContentFrame>
	);
}

function DetailFieldRow({
	column,
	sampleRow,
	selected,
	broken,
	onSelect,
}: {
	readonly column: Column;
	readonly sampleRow: CaseRowWithCalculated | undefined;
	readonly selected: boolean;
	readonly broken: boolean;
	readonly onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={`flex min-h-16 w-full cursor-pointer items-start gap-4 border-b border-nova-violet/[0.07] px-4 py-3 text-left transition-colors last:border-b-0 ${
				selected
					? "bg-nova-violet/[0.09] shadow-[inset_0_0_0_1.5px_var(--nova-violet)]"
					: "hover:bg-white/[0.025]"
			}`}
			data-case-field-role="visible"
			data-column-uuid={column.uuid}
		>
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate text-[12px] font-medium text-nova-text-muted">
						{columnLabel(column)}
					</span>
					{column.visibleInList !== false && (
						<span className="shrink-0 rounded-full border border-nova-border px-1.5 py-px text-[9px] text-nova-text-muted">
							List too
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
				<span className="mt-1 block min-w-0 overflow-hidden break-words text-[13px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]">
					{sampleRow === undefined
						? "No sample value yet"
						: renderColumnCell(column, sampleRow)}
				</span>
			</span>
			<span className="max-w-[36%] shrink-0 truncate pt-0.5 font-mono text-[10px] text-nova-text-muted">
				{columnSource(column)}
			</span>
		</button>
	);
}

function DetailPreviewState({
	preview,
	hasFields,
	generate,
}: {
	readonly preview: CaseListPreviewState;
	readonly hasFields: boolean;
	readonly generate: SampleDataAction;
}) {
	if (!hasFields || preview.kind === "rows") return null;

	if (preview.kind === "empty") {
		return (
			<div className="mb-5 rounded-xl border border-dashed border-nova-border-bright px-5 py-5 text-center">
				<p className="mb-3 text-xs leading-relaxed text-nova-text-muted">
					Generate realistic cases to preview this detail with live values.
				</p>
				<GenerateSampleDataButton generate={generate} />
			</div>
		);
	}

	if (preview.kind === "idle" || preview.kind === "loading") {
		return (
			<div className="mb-5 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-nova-border text-xs text-nova-text-muted">
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
		<div className="mb-5 overflow-hidden rounded-xl border border-nova-border">
			<CanvasNotice tone={notice.tone}>{notice.text}</CanvasNotice>
		</div>
	);
}
