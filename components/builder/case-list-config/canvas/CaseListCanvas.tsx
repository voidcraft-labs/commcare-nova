// components/builder/case-list-config/canvas/CaseListCanvas.tsx
//
// Results is a direct-manipulation composition surface. The author drags one
// calm label-first row per information item, while actual case values stay in
// the global Preview and the selected row's formatting stays in the properties
// rail. No table geometry, wire names, positional badges, or hidden columns
// leak into the experience.
//
// Arrangement is a choice this canvas owns. A case list shows its fields as
// rows or as a tile, and the switch sits beside the information it rearranges:
// the same reason order is dragged here and never set from a panel.

"use client";

import { ContentFrame } from "@/components/builder/ContentFrame";
import type {
	CaseListConfig,
	CaseProperty,
	CaseSearchConfig,
	CaseSelection,
	CaseTileGrouping,
	CaseType,
	Column,
	CommitOutcome,
	TileCell,
	UserProperty,
	Uuid,
} from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import { useCanEdit } from "@/lib/session/hooks";
import { CaseOrderingComposer } from "../SortPriorityStack";
import {
	representedColumnProperties,
	unrepresentedColumnProperties,
} from "../seeds";
import { TileLayoutCanvas } from "../tile/TileLayoutCanvas";
import {
	type CaseListArrangement,
	TileLayoutToggle,
} from "../tile/TileLayoutToggle";
import type { TilePresetId } from "../tile/tilePresets";
import { projectCaseWorkspaceColumns } from "../workspaceProjection";
import type { WorkspaceSelection } from "../workspaceSelection";
import {
	CaseAvailabilityComposer,
	type CaseAvailabilityComposerProps,
} from "./CaseAvailabilityComposer";
import { CaseSelectionSetting } from "./CaseSelectionSetting";
import { CanvasNotice } from "./canvasChrome";
import {
	AddInformationControl,
	DisplayFieldComposer,
} from "./DisplayFieldComposer";

export interface CaseListCanvasProps {
	readonly config: CaseListConfig;
	readonly caseType: CaseType | undefined;
	readonly caseTypes?: readonly CaseType[];
	readonly userProperties?: readonly UserProperty[];
	readonly brokenColumns: ReadonlySet<string>;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddColumn: (property: CaseProperty) => void;
	readonly onAddCalculated: () => void;
	readonly addColumnDisabledReason: string | undefined;
	readonly onMoveColumn: (uuid: Column["uuid"], toIndex: number) => void;
	readonly onColumnsChange: (next: readonly Column[]) => void;
	readonly onShowColumn: (column: Column) => void;
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
	/** Tile-placement problems, keyed by field. Results owns these; they
	 *  deliberately stay out of `brokenColumns` so Details is never
	 *  badged for a problem that only exists on this screen. */
	readonly tileIssues: ReadonlyMap<Uuid, readonly string[]>;
	/** Present when the case list cannot be laid out as a tile right now. */
	readonly tileDisabledReason: string | undefined;
	readonly onArrangementChange: (next: CaseListArrangement) => void;
	readonly onPlaceTileCell: (uuid: Uuid, cell: TileCell) => void;
	readonly onPutColumnOnTile: (uuid: Uuid) => void;
	readonly onApplyTilePreset: (preset: TilePresetId) => void;
	readonly onTilePersistOnFormsChange: (persist: boolean) => void;
	readonly onTileGroupingChange: (next: CaseTileGrouping | undefined) => void;
	readonly onCaseSelectionChange: (
		next: CaseSelection | undefined,
		origin?: HTMLElement,
	) => void;
}

export function CaseListCanvas({
	config,
	caseType,
	caseTypes,
	userProperties = [],
	brokenColumns,
	selection,
	onSelect,
	onAddColumn,
	onAddCalculated,
	addColumnDisabledReason,
	onMoveColumn,
	onColumnsChange,
	onShowColumn,
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
	tileIssues,
	tileDisabledReason,
	onArrangementChange,
	onPlaceTileCell,
	onPutColumnOnTile,
	onApplyTilePreset,
	onTilePersistOnFormsChange,
	onTileGroupingChange,
	onCaseSelectionChange,
}: CaseListCanvasProps) {
	const canEdit = useCanEdit();
	const projection = projectCaseWorkspaceColumns(config);
	const availableProperties = unrepresentedColumnProperties(config, caseType);
	const repeatableProperties = representedColumnProperties(config, caseType);
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;
	const tile = config.tile;
	// A tile problem marks the same row a kind mismatch would, so one
	// attention mark on Results covers both.
	const resultsBrokenColumns = new Set<string>([
		...brokenColumns,
		...tileIssues.keys(),
	]);

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-8">
			<div data-case-list-layout>
				<header className="mb-9">
					<div className="min-w-0 flex-1">
						<h1 className="font-display text-2xl font-semibold tracking-tighter text-nova-text">
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
					<CaseSelectionSetting
						value={config.selection}
						canEdit={canEdit}
						onChange={onCaseSelectionChange}
					/>

					<section aria-labelledby="results-information-heading">
						<div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
							{/* Asks for a readable column before the switch beside it
							 * gets to take room. Without a basis the heading block
							 * shrinks toward nothing and the row never wraps, so the
							 * helper sentence breaks into four lines in ~110px while
							 * the switch keeps its full width. */}
							<div className="min-w-0 grow basis-72">
								<h2
									id="results-information-heading"
									className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
								>
									Information shown
								</h2>
								<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
									{!canEdit
										? "People use this information to compare cases"
										: tile !== undefined
											? "Drag a field to move it on the tile. Select one to change its place or how it looks."
											: "Drag to reorder. Select an item to change its label or appearance."}
								</p>
							</div>
							{canEdit && (
								<TileLayoutToggle
									value={tile === undefined ? "rows" : "tile"}
									tileDisabledReason={tileDisabledReason}
									rowsConsequence={
										tile?.persistOnForms === true
											? "Your tile arrangement is kept, and comes back whenever you choose Tile again. The tile will no longer stay on screen during this module's forms."
											: undefined
									}
									onChange={onArrangementChange}
								/>
							)}
						</div>

						{projection.listVisible.length === 0 ? (
							<div className="overflow-hidden rounded-xl border border-dashed border-nova-border-bright">
								<CanvasNotice tone="muted" title="No case information is shown">
									{canEdit
										? "Add the information people need to recognize a case"
										: "People can't recognize a case from this screen. Ask someone who can edit the app to add information."}
								</CanvasNotice>
							</div>
						) : tile !== undefined ? (
							<TileLayoutCanvas
								config={config}
								tile={tile}
								caseType={caseType}
								appId={appId}
								selectedUuid={selectedColumnUuid}
								issues={tileIssues}
								canEdit={canEdit}
								onSelect={(uuid) => onSelect({ type: "column", uuid })}
								onPlace={onPlaceTileCell}
								onPlaceUnplaced={onPutColumnOnTile}
								onApplyPreset={onApplyTilePreset}
								onPersistOnFormsChange={onTilePersistOnFormsChange}
								onGroupingChange={onTileGroupingChange}
							/>
						) : (
							<DisplayFieldComposer
								columns={projection.listVisible}
								surface="list"
								selectedUuid={selectedColumnUuid}
								brokenColumns={resultsBrokenColumns}
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
								brokenColumns={resultsBrokenColumns}
								onShow={onShowColumn}
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
								className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
							>
								Cases available
							</h2>
							<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
								{canEdit
									? "Choose which cases can appear in Results"
									: "Your app's rules determine which cases can appear in Results"}
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
							userProperties={userProperties}
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
								className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
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
								config={config}
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
