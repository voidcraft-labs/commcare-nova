// components/builder/case-list-config/tile/TileLayoutCanvas.tsx
//
// Everything the tile arrangement owns on the Results canvas: the
// starting-layout menu, the grid itself, and the one setting that
// belongs to the layout rather than to a field: whether the tile stays
// on screen above this module's forms.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerLayoutBoard from "@iconify-icons/tabler/layout-board";
import {
	CONSOLE_MENU_ITEM_CLS,
	ToggleRow,
} from "@/components/builder/inspector/inspectorChrome";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import type {
	CaseListConfig,
	CaseTileGrouping,
	CaseTileLayout,
	CaseType,
	TileCell,
	Uuid,
} from "@/lib/domain";
import { TileGridEditor } from "./TileGridEditor";
import { TileGroupingSection } from "./TileGroupingSection";
import { tileMembership, tileMemberUuids } from "./tileModel";
import {
	matchingTilePreset,
	TILE_PRESETS,
	type TilePresetId,
	tilePresetUnavailableReason,
} from "./tilePresets";

export interface TileLayoutCanvasProps {
	readonly config: CaseListConfig;
	readonly tile: CaseTileLayout;
	/** The type this list shows, for the grouping section's connection hint
	 *  and the population it measures. */
	readonly caseType: CaseType | undefined;
	readonly appId: string;
	readonly selectedUuid: string | null;
	readonly issues: ReadonlyMap<Uuid, readonly string[]>;
	readonly canEdit: boolean;
	readonly onSelect: (uuid: Uuid) => void;
	readonly onPlace: (uuid: Uuid, cell: TileCell) => void;
	readonly onPlaceUnplaced: (uuid: Uuid) => void;
	readonly onApplyPreset: (preset: TilePresetId) => void;
	readonly onPersistOnFormsChange: (persist: boolean) => void;
	readonly onGroupingChange: (next: CaseTileGrouping | undefined) => void;
}

export function TileLayoutCanvas({
	config,
	tile,
	caseType,
	appId,
	selectedUuid,
	issues,
	canEdit,
	onSelect,
	onPlace,
	onPlaceUnplaced,
	onApplyPreset,
	onPersistOnFormsChange,
	onGroupingChange,
}: TileLayoutCanvasProps) {
	const memberCount = tileMemberUuids(config).length;
	const { placed } = tileMembership(config);
	const current =
		placed.length === memberCount
			? matchingTilePreset(placed.map((entry) => entry.cell))
			: null;

	return (
		<div className="space-y-4">
			{canEdit && (
				<div className="flex justify-end">
					<PresetMenu
						memberCount={memberCount}
						current={current}
						onApply={onApplyPreset}
					/>
				</div>
			)}

			<TileGridEditor
				config={config}
				selectedUuid={selectedUuid}
				issues={issues}
				canEdit={canEdit}
				onSelect={onSelect}
				onPlace={onPlace}
				onPlaceUnplaced={onPlaceUnplaced}
			/>

			{canEdit && (
				<ToggleRow
					label="Keep the tile on screen during forms"
					description="Workers see the case they picked above every question in this module."
					checked={tile.persistOnForms === true}
					onChange={onPersistOnFormsChange}
				/>
			)}

			{canEdit && (
				<TileGroupingSection
					config={config}
					tile={tile}
					caseType={caseType}
					appId={appId}
					onGroupingChange={onGroupingChange}
				/>
			)}
		</div>
	);
}

function PresetMenu({
	memberCount,
	current,
	onApply,
}: {
	readonly memberCount: number;
	readonly current: TilePresetId | null;
	readonly onApply: (preset: TilePresetId) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Start from a layout"
				className="flex min-h-11 items-center gap-2 rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 text-[14px] text-nova-text transition-colors hover:border-nova-violet/30"
			>
				<Icon
					icon={tablerLayoutBoard}
					width="15"
					height="15"
					className="shrink-0 text-nova-violet-bright"
				/>
				<span>Start from a layout</span>
				<Icon
					icon={tablerChevronDown}
					aria-hidden="true"
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" sideOffset={4} preferredMinWidth="20rem">
				{TILE_PRESETS.map((preset) => {
					const unavailable = tilePresetUnavailableReason(preset, memberCount);
					const isCurrent = preset.id === current;
					return (
						<DropdownMenuItem
							key={preset.id}
							onClick={() => onApply(preset.id)}
							disabled={unavailable !== undefined || isCurrent}
							className={`${CONSOLE_MENU_ITEM_CLS} ${
								isCurrent ? "bg-nova-violet/10 text-nova-violet-bright" : ""
							}`}
						>
							<span className="min-w-0 flex-1 text-left">
								<span className="block whitespace-normal break-words">
									{preset.label}
								</span>
								<span
									className={`block whitespace-normal break-words text-[13px] leading-5 ${
										isCurrent
											? "text-nova-violet-bright"
											: "text-nova-text-muted"
									}`}
								>
									{unavailable ?? preset.description}
								</span>
							</span>
							{isCurrent && (
								<Icon
									icon={tablerCheck}
									width="14"
									height="14"
									className="shrink-0 text-nova-violet-bright"
								/>
							)}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
