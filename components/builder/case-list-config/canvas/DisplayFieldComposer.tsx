// components/builder/case-list-config/canvas/DisplayFieldComposer.tsx
//
// The direct-manipulation field stack shared by Results and Details.
// Each screen owns its own order: the row the author drags is the row the
// worker sees in that screen. The right rail remains the home for one field's
// formatting and data source; membership and order live here, where their
// effect is visible.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerCopy from "@iconify-icons/tabler/copy";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId, useMemo, useState } from "react";
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
import { AddGhostButton, AuthoredDragPreviewLabel } from "./canvasChrome";

export type DisplaySurface = "list" | "detail";

export interface DisplayFieldComposerProps {
	readonly columns: readonly Column[];
	readonly surface: DisplaySurface;
	readonly selectedUuid: string | null;
	readonly brokenColumns: ReadonlySet<string>;
	readonly onSelect: (column: Column) => void;
	readonly onMove: (uuid: Column["uuid"], toIndex: number) => void;
}

function isCommonCaseProperty(property: CaseProperty): boolean {
	const name = canonicalCasePropertyName(property.name);
	return name === "case_name" || !isStandardCaseListProperty(name);
}

function isCommonCaseColumn(column: Column): boolean {
	if (column.kind === "calculated") return true;
	const name = canonicalCasePropertyName(column.field);
	return name === "case_name" || !isStandardCaseListProperty(name);
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
		itemKeys: columns.map((column) => column.uuid),
		onReorder: (_next, move) => {
			if (canEdit) onMove(move.item.uuid, move.toIndex);
		},
	});

	const screenName = surface === "list" ? "Results" : "Details";

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
				`${columnLabel(column)} is already at the ${targetIndex <= 0 ? "beginning" : "end"} of ${screenName}`,
			);
			return;
		}
		setMoveAnnouncement(
			`${columnLabel(column)} moved ${key === "ArrowUp" || key === "Home" ? "earlier" : "later"} in ${screenName}`,
		);
		onMove(column.uuid, targetIndex);
	};

	return (
		<div data-display-field-composer={surface}>
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{moveAnnouncement}
			</p>
			<ol
				aria-label={`${screenName} information`}
				className="list-none space-y-2 p-0"
			>
				{columns.map((column, index) => (
					<li key={column.uuid}>
						<ReorderableRow
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
					</li>
				))}
			</ol>
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
	const screenName = surface === "list" ? "Results" : "Details";
	const rowContent = (
		<span className="min-w-0 flex-1">
			<span className="flex min-w-0 items-start gap-2">
				<span className="min-w-0 flex-1 break-words whitespace-normal text-[14px] font-semibold text-nova-text">
					{label}
				</span>
				{broken && (
					<span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-nova-rose">
						<Icon icon={tablerAlertCircle} width="14" height="14" />
						{canEdit ? "Needs attention" : "May not appear"}
					</span>
				)}
			</span>
		</span>
	);

	return (
		<div
			className={`group/field flex min-h-16 items-stretch overflow-hidden rounded-xl border transition-colors ${
				selected
					? "border-nova-violet bg-nova-violet/[0.08] shadow-[0_0_0_1px_color-mix(in_oklab,var(--nova-violet),transparent_55%)]"
					: broken
						? "border-nova-rose/40 bg-nova-rose/[0.03]"
						: canEdit
							? "border-white/[0.07] bg-nova-deep/35 hover:border-nova-border-bright hover:bg-white/[0.025]"
							: "border-white/[0.07] bg-nova-deep/35"
			}`}
			data-case-field-role="visible"
			data-column-uuid={column.uuid}
		>
			{canEdit && (
				<SimpleTooltip content="Drag or use arrow keys" side="left">
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
						aria-label={`Move ${label} in ${screenName}. Position ${position} of ${total}. Use arrow keys or drag.`}
						className="h-auto w-11 shrink-0 cursor-grab rounded-l-xl rounded-r-none px-0 text-nova-text-muted hover:bg-white/[0.035] hover:text-nova-text focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet dark:hover:bg-white/[0.035]"
					>
						<Icon icon={tablerGripVertical} width="17" height="17" />
					</Button>
				</SimpleTooltip>
			)}

			{canEdit ? (
				<Button
					type="button"
					variant="ghost"
					onClick={onSelect}
					aria-pressed={selected}
					data-case-column-select={column.uuid}
					className="h-auto min-w-0 flex-1 justify-start rounded-none px-4 py-3 text-left whitespace-normal active:not-aria-[haspopup]:translate-y-0 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet not-disabled:hover:bg-transparent dark:not-disabled:hover:bg-transparent"
				>
					{rowContent}
				</Button>
			) : (
				<div className="flex min-w-0 flex-1 items-center px-4 py-3 text-left">
					{rowContent}
				</div>
			)}
		</div>
	);
}

/**
 * One calm add affordance owns both normal creation and the rare recovery of
 * information removed from this screen. Off-screen fields never occupy
 * permanent canvas real estate; they appear only after the author asks to add
 * something.
 */
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
	const [mode, setMode] = useState<"main" | "alternate">("main");
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
	type ChoiceValue =
		| { readonly kind: "property"; readonly property: CaseProperty }
		| { readonly kind: "column"; readonly column: Column }
		| { readonly kind: "calculated" }
		| { readonly kind: "alternate" };
	const choices = useMemo<readonly SearchableChoice<ChoiceValue>[]>(() => {
		const propertyChoice = (
			property: CaseProperty,
			group: string,
			repeat = false,
		): SearchableChoice<ChoiceValue> => {
			const disambiguator = friendlyPropertyDisambiguator(
				property,
				allProperties,
			);
			return {
				id: `${repeat ? "repeat" : "property"}:${canonicalCasePropertyName(property.name)}`,
				label: propertyDisplayLabel(property),
				detail: [
					propertyTypeLabel(property),
					disambiguator,
					repeat ? "Add a second label or format" : undefined,
				]
					.filter((part): part is string => part !== undefined)
					.join(" · "),
				group,
				icon: tablerPlus,
				searchText: property.name,
				value: { kind: "property", property },
			};
		};
		if (mode === "alternate") {
			return repeatableProperties.map((property) =>
				propertyChoice(
					property,
					isCommonCaseProperty(property)
						? "Common information"
						: "More case information",
					true,
				),
			);
		}

		const next: SearchableChoice<ChoiceValue>[] = properties.map((property) =>
			propertyChoice(
				property,
				isCommonCaseProperty(property)
					? "Common information"
					: "More case information",
			),
		);
		for (const column of columns) {
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
			const placement =
				surface === "list"
					? column.visibleInDetail !== false
						? "Also shown in Details"
						: "Saved label and format"
					: column.visibleInList !== false
						? "Also shown in Results"
						: "Saved label and format";
			next.push({
				id: `column:${column.uuid}`,
				label: columnLabel(column),
				detail: broken
					? "Needs attention"
					: valueKind === undefined
						? placement
						: `${valueKind} · ${placement}`,
				group: isCommonCaseColumn(column)
					? "Common information"
					: "More case information",
				icon: tablerPlus,
				searchText:
					column.kind === "calculated" ? "calculated value" : column.field,
				tone: broken ? "attention" : "normal",
				value: { kind: "column", column },
			});
		}
		if (createDisabledReason === undefined) {
			next.push({
				id: "calculated",
				label: "Calculated value",
				detail: "Build a value from case information",
				group: "More options",
				icon: tablerMathFunction,
				quiet: true,
				searchText: "combine transform case information",
				value: { kind: "calculated" },
			});
		}
		if (repeatableProperties.length > 0) {
			next.push({
				id: "alternate",
				label: "Show information another way",
				detail: "Use another label or format for information already shown",
				group: "More options",
				icon: tablerCopy,
				quiet: true,
				keepOpen: true,
				searchText: "second view label format appearance",
				value: { kind: "alternate" },
			});
		}
		return next;
	}, [
		allProperties,
		brokenColumns,
		columns,
		createDisabledReason,
		mode,
		properties,
		propertyByName,
		repeatableProperties,
		surface,
	]);
	const hasChoices =
		columns.length > 0 ||
		properties.length > 0 ||
		repeatableProperties.length > 0 ||
		createDisabledReason === undefined;
	if (!canEdit) return null;

	if (!hasChoices) {
		return (
			<AddGhostButton
				label="Add information"
				onClick={() => {}}
				disabledReason={
					createDisabledReason ?? "All available information is already shown"
				}
				className="w-full"
				dataCaseAdd={surface}
			/>
		);
	}

	return (
		<SearchableChoiceCombobox
			choices={choices}
			onChoose={(choice) => {
				switch (choice.value.kind) {
					case "alternate":
						setMode("alternate");
						return;
					case "calculated":
						onCreateCalculated();
						return;
					case "property":
						onCreate(choice.value.property);
						return;
					case "column":
						if (brokenColumns.has(choice.value.column.uuid)) {
							onRepair(choice.value.column);
						} else {
							onShow(choice.value.column);
						}
				}
			}}
			trigger={
				<Button
					type="button"
					variant="outline"
					size="xl"
					data-case-add={surface}
					className="min-h-11 w-full gap-2 rounded-lg border-dashed border-nova-border-bright bg-transparent px-4 text-sm text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.06] dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.06]"
				/>
			}
			triggerLabel="Add information"
			triggerContent={
				<>
					<Icon icon={tablerPlus} width="14" height="14" />
					<span className="flex-1">Add information</span>
				</>
			}
			heading={
				mode === "main" ? "Add information" : "Show information another way"
			}
			description={
				mode === "main"
					? `Choose what people see in ${surface === "list" ? "Results" : "Details"}`
					: "Choose information to show with a different label or format"
			}
			searchLabel={
				mode === "main"
					? "Search case information"
					: "Search information already shown"
			}
			searchPlaceholder={
				mode === "main"
					? "Search case information"
					: "Search information already shown"
			}
			headerAction={
				mode === "alternate"
					? (clearSearch) => (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label="Back to Add information"
								onClick={() => {
									clearSearch();
									setMode("main");
								}}
								className="-ml-1 size-11 shrink-0 text-nova-text-muted not-disabled:hover:bg-white/[0.05] not-disabled:hover:text-nova-text dark:not-disabled:hover:bg-white/[0.05]"
							>
								<Icon icon={tablerArrowLeft} width="15" height="15" />
							</Button>
						)
					: undefined
			}
			onClosed={() => setMode("main")}
			contentClassName="max-h-[min(22rem,var(--available-height))]"
		/>
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
			<AuthoredDragPreviewLabel>{columnLabel(column)}</AuthoredDragPreviewLabel>
		</div>
	);
}
