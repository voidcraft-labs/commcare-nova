// components/builder/case-list-config/canvas/CaseListCanvas.tsx
//
// Results is a direct-manipulation composition surface. The author drags one
// calm label-first row per information item, while actual case values stay in
// the global Preview and the selected row's formatting stays in the properties
// rail. No table geometry, wire names, positional badges, or hidden columns
// leak into the experience.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAdjustmentsHorizontal from "@iconify-icons/tabler/adjustments-horizontal";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerFilter from "@iconify-icons/tabler/filter";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { CaseListConfig, CaseType, Column } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { humanizeName, summarizeFilter } from "../predicateSummary";
import { CaseOrderingComposer } from "../SortPriorityStack";
import { projectCaseWorkspaceColumns } from "../workspaceProjection";
import type { WorkspaceSelection } from "../workspaceSelection";
import { CanvasNotice } from "./canvasChrome";
import {
	AddInformationControl,
	DisplayFieldComposer,
} from "./DisplayFieldComposer";

export interface CaseListCanvasProps {
	readonly config: CaseListConfig;
	readonly caseType: CaseType | undefined;
	readonly caseTypes?: readonly CaseType[];
	readonly brokenColumns: ReadonlySet<string>;
	readonly filterBroken: boolean;
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
}

export function CaseListCanvas({
	config,
	caseType,
	caseTypes,
	brokenColumns,
	filterBroken,
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
}: CaseListCanvasProps) {
	const canEdit = useCanEdit();
	const projection = projectCaseWorkspaceColumns(config.columns);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;
	const filterPhrase = summarizeFilter(config.filter);
	const filterSelected = selection?.type === "filter";
	const allCasesLabel = caseType
		? `All ${humanizeName(caseType.name)} cases.`
		: "All cases.";

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-8">
			<div data-case-list-layout>
				<header className="mb-9 flex flex-col gap-4 @min-[22rem]:flex-row @min-[22rem]:items-start">
					<div className="min-w-0 flex-1">
						<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
							Results
						</h1>
						<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
							Choose what people scan before opening a case.
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

				<div className="space-y-10">
					<section aria-labelledby="results-information-heading">
						<div className="mb-4">
							<h2
								id="results-information-heading"
								className="font-display text-[17px] font-semibold text-nova-text"
							>
								Information shown
							</h2>
							<p className="mt-1 text-[12px] leading-relaxed text-nova-text-muted">
								Drag to set the reading order. Select a row to change its label
								or appearance.
							</p>
						</div>

						{projection.listVisible.length === 0 ? (
							<div className="overflow-hidden rounded-xl border border-dashed border-nova-border-bright">
								<CanvasNotice tone="muted">
									Add the information people need to recognize a case.
								</CanvasNotice>
							</div>
						) : (
							<DisplayFieldComposer
								columns={projection.listVisible}
								surface="list"
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

					<section aria-labelledby="results-behavior-heading">
						<div className="mb-4">
							<h2
								id="results-behavior-heading"
								className="font-display text-[17px] font-semibold text-nova-text"
							>
								How results are chosen
							</h2>
							<p className="mt-1 text-[12px] leading-relaxed text-nova-text-muted">
								Control which cases appear and what people see first.
							</p>
						</div>

						<div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-nova-surface/20">
							<div
								className={`flex min-h-[72px] flex-wrap items-center gap-3 px-4 py-3 transition-colors ${
									filterSelected
										? "bg-nova-violet/[0.08] shadow-[inset_3px_0_0_var(--nova-violet)]"
										: filterBroken
											? "bg-nova-rose/[0.035]"
											: "hover:bg-white/[0.018]"
								}`}
							>
								<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.035] text-nova-text-muted">
									<Icon icon={tablerFilter} width="16" height="16" />
								</span>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<h3
											id="included-cases-heading"
											className="text-[13px] font-semibold text-nova-text"
										>
											Cases included
										</h3>
										{filterBroken && (
											<span className="inline-flex items-center gap-1 text-[11px] text-nova-rose">
												<Icon icon={tablerAlertCircle} width="14" height="14" />
												Needs attention
											</span>
										)}
									</div>
									<p className="mt-0.5 text-[12px] leading-relaxed text-nova-text-muted first-letter:uppercase">
										{filterBroken
											? "This rule needs a quick fix."
											: filterPhrase === undefined
												? allCasesLabel
												: `Cases where ${filterPhrase}.`}
									</p>
								</div>
								{canEdit && (
									<button
										type="button"
										onClick={() => onSelect({ type: "filter" })}
										aria-label={
											filterBroken
												? "Fix cases included"
												: "Change cases included"
										}
										className="min-h-11 w-full shrink-0 cursor-pointer rounded-lg px-3 text-[12px] font-medium text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.08] @min-[28rem]:w-auto"
									>
										{filterBroken ? "Fix" : "Change"}
									</button>
								)}
							</div>

							<CaseOrderingComposer
								value={config.columns}
								caseType={caseType}
								caseTypes={caseTypes}
								onChange={onColumnsChange}
							/>
						</div>
					</section>
				</div>
			</div>
		</ContentFrame>
	);
}
