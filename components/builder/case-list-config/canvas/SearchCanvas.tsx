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
// field, everything else on the card (title, subtitle, the Search
// button) selects the panel. The fields are depictions, not live
// widgets — the Preview tab mounts the real `SearchInputForm` for
// actually searching.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerBarcode from "@iconify-icons/tabler/barcode";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlayerPlay from "@iconify-icons/tabler/player-play";
import tablerSearch from "@iconify-icons/tabler/search";
import { useId, useMemo } from "react";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { Tooltip } from "@/components/ui/Tooltip";
import type { CaseSearchConfig, CaseType, SearchInputDef } from "@/lib/domain";
import type { ValueExpression } from "@/lib/domain/predicate";
import { PreviewMarkdown } from "@/lib/markdown";
import { summarizeFilter } from "../predicateSummary";
import {
	resolveRows,
	rowHasStructuralError,
	SEARCH_INPUT_TYPE_ICONS,
} from "../searchInputResolution";
import type { WorkspaceSelection } from "../workspaceSelection";
import { AddGhostButton, activateOnKeyDown } from "./canvasChrome";

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
	readonly onReorderInputs: (next: readonly SearchInputDef[]) => void;
	/** Jump to the Preview tab — where this screen actually runs. */
	readonly onPreview: () => void;
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
	onReorderInputs,
	onPreview,
}: SearchCanvasProps) {
	const containerKey = useId();
	const panelSelected = selection?.type === "search-panel";
	const selectedInputUuid = selection?.type === "input" ? selection.uuid : null;

	const resolved = useMemo(
		() => resolveRows(searchInputs, caseTypes, currentCaseType),
		[searchInputs, caseTypes, currentCaseType],
	);

	const { pendingDrop } = useReorderableList<SearchInputDef>({
		containerKey,
		containerKind: "search-canvas-inputs",
		items: searchInputs,
		onReorder: onReorderInputs,
	});

	const title = searchConfig?.searchScreenTitle ?? "Search";
	const subtitle = searchConfig?.searchScreenSubtitle;
	const buttonLabel = searchConfig?.searchButtonLabel ?? "Search";
	const displayConditionPhrase = summarizeFilter(
		searchConfig?.searchButtonDisplayCondition,
	);

	return (
		<div className="max-w-md mx-auto px-6 pt-6 pb-24">
			<p className="mb-5 text-[13px] text-nova-text-muted">
				The search screen, as your app shows it — click any part to set it up.
			</p>

			{/* The search panel. Clicking panel chrome selects the panel;
			 *  inner rows stop propagation and select themselves. */}
			{/* biome-ignore lint/a11y/useSemanticElements: can't use <button> — the card hosts nested interactive children (rows, grips, the add affordance), which HTML forbids in a button */}
			<div
				role="button"
				tabIndex={0}
				onClick={() => onSelect({ type: "search-panel" })}
				onKeyDown={activateOnKeyDown(() => onSelect({ type: "search-panel" }))}
				className={`rounded-lg p-4 cursor-pointer transition-all border bg-nova-surface/40 ${
					panelSelected
						? "border-nova-violet shadow-[0_0_14px_rgba(139,92,246,0.25)]"
						: "border-nova-border hover:border-nova-border-bright"
				}`}
			>
				<div className="flex items-center gap-2.5 px-1 pb-1">
					<Icon
						icon={tablerSearch}
						width="17"
						height="17"
						className="text-nova-text-secondary"
					/>
					<span className="font-display font-semibold text-base text-nova-text">
						{title}
					</span>
				</div>
				{subtitle !== undefined && (
					<div className="px-1 pb-1 preview-markdown text-xs text-nova-text-muted">
						<PreviewMarkdown>{subtitle}</PreviewMarkdown>
					</div>
				)}

				<div className="mt-2 space-y-1">
					{searchInputs.length === 0 && (
						<p className="px-1 py-2 text-xs text-nova-text-muted">
							No search fields yet — the app goes straight to the list.
						</p>
					)}
					{searchInputs.map((input, i) => {
						const hasError =
							resolved[i] !== undefined && rowHasStructuralError(resolved[i]);
						return (
							<ReorderableRow
								key={input.uuid}
								index={i}
								containerKey={containerKey}
								containerKind="search-canvas-inputs"
								pendingDrop={pendingDrop}
								preview={<InputDragPreview input={input} index={i} />}
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
											setHandleEl={setHandleEl}
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

				<AddGhostButton
					label="Add search field"
					onClick={(e) => {
						e.stopPropagation();
						onAddInput();
					}}
					disabledReason={addInputDisabledReason}
					className="w-full my-3"
				/>

				{/* The screen's Search button, drawn as a blueprint of itself —
				 *  outlined, never filled. The filled violet button is the
				 *  pressable one in Preview; on this canvas clicking a thing
				 *  configures that thing, so the artifact keeps the screen's
				 *  shape while its click opens the panel settings that own the
				 *  button's label and display condition. */}
				<Tooltip content="The search button — click to set its label and when it appears">
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onSelect({ type: "search-panel" });
						}}
						className="w-full inline-flex items-center justify-center gap-2 px-4 min-h-11 rounded-md border border-nova-violet/45 bg-nova-violet/[0.07] text-nova-violet-bright text-sm font-semibold cursor-pointer hover:border-nova-violet hover:bg-nova-violet/[0.13] transition-colors"
					>
						<Icon icon={tablerSearch} width="15" height="15" />
						{buttonLabel}
					</button>
				</Tooltip>
				{displayConditionPhrase !== undefined && (
					<p className="mt-2 px-1 text-[11px] text-nova-text-muted leading-relaxed first-letter:uppercase">
						The button appears only when {displayConditionPhrase}.
					</p>
				)}
			</div>

			{/* Where the searching impulse lands — this canvas edits the
			 *  screen; Preview runs it. */}
			<div className="mt-3 flex justify-center">
				<button
					type="button"
					onClick={onPreview}
					className="inline-flex items-center gap-1.5 px-3 min-h-11 text-[12px] rounded-lg text-nova-text-muted hover:text-nova-violet-bright transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlayerPlay} width="12" height="12" />
					Try this screen in Preview
				</button>
			</div>
		</div>
	);
}

// ── App-true field row ────────────────────────────────────────────

interface InputRowProps {
	readonly input: SearchInputDef;
	readonly selected: boolean;
	readonly hasError: boolean;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onClick: () => void;
}

function InputRow({
	input,
	selected,
	hasError,
	setHandleEl,
	onClick,
}: InputRowProps) {
	const dflt = defaultDisplayValue(input.default);
	return (
		// biome-ignore lint/a11y/useSemanticElements: can't use <button> — the row hosts a nested grab rail button, which HTML forbids inside a button
		<div
			role="button"
			tabIndex={0}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			onKeyDown={activateOnKeyDown(onClick)}
			className={`group/input relative rounded-md pl-8 pr-3 py-2.5 cursor-pointer border transition-all ${
				selected
					? "border-nova-violet bg-nova-violet/[0.08] shadow-[0_0_10px_rgba(139,92,246,0.2)]"
					: hasError
						? "border-nova-rose/35 hover:border-nova-rose/55"
						: "border-transparent hover:bg-white/[0.03]"
			}`}
		>
			{/* Grab rail — the row's full height, so the drag target is
			 *  never smaller than the row itself. */}
			<Tooltip content="Drag to reorder" placement="left">
				<button
					type="button"
					ref={setHandleEl}
					aria-label={`Drag to reorder ${input.label || input.name || "search field"}`}
					onClick={(e) => e.stopPropagation()}
					className="absolute left-0 top-0 bottom-0 w-7 grid place-items-center rounded-l-md cursor-grab text-nova-text-muted/0 group-hover/input:text-nova-text-muted/60 hover:!text-nova-text-muted transition-colors"
				>
					<Icon icon={tablerGripVertical} width="14" height="14" />
				</button>
			</Tooltip>
			<div className="flex items-center gap-1.5 mb-1.5">
				<span
					className={`text-[13px] font-medium ${input.label ? "text-nova-text" : "italic text-nova-text-muted"}`}
				>
					{input.label || "untitled field"}
				</span>
				{hasError && (
					<Tooltip content="This field has a problem — open it to see what.">
						<span
							role="img"
							className="inline-flex"
							aria-label="This field has a problem"
						>
							<Icon
								icon={tablerAlertCircle}
								width="13"
								height="13"
								className="text-nova-rose/80"
							/>
						</span>
					</Tooltip>
				)}
			</div>
			<AppField input={input} defaultText={dflt} />
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

function InputDragPreview({
	input,
	index,
}: {
	readonly input: SearchInputDef;
	readonly index: number;
}) {
	const label = input.label || input.name || `Search input ${index + 1}`;
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
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">{label}</span>
		</div>
	);
}
