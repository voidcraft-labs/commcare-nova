// components/builder/shared/cards/BetweenCard.tsx
//
// Renders the `between` predicate. Property picker on the left
// (ordered-typed only) + lower bound input + upper bound input
// (each independently optional — leaving one blank produces a
// half-bounded range) + per-bound inclusivity toggles.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerSquare from "@iconify-icons/tabler/square";
import tablerSquareCheck from "@iconify-icons/tabler/square-check-filled";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { canonicalCasePropertyName, isOrdered } from "@/lib/domain";
import {
	between,
	betweenBoundConstraint,
	compatibleTypesFor,
	literal,
	type Predicate,
	prop,
	type ResolvedType,
	type SlotConstraint,
	type ValueExpression,
	term as wrapTerm,
} from "@/lib/domain/predicate";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	useResolvedType,
} from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";
import {
	reseedValueForConstraint,
	resolveExpressionType,
	seedLiteralForProperty,
} from "./reseed";

/** Module-level filter so render-time identity stays stable —
 *  `PropertyPicker`'s `useMemo` on `[caseType, filter]` invalidates
 *  on each fresh-arrow filter, even when the actual selection rule
 *  is constant. The shared `isOrdered` helper (in
 *  `lib/domain/casePropertyTypes.ts`) consolidates the
 *  `data_type ?? "text"` fallback every consumer applies. */
const ORDERED_PROPERTY_FILTER = isOrdered;

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
	// Left-side errors render via the picker's `invalid` prop +
	// inline `<InlineError>` below — `PropertyRefPicker` doesn't
	// have a card-shell footer of its own. Bound-side (`lower` /
	// `upper`) errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at the matching slot path; rendering them
	// again here would double the diagnostic row count for the
	// same message.
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));
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
				<div>
					<PropertyRefPicker
						mode="left"
						value={value.left}
						onChange={setLeft}
						filter={ORDERED_PROPERTY_FILTER}
						invalid={leftErrors.length > 0}
						ariaLabel="Property"
					/>
					<InlineError errors={leftErrors} />
				</div>
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
					label="From"
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
					label="To"
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
	return (
		<div>
			<div className="flex items-center justify-between mb-1">
				<SimpleTooltip
					content={toggleDisabled ? "At least one end must stay on" : undefined}
				>
					<button
						type="button"
						aria-pressed={isEnabled}
						onClick={() => {
							if (isEnabled) {
								if (toggleDisabled) return;
								onChange(undefined);
							} else {
								// Enable with a bound of the anchor's type — a text
								// `literal("")` opposite an ordered subject is invalid.
								onChange(
									constraint.accepts === "any"
										? wrapTerm(literal(""))
										: reseedValueForConstraint(
												wrapTerm(literal("")),
												constraint.accepts,
											),
								);
							}
						}}
						disabled={toggleDisabled}
						className={`min-h-11 px-1.5 text-[10px] uppercase tracking-wider transition-colors ${
							toggleDisabled
								? "text-nova-text-muted cursor-not-allowed"
								: isEnabled
									? "text-nova-violet-bright cursor-pointer"
									: "text-nova-text-muted hover:text-nova-text-muted cursor-pointer"
						}`}
					>
						{label}
					</button>
				</SimpleTooltip>
				<InclusiveToggle
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
				<div className="text-xs text-nova-text-muted italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
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
		<SimpleTooltip
			content={
				inclusive
					? "The end itself counts as a match (≤)"
					: "Up to, but not including, the end (<)"
			}
		>
			<button
				type="button"
				aria-pressed={inclusive}
				onClick={() => setInclusive(!inclusive)}
				disabled={disabled}
				className={`flex items-center gap-1 min-h-11 px-1.5 text-[10px] uppercase tracking-wider transition-colors ${
					disabled
						? "text-nova-text-muted cursor-not-allowed"
						: inclusive
							? "text-nova-violet-bright cursor-pointer"
							: "text-nova-text-muted hover:text-nova-text cursor-pointer"
				}`}
			>
				<Icon
					icon={inclusive ? tablerSquareCheck : tablerSquare}
					width="11"
					height="11"
				/>
				<span>Inclusive</span>
			</button>
		</SimpleTooltip>
	);
}
