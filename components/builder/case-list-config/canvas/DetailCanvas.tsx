// components/builder/case-list-config/canvas/DetailCanvas.tsx
//
// Details is composed directly in the center. It owns an order independent
// from Results, matching CommCare's separate short/long detail arrays while
// keeping that wire vocabulary out of Nova's UI.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerId from "@iconify-icons/tabler/id";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { CaseListConfig, Column } from "@/lib/domain";
import type { CaseListPreviewState } from "../useCaseListPreview";
import { projectCaseWorkspaceColumns } from "../workspaceProjection";
import type { WorkspaceSelection } from "../workspaceSelection";
import { CanvasNotice, previewNotice } from "./canvasChrome";
import {
	AddInformationControl,
	DisplayFieldComposer,
} from "./DisplayFieldComposer";

export interface DetailCanvasProps {
	readonly config: CaseListConfig;
	readonly brokenColumns: ReadonlySet<string>;
	readonly preview: CaseListPreviewState;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddDetailField: () => void;
	readonly addDisabledReason: string | undefined;
	readonly onMoveColumn: (uuid: Column["uuid"], toIndex: number) => void;
	readonly onShowColumn: (column: Column) => void;
	readonly onRepairColumn: (column: Column) => void;
}

export function DetailCanvas({
	config,
	brokenColumns,
	preview,
	selection,
	onSelect,
	onAddDetailField,
	addDisabledReason,
	onMoveColumn,
	onShowColumn,
	onRepairColumn,
}: DetailCanvasProps) {
	const projection = projectCaseWorkspaceColumns(config.columns);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;
	const sampleRow = preview.kind === "rows" ? preview.rows[0] : undefined;

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-8">
			<div data-case-detail-layout>
				<header className="mb-7">
					<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
						Design the details
					</h1>
					<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
						Choose what people need after opening a case. Drag rows into the
						most useful reading order, then select one to shape it.
					</p>
				</header>

				<div className="space-y-5">
					<section
						className="overflow-hidden rounded-2xl border border-white/[0.08] bg-nova-surface/25 p-3"
						aria-labelledby="case-details-heading"
					>
						<div className="mb-3 flex min-h-16 items-center gap-3 rounded-xl bg-nova-deep/35 px-3 py-3">
							<span className="grid size-10 shrink-0 place-items-center rounded-full bg-white/[0.04] text-nova-text-secondary">
								<Icon icon={tablerId} width="18" height="18" />
							</span>
							<div className="min-w-0 flex-1">
								<h2
									id="case-details-heading"
									className="truncate font-display text-[17px] font-semibold tracking-tight text-nova-text"
								>
									{sampleRow?.case_name || "Example case"}
								</h2>
								<p className="mt-0.5 text-[12px] leading-relaxed text-nova-text-muted">
									What people see before they continue.
								</p>
							</div>
						</div>

						{projection.detailVisible.length === 0 ? (
							<CanvasNotice tone="muted">
								Details are optional. Without them, people continue directly
								from Results.
							</CanvasNotice>
						) : (
							<DisplayFieldComposer
								columns={projection.detailVisible}
								surface="detail"
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
								surface="detail"
								columns={projection.detailHidden}
								brokenColumns={brokenColumns}
								onShow={onShowColumn}
								onRepair={onRepairColumn}
								onCreate={onAddDetailField}
								createDisabledReason={addDisabledReason}
							/>
						</div>
					</section>
					<DetailPreviewIssue preview={preview} />
				</div>
			</div>
		</ContentFrame>
	);
}

function DetailPreviewIssue({
	preview,
}: {
	readonly preview: CaseListPreviewState;
}) {
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
