// components/builder/case-list-config/tile/TileGridEditor.tsx
//
// The tile's arrangement, drawn where its effect is visible. Each field
// is a rectangle on a 12 x 12 grid: drag it to move, drag its corner to
// resize, or use the arrow keys — Shift with an arrow moves the edge the
// arrow points at.
//
// Two things this surface refuses to fake:
//
//   - **A refusal is stated, never a snap-back.** While a drag is over a
//     square it can't have, the field stays at the last place it could
//     hold and the reason is on screen; releasing there changes nothing
//     and leaves the reason up.
//   - **The tile is not the canvas.** A worker's device sizes the tile
//     from the squares the fields actually occupy and stretches that to
//     the full width of the list, so the occupied region is drawn as the
//     tile and the rest of the 12 x 12 canvas is drawn as room to grow.
//     Cell geometry comes from `lib/preview/caseTileLayout`, the one
//     projection the running list reads, so the two can never disagree.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerCornerRightDown from "@iconify-icons/tabler/corner-right-down";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	type Column,
	TILE_GRID_COLUMNS,
	TILE_GRID_ROWS,
	type TileCell,
	tileCellBottomEdge,
	tileCellRightEdge,
	type Uuid,
} from "@/lib/domain";
import {
	projectTileGrid,
	tileCellGridArea,
} from "@/lib/preview/caseTileLayout";
import {
	describeTileCell,
	describeTilePlace,
	planTileKeyboardGesture,
	planTilePlacement,
	type TileGeometry,
	type TilePlacement,
	tileKeyboardGesture,
	tileMembership,
} from "./tileModel";

export interface TileGridEditorProps {
	readonly columns: readonly Column[];
	readonly selectedUuid: string | null;
	/** Tile problems, keyed by field, in the words the canvas shows. */
	readonly issues: ReadonlyMap<Uuid, readonly string[]>;
	readonly canEdit: boolean;
	readonly onSelect: (uuid: Uuid) => void;
	readonly onPlace: (uuid: Uuid, cell: TileCell) => void;
	readonly onPlaceUnplaced: (uuid: Uuid) => void;
}

interface DragState {
	readonly uuid: Uuid;
	readonly mode: "move" | "resize";
	readonly pointerId: number;
	readonly startX: number;
	readonly startY: number;
	readonly origin: TileCell;
	/** The last placement the tile could actually hold. */
	readonly cell: TileCell;
	readonly refusal: string | null;
}

export function TileGridEditor({
	columns,
	selectedUuid,
	issues,
	canEdit,
	onSelect,
	onPlace,
	onPlaceUnplaced,
}: TileGridEditorProps) {
	const gridRef = useRef<HTMLFieldSetElement>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");

	const { placed, unplaced } = tileMembership(columns);
	// A place outside the grid can't be drawn on it — CSS would grow
	// implicit tracks and the canvas would stop being 12 x 12. Those
	// fields move to the attention strip below, where their reason and
	// their repair are both reachable.
	const drawable = placed.filter(
		(entry) =>
			tileCellRightEdge(entry.cell) <= TILE_GRID_COLUMNS &&
			tileCellBottomEdge(entry.cell) <= TILE_GRID_ROWS,
	);
	const offGrid = placed.filter((entry) => !drawable.includes(entry));
	const drawableUuids = new Set(drawable.map((entry) => entry.uuid));
	const extent = projectTileGrid(
		[...columns].filter((column) => drawableUuids.has(column.uuid)),
	);
	const needsAPlace: ReadonlyArray<{
		readonly uuid: Uuid;
		readonly label: string;
		readonly reason: string | undefined;
	}> = [
		...offGrid.map((entry) => ({
			uuid: entry.uuid,
			label: entry.label,
			reason: issues.get(entry.uuid)?.[0],
		})),
		...unplaced.map((entry) => ({ ...entry, reason: undefined })),
	];

	const gridGeometry = () => {
		const rect = gridRef.current?.getBoundingClientRect();
		if (rect === undefined || rect.width === 0 || rect.height === 0)
			return null;
		return {
			columnStep: rect.width / TILE_GRID_COLUMNS,
			rowStep: rect.height / TILE_GRID_ROWS,
		};
	};

	const beginDrag = (
		event: React.PointerEvent<HTMLElement>,
		placement: TilePlacement,
		mode: DragState["mode"],
	) => {
		if (!canEdit || event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		setRefusal(null);
		setDrag({
			uuid: placement.uuid,
			mode,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			origin: placement.cell,
			cell: placement.cell,
			refusal: null,
		});
	};

	const continueDrag = (event: React.PointerEvent<HTMLElement>) => {
		if (drag === null || event.pointerId !== drag.pointerId) return;
		const geometry = gridGeometry();
		if (geometry === null) return;
		const deltaColumns = Math.round(
			(event.clientX - drag.startX) / geometry.columnStep,
		);
		const deltaRows = Math.round(
			(event.clientY - drag.startY) / geometry.rowStep,
		);
		const candidate: TileGeometry =
			drag.mode === "move"
				? {
						x: drag.origin.x + deltaColumns,
						y: drag.origin.y + deltaRows,
						width: drag.origin.width,
						height: drag.origin.height,
					}
				: {
						x: drag.origin.x,
						y: drag.origin.y,
						width: drag.origin.width + deltaColumns,
						height: drag.origin.height + deltaRows,
					};
		const verdict = planTilePlacement(placed, drag.uuid, candidate);
		if (verdict.ok) {
			if (sameGeometry(verdict.cell, drag.cell) && drag.refusal === null)
				return;
			setDrag({ ...drag, cell: verdict.cell, refusal: null });
			return;
		}
		if (verdict.reason === drag.refusal) return;
		setDrag({ ...drag, refusal: verdict.reason });
	};

	const endDrag = (event: React.PointerEvent<HTMLElement>) => {
		if (drag === null || event.pointerId !== drag.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		const settled = drag;
		setDrag(null);
		const label =
			placed.find((entry) => entry.uuid === settled.uuid)?.label ?? "The field";
		if (!sameGeometry(settled.cell, settled.origin)) {
			onPlace(settled.uuid, settled.cell);
			setRefusal(null);
			setAnnouncement(`${label} is now at ${describeTilePlace(settled.cell)}`);
			return;
		}
		if (settled.refusal !== null) {
			setRefusal(settled.refusal);
			setAnnouncement(settled.refusal);
		}
	};

	const applyKeyboardGesture = (
		event: React.KeyboardEvent<HTMLElement>,
		placement: TilePlacement,
		forceResize: boolean,
	) => {
		const gesture = tileKeyboardGesture(
			event.key,
			forceResize ? true : event.shiftKey,
		);
		if (gesture === null) return;
		event.preventDefault();
		if (!canEdit) return;
		const verdict = planTileKeyboardGesture(placed, placement.uuid, gesture);
		if (!verdict.ok) {
			setRefusal(verdict.reason);
			setAnnouncement(verdict.reason);
			return;
		}
		setRefusal(null);
		onPlace(placement.uuid, verdict.cell);
		setAnnouncement(
			`${placement.label} is now at ${describeTilePlace(verdict.cell)}`,
		);
	};

	return (
		<div data-tile-grid-editor>
			<p
				className="sr-only"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{announcement}
			</p>

			<div className="overflow-x-auto overscroll-x-contain [scrollbar-gutter:auto]">
				{/* A fieldset: the grid is one labelled group of the tile's own
				 * controls. The minimum width keeps every square at a real
				 * pointer target on a handset, where the group scrolls sideways
				 * instead of shrinking below it. */}
				<fieldset
					ref={gridRef}
					className="relative m-0 grid min-w-[34rem] rounded-xl border border-white/[0.07] bg-nova-deep/40 p-0 [--tile-row-height:2.75rem] @[52rem]:[--tile-row-height:3rem]"
					style={{
						gridTemplateColumns: `repeat(${TILE_GRID_COLUMNS}, minmax(0, 1fr))`,
						gridTemplateRows: `repeat(${TILE_GRID_ROWS}, var(--tile-row-height))`,
						backgroundImage: `linear-gradient(to right, var(--nova-border) 1px, transparent 1px), linear-gradient(to bottom, var(--nova-border) 1px, transparent 1px)`,
						backgroundSize: `calc(100% / ${TILE_GRID_COLUMNS}) calc(100% / ${TILE_GRID_ROWS})`,
					}}
				>
					<legend className="sr-only">
						{`Tile layout, ${TILE_GRID_COLUMNS} columns by ${TILE_GRID_ROWS} rows`}
					</legend>
					{extent.columns > 0 && extent.rows > 0 && (
						<div
							aria-hidden="true"
							className="pointer-events-none rounded-lg ring-1 ring-inset ring-nova-violet/25"
							style={{
								gridArea: `1 / 1 / ${extent.rows + 1} / ${extent.columns + 1}`,
							}}
						/>
					)}

					{drawable.map((placement) => {
						const dragging = drag?.uuid === placement.uuid;
						const cell = dragging ? drag.cell : placement.cell;
						const selected = selectedUuid === placement.uuid;
						const problems = issues.get(placement.uuid) ?? [];
						return (
							<TileCellChip
								key={placement.uuid}
								placement={placement}
								cell={cell}
								selected={selected}
								dragging={dragging}
								broken={problems.length > 0}
								canEdit={canEdit}
								onSelect={() => onSelect(placement.uuid)}
								onPointerDown={(event) => beginDrag(event, placement, "move")}
								onPointerMove={continueDrag}
								onPointerUp={endDrag}
								onPointerCancel={endDrag}
								onKeyDown={(event) =>
									applyKeyboardGesture(event, placement, false)
								}
							/>
						);
					})}

					{canEdit &&
						drawable
							.filter((placement) => placement.uuid === selectedUuid)
							.map((placement) => {
								const cell =
									drag?.uuid === placement.uuid ? drag.cell : placement.cell;
								return (
									<button
										key={`resize:${placement.uuid}`}
										type="button"
										aria-label={`Resize ${placement.label}. Currently ${describeTilePlace(cell)}. Drag, or use the arrow keys.`}
										aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
										onPointerDown={(event) =>
											beginDrag(event, placement, "resize")
										}
										onPointerMove={continueDrag}
										onPointerUp={endDrag}
										onPointerCancel={endDrag}
										onKeyDown={(event) =>
											applyKeyboardGesture(event, placement, true)
										}
										className="z-20 flex size-11 translate-x-1/2 translate-y-1/2 cursor-nwse-resize items-center justify-center self-end justify-self-end rounded-full text-nova-void [touch-action:none]"
										style={{ gridArea: tileCellGridArea(cell) }}
									>
										<span className="flex size-6 items-center justify-center rounded-full bg-nova-violet-bright shadow-[0_1px_6px_rgba(0,0,0,0.45)]">
											<Icon
												icon={tablerCornerRightDown}
												width="14"
												height="14"
											/>
										</span>
									</button>
								);
							})}
				</fieldset>
			</div>

			<div className="mt-3 space-y-2" aria-live="polite">
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
				{offGrid.length === 0 && (
					<p className="text-[13px] leading-relaxed text-nova-text-muted">
						{extent.columns === 0
							? "Nothing is placed on the tile yet."
							: `This tile uses ${describeExtent(extent.columns, extent.rows)}. On a worker’s screen it fills the full width of the list, however many columns it uses.`}
					</p>
				)}
				{canEdit && (
					<p className="text-[13px] leading-relaxed text-nova-text-muted">
						Drag a field to move it, or drag the round handle to resize it. With
						a field focused, the arrow keys move it and Shift with an arrow key
						moves its edge.
					</p>
				)}
			</div>

			{needsAPlace.length > 0 && (
				<div className="mt-4 rounded-xl border border-nova-rose/35 bg-nova-rose/[0.04] p-3">
					<p className="text-[14px] font-medium text-nova-text">
						{needsAPlace.length === 1
							? "One field needs a place on the tile"
							: `${needsAPlace.length} fields need a place on the tile`}
					</p>
					<p className="mt-1 text-[13px] leading-relaxed text-nova-text-secondary">
						A tile can’t hide a field. Anything the case list carries lands
						wherever the grid has room until it sits inside it.
					</p>
					<ul className="mt-3 list-none space-y-2 p-0">
						{needsAPlace.map((entry) => (
							<li
								key={entry.uuid}
								className="flex flex-wrap items-center justify-between gap-2"
							>
								<span className="min-w-0 flex-1 break-words text-[14px] text-nova-text">
									{entry.label}
									{entry.reason !== undefined && (
										<span className="mt-0.5 block text-[13px] leading-relaxed text-nova-text-secondary">
											{entry.reason}
										</span>
									)}
								</span>
								{canEdit && (
									<Button
										type="button"
										variant="outline"
										size="xl"
										onClick={() => onPlaceUnplaced(entry.uuid)}
										className="min-h-11 gap-2 rounded-lg border-white/[0.10] bg-transparent px-3 text-[14px] dark:bg-transparent"
									>
										<Icon icon={tablerPlus} width="14" height="14" />
										{entry.reason === undefined
											? "Put it on the tile"
											: "Move it onto the tile"}
									</Button>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function TileCellChip({
	placement,
	cell,
	selected,
	dragging,
	broken,
	canEdit,
	onSelect,
	onPointerDown,
	onPointerMove,
	onPointerUp,
	onPointerCancel,
	onKeyDown,
}: {
	readonly placement: TilePlacement;
	readonly cell: TileCell;
	readonly selected: boolean;
	readonly dragging: boolean;
	readonly broken: boolean;
	readonly canEdit: boolean;
	readonly onSelect: () => void;
	readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
	readonly onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
	readonly onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
	readonly onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
	readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}) {
	const tone = broken
		? "border-nova-rose/50 bg-nova-rose/[0.10]"
		: selected
			? "border-nova-violet bg-nova-violet/[0.16]"
			: "border-white/[0.12] bg-nova-surface/70";

	const body = (
		<span className="flex min-w-0 items-center gap-1.5">
			{broken && (
				<Icon
					icon={tablerAlertCircle}
					width="14"
					height="14"
					className="shrink-0 text-nova-rose"
				/>
			)}
			<span className="min-w-0 break-words [overflow-wrap:anywhere]">
				{placement.label}
			</span>
		</span>
	);

	const className = `m-0.5 flex items-center overflow-hidden rounded-lg border px-2 text-left text-[13px] leading-tight text-nova-text transition-colors motion-reduce:transition-none ${tone} ${
		dragging ? "z-10 shadow-lg" : ""
	} ${canEdit ? "cursor-grab [touch-action:none] active:cursor-grabbing" : ""}`;

	if (!canEdit) {
		// A viewer's cell is content, not a control, so its place is read
		// out beside the visible label rather than replacing it.
		return (
			<div className={className} style={{ gridArea: tileCellGridArea(cell) }}>
				{body}
				<span className="sr-only">{describeTilePlace(cell)}</span>
			</div>
		);
	}

	return (
		<button
			type="button"
			data-case-column-select={placement.uuid}
			data-tile-cell={placement.uuid}
			aria-pressed={selected}
			aria-label={describeTileCell(placement.label, cell)}
			aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight"
			onClick={onSelect}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			onKeyDown={onKeyDown}
			className={`${className} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nova-violet`}
			style={{ gridArea: tileCellGridArea(cell) }}
		>
			{body}
		</button>
	);
}

function describeExtent(columns: number, rows: number): string {
	const columnWords = columns === 1 ? "1 column" : `${columns} columns`;
	const rowWords = rows === 1 ? "1 row" : `${rows} rows`;
	return `${columnWords} and ${rowWords}`;
}

function sameGeometry(a: TileCell, b: TileCell): boolean {
	return (
		a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
	);
}
