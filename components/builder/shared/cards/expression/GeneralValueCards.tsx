"use client";

import { Icon } from "@iconify/react/offline";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerListSearch from "@iconify-icons/tabler/list-search";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	ANY_CONSTRAINT,
	type Expression,
	type ExpressionOfKind,
	literal,
	numericConstraint,
	type SlotConstraint,
	term,
	valueList,
} from "@/lib/domain/expression";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendKindSlot, appendSlotIndex, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";
import {
	ReorderableRow,
	type ReorderKeyboardKey,
	reorderByKeyboard,
	useReorderableList,
} from "../../useReorderableList";
import { useStableListIdentity } from "../../useStableListIdentity";
import { reseedValueForConstraint } from "../reseed";

interface GeneralValueCardProps<
	K extends "negate" | "here" | "case-list-search-text" | "value-list",
> {
	readonly value: ExpressionOfKind<K>;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function NegateCard({
	value,
	onChange,
	path,
}: GeneralValueCardProps<"negate">) {
	return (
		<ExpressionPicker
			value={value.value}
			onChange={(next) => onChange({ ...value, value: next })}
			path={appendKindSlot(path, "negate", "value")}
			constraint={numericConstraint()}
			variant="nested"
		/>
	);
}

export function HereCard(_props: GeneralValueCardProps<"here">) {
	return (
		<p className="text-[13px] text-nova-text-muted">
			Where the worker is when the case list shows.
		</p>
	);
}

export function CaseListSearchTextCard(
	_props: GeneralValueCardProps<"case-list-search-text">,
) {
	return (
		<p className="text-[13px] text-nova-text-muted">
			What the worker typed into the case list's search box, blank when they
			typed nothing.
		</p>
	);
}

/** The registry's list of values: one empty text value, which the value
 *  menu seeds for the slot the list stands in
 *  (`ExpressionPicker.tsx::defaultExpressionForSlot`). */
export function valueListDefault(
	_ctx: ExpressionEditContext,
): ExpressionOfKind<"value-list"> {
	return valueList(term(literal("")));
}

interface ValueListCardProps extends GeneralValueCardProps<"value-list"> {
	/** The slot the list stands in: every value is compared with the same
	 *  case value, so each row takes this constraint. */
	readonly constraint?: SlotConstraint;
}

/** Several values a case value is compared with by "is" or "isn't", any one
 * of which matches: offered where only CommCare's server search reads the
 * slot. Each value is edited in its own row, as `ConcatCard` edits its parts:
 * reordered by drag or from the handle with the keyboard, removed by its own
 * action except the last, and one appended by "Add a value". */
export function ValueListCard({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
}: ValueListCardProps) {
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const rowIdentity = useStableListIdentity(value.items);

	const apply = (
		items: readonly Expression[],
	): ExpressionOfKind<"value-list"> => {
		const [first, ...rest] = items;
		return valueList(first, ...rest);
	};

	const { pendingDrop } = useReorderableList({
		containerKey,
		containerKind: "value-list",
		items: value.items,
		itemKeys: rowIdentity.keys,
		onReorder: (next, move) => {
			rowIdentity.stage(next, {
				kind: "move",
				fromIndex: move.fromIndex,
				toIndex: move.toIndex,
			});
			onChange(apply(next));
		},
	});

	const updateItem = (index: number, next: Expression) => {
		const updated = value.items.map((item, itemIndex) =>
			itemIndex === index ? next : item,
		);
		rowIdentity.stage(updated, { kind: "replace" });
		onChange(apply(updated));
	};

	const removeItem = (index: number) => {
		// A list holds one value or more; the last row has no remove action.
		if (value.items.length === 1) return;
		const filtered = value.items.filter((_, i) => i !== index);
		rowIdentity.stage(filtered, {
			kind: "splice",
			index,
			deleteCount: 1,
			insertCount: 0,
		});
		onChange(apply(filtered));
	};

	const append = () => {
		const seed = term(literal(""));
		const next = [
			...value.items,
			constraint.accepts === "any"
				? seed
				: reseedValueForConstraint(seed, constraint.accepts),
		];
		rowIdentity.stage(next, {
			kind: "splice",
			index: value.items.length,
			deleteCount: 0,
			insertCount: 1,
		});
		onChange(apply(next));
	};

	const moveItem = (index: number, key: ReorderKeyboardKey) => {
		const result = reorderByKeyboard(value.items, index, key);
		const towardStart = key === "ArrowUp" || key === "Home";
		if (result === undefined) {
			setMoveAnnouncement(
				`Value ${index + 1} is already at the ${towardStart ? "beginning" : "end"}`,
			);
			return;
		}
		rowIdentity.stage(result.items, {
			kind: "move",
			fromIndex: result.move.fromIndex,
			toIndex: result.move.toIndex,
		});
		onChange(apply(result.items));
		setMoveAnnouncement(
			`Value ${index + 1} moved ${towardStart ? "earlier" : "later"}`,
		);
	};

	return (
		<div className="space-y-2" data-value-list>
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{moveAnnouncement}
			</p>
			<div className="text-[13px] font-medium text-nova-text-secondary">
				Any of these values
			</div>
			{value.items.map((item, i) => (
				<ReorderableRow
					key={rowIdentity.keys[i]}
					index={i}
					itemKey={rowIdentity.keys[i]}
					containerKey={containerKey}
					containerKind="value-list"
					pendingDrop={pendingDrop}
					preview={<ValueListItemDragPreview index={i} />}
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
							data-removal-focus-row
							data-value-list-item={i}
							className={`relative ${beingMoved ? "opacity-50" : ""}`}
						>
							{closestEdge !== null && (
								<div
									aria-hidden="true"
									className="absolute left-0 right-0 h-0.5 bg-nova-violet rounded-full"
									style={{
										top: closestEdge === "top" ? -3 : undefined,
										bottom: closestEdge === "bottom" ? -3 : undefined,
									}}
								/>
							)}
							<ExpressionPicker
								value={item}
								onChange={(next) => updateItem(i, next)}
								path={appendSlotIndex(path, "items", i)}
								constraint={constraint}
								variant="nested"
								dragHandleRef={setHandleEl}
								onMove={(key) => moveItem(i, key)}
								reorderLabel={`Move value ${i + 1} of ${value.items.length}`}
								onRemove={
									value.items.length === 1 ? undefined : () => removeItem(i)
								}
								removeLabel={`Remove value ${i + 1}`}
							/>
							{previewPortal}
						</div>
					)}
				</ReorderableRow>
			))}
			<Button
				type="button"
				variant="ghost"
				onClick={append}
				data-removal-focus-fallback
				className="nova-add-slot w-full"
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span>Add a value</span>
			</Button>
		</div>
	);
}

/** The drag preview of one value, in place of the browser's snapshot of the
 *  grip icon. */
function ValueListItemDragPreview({ index }: { readonly index: number }) {
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={tablerListSearch}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<span className="max-w-[240px] truncate">Value {index + 1}</span>
		</div>
	);
}
