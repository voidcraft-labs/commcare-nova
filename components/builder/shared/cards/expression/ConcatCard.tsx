// components/builder/shared/cards/expression/ConcatCard.tsx
//
// Renders the `concat` ValueExpression — variadic string
// concatenation. Each `parts[i]` is a recursive `ValueExpression`;
// the result type is always `text`. Drag-and-drop reorders the
// parts in place via the shared `useReorderableList`
// + `<ReorderableRow>` primitives.
//
// Schema invariant: `parts` is non-empty (`z.tuple([first], rest)`).
// The card refuses to remove the last remaining row so the AST
// never enters an unparseable state. Adding rows appends an empty
// text-literal seed; the type checker has nothing to flag for the
// concat operator beyond per-part resolution failures.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	concat,
	concatPartConstraint,
	literal,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
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

/** Default `concat` — two empty text literals. The schema rejects
 *  empty parts; seeding two rows lets the user immediately see the
 *  multi-row structure rather than having to discover the "Add part"
 *  affordance. */
export function concatDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "concat" }> {
	return concat(term(literal("")), term(literal("")));
}

/** Every part casts to text at evaluation, so the part slot accepts
 *  any value type — module-const for a stable identity across renders. */
const PART_CONSTRAINT = concatPartConstraint();

interface ConcatCardProps {
	readonly value: Extract<ValueExpression, { kind: "concat" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function ConcatCard({ value, onChange, path }: ConcatCardProps) {
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const rowIdentity = useStableListIdentity(value.parts);

	// Build the next concat from a transformed parts array. Every
	// code path here guarantees `parts.length >= 1` (the "Add" button
	// only appends; the "Remove" button refuses to delete the last
	// remaining row), so destructuring `[first, ...rest]` is sound at
	// runtime; the `concat` builder's variadic-with-required-first
	// signature ties the call together. `concat`'s declared return
	// type is the precise `Extract<ValueExpression, { kind: "concat" }>`
	// arm — no narrowing cast needed.
	const apply = (
		parts: readonly ValueExpression[],
	): Extract<ValueExpression, { kind: "concat" }> => {
		const [first, ...rest] = parts;
		return concat(first, ...rest);
	};

	const { pendingDrop } = useReorderableList({
		containerKey,
		containerKind: "concat",
		items: value.parts,
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

	const updatePart = (index: number, next: ValueExpression) => {
		const updated = value.parts.map((part, partIndex) =>
			partIndex === index ? next : part,
		);
		rowIdentity.stage(updated, { kind: "replace" });
		onChange(apply(updated));
	};

	const removePart = (index: number) => {
		// Schema requires non-empty; refuse the last row's removal.
		if (value.parts.length === 1) return;
		const filtered = value.parts.filter((_, i) => i !== index);
		rowIdentity.stage(filtered, {
			kind: "splice",
			index,
			deleteCount: 1,
			insertCount: 0,
		});
		onChange(apply(filtered));
	};

	const append = () => {
		const next = [...value.parts, term(literal(""))];
		rowIdentity.stage(next, {
			kind: "splice",
			index: value.parts.length,
			deleteCount: 0,
			insertCount: 1,
		});
		onChange(apply(next));
	};

	const movePart = (index: number, key: ReorderKeyboardKey) => {
		const result = reorderByKeyboard(value.parts, index, key);
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
				Join these values in order
			</div>
			{value.parts.map((part, i) => (
				<ReorderableRow
					key={rowIdentity.keys[i]}
					index={i}
					itemKey={rowIdentity.keys[i]}
					containerKey={containerKey}
					containerKind="concat"
					pendingDrop={pendingDrop}
					preview={<ConcatPartDragPreview index={i} />}
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
							<PartRow
								part={part}
								partIndex={i}
								isOnlyOne={value.parts.length === 1}
								onUpdate={(next) => updatePart(i, next)}
								onRemove={() => removePart(i)}
								setHandleEl={setHandleEl}
								onMove={(key) => movePart(i, key)}
								reorderLabel={`Move value ${i + 1} of ${value.parts.length}`}
								path={appendSlotIndex(path, "parts", i)}
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
				<span>Add value</span>
			</Button>
		</div>
	);
}

interface PartRowProps {
	readonly part: ValueExpression;
	readonly partIndex: number;
	readonly isOnlyOne: boolean;
	readonly onUpdate: (next: ValueExpression) => void;
	readonly onRemove: () => void;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: ReorderKeyboardKey) => void;
	readonly reorderLabel: string;
	readonly path: EditorPath;
}

function PartRow({
	part,
	isOnlyOne,
	onUpdate,
	onRemove,
	setHandleEl,
	onMove,
	reorderLabel,
	path,
}: PartRowProps) {
	// Per-part errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at the matching slot path — no parallel
	// `<InlineError>` is needed here.
	return (
		<ExpressionPicker
			value={part}
			onChange={onUpdate}
			path={path}
			// Each part casts to text at evaluation, so every value type
			// is admissible here — the constraint admits everything.
			constraint={PART_CONSTRAINT}
			variant="nested"
			dragHandleRef={setHandleEl}
			onMove={onMove}
			reorderLabel={reorderLabel}
			onRemove={isOnlyOne ? undefined : onRemove}
		/>
	);
}

/** Custom drag preview rendered in place of the browser's default
 *  source snapshot. Without it, the browser would snapshot the
 *  14×14 grip icon and the user couldn't see what's being moved.
 *  Mirrors `ClauseDragPreview` in `LogicalGroupCard`. */
function ConcatPartDragPreview({ index }: { readonly index: number }) {
	const schema = expressionCardSchemas.concat;
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
			<span className="max-w-[240px] truncate">Part {index + 1}</span>
		</div>
	);
}
