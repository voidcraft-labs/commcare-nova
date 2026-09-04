// components/builder/case-list-config/canvas/SearchCanvas.tsx
//
// Search owns the worker-facing fields used to narrow an already-available
// set. The running search screen stays recognizable without pretending
// edit-mode fields are live.
// Config state lives in the artifact where it manifests: a date-range field
// renders as two From/To boxes, a choice list carries its chevron, a default
// shows pre-filled in the field, and in the inspector where it doesn't (the
// match setting is invisible on the screen, so it stays off the canvas).
//
// Clicking a thing configures that thing: field rows select their
// field, while Edit Search screen opens the screen-copy inspector. The
// fields are depictions, not live widgets: the global Preview mode
// mounts the real `SearchInputForm` and its functional Search action.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerBarcode from "@iconify-icons/tabler/barcode";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerSquareCheck from "@iconify-icons/tabler/square-check";
import { useId, useMemo, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import {
	type SearchableChoice,
	SearchableChoiceCombobox,
} from "@/components/builder/case-list-config/SearchableChoiceCombobox";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	type CaseProperty,
	type CaseSearchConfig,
	type CaseType,
	DEFAULT_CASE_SEARCH_TITLE,
	isStandardCaseListProperty,
	type SearchInputDef,
	searchInputDefault,
	type Uuid,
} from "@/lib/domain";
import type { ValueExpression } from "@/lib/domain/predicate";
import { PreviewMarkdown } from "@/lib/markdown";
import { useCanEdit } from "@/lib/session/hooks";
import { LIST_ROW_CLS } from "@/lib/styles";
import {
	friendlyPropertyDisambiguator,
	propertyDisplayLabel,
	propertyTypeLabel,
} from "../../shared/primitives/propertyDisplay";
import {
	resolveRows,
	rowHasStructuralError,
	searchInputIcon,
} from "../searchInputResolution";
import type { WorkspaceSelection } from "../workspaceSelection";
import { AddGhostButton, AuthoredDragPreviewLabel } from "./canvasChrome";
import { NoMatchesFormSetting } from "./NoMatchesFormSetting";

export interface SearchCanvasProps {
	readonly searchInputs: readonly SearchInputDef[];
	readonly searchConfig: CaseSearchConfig | undefined;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	/** Enables an intentional zero-input Search action before opening settings. */
	readonly onConfigureSearchAction?: () => void;
	readonly onAddInput: (property: CaseProperty) => void;
	/** Adds a hidden value: computed when the search runs, never shown. */
	readonly onAddHiddenInput: () => void;
	/** Disabled-add hint: `undefined` means add is enabled. */
	readonly addInputDisabledReason: string | undefined;
	readonly onMoveInput: (uuid: SearchInputDef["uuid"], toIndex: number) => void;
	/** Whether the worker actually sees a search screen (requires an input). */
	readonly hasSearchSurface?: boolean;
	/** Whether the module has an effective Search action. This stays distinct
	 * from both visible inputs and assigned-case availability. */
	readonly hasSearchAction?: boolean;
	/** The real web auto-launch shape: enabled case search, no prompts, and an
	 * effective Cases available rule. This is not inferred from marker presence. */
	readonly opensResultsAutomatically?: boolean;
	/** A Search-action setting is invalid and needs a findable repair mark. */
	readonly searchSettingsHasError?: boolean;
	/** The module opens on Search: no browse list, Results only after a search. */
	readonly searchFirst?: boolean;
	/** The module whose Search this is; the no-matches setting plans against
	 *  it. Absent while the URL is still resolving. */
	readonly moduleUuid?: Uuid;
}

export function SearchCanvas({
	searchInputs,
	searchConfig,
	caseTypes,
	currentCaseType,
	selection,
	onSelect,
	onConfigureSearchAction,
	onAddInput,
	onAddHiddenInput,
	addInputDisabledReason,
	onMoveInput,
	hasSearchSurface,
	hasSearchAction,
	opensResultsAutomatically = false,
	searchSettingsHasError = false,
	searchFirst = false,
	moduleUuid,
}: SearchCanvasProps) {
	const canEdit = useCanEdit();
	const projectProse = useProseProjection();
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const panelSelected = selection?.type === "search-panel";
	const selectedInputUuid = selection?.type === "input" ? selection.uuid : null;
	const enabledSearchConfig =
		searchConfig === undefined || "searchActionEnabled" in searchConfig
			? undefined
			: searchConfig;
	const searchEnabled = hasSearchSurface ?? searchInputs.length > 0;
	const searchActionEnabled =
		hasSearchAction ??
		(searchInputs.length > 0 ||
			(searchConfig !== undefined && !("searchActionEnabled" in searchConfig)));
	const properties = useMemo(
		() =>
			caseTypes.find((caseType) => caseType.name === currentCaseType)
				?.properties ?? [],
		[caseTypes, currentCaseType],
	);

	// Array position is the display sequence. The render, `resolved` parallel
	// array, and reorder drag indices all key off it, so an SA/MCP
	// `moveSearchInput` reflects here and a drag computes correct indices.
	const orderedInputs = useMemo(() => [...searchInputs], [searchInputs]);

	const resolved = useMemo(
		() => resolveRows(orderedInputs, caseTypes, currentCaseType, projectProse),
		[orderedInputs, caseTypes, currentCaseType, projectProse],
	);

	const { pendingDrop } = useReorderableList<SearchInputDef>({
		containerKey,
		containerKind: "search-canvas-inputs",
		items: orderedInputs,
		itemKeys: orderedInputs.map((input) => input.uuid),
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
				`${label} is already at the ${targetIndex <= 0 ? "beginning" : "end"} of Search`,
			);
			return;
		}
		setMoveAnnouncement(
			`${label} moved ${key === "ArrowUp" || key === "Home" ? "earlier" : "later"} in Search`,
		);
		onMoveInput(input.uuid, targetIndex);
	};

	const title =
		enabledSearchConfig?.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE;
	const subtitle = enabledSearchConfig?.searchScreenSubtitle;
	const openSearchSettings = () => {
		if (onConfigureSearchAction !== undefined) onConfigureSearchAction();
		else onSelect({ type: "search-panel" });
	};
	return (
		<ContentFrame width="3xl" className="px-6 pt-8 pb-24">
			<header className="mb-9">
				<div className="min-w-0">
					<h1 className="font-display text-2xl font-semibold tracking-tighter text-nova-text">
						Search
					</h1>
					<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
						{searchFirst
							? "People search before they see any cases. Results shows only what a search finds."
							: canEdit
								? "Choose how people narrow cases before selecting one"
								: "People narrow cases here before selecting one"}
					</p>
				</div>
			</header>

			<div className="space-y-10">
				<section aria-labelledby="search-fields-heading">
					<div className="mb-4">
						<h2
							id="search-fields-heading"
							className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
						>
							Search fields
						</h2>
						<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
							{searchEnabled
								? "People can use any combination of these fields"
								: searchActionEnabled
									? "Search can continue without asking for information"
									: canEdit
										? "Add fields when people should narrow Results before choosing a case"
										: "This module doesn't ask for search information"}
						</p>
					</div>

					<div
						data-search-surface-state={searchEnabled ? "authored" : "empty"}
						data-search-action-state={
							searchActionEnabled ? "available" : "not-available"
						}
						data-search-settings-state={
							searchSettingsHasError ? "needs-attention" : "ready"
						}
						data-search-first={searchFirst ? "true" : undefined}
						className={`rounded-2xl border p-4 transition-colors ${
							panelSelected
								? "border-nova-violet bg-nova-surface/25"
								: searchSettingsHasError
									? "border-nova-rose/45 bg-nova-rose/[0.035]"
									: searchEnabled
										? "border-white/[0.08] bg-nova-surface/25"
										: "border-dashed border-nova-border-bright bg-nova-surface/15"
						}`}
					>
						<div className="flex min-h-16 flex-wrap items-center gap-3 px-1 pb-2">
							<div className="flex min-w-0 flex-1 items-center gap-3">
								<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.035] text-nova-text-secondary">
									<Icon icon={tablerSearch} width="17" height="17" />
								</span>
								<div className="min-w-0 flex-1">
									<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
										<h3 className="min-w-0 break-words font-display tracking-tighter text-[16px] font-semibold text-nova-text">
											{searchEnabled
												? title
												: opensResultsAutomatically
													? "Results can open automatically"
													: searchActionEnabled
														? "Search is available from Results"
														: "No search fields"}
										</h3>
										{searchSettingsHasError && (
											<span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-nova-rose">
												<Icon icon={tablerAlertCircle} width="13" height="13" />
												Needs attention
											</span>
										)}
									</div>
									{searchEnabled ? (
										subtitle !== undefined && (
											<div className="mt-1 preview-markdown text-[13px] text-nova-text-muted">
												<PreviewMarkdown>{subtitle}</PreviewMarkdown>
											</div>
										)
									) : (
										<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
											{opensResultsAutomatically
												? "Cases available still decides which cases people see"
												: searchActionEnabled
													? "People continue without entering search information"
													: canEdit
														? "Add a field to let people narrow cases before Results"
														: "Results opens without asking for search information"}
										</p>
									)}
								</div>
							</div>
							{canEdit && searchEnabled ? (
								<Button
									type="button"
									variant="ghost-action"
									onClick={() => onSelect({ type: "search-panel" })}
									aria-expanded={panelSelected}
									data-case-search-panel
									className="w-full shrink-0 @min-[34rem]:w-auto"
								>
									Edit Search screen
								</Button>
							) : canEdit ? (
								<Button
									type="button"
									variant="ghost-action"
									onClick={openSearchSettings}
									aria-expanded={panelSelected}
									data-case-search-panel
									className="w-full shrink-0 @min-[34rem]:w-auto"
								>
									Change when people continue
								</Button>
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

						{searchEnabled && (
							<ol
								aria-labelledby="search-fields-heading"
								className="mt-2 flex list-none flex-col gap-2 p-0"
							>
								{orderedInputs.map((input, i) => {
									const hasError =
										resolved[i] !== undefined &&
										rowHasStructuralError(resolved[i]);
									return (
										<li key={input.uuid}>
											<ReorderableRow
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
																	bottom:
																		closestEdge === "bottom" ? -2 : undefined,
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
										</li>
									);
								})}
							</ol>
						)}

						{canEdit && (
							<AddSearchFieldControl
								properties={properties}
								onChoose={onAddInput}
								onChooseHidden={onAddHiddenInput}
								disabledReason={addInputDisabledReason}
							/>
						)}
					</div>
				</section>

				{/* Only a module with a Search action and a case type can offer a
				 * registration form after an empty search; without either there
				 * is nothing to search and nothing to register. */}
				{moduleUuid !== undefined &&
					searchActionEnabled &&
					currentCaseType !== "" && (
						<NoMatchesFormSetting moduleUuid={moduleUuid} />
					)}
			</div>
		</ContentFrame>
	);
}

type AddSearchFieldChoice =
	| { readonly kind: "property"; readonly property: CaseProperty }
	| { readonly kind: "hidden" };

/**
 * Search-field creation starts with the one decision Nova cannot infer: which
 * case information the author wants people to search. Mechanical field and
 * match defaults are applied only after that explicit choice. A hidden value
 * (something Nova works out and carries with the search, never shown) is the
 * one quiet footer choice, because it names no case information at all.
 */
export function AddSearchFieldControl({
	properties,
	onChoose,
	onChooseHidden,
	disabledReason,
}: {
	readonly properties: readonly CaseProperty[];
	readonly onChoose: (property: CaseProperty) => void;
	readonly onChooseHidden: () => void;
	readonly disabledReason: string | undefined;
}) {
	const projectProse = useProseProjection();
	const effectiveDisabledReason = disabledReason;

	const orderedProperties = useMemo(() => {
		const indexed = properties.map((property, index) => ({ property, index }));
		indexed.sort((left, right) => {
			const leftName = left.property.name;
			const rightName = right.property.name;
			if (leftName === "case_name" && rightName !== "case_name") return -1;
			if (rightName === "case_name" && leftName !== "case_name") return 1;
			const leftIsSystem = isStandardCaseListProperty(leftName);
			const rightIsSystem = isStandardCaseListProperty(rightName);
			if (leftIsSystem !== rightIsSystem) return leftIsSystem ? 1 : -1;
			return left.index - right.index;
		});
		return indexed.map(({ property }) => property);
	}, [properties]);
	const choices = useMemo<readonly SearchableChoice<AddSearchFieldChoice>[]>(
		() => [
			...orderedProperties.map(
				(property): SearchableChoice<AddSearchFieldChoice> => {
					const name = property.name;
					return {
						id: `property:${name}`,
						label: propertyDisplayLabel(property, projectProse),
						detail: [
							propertyTypeLabel(property),
							friendlyPropertyDisambiguator(
								property,
								orderedProperties,
								projectProse,
							),
						]
							.filter((part): part is string => part !== undefined)
							.join(" · "),
						group:
							name === "case_name" || !isStandardCaseListProperty(name)
								? "Common information"
								: "More case information",
						icon: tablerPlus,
						searchText: `${property.name} ${propertyTypeLabel(property)}`,
						value: { kind: "property", property },
					};
				},
			),
			{
				id: "hidden",
				label: "Hidden value",
				detail:
					"A value Nova works out when the search runs, kept with it but never shown",
				group: "More options",
				icon: tablerEyeOff,
				quiet: true,
				searchText: "hidden system value search time provenance",
				value: { kind: "hidden" },
			},
		],
		[orderedProperties, projectProse],
	);

	if (effectiveDisabledReason !== undefined) {
		return (
			<AddGhostButton
				label="Add search field"
				onClick={() => {}}
				disabledReason={effectiveDisabledReason}
				dataCaseAddSearchField
				className="mb-1 mt-3 w-full"
			/>
		);
	}

	return (
		<SearchableChoiceCombobox
			choices={choices}
			onChoose={(choice) => {
				if (choice.value.kind === "hidden") onChooseHidden();
				else onChoose(choice.value.property);
			}}
			trigger={
				<Button
					type="button"
					variant="ghost"
					data-case-add-search-field
					className="nova-add-slot mb-1 mt-3 w-full gap-2"
				/>
			}
			triggerLabel="Add search field"
			triggerContent={
				<>
					<Icon icon={tablerPlus} width="14" height="14" />
					<span className="flex-1">Add search field</span>
				</>
			}
			heading="Add search field"
			description="Choose the case information people can search"
			searchLabel="Search case information"
			searchPlaceholder="Search case information"
			contentClassName="max-h-[min(22rem,var(--available-height))]"
		/>
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
	const dflt = defaultDisplayValue(searchInputDefault(input));
	const label = input.label || input.name || "Untitled field";
	const hidden = input.kind === "hidden";
	const hint = hidden ? undefined : input.hint;
	const required = hidden ? undefined : input.required;
	const content = (
		<span className="flex min-w-0 w-full flex-col">
			<span className="mb-2 flex min-w-0 items-start gap-2">
				<span
					className={`min-w-0 flex-1 break-words text-left text-[14px] font-semibold ${input.label ? "text-nova-text" : "italic text-nova-text-muted"}`}
				>
					{input.label || "Untitled field"}
					{required !== undefined && (
						<span
							className="ml-1 text-xs text-nova-rose"
							title={
								required.when === undefined
									? "Required"
									: "Required under a condition"
							}
						>
							*
						</span>
					)}
				</span>
				{hidden && (
					<span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-nova-text-muted">
						<Icon icon={tablerEyeOff} width="13" height="13" />
						Hidden
					</span>
				)}
				{hasError && (
					<span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-nova-rose">
						<Icon icon={tablerAlertCircle} width="13" height="13" />
						{canEdit ? "Needs attention" : "May not work"}
					</span>
				)}
			</span>
			{hint !== undefined && (
				<span className="mb-2 break-words text-left text-[13px] text-nova-text-secondary">
					{hint}
				</span>
			)}
			<AppField input={input} defaultText={dflt} />
		</span>
	);
	return (
		<div
			className={`group/input flex min-h-[72px] items-stretch overflow-hidden rounded-xl border transition-colors ${
				selected
					? "border-nova-violet bg-nova-violet/[0.08]"
					: hasError
						? "border-nova-rose/40 bg-nova-rose/[0.03]"
						: canEdit
							? "border-white/[0.07] bg-nova-deep/35 hover:border-nova-border-bright hover:bg-white/[0.025]"
							: "border-white/[0.07] bg-nova-deep/35"
			}`}
		>
			{canEdit && (
				<SimpleTooltip content="Drag or use arrow keys to move" side="left">
					<Button
						type="button"
						variant="ghost"
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
						aria-label={`Move ${label} in Search. Position ${position} of ${total}. Use arrow keys or drag.`}
						className="nova-focusable-inset h-auto w-11 shrink-0 cursor-grab rounded-l-xl rounded-r-none px-0 text-nova-text-muted hover:bg-white/[0.035] dark:hover:bg-white/[0.035]"
					>
						<Icon icon={tablerGripVertical} width="17" height="17" />
					</Button>
				</SimpleTooltip>
			)}
			{canEdit ? (
				<button
					type="button"
					onClick={onClick}
					aria-pressed={selected}
					data-case-search-field={input.uuid}
					className={`flex-1 items-stretch ${LIST_ROW_CLS}`}
				>
					{content}
				</button>
			) : (
				<div className="min-w-0 flex-1 px-3 py-3 text-left">{content}</div>
			)}
		</div>
	);
}

/** The field as the app renders it: widget shape carried by the
 *  rendering itself (range = two fields, choice list = chevron,
 *  barcode = scan glyph), defaults pre-filled in full text color. */
function AppField({
	input,
	defaultText,
}: {
	readonly input: SearchInputDef;
	readonly defaultText: string | undefined;
}) {
	if (input.kind === "hidden") {
		// The worker never sees this value; the canvas shows what the app
		// will carry, in the same box shape, dimmed like a disabled control.
		return (
			<FieldBox
				text={defaultText ?? "Calculated value"}
				filled={false}
				icon={tablerEyeOff}
			/>
		);
	}
	switch (input.type) {
		case "select":
			return (
				<FieldBox
					text={defaultText ?? "Choose one"}
					filled={defaultText !== undefined}
					icon={tablerChevronDown}
				/>
			);
		case "multi-select":
			return (
				<FieldBox
					text={defaultText ?? "Choose any that apply"}
					filled={defaultText !== undefined}
					icon={tablerSquareCheck}
				/>
			);
		case "date-range":
			return (
				<span className="grid min-w-0 w-full grid-cols-1 gap-1.5 @sm:grid-cols-2">
					<FieldBox
						text={defaultText ?? "From"}
						filled={defaultText !== undefined}
						icon={tablerCalendar}
					/>
					<FieldBox text="To" filled={false} icon={tablerCalendar} />
				</span>
			);
		case "date":
			return (
				<FieldBox
					text={defaultText ?? " "}
					filled={defaultText !== undefined}
					icon={tablerCalendar}
				/>
			);
		case "barcode":
			return (
				<FieldBox
					text={defaultText ?? " "}
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
		<span
			className={`flex min-h-10 min-w-0 w-full flex-1 items-center justify-between gap-2 rounded-md border border-nova-border bg-nova-deep/60 px-3 py-2 text-[14px] ${
				filled ? "text-nova-text" : "text-nova-text-muted"
			}`}
		>
			<span className="min-w-0 break-words text-left">{text}</span>
			{icon !== undefined && (
				<Icon
					icon={icon}
					width="15"
					height="15"
					className="shrink-0 text-nova-text-muted"
				/>
			)}
		</span>
	);
}

/**
 * Render a default-value expression the way the field would carry it:
 * literal terms show their value, `today` reads as a date, anything
 * computed shows an honest generic. Mirrors the canvas principle:
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
	return "Calculated value";
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
				icon={searchInputIcon(input)}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<AuthoredDragPreviewLabel>{label}</AuthoredDragPreviewLabel>
		</div>
	);
}
