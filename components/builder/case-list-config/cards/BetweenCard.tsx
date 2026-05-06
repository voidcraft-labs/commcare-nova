// components/builder/case-list-config/cards/BetweenCard.tsx
//
// Renders the `between` predicate. Property picker on the left
// (ordered-typed only) + lower bound input + upper bound input
// (each independently optional — leaving one blank produces a
// half-bounded range) + per-bound inclusivity toggles.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerSquare from "@iconify-icons/tabler/square";
import tablerSquareCheck from "@iconify-icons/tabler/square-check-filled";
import {
	between,
	literal,
	type Predicate,
	prop,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { PropertyPicker } from "../primitives/PropertyPicker";
import { ValueExpressionPicker } from "../primitives/ValueExpressionPicker";

const ORDERED_PROPERTY_TYPES = new Set<string>([
	"int",
	"decimal",
	"date",
	"datetime",
	"time",
]);

export function betweenDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "between" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((p) =>
		ORDERED_PROPERTY_TYPES.has(p.data_type ?? "text"),
	);
	const propName = property?.name ?? "";
	return between(prop(ctx.currentCaseType, propName), {
		lower: literal(""),
		upper: literal(""),
	});
}

interface BetweenCardProps {
	readonly value: Extract<Predicate, { kind: "between" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

/** Marshal `between(...)` arguments from card state, preserving the
 *  schema's "at least one bound" invariant. The schema rejects the
 *  no-bounds shape; the card surfaces an inline error if both are
 *  cleared, but the AST stays parseable so the editor doesn't
 *  brick on transient empty states. */
function buildBetween(
	value: Extract<Predicate, { kind: "between" }>,
	patch: {
		left?: ValueExpression;
		lower?: ValueExpression | undefined;
		upper?: ValueExpression | undefined;
		lowerInclusive?: boolean;
		upperInclusive?: boolean;
	},
): Extract<Predicate, { kind: "between" }> {
	const left = patch.left ?? value.left;
	const lower = "lower" in patch ? patch.lower : value.lower;
	const upper = "upper" in patch ? patch.upper : value.upper;
	const lowerInclusive = patch.lowerInclusive ?? value.lowerInclusive;
	const upperInclusive = patch.upperInclusive ?? value.upperInclusive;

	return between(left, {
		lower,
		upper,
		lowerInclusive,
		upperInclusive,
	});
}

export function BetweenCard({ value, onChange, path }: BetweenCardProps) {
	const ctx = usePredicateEditContext();
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));
	const lowerErrors = useEditorErrorsAt(appendSlot(path, "lower"));
	const upperErrors = useEditorErrorsAt(appendSlot(path, "upper"));

	const propertyName =
		value.left.kind === "term" && value.left.term.kind === "prop"
			? value.left.term.property
			: undefined;

	const setProperty = (next: string) => {
		onChange(
			buildBetween(value, {
				left: { kind: "term", term: prop(ctx.currentCaseType, next) },
			}),
		);
	};

	return (
		<div className="space-y-2">
			<div>
				<PropertyPicker
					value={propertyName}
					onChange={setProperty}
					filter={(p) => ORDERED_PROPERTY_TYPES.has(p.data_type ?? "text")}
					invalid={leftErrors.length > 0}
					ariaLabel="Property"
				/>
				{leftErrors.length > 0 && (
					<div className="mt-1 text-[11px] leading-snug text-nova-error/90">
						{leftErrors.map((m) => (
							<div key={m}>{m}</div>
						))}
					</div>
				)}
			</div>

			<div className="grid grid-cols-2 gap-2">
				{/* The schema's `.refine(...)` rejects a between with no
				 *  bounds — at least one of `lower` / `upper` must be
				 *  present. The editor enforces the same invariant via
				 *  the boundless guards on each editor: a clear toggle
				 *  on the only-enabled bound is disabled until the
				 *  sibling is enabled. Authors who want a single-
				 *  bounded range disable one bound; the schema accepts
				 *  the half-open shape. */}
				<BoundEditor
					label="From"
					value={value.lower}
					onChange={(next) => onChange(buildBetween(value, { lower: next }))}
					inclusive={value.lowerInclusive}
					setInclusive={(b) =>
						onChange(buildBetween(value, { lowerInclusive: b }))
					}
					caseTypeName={ctx.currentCaseType}
					anchorPropertyName={propertyName}
					errors={lowerErrors}
					canDisable={value.upper !== undefined}
				/>
				<BoundEditor
					label="To"
					value={value.upper}
					onChange={(next) => onChange(buildBetween(value, { upper: next }))}
					inclusive={value.upperInclusive}
					setInclusive={(b) =>
						onChange(buildBetween(value, { upperInclusive: b }))
					}
					caseTypeName={ctx.currentCaseType}
					anchorPropertyName={propertyName}
					errors={upperErrors}
					canDisable={value.lower !== undefined}
				/>
			</div>
		</div>
	);
}

interface BoundEditorProps {
	readonly label: string;
	readonly value: ValueExpression | undefined;
	readonly onChange: (next: ValueExpression | undefined) => void;
	readonly inclusive: boolean;
	readonly setInclusive: (next: boolean) => void;
	readonly caseTypeName: string;
	readonly anchorPropertyName: string | undefined;
	readonly errors: readonly string[];
	/** When false, the bound's enable-toggle is locked on — the
	 *  sibling bound is currently disabled, and clearing this one
	 *  too would yield a no-bounds shape the schema rejects. */
	readonly canDisable: boolean;
}

function BoundEditor({
	label,
	value,
	onChange,
	inclusive,
	setInclusive,
	caseTypeName,
	anchorPropertyName,
	errors,
	canDisable,
}: BoundEditorProps) {
	const isEnabled = value !== undefined;
	const toggleDisabled = isEnabled && !canDisable;
	return (
		<div>
			<div className="flex items-center justify-between mb-1">
				<button
					type="button"
					aria-pressed={isEnabled}
					onClick={() => {
						if (isEnabled) {
							if (toggleDisabled) return;
							onChange(undefined);
						} else {
							onChange({ kind: "term", term: literal("") });
						}
					}}
					disabled={toggleDisabled}
					title={
						toggleDisabled
							? "At least one bound must remain enabled"
							: undefined
					}
					className={`text-[10px] uppercase tracking-wider transition-colors ${
						toggleDisabled
							? "text-nova-text-muted/40 cursor-not-allowed"
							: isEnabled
								? "text-nova-violet-bright cursor-pointer"
								: "text-nova-text-muted/60 hover:text-nova-text-muted cursor-pointer"
					}`}
				>
					{label}
				</button>
				<InclusiveToggle
					inclusive={inclusive}
					setInclusive={setInclusive}
					disabled={!isEnabled}
				/>
			</div>
			{isEnabled && value !== undefined ? (
				<div>
					<ValueExpressionPicker
						value={value}
						onChange={onChange}
						caseTypeName={caseTypeName}
						anchorPropertyName={anchorPropertyName}
						invalid={errors.length > 0}
						ariaLabel={`${label} bound`}
					/>
					{errors.length > 0 && (
						<div className="mt-1 text-[11px] leading-snug text-nova-error/90">
							{errors.map((m) => (
								<div key={m}>{m}</div>
							))}
						</div>
					)}
				</div>
			) : (
				<div className="text-xs text-nova-text-muted/60 italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
					No {label.toLowerCase()} bound
				</div>
			)}
		</div>
	);
}

function InclusiveToggle({
	inclusive,
	setInclusive,
	disabled,
}: {
	readonly inclusive: boolean;
	readonly setInclusive: (next: boolean) => void;
	readonly disabled: boolean;
}) {
	return (
		<button
			type="button"
			aria-pressed={inclusive}
			onClick={() => setInclusive(!inclusive)}
			disabled={disabled}
			className={`flex items-center gap-1 text-[10px] uppercase tracking-wider transition-colors ${
				disabled
					? "text-nova-text-muted/30 cursor-not-allowed"
					: inclusive
						? "text-nova-violet-bright cursor-pointer"
						: "text-nova-text-muted hover:text-nova-text cursor-pointer"
			}`}
			title={inclusive ? "Inclusive (≤)" : "Exclusive (<)"}
		>
			<Icon
				icon={inclusive ? tablerSquareCheck : tablerSquare}
				width="11"
				height="11"
			/>
			<span>Inclusive</span>
		</button>
	);
}
