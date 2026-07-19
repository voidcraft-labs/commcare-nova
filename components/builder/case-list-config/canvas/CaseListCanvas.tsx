// components/builder/case-list-config/canvas/CaseListCanvas.tsx
//
// Results is a direct-manipulation composition surface. The author drags one
// calm label-first row per information item, while actual case values stay in
// the global Preview and the selected row's formatting stays in the properties
// rail. No table geometry, wire names, positional badges, or hidden columns
// leak into the experience.

"use client";

import { ContentFrame } from "@/components/builder/ContentFrame";
import type {
	CaseListConfig,
	CaseProperty,
	CaseSearchConfig,
	CaseType,
	Column,
	CommitOutcome,
} from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import { useCanEdit } from "@/lib/session/hooks";
import { CaseOrderingComposer } from "../SortPriorityStack";
import {
	representedColumnProperties,
	unrepresentedColumnProperties,
} from "../seeds";
import { projectCaseWorkspaceColumns } from "../workspaceProjection";
import type { WorkspaceSelection } from "../workspaceSelection";
import {
	CaseAvailabilityComposer,
	type CaseAvailabilityComposerProps,
} from "./CaseAvailabilityComposer";
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
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddColumn: (property: CaseProperty) => void;
	readonly onAddCalculated: () => void;
	readonly addColumnDisabledReason: string | undefined;
	readonly onMoveColumn: (uuid: Column["uuid"], toIndex: number) => void;
	readonly onColumnsChange: (next: readonly Column[]) => void;
	readonly onShowColumn: (column: Column) => void;
	readonly onRepairColumn: (column: Column) => void;
	readonly filterBroken: boolean;
	readonly excludedOwnerIdsBroken?: boolean;
	readonly onFilterChange: (next: Predicate | undefined) => CommitOutcome;
	readonly onClearFilter: (next: Predicate | undefined) => CommitOutcome;
	readonly searchConfig: CaseSearchConfig | undefined;
	readonly caseSearchEnabled: boolean;
	readonly onExcludedOwnerIdsChange: (
		next: ValueExpression | undefined,
	) => void;
	readonly appId: string;
	readonly dependencyReview?: CaseAvailabilityComposerProps["dependencyReview"];
	readonly onReturnToSearchField?: () => void;
}

export function CaseListCanvas({
	config,
	caseType,
	caseTypes,
	brokenColumns,
	selection,
	onSelect,
	onAddColumn,
	onAddCalculated,
	addColumnDisabledReason,
	onMoveColumn,
	onColumnsChange,
	onShowColumn,
	onRepairColumn,
	filterBroken,
	excludedOwnerIdsBroken = false,
	onFilterChange,
	onClearFilter,
	searchConfig,
	caseSearchEnabled,
	onExcludedOwnerIdsChange,
	appId,
	dependencyReview,
	onReturnToSearchField,
}: CaseListCanvasProps) {
	const canEdit = useCanEdit();
	const projection = projectCaseWorkspaceColumns(config.columns);
	const availableProperties = unrepresentedColumnProperties(config, caseType);
	const repeatableProperties = representedColumnProperties(config, caseType);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-8">
			<div data-case-list-layout>
				<header className="mb-9">
					<div className="min-w-0 flex-1">
						<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
							Results
						</h1>
						<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
							{canEdit
								? "Choose how people recognize and compare cases"
								: "People recognize and compare cases here"}
						</p>
					</div>
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
							<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
								{canEdit
									? "Drag to reorder. Select an item to change its label or appearance."
									: "People use this information to compare cases"}
							</p>
						</div>

						{projection.listVisible.length === 0 ? (
							<div className="overflow-hidden rounded-xl border border-dashed border-nova-border-bright">
								<CanvasNotice tone="muted" title="No case information is shown">
									{canEdit
										? "Add the information people need to recognize a case"
										: "People can’t recognize a case from this screen. Ask someone who can edit the app to add information."}
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
								properties={availableProperties}
								repeatableProperties={repeatableProperties}
								brokenColumns={brokenColumns}
								onShow={onShowColumn}
								onRepair={onRepairColumn}
								onCreate={onAddColumn}
								onCreateCalculated={onAddCalculated}
								createDisabledReason={addColumnDisabledReason}
							/>
						</div>
					</section>

					<section aria-labelledby="results-availability-heading">
						<div className="mb-4">
							<h2
								id="results-availability-heading"
								className="font-display text-[17px] font-semibold text-nova-text"
							>
								Cases available
							</h2>
							<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
								{canEdit
									? "Choose which cases can appear in Results"
									: "Your app’s rules determine which cases can appear in Results"}
							</p>
						</div>

						<CaseAvailabilityComposer
							config={config}
							filterBroken={filterBroken}
							excludedOwnerIdsBroken={excludedOwnerIdsBroken}
							onFilterChange={onFilterChange}
							onClearFilter={onClearFilter}
							searchConfig={searchConfig}
							caseSearchEnabled={caseSearchEnabled}
							onExcludedOwnerIdsChange={onExcludedOwnerIdsChange}
							caseTypes={caseTypes ?? []}
							currentCaseType={caseType?.name ?? ""}
							appId={appId}
							dependencyReview={dependencyReview}
							onReturnToSearchField={onReturnToSearchField}
						/>
					</section>

					<section aria-labelledby="results-order-heading">
						<div className="mb-4">
							<h2
								id="results-order-heading"
								className="font-display text-[17px] font-semibold text-nova-text"
							>
								Default order
							</h2>
							<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
								{canEdit
									? "Choose which cases appear first in Results"
									: "This order determines which cases appear first in Results"}
							</p>
						</div>

						<div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-nova-surface/20">
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
