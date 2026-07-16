// components/builder/case-list-config/canvas/CaseListCanvas.tsx
//
// Results is a direct-manipulation composition surface. The author drags the
// same spacious rows a worker will scan, while the selected row's formatting
// stays in the properties rail. No table geometry, wire names, positional
// badges, or hidden columns leak into the experience.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAdjustmentsHorizontal from "@iconify-icons/tabler/adjustments-horizontal";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { CaseListConfig, CaseType, Column } from "@/lib/domain";
import { summarizeFilter } from "../predicateSummary";
import { GenerateSampleDataButton } from "../SampleDataButton";
import { CaseOrderingComposer } from "../SortPriorityStack";
import type { CaseListPreviewState } from "../useCaseListPreview";
import type { SampleDataAction } from "../useSampleData";
import { projectCaseWorkspaceColumns } from "../workspaceProjection";
import type { WorkspaceSelection } from "../workspaceSelection";
import { CanvasNotice, previewNotice } from "./canvasChrome";
import {
	AddInformationControl,
	DisplayFieldComposer,
} from "./DisplayFieldComposer";

export interface CaseListCanvasProps {
	readonly config: CaseListConfig;
	readonly caseType: CaseType | undefined;
	readonly caseTypes?: readonly CaseType[];
	readonly brokenColumns: ReadonlySet<string>;
	readonly preview: CaseListPreviewState;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddColumn: () => void;
	readonly addColumnDisabledReason: string | undefined;
	readonly onMoveColumn: (uuid: Column["uuid"], toIndex: number) => void;
	readonly onColumnsChange: (next: readonly Column[]) => void;
	readonly onRemoveColumn: (column: Column) => void;
	readonly onShowColumn: (column: Column) => void;
	readonly onOpenOptions: () => void;
	readonly showOptions?: boolean;
	readonly refreshing?: boolean;
	readonly generateSampleData: SampleDataAction;
}

export function CaseListCanvas({
	config,
	caseType,
	caseTypes,
	brokenColumns,
	preview,
	selection,
	onSelect,
	onAddColumn,
	addColumnDisabledReason,
	onMoveColumn,
	onColumnsChange,
	onRemoveColumn,
	onShowColumn,
	onOpenOptions,
	showOptions = true,
	refreshing = false,
	generateSampleData,
}: CaseListCanvasProps) {
	const projection = projectCaseWorkspaceColumns(config.columns);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;
	const sampleRow = preview.kind === "rows" ? preview.rows[0] : undefined;
	const filterPhrase = summarizeFilter(config.filter);
	const filterSelected = selection?.type === "filter";

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-8">
			<div data-case-list-layout>
				<header className="mb-7 flex items-start gap-4">
					<div className="min-w-0 flex-1">
						<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
							Design the results
						</h1>
						<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
							Drag the information into the order people should scan it. Select
							a row to change what it shows or how it looks.
						</p>
					</div>
					{showOptions && (
						<button
							type="button"
							onClick={onOpenOptions}
							className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-white/[0.08] px-3 text-[12px] text-nova-text-secondary transition-colors hover:border-nova-violet/30 hover:bg-nova-violet/[0.06] hover:text-nova-text"
						>
							<Icon icon={tablerAdjustmentsHorizontal} width="15" height="15" />
							Options
						</button>
					)}
				</header>

				<section
					className={`mb-4 flex min-h-16 items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${
						filterSelected
							? "border-nova-violet bg-nova-violet/[0.08]"
							: "border-white/[0.07] bg-nova-surface/25"
					}`}
					aria-labelledby="included-cases-heading"
				>
					<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.035] text-nova-text-muted">
						<Icon icon={tablerFilter} width="16" height="16" />
					</span>
					<div className="min-w-0 flex-1">
						<h2
							id="included-cases-heading"
							className="text-[12px] font-medium text-nova-text-muted"
						>
							Cases included
						</h2>
						<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-secondary first-letter:uppercase">
							{filterPhrase === undefined
								? "Showing all cases."
								: `Showing cases where ${filterPhrase}.`}
						</p>
					</div>
					<button
						type="button"
						onClick={() => onSelect({ type: "filter" })}
						className="min-h-11 shrink-0 cursor-pointer rounded-lg px-3 text-[12px] font-medium text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.08]"
					>
						Change
					</button>
				</section>

				<section
					className="overflow-hidden rounded-2xl border border-white/[0.08] bg-nova-surface/25 p-3"
					aria-labelledby="example-result-heading"
				>
					<div className="flex items-start gap-3 px-2 pb-3 pt-1">
						<div className="min-w-0 flex-1">
							<h2
								id="example-result-heading"
								className="font-display text-[16px] font-semibold text-nova-text"
							>
								Example result
							</h2>
							<p className="mt-1 text-[12px] leading-relaxed text-nova-text-muted">
								This is the information people will scan before choosing a case.
							</p>
						</div>
					</div>

					{projection.listVisible.length === 0 ? (
						<CanvasNotice tone="muted">
							Use Add information to build the first result.
						</CanvasNotice>
					) : (
						<DisplayFieldComposer
							columns={projection.listVisible}
							surface="list"
							sampleRow={sampleRow}
							selectedUuid={selectedColumnUuid}
							brokenColumns={brokenColumns}
							onSelect={(column) =>
								onSelect({ type: "column", uuid: column.uuid })
							}
							onMove={onMoveColumn}
							onRemove={onRemoveColumn}
						/>
					)}

					<div className="pt-3">
						<AddInformationControl
							columns={projection.listHidden}
							brokenColumns={brokenColumns}
							onShow={onShowColumn}
							onCreate={onAddColumn}
							createDisabledReason={addColumnDisabledReason}
						/>
					</div>
				</section>

				<PreviewDataStatus
					preview={preview}
					refreshing={refreshing}
					hasFields={projection.listVisible.length > 0}
					generateSampleData={generateSampleData}
				/>

				<CaseOrderingComposer
					value={config.columns}
					caseType={caseType}
					caseTypes={caseTypes}
					onChange={onColumnsChange}
				/>
			</div>
		</ContentFrame>
	);
}

function PreviewDataStatus({
	preview,
	refreshing,
	hasFields,
	generateSampleData,
}: {
	readonly preview: CaseListPreviewState;
	readonly refreshing: boolean;
	readonly hasFields: boolean;
	readonly generateSampleData: SampleDataAction;
}) {
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
			<div className="mt-3 flex min-h-9 flex-wrap items-center gap-2 px-1 text-[12px] text-nova-text-muted">
				<span>
					Using {preview.rows.length}{" "}
					{preview.rows.length === 1 ? "case" : "cases"} to show realistic
					examples.
				</span>
				{refreshing && (
					<Icon
						icon={tablerLoader2}
						width="13"
						height="13"
						className="animate-spin"
						aria-label="Updating examples"
					/>
				)}
				{preview.rows.length === 0 && <span>No cases match right now.</span>}
			</div>
		);
	}

	if (preview.kind === "empty") {
		return (
			<div className="mt-4 rounded-2xl border border-dashed border-nova-border-bright px-5 py-5 text-center">
				<p className="mb-3 text-[12px] leading-relaxed text-nova-text-muted">
					Add a few realistic cases so every row can show a useful example.
				</p>
				<GenerateSampleDataButton generate={generateSampleData} />
			</div>
		);
	}

	if (preview.kind === "idle" || preview.kind === "loading") {
		return (
			<div className="mt-3 flex min-h-11 items-center justify-center gap-2 text-[12px] text-nova-text-muted">
				<Icon
					icon={tablerLoader2}
					width="14"
					height="14"
					className="animate-spin"
				/>
				Loading examples…
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
