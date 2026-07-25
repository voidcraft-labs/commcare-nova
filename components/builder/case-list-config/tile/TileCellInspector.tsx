// components/builder/case-list-config/tile/TileCellInspector.tsx
//
// One field's place on the tile, and how it looks there.
//
// The presentation controls appear only for a field that HOLDS a place.
// CommCare's `<style>` element cannot exist without a complete `<grid>`
// child, so alignment, text size, border, and shading have no wire
// spelling at all for an unplaced field — offering them would be an
// affordance with nothing to write.
//
// Two runtime facts this surface states rather than hides:
//
//   - A border or shading is ONE setting for the whole tile. Turning
//     either on for one field changes how every field on the tile is
//     spaced, and a field inside a box stops honoring its own alignment.
//   - An absent text size means the cell INHERITS the list's size. There
//     is no "medium" default at runtime, so the control offers
//     inheriting as a real choice instead of pretending to a default.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerLayoutGrid from "@iconify-icons/tabler/layout-grid";
import { useId, useState } from "react";
import {
	INSPECTOR_INPUT_CLS,
	INSPECTOR_LABEL_CLS,
	InspectorHint,
	InspectorSection,
	SegmentedRow,
	ToggleRow,
} from "@/components/builder/inspector/inspectorChrome";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	type Column,
	TILE_GRID_COLUMNS,
	TILE_GRID_ROWS,
	type TileCell,
	type TileFontSize,
	type TileHorizontalAlign,
	type TileVerticalAlign,
} from "@/lib/domain";
import { projectTileGrid } from "@/lib/preview/caseTileLayout";
import {
	describeTilePlace,
	planColumnTilePlacement,
	type TileGeometry,
	tileMemberUuids,
	tileParticipation,
} from "./tileModel";

export interface TileCellInspectorProps {
	readonly column: Column;
	/** Every case-list column — the tile's members are what a placement
	 *  is adjudicated against. */
	readonly columns: readonly Column[];
	/** Whether the case list is currently laid out as a tile. */
	readonly tileOn: boolean;
	/** This field's tile problems, in the words the canvas shows. */
	readonly issues: readonly string[];
	readonly canEdit: boolean;
	readonly onPlace: (cell: TileCell) => void;
	readonly onClearPlace: () => void;
	readonly onPutOnTile: () => void;
}

/** Nova's authoring word for "no text size", which the runtime honors as
 *  "use the list's size". */
const INHERIT_FONT_SIZE = "inherit" as const;
type FontSizeChoice = TileFontSize | typeof INHERIT_FONT_SIZE;

export function TileCellInspector({
	column,
	columns,
	tileOn,
	issues,
	canEdit,
	onPlace,
	onClearPlace,
	onPutOnTile,
}: TileCellInspectorProps) {
	const role = tileParticipation(column);
	const cell = column.tile;

	if (tileOn && role !== null && cell === undefined) {
		return (
			<InspectorSection label="Place on the tile">
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{role === "order-only"
						? "This field sets the default order, so the tile still carries it — a tile can’t hide a field. Give it a place, or take it out of the default order."
						: "This field is shown in Results but has no place on the tile yet."}
				</p>
				{canEdit && (
					<Button
						type="button"
						variant="outline"
						size="xl"
						onClick={onPutOnTile}
						className="min-h-11 w-full gap-2 rounded-lg border-white/[0.10] bg-transparent px-3 text-[14px] dark:bg-transparent"
					>
						<Icon icon={tablerLayoutGrid} width="15" height="15" />
						Put it on the tile
					</Button>
				)}
			</InspectorSection>
		);
	}

	if (cell === undefined) return null;

	const drawnOnTile = tileOn && role !== null;
	if (!drawnOnTile) {
		return (
			<SavedPlaceSection
				column={column}
				columns={columns}
				cell={cell}
				issues={issues}
				canEdit={canEdit}
				explanation={
					tileOn
						? "This field is hidden from Results, so it isn’t on the tile. Its saved place comes back if you show it in Results again."
						: "Results shows rows right now. This place is used whenever the tile is on."
				}
				onPlace={onPlace}
				onClearPlace={onClearPlace}
			/>
		);
	}

	const members = new Set(tileMemberUuids(columns));
	const projection = projectTileGrid(
		columns.filter(
			(candidate) =>
				members.has(candidate.uuid) && candidate.tile !== undefined,
		),
	);
	const mode =
		projection.cells.find((entry) => entry.columnUuid === column.uuid)?.mode ??
		"flow";

	return (
		<>
			<InspectorSection label="Place on the tile">
				<PlacementFields
					column={column}
					columns={columns}
					cell={cell}
					canEdit={canEdit}
					onPlace={onPlace}
				/>
				{issues.length > 0 && <TileIssueList issues={issues} />}
			</InspectorSection>

			<InspectorSection label="How it looks">
				<div className="space-y-2">
					<span className={INSPECTOR_LABEL_CLS}>Across</span>
					<SegmentedRow<TileHorizontalAlign>
						legend="Horizontal position inside the square"
						value={cell.horizontalAlign ?? "left"}
						options={[
							{ value: "left", label: "Left" },
							{ value: "center", label: "Center" },
							{ value: "right", label: "Right" },
						]}
						onChange={(horizontalAlign) =>
							onPlace({ ...cell, horizontalAlign })
						}
					/>
				</div>
				<div className="space-y-2">
					<span className={INSPECTOR_LABEL_CLS}>Down</span>
					<SegmentedRow<TileVerticalAlign>
						legend="Vertical position inside the square"
						value={cell.verticalAlign ?? "top"}
						options={[
							{ value: "top", label: "Top" },
							{ value: "middle", label: "Middle" },
							{ value: "bottom", label: "Bottom" },
						]}
						onChange={(verticalAlign) => onPlace({ ...cell, verticalAlign })}
					/>
				</div>
				{mode === "boxed" && (
					<InspectorHint>
						This field fills its box, so its position inside the square doesn’t
						change how it looks.
					</InspectorHint>
				)}

				<div className="space-y-2">
					<span className={INSPECTOR_LABEL_CLS}>Text size</span>
					<SegmentedRow<FontSizeChoice>
						legend="Text size for this field"
						value={cell.fontSize ?? INHERIT_FONT_SIZE}
						options={[
							{ value: INHERIT_FONT_SIZE, label: "Same as list" },
							{ value: "small", label: "Small" },
							{ value: "medium", label: "Medium" },
							{ value: "large", label: "Large" },
						]}
						onChange={(choice) => {
							if (choice === INHERIT_FONT_SIZE) {
								const { fontSize: _cleared, ...rest } = cell;
								onPlace(rest);
								return;
							}
							onPlace({ ...cell, fontSize: choice });
						}}
					/>
					<InspectorHint>
						Same as list keeps this field at whatever size the case list uses.
					</InspectorHint>
				</div>

				<ToggleRow
					label="Border"
					checked={cell.showBorder === true}
					onChange={(showBorder) => {
						if (showBorder) {
							onPlace({ ...cell, showBorder: true });
							return;
						}
						const { showBorder: _cleared, ...rest } = cell;
						onPlace(rest);
					}}
				/>
				<ToggleRow
					label="Shading"
					checked={cell.showShading === true}
					onChange={(showShading) => {
						if (showShading) {
							onPlace({ ...cell, showShading: true });
							return;
						}
						const { showShading: _cleared, ...rest } = cell;
						onPlace(rest);
					}}
				/>
				<InspectorHint>
					{mode === "boxed"
						? "A border or shading is one setting for the whole tile. Every other field on this tile is spaced to line up with this one."
						: mode === "inset"
							? "Another field on this tile uses a border or shading. A border or shading is one setting for the whole tile, so this field is spaced to line up with it."
							: "A border or shading is one setting for the whole tile. Turning either on changes the spacing of every field on this tile."}
				</InspectorHint>
			</InspectorSection>
		</>
	);
}

function SavedPlaceSection({
	column,
	columns,
	cell,
	issues,
	canEdit,
	explanation,
	onPlace,
	onClearPlace,
}: {
	readonly column: Column;
	readonly columns: readonly Column[];
	readonly cell: TileCell;
	readonly issues: readonly string[];
	readonly canEdit: boolean;
	readonly explanation: string;
	readonly onPlace: (cell: TileCell) => void;
	readonly onClearPlace: () => void;
}) {
	return (
		<InspectorSection label="Saved tile place">
			<p className="text-[13px] leading-relaxed text-nova-text-secondary">
				{explanation}
			</p>
			{issues.length === 0 ? (
				<p className="text-[14px] text-nova-text">{describeTilePlace(cell)}</p>
			) : (
				<>
					<TileIssueList issues={issues} />
					<PlacementFields
						column={column}
						columns={columns}
						cell={cell}
						canEdit={canEdit}
						onPlace={onPlace}
					/>
					{canEdit && (
						<Button
							type="button"
							variant="outline"
							size="xl"
							onClick={onClearPlace}
							className="min-h-11 w-full rounded-lg border-white/[0.10] bg-transparent px-3 text-[14px] dark:bg-transparent"
						>
							Remove the saved place
						</Button>
					)}
				</>
			)}
		</InspectorSection>
	);
}

function TileIssueList({ issues }: { readonly issues: readonly string[] }) {
	return (
		<ul className="list-none space-y-1.5 p-0">
			{issues.map((issue) => (
				<li
					key={issue}
					className="flex items-start gap-2 text-[13px] leading-relaxed text-nova-rose"
				>
					<Icon
						icon={tablerAlertCircle}
						width="15"
						height="15"
						className="mt-0.5 shrink-0"
					/>
					<span>{issue}</span>
				</li>
			))}
		</ul>
	);
}

/**
 * The exact numbers behind a place. Every field drafts locally and
 * commits on blur or Enter, so ordinary typing never bounces off a
 * refusal mid-keystroke; a refused value stays on screen with its reason
 * so it can be corrected rather than silently reverted.
 */
function PlacementFields({
	column,
	columns,
	cell,
	canEdit,
	onPlace,
}: {
	readonly column: Column;
	readonly columns: readonly Column[];
	readonly cell: TileCell;
	readonly canEdit: boolean;
	readonly onPlace: (next: TileCell) => void;
}) {
	const [refusal, setRefusal] = useState<string | null>(null);

	const commit = (patch: Partial<TileGeometry>): boolean => {
		const verdict = planColumnTilePlacement({
			columns,
			column,
			geometry: {
				x: cell.x,
				y: cell.y,
				width: cell.width,
				height: cell.height,
				...patch,
			},
		});
		if (!verdict.ok) {
			setRefusal(verdict.reason);
			return false;
		}
		setRefusal(null);
		onPlace(verdict.cell);
		return true;
	};

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-2 gap-2">
				<NumberField
					label="Column"
					value={cell.x + 1}
					max={TILE_GRID_COLUMNS}
					disabled={!canEdit}
					onCommit={(next) => commit({ x: next - 1 })}
				/>
				<NumberField
					label="Row"
					value={cell.y + 1}
					max={TILE_GRID_ROWS}
					disabled={!canEdit}
					onCommit={(next) => commit({ y: next - 1 })}
				/>
				<NumberField
					label="Columns wide"
					value={cell.width}
					max={TILE_GRID_COLUMNS}
					disabled={!canEdit}
					onCommit={(next) => commit({ width: next })}
				/>
				<NumberField
					label="Rows tall"
					value={cell.height}
					max={TILE_GRID_ROWS}
					disabled={!canEdit}
					onCommit={(next) => commit({ height: next })}
				/>
			</div>
			{refusal !== null && (
				<p className="flex items-start gap-2 text-[13px] leading-relaxed text-nova-rose">
					<Icon
						icon={tablerAlertCircle}
						width="15"
						height="15"
						className="mt-0.5 shrink-0"
					/>
					<span>{refusal}</span>
				</p>
			)}
		</div>
	);
}

function NumberField({
	label,
	value,
	max,
	disabled,
	onCommit,
}: {
	readonly label: string;
	readonly value: number;
	readonly max: number;
	readonly disabled: boolean;
	/** Returns whether the value was accepted; a refusal keeps the draft
	 *  so the author can correct it. */
	readonly onCommit: (next: number) => boolean;
}) {
	const id = useId();
	const [draft, setDraft] = useState<string | null>(null);

	const settle = () => {
		if (draft === null) return;
		const parsed = Number(draft.trim());
		if (!Number.isInteger(parsed)) {
			setDraft(null);
			return;
		}
		if (onCommit(parsed)) setDraft(null);
	};

	return (
		<div className="space-y-1.5">
			<label htmlFor={id} className={`block ${INSPECTOR_LABEL_CLS}`}>
				{label}
			</label>
			<Input
				id={id}
				type="text"
				inputMode="numeric"
				autoComplete="off"
				data-1p-ignore
				disabled={disabled}
				aria-describedby={undefined}
				value={draft ?? String(value)}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={settle}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						settle();
						return;
					}
					if (event.key === "Escape") setDraft(null);
				}}
				className={`${INSPECTOR_INPUT_CLS} h-11`}
				aria-label={`${label}, 1 to ${max}`}
			/>
		</div>
	);
}
