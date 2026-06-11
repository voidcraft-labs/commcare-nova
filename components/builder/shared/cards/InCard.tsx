// components/builder/shared/cards/InCard.tsx
//
// Renders the `in` predicate. Property picker on the left + a
// literal-list editor (one row per literal, typed by the property's
// data type). The schema requires at least one value; the card
// suppresses the "remove" affordance on the last remaining row.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { Tooltip } from "@/components/ui/Tooltip";
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
import { PredicateVerbMenu } from "./PredicateVerbMenu";

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
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
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
				<PredicateVerbMenu value={value} onChange={onChange} />
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
					className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
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
					<Tooltip content="Remove this value">
						<button
							type="button"
							aria-label="Remove value"
							onClick={onRemove}
							className="size-11 grid place-items-center rounded-md text-nova-text-muted/60 hover:text-nova-rose hover:bg-white/[0.05] cursor-pointer transition-colors"
						>
							<Icon icon={tablerX} width="13" height="13" />
						</button>
					</Tooltip>
				)}
			</div>
			<InlineError errors={errors} />
		</div>
	);
}
