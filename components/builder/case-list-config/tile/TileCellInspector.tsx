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
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerLayoutGrid from "@iconify-icons/tabler/layout-grid";
import { useEffect, useId, useRef, useState } from "react";
import {
	CONSOLE_MENU_ITEM_CLS,
	CONSOLE_TRIGGER_CLS,
	INSPECTOR_INPUT_CLS,
	INSPECTOR_LABEL_CLS,
	InspectorHint,
	InspectorSection,
	SegmentedRow,
	ToggleRow,
} from "@/components/builder/inspector/inspectorChrome";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { Input } from "@/components/shadcn/input";
import {
	type CaseListConfig,
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
	tileShowsColumn,
} from "./tileModel";

export interface TileCellInspectorProps {
	readonly column: Column;
	/** Every case-list column — the tile's members are what a placement
	 *  is adjudicated against. */
	readonly config: CaseListConfig;
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
	config,
	tileOn,
	issues,
	canEdit,
	onPlace,
	onClearPlace,
	onPutOnTile,
}: TileCellInspectorProps) {
	const onTile = tileShowsColumn(column);
	const cell = column.tile;
	/* Placing a field replaces this whole branch with the editor below, so
	 * the button that did it unmounts. The first exact-place input is the
	 * successor; without this, focus lands on the page. */
	const [focusPlaceOnMount, setFocusPlaceOnMount] = useState(false);

	if (tileOn && onTile && cell === undefined) {
		return (
			<InspectorSection label="Place on the tile">
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					This field is shown in Results but has no place on the tile yet.
				</p>
				{canEdit && (
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							setFocusPlaceOnMount(true);
							onPutOnTile();
						}}
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

	const drawnOnTile = tileOn && onTile;
	if (!drawnOnTile) {
		return (
			<SavedPlaceSection
				column={column}
				config={config}
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

	const members = new Set(tileMemberUuids(config));
	const projection = projectTileGrid(
		config.columns.filter(
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
					config={config}
					cell={cell}
					canEdit={canEdit}
					autoFocus={focusPlaceOnMount}
					onPlace={onPlace}
				/>
				{issues.length > 0 && <TileIssueList issues={issues} />}
			</InspectorSection>

			<InspectorSection label="How it looks">
				{/* A viewer READS this cell's presentation. Live controls would
				 * bounce off the data backstop, which reads as a broken app. */}
				{!canEdit && (
					<p className="text-[14px] leading-relaxed text-nova-text">
						{describeTilePresentation(cell)}
					</p>
				)}
				{canEdit && (
					<>
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
								onChange={(verticalAlign) =>
									onPlace({ ...cell, verticalAlign })
								}
							/>
						</div>
						{mode === "boxed" && (
							<InspectorHint>
								This field fills its box, so its position inside the square
								doesn’t change how it looks.
							</InspectorHint>
						)}

						<div className="space-y-2">
							<span className={INSPECTOR_LABEL_CLS}>Text size</span>
							<TextSizePicker
								value={cell.fontSize ?? INHERIT_FONT_SIZE}
								onChange={(choice) => {
									if (choice === INHERIT_FONT_SIZE) {
										const { fontSize: _cleared, ...rest } = cell;
										onPlace(rest);
										return;
									}
									onPlace({ ...cell, fontSize: choice });
								}}
							/>
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
					</>
				)}
			</InspectorSection>
		</>
	);
}

function SavedPlaceSection({
	column,
	config,
	cell,
	issues,
	canEdit,
	explanation,
	onPlace,
	onClearPlace,
}: {
	readonly column: Column;
	readonly config: CaseListConfig;
	readonly cell: TileCell;
	readonly issues: readonly string[];
	readonly canEdit: boolean;
	readonly explanation: string;
	readonly onPlace: (cell: TileCell) => void;
	readonly onClearPlace: () => void;
}) {
	/* Editing is unconditional, not gated on a current finding. A saved cell
	 * off the tile is invisible to `tileLayoutIssues` — that walk only checks
	 * columns the tile SHOWS — so a cell that would collide the moment this
	 * field came back reports nothing, and hiding the controls behind a
	 * finding leaves the author no way to move it before revealing. */
	return (
		<InspectorSection label="Saved tile place">
			<p className="text-[13px] leading-relaxed text-nova-text-secondary">
				{explanation}
			</p>
			{issues.length > 0 && <TileIssueList issues={issues} />}
			{canEdit ? (
				<>
					<PlacementFields
						column={column}
						config={config}
						cell={cell}
						canEdit={canEdit}
						onPlace={onPlace}
					/>
					<Button
						type="button"
						variant="outline"
						onClick={onClearPlace}
						className="min-h-11 w-full rounded-lg border-white/[0.10] bg-transparent px-3 text-[14px] dark:bg-transparent"
					>
						Remove the saved place
					</Button>
				</>
			) : (
				<p className="text-[14px] text-nova-text">{describeTilePlace(cell)}</p>
			)}
		</InspectorSection>
	);
}

/**
 * Text size, with inheriting the list's size as a real first choice.
 *
 * A menu rather than a segmented row because the honest name for an
 * absent size is a phrase, not a word, and four segments in a 300px rail
 * would clip it. The runtime has no `medium` fallback — an absent size
 * produces an empty declaration the browser discards — so presenting one
 * of the three sizes as the default would be a lie.
 */
function TextSizePicker({
	value,
	onChange,
}: {
	readonly value: FontSizeChoice;
	readonly onChange: (next: FontSizeChoice) => void;
}) {
	const current = TEXT_SIZE_CHOICES.find((choice) => choice.value === value);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Text size: ${current?.label ?? "Same as the list"}`}
				className={CONSOLE_TRIGGER_CLS}
			>
				<span className="min-w-0 flex-1 text-left">
					<span className="block text-nova-text">{current?.label}</span>
					<span className="block whitespace-normal break-words text-[13px] leading-5 text-nova-text-muted">
						{current?.description}
					</span>
				</span>
				<Icon
					icon={tablerChevronDown}
					aria-hidden="true"
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				sideOffset={4}
				preferredMinWidth="17rem"
			>
				{TEXT_SIZE_CHOICES.map((choice) => (
					<DropdownMenuItem
						key={choice.value}
						onClick={() => onChange(choice.value)}
						disabled={choice.value === value}
						className={`${CONSOLE_MENU_ITEM_CLS} ${
							choice.value === value
								? "bg-nova-violet/10 text-nova-violet-bright"
								: ""
						}`}
					>
						<span className="min-w-0 flex-1 text-left">
							<span className="block whitespace-normal break-words">
								{choice.label}
							</span>
							<span
								className={`block whitespace-normal break-words text-[13px] leading-5 ${
									choice.value === value
										? "text-nova-violet-bright"
										: "text-nova-text-muted"
								}`}
							>
								{choice.description}
							</span>
						</span>
						{choice.value === value && (
							<Icon
								icon={tablerCheck}
								width="14"
								height="14"
								className="shrink-0 text-nova-violet-bright"
							/>
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A cell's presentation in one sentence, for a reader with no controls. */
function describeTilePresentation(cell: TileCell): string {
	const across = { left: "Left", center: "Centred", right: "Right" }[
		cell.horizontalAlign ?? "left"
	];
	const down = { top: "top", middle: "middle", bottom: "bottom" }[
		cell.verticalAlign ?? "top"
	];
	const size =
		cell.fontSize === undefined
			? "the same text size as the list"
			: `${cell.fontSize} text`;
	const box =
		cell.showBorder === true && cell.showShading === true
			? "a border and shading"
			: cell.showBorder === true
				? "a border"
				: cell.showShading === true
					? "shading"
					: "no border or shading";
	return `${across}, ${down}, ${size}, ${box}.`;
}

const TEXT_SIZE_CHOICES: ReadonlyArray<{
	readonly value: FontSizeChoice;
	readonly label: string;
	readonly description: string;
}> = [
	{
		value: INHERIT_FONT_SIZE,
		label: "Same as the list",
		description: "Whatever size the case list already uses",
	},
	{ value: "small", label: "Small", description: "Quieter than the list" },
	{ value: "medium", label: "Medium", description: "A standard size" },
	{ value: "large", label: "Large", description: "Stands out on the tile" },
];

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
	config,
	cell,
	canEdit,
	autoFocus = false,
	onPlace,
}: {
	readonly column: Column;
	readonly config: CaseListConfig;
	readonly cell: TileCell;
	readonly canEdit: boolean;
	/** Take focus on mount — set when the action that revealed these
	 *  controls unmounted itself doing so. */
	readonly autoFocus?: boolean;
	readonly onPlace: (next: TileCell) => void;
}) {
	const [refusal, setRefusal] = useState<string | null>(null);
	const refusalId = useId();

	const commit = (patch: Partial<TileGeometry>): boolean => {
		const verdict = planColumnTilePlacement({
			config,
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
					autoFocus={autoFocus}
					describedBy={refusal === null ? undefined : refusalId}
					onCommit={(next) => commit({ x: next - 1 })}
				/>
				<NumberField
					label="Row"
					value={cell.y + 1}
					max={TILE_GRID_ROWS}
					disabled={!canEdit}
					describedBy={refusal === null ? undefined : refusalId}
					onCommit={(next) => commit({ y: next - 1 })}
				/>
				<NumberField
					label="Columns wide"
					value={cell.width}
					max={TILE_GRID_COLUMNS}
					disabled={!canEdit}
					describedBy={refusal === null ? undefined : refusalId}
					onCommit={(next) => commit({ width: next })}
				/>
				<NumberField
					label="Rows tall"
					value={cell.height}
					max={TILE_GRID_ROWS}
					disabled={!canEdit}
					describedBy={refusal === null ? undefined : refusalId}
					onCommit={(next) => commit({ height: next })}
				/>
			</div>
			{/* A live region AND the inputs' description: a refused number is
			 * announced when it lands, and re-read on returning to the field
			 * that carries it. */}
			<p
				id={refusalId}
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className={
					refusal === null
						? "sr-only"
						: "flex items-start gap-2 text-[13px] leading-relaxed text-nova-rose"
				}
			>
				{refusal !== null && (
					<Icon
						icon={tablerAlertCircle}
						aria-hidden="true"
						width="15"
						height="15"
						className="mt-0.5 shrink-0"
					/>
				)}
				<span>{refusal ?? ""}</span>
			</p>
		</div>
	);
}

function NumberField({
	label,
	value,
	max,
	disabled,
	autoFocus = false,
	describedBy,
	onCommit,
}: {
	readonly label: string;
	readonly value: number;
	readonly max: number;
	readonly disabled: boolean;
	readonly autoFocus?: boolean;
	/** The refusal element this field's value may have produced. */
	readonly describedBy?: string;
	/** Returns whether the value was accepted; a refusal keeps the draft
	 *  so the author can correct it. */
	readonly onCommit: (next: number) => boolean;
}) {
	const id = useId();
	const [draft, setDraft] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const claimedFocusRef = useRef(false);
	useEffect(() => {
		if (!autoFocus || claimedFocusRef.current || disabled) return;
		claimedFocusRef.current = true;
		inputRef.current?.focus();
	}, [autoFocus, disabled]);

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
				ref={inputRef}
				id={id}
				type="text"
				inputMode="numeric"
				autoComplete="off"
				data-1p-ignore
				disabled={disabled}
				aria-describedby={describedBy}
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
