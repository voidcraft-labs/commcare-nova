// components/builder/case-list-config/canvas/DisplayFieldComposer.tsx
//
// The direct-manipulation field stack shared by Results and Details.
// Each screen owns its own order: the row the author drags is the row the
// worker sees in that screen. The right rail remains the home for one field's
// formatting and data source; membership and order live here, where their
// effect is visible.

"use client";

import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerCopy from "@iconify-icons/tabler/copy";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import {
	type CaseProperty,
	type Column,
	canonicalCasePropertyName,
	isStandardCaseListProperty,
} from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import {
	friendlyPropertyDisambiguator,
	propertyDisplayLabel,
	propertyTypeLabel,
} from "../../shared/primitives/propertyDisplay";
import { columnLabel } from "./ColumnInventory";
import { AddGhostButton } from "./canvasChrome";

export type DisplaySurface = "list" | "detail";

export interface DisplayFieldComposerProps {
	readonly columns: readonly Column[];
	readonly surface: DisplaySurface;
	readonly selectedUuid: string | null;
	readonly brokenColumns: ReadonlySet<string>;
	readonly onSelect: (column: Column) => void;
	readonly onMove: (uuid: Column["uuid"], toIndex: number) => void;
}

export function DisplayFieldComposer({
	columns,
	surface,
	selectedUuid,
	brokenColumns,
	onSelect,
	onMove,
}: DisplayFieldComposerProps) {
	const canEdit = useCanEdit();
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const { pendingDrop } = useReorderableList<Column>({
		containerKey,
		containerKind: `case-${surface}-fields`,
		items: columns,
		getItemKey: (column) => column.uuid,
		onReorder: (_next, move) => {
			if (canEdit) onMove(move.item.uuid, move.toIndex);
		},
	});

	const screenName = surface === "list" ? "results" : "details";

	const moveByKeyboard = (
		index: number,
		key: "ArrowUp" | "ArrowDown" | "Home" | "End",
	) => {
		const column = columns[index];
		if (column === undefined || !canEdit) return;
		const targetIndex =
			key === "Home"
				? 0
				: key === "End"
					? columns.length - 1
					: index + (key === "ArrowUp" ? -1 : 1);
		if (
			targetIndex < 0 ||
			targetIndex >= columns.length ||
			targetIndex === index
		) {
			setMoveAnnouncement(
				`${columnLabel(column)} is already at the ${targetIndex <= 0 ? "beginning" : "end"} of ${screenName}.`,
			);
			return;
		}
		setMoveAnnouncement(
			`${columnLabel(column)} moved ${key === "ArrowUp" || key === "Home" ? "earlier" : "later"} in ${screenName}.`,
		);
		onMove(column.uuid, targetIndex);
	};

	return (
		<div className="space-y-2" data-display-field-composer={surface}>
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{moveAnnouncement}
			</p>
			{columns.map((column, index) => (
				<ReorderableRow
					key={column.uuid}
					index={index}
					itemKey={column.uuid}
					containerKey={containerKey}
					containerKind={`case-${surface}-fields`}
					pendingDrop={pendingDrop}
					preview={<FieldDragPreview column={column} />}
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
									className="absolute left-3 right-3 z-10 h-0.5 rounded-full bg-nova-violet"
									style={{
										top: closestEdge === "top" ? -5 : undefined,
										bottom: closestEdge === "bottom" ? -5 : undefined,
									}}
								/>
							)}
							<FieldRow
								column={column}
								surface={surface}
								selected={selectedUuid === column.uuid}
								broken={brokenColumns.has(column.uuid)}
								canEdit={canEdit}
								position={index + 1}
								total={columns.length}
								setHandleEl={setHandleEl}
								onMove={(key) => moveByKeyboard(index, key)}
								onSelect={() => onSelect(column)}
							/>
							{previewPortal}
						</div>
					)}
				</ReorderableRow>
			))}
		</div>
	);
}

function FieldRow({
	column,
	surface,
	selected,
	broken,
	canEdit,
	position,
	total,
	setHandleEl,
	onMove,
	onSelect,
}: {
	readonly column: Column;
	readonly surface: DisplaySurface;
	readonly selected: boolean;
	readonly broken: boolean;
	readonly canEdit: boolean;
	readonly position: number;
	readonly total: number;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: "ArrowUp" | "ArrowDown" | "Home" | "End") => void;
	readonly onSelect: () => void;
}) {
	const label = columnLabel(column);
	const screenName = surface === "list" ? "results" : "details";

	return (
		<div
			className={`group/field flex min-h-16 items-stretch overflow-hidden rounded-xl border transition-colors ${
				selected
					? "border-nova-violet bg-nova-violet/[0.08] shadow-[0_0_0_1px_color-mix(in_oklab,var(--nova-violet),transparent_55%)]"
					: broken
						? "border-nova-rose/40 bg-nova-rose/[0.03]"
						: "border-white/[0.07] bg-nova-deep/35 hover:border-nova-border-bright hover:bg-white/[0.025]"
			}`}
			data-case-field-role="visible"
			data-column-uuid={column.uuid}
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
						aria-label={`Move ${label} in ${screenName}. Position ${position} of ${total}. Use arrow keys or drag.`}
						className="grid w-11 shrink-0 cursor-grab place-items-center text-nova-text-muted transition-colors hover:bg-white/[0.035] hover:text-nova-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
					>
						<Icon icon={tablerGripVertical} width="17" height="17" />
					</button>
				</SimpleTooltip>
			)}

			<button
				type="button"
				onClick={onSelect}
				disabled={!canEdit}
				aria-pressed={selected}
				className="flex min-w-0 flex-1 cursor-pointer items-center px-4 py-3 text-left disabled:cursor-default"
			>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-2">
						<span className="truncate text-[14px] font-semibold text-nova-text">
							{label}
						</span>
						{broken && (
							<span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-nova-rose">
								<Icon icon={tablerAlertCircle} width="14" height="14" />
								Needs attention
							</span>
						)}
					</span>
				</span>
			</button>
		</div>
	);
}

/**
 * One calm add affordance owns both normal creation and the rare recovery of
 * information removed from this screen. Off-screen fields never occupy
 * permanent canvas real estate; they appear only after the author asks to add
 * something.
 */
const ADD_INFORMATION_SIDE_OFFSET = 6;
const ADD_INFORMATION_COLLISION_PADDING = 6;
const ADD_INFORMATION_EDGE_CLEARANCE =
	ADD_INFORMATION_SIDE_OFFSET + ADD_INFORMATION_COLLISION_PADDING;
// Header, search, and either one useful choice or the full recovery state.
const ADD_INFORMATION_MIN_READABLE_SPACE = 248;

function chooseAddInformationSide(
	trigger: Pick<DOMRect, "top" | "bottom">,
	viewportHeight: number,
): "top" | "bottom" {
	const spaceBelow =
		viewportHeight - trigger.bottom - ADD_INFORMATION_EDGE_CLEARANCE;
	const spaceAbove = trigger.top - ADD_INFORMATION_EDGE_CLEARANCE;
	if (
		spaceBelow >= ADD_INFORMATION_MIN_READABLE_SPACE ||
		spaceBelow >= spaceAbove
	) {
		return "bottom";
	}
	return "top";
}

export function AddInformationControl({
	surface,
	columns,
	properties,
	repeatableProperties,
	brokenColumns,
	onShow,
	onRepair,
	onCreate,
	onCreateCalculated,
	createDisabledReason,
}: {
	readonly surface: DisplaySurface;
	readonly columns: readonly Column[];
	/** Case properties that do not yet have a display definition anywhere. */
	readonly properties: readonly CaseProperty[];
	/** Properties already shown somewhere, offered only through the quiet
	 * "another way" path so duplicate views stay possible without clutter. */
	readonly repeatableProperties: readonly CaseProperty[];
	readonly brokenColumns: ReadonlySet<string>;
	readonly onShow: (column: Column) => void;
	readonly onRepair: (column: Column) => void;
	readonly onCreate: (property: CaseProperty) => void;
	readonly onCreateCalculated: () => void;
	readonly createDisabledReason: string | undefined;
}) {
	const canEdit = useCanEdit();
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"main" | "alternate">("main");
	const [query, setQuery] = useState("");
	const [pickerSide, setPickerSide] = useState<"top" | "bottom">("bottom");
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const closePicker = () => {
		setQuery("");
		setMode("main");
		setOpen(false);
	};
	const clearSearch = () => {
		setQuery("");
		searchInputRef.current?.focus({ preventScroll: true });
	};
	useEffect(() => {
		if (open && searchInputRef.current?.dataset.addInformationMode === mode) {
			searchInputRef.current.focus({ preventScroll: true });
		}
	}, [open, mode]);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const allProperties = useMemo(() => {
		const byName = new Map<string, CaseProperty>();
		for (const property of [...properties, ...repeatableProperties]) {
			byName.set(canonicalCasePropertyName(property.name), property);
		}
		return [...byName.values()];
	}, [properties, repeatableProperties]);
	const propertyByName = useMemo(
		() =>
			new Map(
				allProperties.map((property) => [
					canonicalCasePropertyName(property.name),
					property,
				]),
			),
		[allProperties],
	);
	const matchesQuery = (text: string) =>
		normalizedQuery === "" ||
		text.toLocaleLowerCase().includes(normalizedQuery);
	const filteredColumns = useMemo(() => {
		if (normalizedQuery === "") return columns;
		return columns.filter((column) =>
			`${columnLabel(column)} ${column.kind === "calculated" ? "calculated value" : column.field}`
				.toLocaleLowerCase()
				.includes(normalizedQuery),
		);
	}, [columns, normalizedQuery]);
	const filteredProperties = useMemo(() => {
		if (normalizedQuery === "") return properties;
		return properties.filter((property) =>
			`${propertyDisplayLabel(property)} ${property.name} ${propertyTypeLabel(property)}`
				.toLocaleLowerCase()
				.includes(normalizedQuery),
		);
	}, [properties, normalizedQuery]);
	const filteredRepeatableProperties = useMemo(() => {
		if (normalizedQuery === "") return repeatableProperties;
		return repeatableProperties.filter((property) =>
			`${propertyDisplayLabel(property)} ${property.name} ${propertyTypeLabel(property)}`
				.toLocaleLowerCase()
				.includes(normalizedQuery),
		);
	}, [repeatableProperties, normalizedQuery]);
	const isCommonProperty = (property: CaseProperty) => {
		const name = canonicalCasePropertyName(property.name);
		return name === "case_name" || !isStandardCaseListProperty(name);
	};
	const isCommonColumn = (column: Column) => {
		if (column.kind === "calculated") return true;
		const name = canonicalCasePropertyName(column.field);
		return name === "case_name" || !isStandardCaseListProperty(name);
	};
	const commonProperties = filteredProperties.filter(isCommonProperty);
	const additionalProperties = filteredProperties.filter(
		(property) => !isCommonProperty(property),
	);
	const commonColumns = filteredColumns.filter(isCommonColumn);
	const additionalColumns = filteredColumns.filter(
		(column) => !isCommonColumn(column),
	);
	const commonRepeatableProperties =
		filteredRepeatableProperties.filter(isCommonProperty);
	const additionalRepeatableProperties = filteredRepeatableProperties.filter(
		(property) => !isCommonProperty(property),
	);
	const showCalculated =
		createDisabledReason === undefined &&
		matchesQuery("Calculated value combine transform case information");
	const showAlternate =
		repeatableProperties.length > 0 &&
		matchesQuery(
			"Show information another way second view label format appearance",
		);
	const hasChoices =
		columns.length > 0 ||
		properties.length > 0 ||
		repeatableProperties.length > 0 ||
		createDisabledReason === undefined;
	const noMainMatches =
		filteredColumns.length === 0 &&
		filteredProperties.length === 0 &&
		!showCalculated &&
		!showAlternate;
	const noMatches =
		(mode === "main" && noMainMatches) ||
		(mode === "alternate" && filteredRepeatableProperties.length === 0);
	if (!canEdit) return null;

	if (!hasChoices) {
		return (
			<AddGhostButton
				label="Add information"
				onClick={() => {}}
				disabledReason={
					createDisabledReason ?? "All available information is already shown."
				}
				className="w-full"
				dataCaseAdd={surface}
			/>
		);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					closePicker();
					return;
				}
				const trigger = triggerRef.current?.getBoundingClientRect();
				if (trigger !== undefined) {
					setPickerSide(chooseAddInformationSide(trigger, window.innerHeight));
				}
				setOpen(true);
			}}
		>
			<PopoverTrigger
				ref={triggerRef}
				type="button"
				aria-label="Add information"
				data-case-add={surface}
				className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-nova-border-bright px-4 text-[13px] text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.06]"
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span>Add information</span>
				<Icon icon={tablerChevronDown} width="14" height="14" />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side={pickerSide}
				sideOffset={ADD_INFORMATION_SIDE_OFFSET}
				collisionPadding={ADD_INFORMATION_COLLISION_PADDING}
				collisionAvoidance={{
					// Choose the readable side once when the picker opens, then keep that
					// side while filtering. Eager collision flipping can move the search
					// field hundreds of pixels as the result list gets shorter.
					side: "none",
					align: "shift",
					fallbackAxisSide: "none",
				}}
				className="h-[min(22rem,calc(var(--available-height)-0.5rem))] w-80 max-w-[calc(var(--available-width)-0.5rem)] gap-0 overflow-hidden p-0"
			>
				<PopoverHeader className="shrink-0 gap-1 px-3 pb-2.5 pt-3">
					<div className="flex items-start gap-2">
						{mode === "alternate" && (
							<button
								type="button"
								aria-label="Back to Add information"
								onClick={() => {
									setQuery("");
									setMode("main");
								}}
								className="-ml-1 grid size-11 shrink-0 place-items-center rounded-lg text-nova-text-muted transition-colors hover:bg-white/[0.05] hover:text-nova-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
							>
								<Icon icon={tablerArrowLeft} width="15" height="15" />
							</button>
						)}
						<div className="min-w-0 pt-0.5">
							<PopoverTitle className="font-display text-[15px] font-semibold text-nova-text">
								{mode === "main"
									? "Add information"
									: "Show information another way"}
							</PopoverTitle>
							<PopoverDescription className="mt-1 text-[12px] leading-relaxed text-nova-text-muted">
								{mode === "main"
									? `Choose what people should see in ${surface === "list" ? "Results" : "Details"}.`
									: "Choose information that needs a second label or format."}
							</PopoverDescription>
						</div>
					</div>
				</PopoverHeader>
				<div className="shrink-0 border-y border-white/[0.06] p-2">
					<label className="flex min-h-11 items-center gap-2 rounded-lg border border-white/[0.08] bg-nova-deep/55 px-3 focus-within:border-nova-violet/40">
						<Icon
							icon={tablerSearch}
							width="14"
							height="14"
							className="shrink-0 text-nova-text-muted"
						/>
						<span className="sr-only">
							{mode === "main"
								? "Search case information"
								: "Search information already shown"}
						</span>
						<input
							ref={searchInputRef}
							data-add-information-mode={mode}
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={
								mode === "main"
									? "Search case information"
									: "Search information already shown"
							}
							autoComplete="off"
							data-1p-ignore
							className="min-w-0 flex-1 bg-transparent text-[13px] text-nova-text outline-none placeholder:text-nova-text-muted"
						/>
					</label>
				</div>
				<div
					className={`min-h-0 flex-1 overflow-y-auto p-1.5 ${noMatches ? "" : "space-y-1"}`}
					data-add-information-scroll-region
				>
					{mode === "main" ? (
						<>
							<MixedChoiceGroup
								label="Common information"
								properties={commonProperties}
								columns={commonColumns}
								allProperties={allProperties}
								propertyByName={propertyByName}
								brokenColumns={brokenColumns}
								onChooseProperty={(property) => {
									closePicker();
									onCreate(property);
								}}
								onChooseColumn={(column) => {
									closePicker();
									if (brokenColumns.has(column.uuid)) onRepair(column);
									else onShow(column);
								}}
							/>
							<MixedChoiceGroup
								label="More case information"
								properties={additionalProperties}
								columns={additionalColumns}
								allProperties={allProperties}
								propertyByName={propertyByName}
								brokenColumns={brokenColumns}
								onChooseProperty={(property) => {
									closePicker();
									onCreate(property);
								}}
								onChooseColumn={(column) => {
									closePicker();
									if (brokenColumns.has(column.uuid)) onRepair(column);
									else onShow(column);
								}}
							/>
							{(showCalculated || showAlternate) && (
								<div className="mt-1 border-t border-white/[0.06] pt-1">
									{showCalculated && (
										<InformationChoice
											label="Calculated value"
											detail="Combine or transform case information"
											icon={tablerMathFunction}
											quiet
											onClick={() => {
												closePicker();
												onCreateCalculated();
											}}
										/>
									)}
									{showAlternate && (
										<InformationChoice
											label="Show information another way…"
											detail="Add a second view with its own label or format"
											icon={tablerCopy}
											quiet
											onClick={() => {
												setQuery("");
												setMode("alternate");
											}}
										/>
									)}
								</div>
							)}
						</>
					) : (
						<>
							<PropertyChoiceGroup
								label="Common information"
								properties={commonRepeatableProperties}
								allProperties={allProperties}
								detailSuffix="Add a second label or format"
								onChoose={(property) => {
									closePicker();
									onCreate(property);
								}}
							/>
							<PropertyChoiceGroup
								label="More case information"
								properties={additionalRepeatableProperties}
								allProperties={allProperties}
								detailSuffix="Add a second label or format"
								onChoose={(property) => {
									closePicker();
									onCreate(property);
								}}
							/>
						</>
					)}
					{noMatches && (
						<div
							className="grid h-full min-h-24 place-items-center px-4 py-5 text-center"
							data-add-information-empty
						>
							<div>
								<p
									role="status"
									className="text-[13px] font-medium text-nova-text"
								>
									No matching information
								</p>
								<p className="mt-1 text-[12px] text-nova-text-muted">
									Try another word, or browse everything again.
								</p>
								<button
									type="button"
									onClick={clearSearch}
									className="mt-3 min-h-11 rounded-lg px-3 text-[12px] font-medium text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
								>
									Clear search
								</button>
							</div>
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function MixedChoiceGroup({
	label,
	properties,
	columns,
	allProperties,
	propertyByName,
	brokenColumns,
	onChooseProperty,
	onChooseColumn,
}: {
	readonly label: string;
	readonly properties: readonly CaseProperty[];
	readonly columns: readonly Column[];
	readonly allProperties: readonly CaseProperty[];
	readonly propertyByName: ReadonlyMap<string, CaseProperty>;
	readonly brokenColumns: ReadonlySet<string>;
	readonly onChooseProperty: (property: CaseProperty) => void;
	readonly onChooseColumn: (column: Column) => void;
}) {
	return (
		<InformationChoiceGroup
			label={label}
			show={properties.length > 0 || columns.length > 0}
		>
			{properties.map((property) => (
				<PropertyChoice
					key={property.name}
					property={property}
					allProperties={allProperties}
					onChoose={onChooseProperty}
				/>
			))}
			{columns.map((column) => {
				const broken = brokenColumns.has(column.uuid);
				const property =
					column.kind === "calculated"
						? undefined
						: propertyByName.get(canonicalCasePropertyName(column.field));
				const valueKind =
					column.kind === "calculated"
						? "Calculated value"
						: property === undefined
							? undefined
							: propertyTypeLabel(property);
				const detail = broken
					? "Needs a quick fix"
					: valueKind === undefined
						? "Keeps its current format"
						: `${valueKind} · Keeps its current format`;
				return (
					<InformationChoice
						key={column.uuid}
						label={columnLabel(column)}
						detail={detail}
						tone={broken ? "attention" : "normal"}
						onClick={() => onChooseColumn(column)}
					/>
				);
			})}
		</InformationChoiceGroup>
	);
}

function InformationChoiceGroup({
	label,
	show,
	children,
}: {
	readonly label: string;
	readonly show: boolean;
	readonly children: React.ReactNode;
}) {
	if (!show) return null;
	return (
		<section>
			<h3 className="px-2 pb-1 pt-1.5 text-[11px] font-semibold text-nova-text-muted">
				{label}
			</h3>
			<div>{children}</div>
		</section>
	);
}

function PropertyChoiceGroup({
	label,
	properties,
	allProperties,
	detailSuffix,
	onChoose,
}: {
	readonly label: string;
	readonly properties: readonly CaseProperty[];
	readonly allProperties: readonly CaseProperty[];
	readonly detailSuffix?: string;
	readonly onChoose: (property: CaseProperty) => void;
}) {
	return (
		<InformationChoiceGroup label={label} show={properties.length > 0}>
			{properties.map((property) => (
				<PropertyChoice
					key={property.name}
					property={property}
					allProperties={allProperties}
					detailSuffix={detailSuffix}
					onChoose={onChoose}
				/>
			))}
		</InformationChoiceGroup>
	);
}

function PropertyChoice({
	property,
	allProperties,
	detailSuffix,
	onChoose,
}: {
	readonly property: CaseProperty;
	readonly allProperties: readonly CaseProperty[];
	readonly detailSuffix?: string;
	readonly onChoose: (property: CaseProperty) => void;
}) {
	const disambiguator = friendlyPropertyDisambiguator(property, allProperties);
	const detail = [propertyTypeLabel(property), disambiguator, detailSuffix]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	return (
		<InformationChoice
			label={propertyDisplayLabel(property)}
			detail={detail}
			onClick={() => onChoose(property)}
		/>
	);
}

function InformationChoice({
	label,
	detail,
	tone = "normal",
	icon = tablerPlus,
	quiet = false,
	onClick,
}: {
	readonly label: string;
	readonly detail: string;
	readonly tone?: "normal" | "attention";
	readonly icon?: IconifyIcon;
	readonly quiet?: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-nova-violet/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
		>
			<span
				className={`grid size-7 shrink-0 place-items-center rounded-lg ${quiet ? "bg-white/[0.035] text-nova-text-muted" : "bg-nova-violet/[0.08] text-nova-violet-bright"}`}
			>
				<Icon icon={icon} width="14" height="14" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-medium text-nova-text">
					{label}
				</span>
				<span
					className={`block truncate text-[11px] ${tone === "attention" ? "text-nova-rose" : "text-nova-text-muted"}`}
				>
					{detail}
				</span>
			</span>
		</button>
	);
}

function FieldDragPreview({ column }: { readonly column: Column }) {
	return (
		<div className="inline-flex items-center gap-2 rounded-xl border border-nova-violet/35 bg-nova-surface/95 px-3 py-2 text-[13px] text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="15"
				height="15"
				className="text-nova-text-muted"
			/>
			<span className="max-w-[240px] truncate">{columnLabel(column)}</span>
		</div>
	);
}
