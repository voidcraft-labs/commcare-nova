// components/builder/shared/cards/BetweenCard.tsx
//
// Renders the `between` predicate. Property picker on the left
// (ordered-typed only) + lower bound input + upper bound input
// (each independently optional — leaving one blank produces a
// half-bounded range) + per-bound inclusivity toggles.

"use client";
import { useId } from "react";
import { Switch } from "@/components/shadcn/switch";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { canonicalCasePropertyName, isOrdered } from "@/lib/domain";
import {
	between,
	betweenBoundConstraint,
	betweenSubjectConstraint,
	compatibleTypesFor,
	literal,
	type Predicate,
	prop,
	type ResolvedType,
	type SlotConstraint,
	type ValueExpression,
	term as wrapTerm,
} from "@/lib/domain/predicate";
import { usePredicateEditContext, useResolvedType } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";
import {
	reseedValueForConstraint,
	resolveExpressionType,
	seedLiteralForProperty,
} from "./reseed";

export function betweenDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "between" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find(isOrdered);
	const propName = canonicalCasePropertyName(property?.name ?? "");
	// Seed bounds of the ordered property's OWN type — text `literal("")`
	// bounds opposite a numeric / temporal property would be a soundness
	// error (an ordered subject is never text-compatible).
	return between(prop(ctx.currentCaseType, propName), {
		lower: seedLiteralForProperty(property),
		upper: seedLiteralForProperty(property),
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

/** Reseed one bound when an anchor change leaves its resolved type
 *  outside the anchor's compatible set; an absent or already-compatible
 *  bound flows through unchanged. */
function reseedBoundIfNeeded(
	bound: ValueExpression | undefined,
	accepts: ReadonlySet<ResolvedType>,
	ctx: Parameters<typeof resolveExpressionType>[1],
): ValueExpression | undefined {
	if (bound === undefined) return undefined;
	const type = resolveExpressionType(bound, ctx);
	return type !== undefined && !accepts.has(type)
		? reseedValueForConstraint(bound, accepts)
		: bound;
}

export function BetweenCard({ value, onChange, path }: BetweenCardProps) {
	const ctx = usePredicateEditContext();

	// The anchor (left) drives both bounds — each bound offers only
	// types compatible with the anchor, and a change of anchor reseeds
	// any now-incompatible bound in the same onChange.
	const subjectType = useResolvedType(value.left);
	const boundConstraint = betweenBoundConstraint(subjectType);

	const setLeft = (left: ValueExpression) => {
		const accepts = compatibleTypesFor(resolveExpressionType(left, ctx));
		const lower = reseedBoundIfNeeded(value.lower, accepts, ctx);
		const upper = reseedBoundIfNeeded(value.upper, accepts, ctx);
		onChange(buildBetween(value, { left, lower, upper }));
	};

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<ExpressionPicker
					value={value.left}
					onChange={setLeft}
					path={appendSlot(path, "left")}
					constraint={betweenSubjectConstraint()}
					presentation="subject"
					variant="nested"
				/>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>

			<div className="grid grid-cols-1 @md:grid-cols-2 gap-2">
				{/* The schema's `.refine(...)` rejects a between with no
				 *  bounds — at least one of `lower` / `upper` must be
				 *  present. The editor enforces the same invariant via
				 *  the boundless guards on each editor: a clear toggle
				 *  on the only-enabled bound is disabled until the
				 *  sibling is enabled. Authors who want a single-
				 *  bounded range disable one bound; the schema accepts
				 *  the half-open shape. */}
				<BoundEditor
					label="Minimum"
					boundSlot="lower"
					value={value.lower}
					onChange={(next) => onChange(buildBetween(value, { lower: next }))}
					inclusive={value.lowerInclusive}
					setInclusive={(b) =>
						onChange(buildBetween(value, { lowerInclusive: b }))
					}
					path={path}
					constraint={boundConstraint}
					canDisable={value.upper !== undefined}
				/>
				<BoundEditor
					label="Maximum"
					boundSlot="upper"
					value={value.upper}
					onChange={(next) => onChange(buildBetween(value, { upper: next }))}
					inclusive={value.upperInclusive}
					setInclusive={(b) =>
						onChange(buildBetween(value, { upperInclusive: b }))
					}
					path={path}
					constraint={boundConstraint}
					canDisable={value.lower !== undefined}
				/>
			</div>
		</div>
	);
}

interface BoundEditorProps {
	readonly label: string;
	readonly boundSlot: "lower" | "upper";
	readonly value: ValueExpression | undefined;
	readonly onChange: (next: ValueExpression | undefined) => void;
	readonly inclusive: boolean;
	readonly setInclusive: (next: boolean) => void;
	readonly path: EditorPath;
	/** The bound's type constraint — compatible with the anchor. */
	readonly constraint: SlotConstraint;
	/** When false, the bound's enable-toggle is locked on — the
	 *  sibling bound is currently disabled, and clearing this one
	 *  too would yield a no-bounds shape the schema rejects. */
	readonly canDisable: boolean;
}

function BoundEditor({
	label,
	boundSlot,
	value,
	onChange,
	inclusive,
	setInclusive,
	path,
	constraint,
	canDisable,
}: BoundEditorProps) {
	const isEnabled = value !== undefined;
	const toggleDisabled = isEnabled && !canDisable;
	const enabledId = useId();
	return (
		<div>
			<div className="mb-1 flex min-h-11 items-center justify-between gap-2">
				<SimpleTooltip
					content={toggleDisabled ? "Keep at least one limit" : undefined}
				>
					<label
						htmlFor={enabledId}
						className={`flex min-h-11 items-center gap-2 text-[13px] font-medium ${
							toggleDisabled
								? "cursor-not-allowed text-nova-text-muted"
								: "cursor-pointer text-nova-text-secondary"
						}`}
					>
						<Switch
							id={enabledId}
							checked={isEnabled}
							onCheckedChange={(next) => {
								if (!next) {
									if (toggleDisabled) return;
									onChange(undefined);
									return;
								}
								// Enable with a bound of the anchor's type. A text
								// literal opposite an ordered subject is invalid.
								onChange(
									constraint.accepts === "any"
										? wrapTerm(literal(""))
										: reseedValueForConstraint(
												wrapTerm(literal("")),
												constraint.accepts,
											),
								);
							}}
							disabled={toggleDisabled}
						/>
						<span>{label}</span>
					</label>
				</SimpleTooltip>
				<InclusiveToggle
					label={label}
					inclusive={inclusive}
					setInclusive={setInclusive}
					disabled={!isEnabled}
				/>
			</div>
			{isEnabled && value !== undefined ? (
				<div>
					{/* Bound value routes through `ExpressionPicker` so the
					 *  full ValueExpression family is reachable at the
					 *  slot. The picker's own `CardShell` footer surfaces
					 *  inline errors at the slot path, so no parallel
					 *  `<InlineError>` is needed here. */}
					<ExpressionPicker
						value={value}
						onChange={(next) => onChange(next)}
						path={appendSlot(path, boundSlot)}
						constraint={constraint}
						variant="nested"
					/>
				</div>
			) : (
				<div className="rounded-md border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
					No {label.toLowerCase()}
				</div>
			)}
		</div>
	);
}

function InclusiveToggle({
	label,
	inclusive,
	setInclusive,
	disabled,
}: {
	readonly label: string;
	readonly inclusive: boolean;
	readonly setInclusive: (next: boolean) => void;
	readonly disabled: boolean;
}) {
	const id = useId();
	const isMinimum = label === "Minimum";
	return (
		<SimpleTooltip
			content={
				inclusive
					? `Cases can equal the ${label.toLowerCase()}`
					: isMinimum
						? "Cases must be greater than the minimum"
						: "Cases must be less than the maximum"
			}
		>
			<label
				htmlFor={id}
				className={`flex min-h-11 items-center gap-2 text-[13px] ${
					disabled
						? "cursor-not-allowed text-nova-text-muted"
						: "cursor-pointer text-nova-text-secondary"
				}`}
			>
				<span>Include limit</span>
				<Switch
					id={id}
					checked={inclusive}
					onCheckedChange={setInclusive}
					disabled={disabled}
					size="sm"
				/>
			</label>
		</SimpleTooltip>
	);
}
