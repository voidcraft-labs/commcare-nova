// components/builder/case-list-config/canvas/SearchCanvas.tsx
//
// The search tab's canvas: the search screen, rendered the way the
// running app shows it. Config state lives in the artifact where it
// manifests — a date-range field renders as two From/To boxes, a
// choice list carries its chevron, a default shows pre-filled in the
// field — and in the inspector where it doesn't (the match setting is
// invisible on the screen, so it stays off the canvas).
//
// Clicking a thing configures that thing: field rows select their
// field, while Screen settings opens the screen-copy inspector. The
// fields are depictions, not live widgets — the global Preview mode
// mounts the real `SearchInputForm` and its functional Search action.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerBarcode from "@iconify-icons/tabler/barcode";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerSearch from "@iconify-icons/tabler/search";
import { useId, useMemo, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { bySortKey } from "@/lib/doc/order/compare";
import {
	type CaseSearchConfig,
	type CaseType,
	DEFAULT_CASE_SEARCH_TITLE,
	type SearchInputDef,
} from "@/lib/domain";
import type { ValueExpression } from "@/lib/domain/predicate";
import { PreviewMarkdown } from "@/lib/markdown";
import { useCanEdit } from "@/lib/session/hooks";
import {
	resolveRows,
	rowHasStructuralError,
	SEARCH_INPUT_TYPE_ICONS,
} from "../searchInputResolution";
import type { WorkspaceSelection } from "../workspaceSelection";
import { AddGhostButton } from "./canvasChrome";

export interface SearchCanvasProps {
	readonly searchInputs: readonly SearchInputDef[];
	readonly searchConfig: CaseSearchConfig | undefined;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddInput: () => void;
	/** Disabled-add hint — `undefined` means add is enabled. */
	readonly addInputDisabledReason: string | undefined;
	readonly onMoveInput: (uuid: SearchInputDef["uuid"], toIndex: number) => void;
	/** Whether the worker actually sees a search screen (requires an input). */
	readonly hasSearchSurface?: boolean;
	/** Whether an always-on rule narrows the Results they go straight to. */
	readonly hasAutomaticResultsFilter?: boolean;
}

export function SearchCanvas({
	searchInputs,
	searchConfig,
	caseTypes,
	currentCaseType,
	selection,
	onSelect,
	onAddInput,
	addInputDisabledReason,
	onMoveInput,
	hasSearchSurface,
	hasAutomaticResultsFilter = false,
}: SearchCanvasProps) {
	const canEdit = useCanEdit();
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const panelSelected = selection?.type === "search-panel";
	const selectedInputUuid = selection?.type === "input" ? selection.uuid : null;
	const searchEnabled = hasSearchSurface ?? searchInputs.length > 0;

	// DISPLAY order (`sort-by-(order, uuid)`), not array position — the render,
	// the `resolved` parallel array, and the reorder drag's indices all key off
	// this so an SA/MCP `moveSearchInput` reflects here and a drag computes
	// correct from/to indices.
	const orderedInputs = useMemo(
		() => [...searchInputs].sort(bySortKey),
		[searchInputs],
	);

	const resolved = useMemo(
		() => resolveRows(orderedInputs, caseTypes, currentCaseType),
		[orderedInputs, caseTypes, currentCaseType],
	);

	const { pendingDrop } = useReorderableList<SearchInputDef>({
		containerKey,
		containerKind: "search-canvas-inputs",
		items: orderedInputs,
		getItemKey: (input) => input.uuid,
		onReorder: (_next, move) => {
			if (canEdit) onMoveInput(move.item.uuid, move.toIndex);
		},
	});

	const moveByKeyboard = (
		index: number,
		key: "ArrowUp" | "ArrowDown" | "Home" | "End",
	) => {
		const input = orderedInputs[index];
		if (input === undefined || !canEdit) return;
		const targetIndex =
			key === "Home"
				? 0
				: key === "End"
					? orderedInputs.length - 1
					: index + (key === "ArrowUp" ? -1 : 1);
		const label = input.label || input.name || "Search field";
		if (
			targetIndex < 0 ||
			targetIndex >= orderedInputs.length ||
			targetIndex === index
		) {
			setMoveAnnouncement(
				`${label} is already at the ${targetIndex <= 0 ? "beginning" : "end"} of search.`,
			);
			return;
		}
		setMoveAnnouncement(
			`${label} moved ${key === "ArrowUp" || key === "Home" ? "earlier" : "later"} in search.`,
		);
		onMoveInput(input.uuid, targetIndex);
	};

	const title = searchEnabled
		? (searchConfig?.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE)
		: "People go straight to results";
	const subtitle = searchConfig?.searchScreenSubtitle;
	return (
		<ContentFrame width="3xl" className="px-6 pt-8 pb-24">
			<header className="mb-9">
				<div className="min-w-0">
					<h1 className="font-display text-2xl font-semibold tracking-tight text-nova-text">
						Search
					</h1>
					<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
						Choose how people narrow the case list.
					</p>
				</div>
			</header>

			<div
				className={`rounded-2xl p-4 transition-colors border bg-nova-surface/25 ${
					panelSelected ? "border-nova-violet" : "border-white/[0.08]"
				}`}
			>
				<div className="flex min-h-16 flex-wrap items-center gap-3 px-1 pb-2">
					<div className="flex min-w-0 flex-1 items-center gap-3">
						<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.035] text-nova-text-secondary">
							<Icon icon={tablerSearch} width="17" height="17" />
						</span>
						<div className="min-w-0 flex-1">
							<h2 className="font-display text-[16px] font-semibold text-nova-text">
								{title}
							</h2>
							{searchEnabled && subtitle !== undefined && (
								<div className="mt-1 preview-markdown text-[12px] text-nova-text-muted">
									<PreviewMarkdown>{subtitle}</PreviewMarkdown>
								</div>
							)}
						</div>
					</div>
					{canEdit && searchEnabled ? (
						<button
							type="button"
							onClick={() => onSelect({ type: "search-panel" })}
							aria-expanded={panelSelected}
							className="min-h-11 w-full shrink-0 cursor-pointer rounded-lg px-3 text-[12px] font-medium text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.08] @min-[28rem]:w-auto"
						>
							Screen settings
						</button>
					) : canEdit &&
						searchConfig !== undefined &&
						hasAutomaticResultsFilter ? (
						<button
							type="button"
							onClick={() => onSelect({ type: "search-panel" })}
							aria-expanded={panelSelected}
							className="min-h-11 w-full shrink-0 cursor-pointer rounded-lg px-3 text-[12px] font-medium text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.08] @min-[28rem]:w-auto"
						>
							Search rules
						</button>
					) : null}
				</div>

				<p
					role="status"
					aria-live="polite"
					aria-atomic="true"
					className="sr-only"
				>
					{moveAnnouncement}
				</p>

				<div className="mt-2 space-y-1">
					{orderedInputs.length === 0 && (
						<p className="px-2 py-5 text-center text-[12px] text-nova-text-muted">
							{hasAutomaticResultsFilter
								? "The Cases included rule narrows what they see. Add a search field if people should narrow it further."
								: "Add a search field when people need to narrow the list before choosing."}
						</p>
					)}
					{orderedInputs.map((input, i) => {
						const hasError =
							resolved[i] !== undefined && rowHasStructuralError(resolved[i]);
						return (
							<ReorderableRow
								key={input.uuid}
								index={i}
								itemKey={input.uuid}
								containerKey={containerKey}
								containerKind="search-canvas-inputs"
								pendingDrop={pendingDrop}
								preview={<InputDragPreview input={input} />}
							>
								{({
									wrapperRef,
									setHandleEl,
									closestEdge,
									previewPortal,
									beingMoved,
								}) => (
									<div
										ref={wrapperRef}
										className={`relative ${beingMoved ? "opacity-50" : ""}`}
									>
										{closestEdge !== null && (
											<div
												aria-hidden="true"
												className="absolute left-0 right-0 h-0.5 bg-nova-violet rounded-full z-10"
												style={{
													top: closestEdge === "top" ? -2 : undefined,
													bottom: closestEdge === "bottom" ? -2 : undefined,
												}}
											/>
										)}
										<InputRow
											input={input}
											selected={selectedInputUuid === input.uuid}
											hasError={hasError}
											canEdit={canEdit}
											position={i + 1}
											total={orderedInputs.length}
											setHandleEl={setHandleEl}
											onMove={(key) => moveByKeyboard(i, key)}
											onClick={() =>
												onSelect({ type: "input", uuid: input.uuid })
											}
										/>
										{previewPortal}
									</div>
								)}
							</ReorderableRow>
						);
					})}
				</div>

				{canEdit && (
					<AddGhostButton
						label="Add search field"
						onClick={onAddInput}
						disabledReason={addInputDisabledReason}
						className="w-full my-3"
					/>
				)}
			</div>
		</ContentFrame>
	);
}

// ── App-true field row ────────────────────────────────────────────

interface InputRowProps {
	readonly input: SearchInputDef;
	readonly selected: boolean;
	readonly hasError: boolean;
	readonly canEdit: boolean;
	readonly position: number;
	readonly total: number;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: "ArrowUp" | "ArrowDown" | "Home" | "End") => void;
	readonly onClick: () => void;
}

function InputRow({
	input,
	selected,
	hasError,
	canEdit,
	position,
	total,
	setHandleEl,
	onMove,
	onClick,
}: InputRowProps) {
	const dflt = defaultDisplayValue(input.default);
	const label = input.label || input.name || "Untitled field";
	return (
		<div
			className={`group/input flex min-h-[72px] items-stretch overflow-hidden rounded-xl border transition-colors ${
				selected
					? "border-nova-violet bg-nova-violet/[0.08]"
					: hasError
						? "border-nova-rose/40 bg-nova-rose/[0.03]"
						: "border-white/[0.07] bg-nova-deep/35 hover:border-nova-border-bright hover:bg-white/[0.025]"
			}`}
		>
			{canEdit && (
				<SimpleTooltip content="Drag to move · Arrow keys work too" side="left">
					<button
						type="button"
						ref={setHandleEl}
						onKeyDown={(event) => {
							if (
								event.key !== "ArrowUp" &&
								event.key !== "ArrowDown" &&
								event.key !== "Home" &&
								event.key !== "End"
							) {
								return;
							}
							event.preventDefault();
							onMove(event.key);
						}}
						aria-keyshortcuts="ArrowUp ArrowDown Home End"
						aria-label={`Move ${label} in search. Position ${position} of ${total}. Use arrow keys or drag.`}
						className="grid w-11 shrink-0 cursor-grab place-items-center text-nova-text-muted transition-colors hover:bg-white/[0.035] hover:text-nova-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
					>
						<Icon icon={tablerGripVertical} width="17" height="17" />
					</button>
				</SimpleTooltip>
			)}
			<button
				type="button"
				onClick={onClick}
				disabled={!canEdit}
				aria-pressed={selected}
				className="min-w-0 flex-1 cursor-pointer px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet disabled:cursor-default"
			>
				<span className="mb-2 flex items-center gap-2">
					<span
						className={`truncate text-[13px] font-semibold ${input.label ? "text-nova-text" : "italic text-nova-text-muted"}`}
					>
						{input.label || "Untitled field"}
					</span>
					{hasError && (
						<span className="inline-flex items-center gap-1 text-[11px] font-medium text-nova-rose">
							<Icon icon={tablerAlertCircle} width="13" height="13" />
							Needs attention
						</span>
					)}
				</span>
				<AppField input={input} defaultText={dflt} />
			</button>
		</div>
	);
}

/** The field as the app renders it — widget shape carried by the
 *  rendering itself (range = two fields, choice list = chevron,
 *  barcode = scan glyph), defaults pre-filled in full text color. */
function AppField({
	input,
	defaultText,
}: {
	readonly input: SearchInputDef;
	readonly defaultText: string | undefined;
}) {
	switch (input.type) {
		case "date-range":
			return (
				<div className="flex gap-1.5">
					<FieldBox
						text={defaultText ?? "From"}
						filled={defaultText !== undefined}
						icon={tablerCalendar}
					/>
					<FieldBox text="To" filled={false} icon={tablerCalendar} />
				</div>
			);
		case "date":
			return (
				<FieldBox
					text={defaultText ?? "mm/dd/yyyy"}
					filled={defaultText !== undefined}
					icon={tablerCalendar}
				/>
			);
		case "select":
			return (
				<FieldBox
					text={defaultText ?? "Choose…"}
					filled={defaultText !== undefined}
					icon={tablerChevronDown}
				/>
			);
		case "barcode":
			return (
				<FieldBox
					text={defaultText ?? "Scan or type…"}
					filled={defaultText !== undefined}
					icon={tablerBarcode}
				/>
			);
		case "text":
			return (
				<FieldBox
					text={defaultText ?? " "}
					filled={defaultText !== undefined}
				/>
			);
	}
}

function FieldBox({
	text,
	filled,
	icon,
}: {
	readonly text: string;
	readonly filled: boolean;
	readonly icon?: IconifyIcon;
}) {
	return (
		<div
			className={`flex-1 min-w-0 h-10 px-3 rounded-md border border-nova-border bg-nova-deep/60 flex items-center justify-between gap-2 text-[13px] whitespace-nowrap overflow-hidden ${
				filled ? "text-nova-text" : "text-nova-text-muted"
			}`}
		>
			<span className="overflow-hidden text-ellipsis">{text}</span>
			{icon !== undefined && (
				<Icon
					icon={icon}
					width="15"
					height="15"
					className="shrink-0 text-nova-text-muted"
				/>
			)}
		</div>
	);
}

/**
 * Render a default-value expression the way the field would carry it:
 * literal terms show their value, `today` reads as a date, anything
 * computed shows an honest generic. Mirrors the canvas principle —
 * the inspector owns the structure.
 */
function defaultDisplayValue(
	expr: ValueExpression | undefined,
): string | undefined {
	if (expr === undefined) return undefined;
	if (expr.kind === "term" && expr.term.kind === "literal") {
		const value = expr.term.value;
		if (value === null || value === "") return undefined;
		return String(value);
	}
	if (expr.kind === "today") return "today";
	return "computed default";
}

function InputDragPreview({ input }: { readonly input: SearchInputDef }) {
	const label = input.label || input.name || "Untitled field";
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={SEARCH_INPUT_TYPE_ICONS[input.type]}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<span className="max-w-[240px] truncate">{label}</span>
		</div>
	);
}
