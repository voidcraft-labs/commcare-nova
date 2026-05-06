// components/builder/case-list-config/cards/InCard.tsx
//
// Renders the `in` predicate. Property picker on the left + a
// literal-list editor (one row per literal, typed by the property's
// data type). The schema requires at least one value; the card
// suppresses the "remove" affordance on the last remaining row.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import {
	isIn,
	type Literal,
	literal,
	type Predicate,
	prop,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { nodeId } from "../nodeIdentity";
import { appendSlot, appendSlotIndex, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { LiteralValueInput } from "../primitives/LiteralValueInput";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";

export function inDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "in" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties[0];
	const propName = property?.name ?? "";
	return isIn(prop(ctx.currentCaseType, propName), literal(""));
}

interface InCardProps {
	readonly value: Extract<Predicate, { kind: "in" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function InCard({ value, onChange, path }: InCardProps) {
	const ctx = usePredicateEditContext();
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));

	// Anchor property name for typed-input switching in each value
	// row. Pulled from the LEFT-slot AST shape; only meaningful
	// when the left is a property reference.
	const propertyName =
		value.left.kind === "term" && value.left.term.kind === "prop"
			? value.left.term.property
			: undefined;

	const setLeft = (left: ValueExpression) => {
		const [first, ...rest] = value.values;
		onChange(isIn(left, first, ...rest));
	};

	const setValueAt = (index: number, next: Literal) => {
		const updated = value.values.map((v, i) => (i === index ? next : v));
		const [first, ...rest] = updated;
		onChange(isIn(value.left, first, ...rest));
	};

	const removeAt = (index: number) => {
		// Schema requires non-empty; refuse the last row's removal.
		if (value.values.length === 1) return;
		const filtered = value.values.filter((_, i) => i !== index);
		const [first, ...rest] = filtered;
		onChange(isIn(value.left, first, ...rest));
	};

	const append = () => {
		const [first, ...rest] = value.values;
		onChange(isIn(value.left, first, ...rest, literal("")));
	};

	return (
		<div className="space-y-2">
			<div>
				<PropertyRefPicker
					mode="left"
					value={value.left}
					onChange={setLeft}
					invalid={leftErrors.length > 0}
					ariaLabel="Property"
				/>
				<InlineError errors={leftErrors} />
			</div>

			<div className="space-y-1.5">
				{value.values.map((v, i) => (
					// Stable per-literal identity comes from the WeakMap-
					// backed `nodeId(v)` rather than the array index — the
					// schema-required reductions (none for `in`) keep
					// references stable across edits, so swapping or
					// removing a row preserves the right row's React
					// state without index-shift confusion.
					<ValueRow
						key={nodeId(v)}
						value={v}
						onChange={(next) => setValueAt(i, next)}
						onRemove={() => removeAt(i)}
						isOnlyOne={value.values.length === 1}
						caseTypeName={ctx.currentCaseType}
						propertyName={propertyName}
						indexPath={appendSlotIndex(path, "values", i)}
					/>
				))}
				<button
					type="button"
					onClick={append}
					className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlus} width="11" height="11" />
					<span>Add value</span>
				</button>
			</div>
		</div>
	);
}

function ValueRow({
	value,
	onChange,
	onRemove,
	isOnlyOne,
	caseTypeName,
	propertyName,
	indexPath,
}: {
	readonly value: Literal;
	readonly onChange: (next: Literal) => void;
	readonly onRemove: () => void;
	readonly isOnlyOne: boolean;
	readonly caseTypeName: string;
	readonly propertyName: string | undefined;
	readonly indexPath: EditorPath;
}) {
	const errors = useEditorErrorsAt(indexPath);
	return (
		<div className="space-y-0.5">
			<div className="flex items-start gap-1.5">
				<div className="flex-1">
					<LiteralValueInput
						value={value}
						onChange={onChange}
						caseTypeName={caseTypeName}
						propertyName={propertyName}
						invalid={errors.length > 0}
					/>
				</div>
				{!isOnlyOne && (
					<button
						type="button"
						aria-label="Remove value"
						onClick={onRemove}
						className="mt-0.5 rounded text-nova-text-muted/60 hover:text-nova-error hover:bg-white/[0.05] p-1 cursor-pointer transition-colors"
					>
						<Icon icon={tablerX} width="12" height="12" />
					</button>
				)}
			</div>
			<InlineError errors={errors} />
		</div>
	);
}
