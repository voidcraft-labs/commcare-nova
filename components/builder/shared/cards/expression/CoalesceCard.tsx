// components/builder/shared/cards/expression/CoalesceCard.tsx
//
// Renders the `coalesce` ValueExpression — first-non-empty fallback
// chain. Each `values[i]` is a recursive `ValueExpression`; the
// result type is the agreed type across all values (per
// `accumulateBranchType` in the type checker). Drag-and-drop
// reorders the values via the shared `useReorderableList`
// + `<ReorderableRow>` primitives.
//
// Schema invariant: `values` is non-empty (`z.tuple([first], rest)`).
// The card refuses to remove the last remaining row so the AST
// stays parseable. New rows append a typed-null literal so the
// type checker accepts the seed without a "values must agree on
// type" error fired against an empty-string seed.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	ANY_CONSTRAINT,
	branchConstraint,
	coalesce,
	literal,
	type SlotConstraint,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { usePredicateEditContext } from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { expressionCardSchemas } from "../../expressionEditorSchemas";
import { appendSlotIndex, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";
import {
	ReorderableRow,
	type ReorderKeyboardKey,
	reorderByKeyboard,
	useReorderableList,
} from "../../useReorderableList";
import { useStableListIdentity } from "../../useStableListIdentity";
import { resolveExpressionType } from "../reseed";

/** Default `coalesce` — two null literals. Both values resolve to
 *  the `_any` sentinel so the `accumulateBranchType` agreement
 *  check accepts the seed clean. Authors flip values via the per-
 *  row picker. */
export function coalesceDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "coalesce" }> {
	return coalesce(term(literal(null)), term(literal(null)));
}

interface CoalesceCardProps {
	readonly value: Extract<ValueExpression, { kind: "coalesce" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	/** The coalesce's own result constraint propagates to every value —
	 *  the result is whichever value resolves first, so each must
	 *  satisfy the slot. */
	readonly constraint?: SlotConstraint;
}

export function CoalesceCard({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
}: CoalesceCardProps) {
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const ctx = usePredicateEditContext();
	const rowIdentity = useStableListIdentity(value.values);
	const valueTypes = useMemo(
		() => value.values.map((item) => resolveExpressionType(item, ctx)),
		[value.values, ctx],
	);

	const apply = (
		values: readonly ValueExpression[],
	): Extract<ValueExpression, { kind: "coalesce" }> => {
		const [first, ...rest] = values;
		// Runtime contract guarantees `values.length >= 1` (no path
		// mutates the array to empty), so destructuring is sound; the
		// `coalesce` builder's variadic-with-required-first signature
		// ties the call together. The builder's declared return type
		// is the precise `Extract<ValueExpression, { kind: "coalesce" }>`
		// arm — no narrowing cast needed.
		return coalesce(first, ...rest);
	};

	const { pendingDrop } = useReorderableList({
		containerKey,
		containerKind: "coalesce",
		items: value.values,
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

	const updateValue = (index: number, next: ValueExpression) => {
		const updated = value.values.map((item, itemIndex) =>
			itemIndex === index ? next : item,
		);
		rowIdentity.stage(updated, { kind: "replace" });
		onChange(apply(updated));
	};

	const removeValue = (index: number) => {
		if (value.values.length === 1) return;
		const filtered = value.values.filter((_, i) => i !== index);
		rowIdentity.stage(filtered, {
			kind: "splice",
			index,
			deleteCount: 1,
			insertCount: 0,
		});
		onChange(apply(filtered));
	};

	const append = () => {
		const next = [...value.values, term(literal(null))];
		rowIdentity.stage(next, {
			kind: "splice",
			index: value.values.length,
			deleteCount: 0,
			insertCount: 1,
		});
		onChange(apply(next));
	};

	const moveValue = (index: number, key: ReorderKeyboardKey) => {
		const result = reorderByKeyboard(value.values, index, key);
		const towardStart = key === "ArrowUp" || key === "Home";
		if (result === undefined) {
			setMoveAnnouncement(
				`Fallback ${index + 1} is already at the ${towardStart ? "beginning" : "end"}`,
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
			`Fallback ${index + 1} moved ${towardStart ? "earlier" : "later"}`,
		);
	};

	return (
		<div className="space-y-2">
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{moveAnnouncement}
			</p>
			<div className="text-[13px] leading-relaxed text-nova-text-muted">
				Use the first value that isn't blank
			</div>
			{value.values.map((v, i) => (
				<ReorderableRow
					key={rowIdentity.keys[i]}
					index={i}
					itemKey={rowIdentity.keys[i]}
					containerKey={containerKey}
					containerKind="coalesce"
					pendingDrop={pendingDrop}
					preview={<CoalesceValueDragPreview index={i} />}
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
							<ValueRow
								valueExpr={v}
								isOnlyOne={value.values.length === 1}
								onUpdate={(next) => updateValue(i, next)}
								onRemove={() => removeValue(i)}
								setHandleEl={setHandleEl}
								onMove={(key) => moveValue(i, key)}
								reorderLabel={`Move fallback ${i + 1} of ${value.values.length}`}
								path={appendSlotIndex(path, "values", i)}
								constraint={branchConstraint(
									constraint,
									...valueTypes.filter((_, valueIndex) => valueIndex !== i),
								)}
							/>
							{previewPortal}
						</div>
					)}
				</ReorderableRow>
			))}
			<Button
				type="button"
				variant="outline"
				size="xl"
				onClick={append}
				data-removal-focus-fallback
				className="w-full border-dashed text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:text-nova-violet-bright"
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span>Add another value</span>
			</Button>
		</div>
	);
}

interface ValueRowProps {
	readonly valueExpr: ValueExpression;
	readonly isOnlyOne: boolean;
	readonly onUpdate: (next: ValueExpression) => void;
	readonly onRemove: () => void;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: ReorderKeyboardKey) => void;
	readonly reorderLabel: string;
	readonly path: EditorPath;
	readonly constraint: SlotConstraint;
}

function ValueRow({
	valueExpr,
	isOnlyOne,
	onUpdate,
	onRemove,
	setHandleEl,
	onMove,
	reorderLabel,
	path,
	constraint,
}: ValueRowProps) {
	// Per-value errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at the matching slot path — no parallel
	// `<InlineError>` is needed here.
	return (
		<ExpressionPicker
			value={valueExpr}
			onChange={onUpdate}
			path={path}
			constraint={constraint}
			variant="nested"
			dragHandleRef={setHandleEl}
			onMove={onMove}
			reorderLabel={reorderLabel}
			onRemove={isOnlyOne ? undefined : onRemove}
		/>
	);
}

function CoalesceValueDragPreview({ index }: { readonly index: number }) {
	const schema = expressionCardSchemas.coalesce;
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={schema.icon}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<span className="max-w-[240px] truncate">Fallback {index + 1}</span>
		</div>
	);
}
