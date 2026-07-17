// components/builder/case-list-config/canvas/DetailCanvas.tsx
//
// Details is composed directly in the center. It owns an order independent
// from Results, matching CommCare's separate short/long detail arrays while
// keeping that wire vocabulary out of Nova's UI.

"use client";

import { ContentFrame } from "@/components/builder/ContentFrame";
import type {
	CaseListConfig,
	CaseProperty,
	CaseType,
	Column,
} from "@/lib/domain";
import {
	representedColumnProperties,
	unrepresentedColumnProperties,
} from "../seeds";
import { projectCaseWorkspaceColumns } from "../workspaceProjection";
import type { WorkspaceSelection } from "../workspaceSelection";
import { CanvasNotice } from "./canvasChrome";
import {
	AddInformationControl,
	DisplayFieldComposer,
} from "./DisplayFieldComposer";

export interface DetailCanvasProps {
	readonly config: CaseListConfig;
	readonly caseType: CaseType | undefined;
	readonly brokenColumns: ReadonlySet<string>;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddDetailField: (property: CaseProperty) => void;
	readonly onAddCalculated: () => void;
	readonly addDisabledReason: string | undefined;
	readonly onMoveColumn: (uuid: Column["uuid"], toIndex: number) => void;
	readonly onShowColumn: (column: Column) => void;
	readonly onRepairColumn: (column: Column) => void;
}

export function DetailCanvas({
	config,
	caseType,
	brokenColumns,
	selection,
	onSelect,
	onAddDetailField,
	onAddCalculated,
	addDisabledReason,
	onMoveColumn,
	onShowColumn,
	onRepairColumn,
}: DetailCanvasProps) {
	const projection = projectCaseWorkspaceColumns(config.columns);
	const availableProperties = unrepresentedColumnProperties(config, caseType);
	const repeatableProperties = representedColumnProperties(config, caseType);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-8">
			<div data-case-detail-layout>
				<header className="mb-9">
					<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
						Details
					</h1>
					<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
						Choose what people see after opening a case.
					</p>
				</header>

				<section aria-labelledby="details-information-heading">
					<div className="mb-4">
						<h2
							id="details-information-heading"
							className="font-display text-[17px] font-semibold text-nova-text"
						>
							Information shown
						</h2>
						<p className="mt-1 text-[12px] leading-relaxed text-nova-text-muted">
							Drag to set the reading order. Select a row to change its label or
							appearance.
						</p>
					</div>

					{projection.detailVisible.length === 0 ? (
						<div className="overflow-hidden rounded-xl border border-dashed border-nova-border-bright">
							<CanvasNotice tone="muted">
								Details are optional. Without them, people continue directly
								from Results.
							</CanvasNotice>
						</div>
					) : (
						<DisplayFieldComposer
							columns={projection.detailVisible}
							surface="detail"
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
							properties={availableProperties}
							repeatableProperties={repeatableProperties}
							brokenColumns={brokenColumns}
							onShow={onShowColumn}
							onRepair={onRepairColumn}
							onCreate={onAddDetailField}
							onCreateCalculated={onAddCalculated}
							createDisabledReason={addDisabledReason}
						/>
					</div>
				</section>
			</div>
		</ContentFrame>
	);
}
