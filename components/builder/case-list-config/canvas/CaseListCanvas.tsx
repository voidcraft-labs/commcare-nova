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
import { useCanEdit } from "@/lib/session/hooks";
import { summarizeFilter } from "../predicateSummary";
import { CaseOrderingComposer } from "../SortPriorityStack";
import type { CaseListPreviewState } from "../useCaseListPreview";
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
	readonly onShowColumn: (column: Column) => void;
	readonly onRepairColumn: (column: Column) => void;
	readonly onOpenOptions: () => void;
	readonly showMenuAppearance?: boolean;
	readonly refreshing?: boolean;
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
	onShowColumn,
	onRepairColumn,
	onOpenOptions,
	showMenuAppearance = false,
	refreshing = false,
}: CaseListCanvasProps) {
	const canEdit = useCanEdit();
	const projection = projectCaseWorkspaceColumns(config.columns);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;
	const sampleRow = preview.kind === "rows" ? preview.rows[0] : undefined;
	const filterPhrase = summarizeFilter(config.filter);
	const filterSelected = selection?.type === "filter";

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-8">
			<div data-case-list-layout>
				<header className="mb-7 flex flex-col gap-4 @xl:flex-row @xl:items-start">
					<div className="min-w-0 flex-1">
						<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
							Design the results
						</h1>
						<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
							Drag the information into the order people should scan it. Select
							a row to change what it shows or how it looks.
						</p>
					</div>
					{showMenuAppearance && (
						<button
							type="button"
							onClick={onOpenOptions}
							className="inline-flex min-h-11 shrink-0 self-start cursor-pointer items-center gap-2 rounded-xl border border-white/[0.08] px-3 text-[12px] text-nova-text-secondary transition-colors hover:border-nova-violet/30 hover:bg-nova-violet/[0.06] hover:text-nova-text"
						>
							<Icon icon={tablerAdjustmentsHorizontal} width="15" height="15" />
							Menu appearance
						</button>
					)}
				</header>

				<div className="space-y-5">
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
									This is the information people will scan before choosing a
									case.
								</p>
							</div>
							{refreshing && (
								<Icon
									icon={tablerLoader2}
									width="14"
									height="14"
									className="mt-1 shrink-0 animate-spin text-nova-text-muted"
									aria-label="Updating example"
								/>
							)}
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
							/>
						)}

						<div className="pt-3">
							<AddInformationControl
								surface="list"
								columns={projection.listHidden}
								brokenColumns={brokenColumns}
								onShow={onShowColumn}
								onRepair={onRepairColumn}
								onCreate={onAddColumn}
								createDisabledReason={addColumnDisabledReason}
							/>
						</div>
					</section>

					<PreviewIssue preview={preview} />

					<section
						className={`flex min-h-14 flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
							filterSelected
								? "border-nova-violet bg-nova-violet/[0.08]"
								: "border-white/[0.06] bg-white/[0.018]"
						}`}
						aria-labelledby="included-cases-heading"
					>
						<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.035] text-nova-text-muted">
							<Icon icon={tablerFilter} width="16" height="16" />
						</span>
						<div className="min-w-0 flex-1">
							<h2
								id="included-cases-heading"
								className="text-[13px] font-medium text-nova-text-secondary"
							>
								Who appears in results
							</h2>
							<p className="mt-0.5 text-[12px] leading-relaxed text-nova-text-muted first-letter:uppercase">
								{filterPhrase === undefined
									? "Everyone in this case type."
									: `Cases where ${filterPhrase}.`}
							</p>
						</div>
						{canEdit && (
							<button
								type="button"
								onClick={() => onSelect({ type: "filter" })}
								className="min-h-11 w-full shrink-0 cursor-pointer rounded-lg px-3 text-[12px] font-medium text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.08] @min-[28rem]:w-auto"
							>
								Change
							</button>
						)}
					</section>

					<CaseOrderingComposer
						value={config.columns}
						caseType={caseType}
						caseTypes={caseTypes}
						onChange={onColumnsChange}
					/>
				</div>
			</div>
		</ContentFrame>
	);
}

function PreviewIssue({ preview }: { readonly preview: CaseListPreviewState }) {
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
		<div className="overflow-hidden rounded-xl border border-nova-border">
			<CanvasNotice tone={notice.tone}>{notice.text}</CanvasNotice>
		</div>
	);
}
