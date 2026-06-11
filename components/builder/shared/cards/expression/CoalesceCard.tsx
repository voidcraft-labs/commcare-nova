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
import {
	coalesce,
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
}

export function CoalesceCard({ value, onChange, path }: CoalesceCardProps) {
	const containerKey = nodeId(value);

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
		onReorder: (next) => onChange(apply(next)),
	});

	const updateValue = (index: number, next: ValueExpression) => {
		const updated = value.values.map((v, i) => (i === index ? next : v));
		onChange(apply(updated));
	};

	const removeValue = (index: number) => {
		if (value.values.length === 1) return;
		const filtered = value.values.filter((_, i) => i !== index);
		onChange(apply(filtered));
	};

	const append = () => {
		const next = [...value.values, term(literal(null))];
		onChange(apply(next));
	};

	return (
		<div className="space-y-1.5">
			<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
				First non-empty value (fallback chain)
			</div>
			{value.values.map((v, i) => (
				<ReorderableRow
					key={nodeId(v)}
					index={i}
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
								path={appendSlotIndex(path, "values", i)}
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
				<Icon icon={tablerPlus} width="11" height="11" />
				<span>Add fallback</span>
			</button>
		</div>
	);
}

interface ValueRowProps {
	readonly valueExpr: ValueExpression;
	readonly isOnlyOne: boolean;
	readonly onUpdate: (next: ValueExpression) => void;
	readonly onRemove: () => void;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly path: EditorPath;
}

function ValueRow({
	valueExpr,
	isOnlyOne,
	onUpdate,
	onRemove,
	setHandleEl,
	path,
}: ValueRowProps) {
	// Per-value errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at the matching slot path — no parallel
	// `<InlineError>` is needed here.
	return (
		<ExpressionPicker
			value={valueExpr}
			onChange={onUpdate}
			path={path}
			variant="nested"
			dragHandleRef={setHandleEl}
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
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">Fallback {index + 1}</span>
		</div>
	);
}
