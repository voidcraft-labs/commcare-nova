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
import {
	concat,
	literal,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { expressionCardSchemas } from "../../expressionEditorSchemas";
import { nodeId } from "../../nodeIdentity";
import { appendSlotIndex, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";
import { ReorderableRow, useReorderableList } from "../../useReorderableList";

/** Default `concat` — two empty text literals. The schema rejects
 *  empty parts; seeding two rows lets the user immediately see the
 *  multi-row structure rather than having to discover the "Add part"
 *  affordance. */
export function concatDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "concat" }> {
	return concat(term(literal("")), term(literal("")));
}

interface ConcatCardProps {
	readonly value: Extract<ValueExpression, { kind: "concat" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function ConcatCard({ value, onChange, path }: ConcatCardProps) {
	const containerKey = nodeId(value);

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
		onReorder: (next) => onChange(apply(next)),
	});

	const updatePart = (index: number, next: ValueExpression) => {
		const updated = value.parts.map((p, i) => (i === index ? next : p));
		onChange(apply(updated));
	};

	const removePart = (index: number) => {
		// Schema requires non-empty; refuse the last row's removal.
		if (value.parts.length === 1) return;
		const filtered = value.parts.filter((_, i) => i !== index);
		onChange(apply(filtered));
	};

	const append = () => {
		const next = [...value.parts, term(literal(""))];
		onChange(apply(next));
	};

	return (
		<div className="space-y-1.5">
			{value.parts.map((part, i) => (
				<ReorderableRow
					// Stable per-part identity from the WeakMap-backed
					// `nodeId(part)` rather than the array index — keeps
					// React state on the right row across reorders.
					key={nodeId(part)}
					index={i}
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
								path={appendSlotIndex(path, "parts", i)}
							/>
							{previewPortal}
						</div>
					)}
				</ReorderableRow>
			))}
			<button
				type="button"
				onClick={append}
				className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span>Add Part</span>
			</button>
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
	readonly path: EditorPath;
}

function PartRow({
	part,
	isOnlyOne,
	onUpdate,
	onRemove,
	setHandleEl,
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
			// Each part casts to text at evaluation; the editor
			// suggests text-shaped kinds in the kind picker but
			// allows any kind (every type casts to text at the
			// wire layer). `applicable` honors the hint without
			// outright filtering.
			expectedType="text"
			variant="nested"
			dragHandleRef={setHandleEl}
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
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">Part {index + 1}</span>
		</div>
	);
}
