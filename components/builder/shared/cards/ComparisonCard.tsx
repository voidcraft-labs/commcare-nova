// components/builder/shared/cards/ComparisonCard.tsx
//
// Renders the six comparison kinds (`eq` / `neq` / `gt` / `gte`
// / `lt` / `lte`) as a single card. Each shares the same
// `{ kind, left, right }` shape; the kind discriminator picks the
// operator. The schema entry's `defaultValue(ctx)` factory builds a
// kind-specific default predicate that the user can refine.
//
// UI shape: property picker on the left, operator dropdown in the
// middle, value picker on the right. The value picker mirrors the
// type of the picked property — text / numeric / date / select —
// via `LiteralValueInput`'s `data_type` switch.

"use client";
import { isOrdered } from "@/lib/domain";
import {
	type ComparisonKind,
	comparisonObjectConstraint,
	compatibleTypesFor,
	eq,
	gt,
	gte,
	lt,
	lte,
	neq,
	type Predicate,
	prop,
	type ValueExpression,
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

/** Per-kind builder dispatch. Keeps the card body's onChange paths
 *  precise — each kind constructs through the matching builder so
 *  the AST stays canonical. Exported so `preservedOperandSwap` in
 *  `ChildPredicateEditor` can route comparison ↔ comparison
 *  replacements through the same builders. */
export const KIND_BUILDERS: Record<
	ComparisonKind,
	(left: Parameters<typeof eq>[0], right: Parameters<typeof eq>[1]) => Predicate
> = {
	eq,
	neq,
	gt,
	gte,
	lt,
	lte,
};

const ORDERED_KINDS = new Set<ComparisonKind>(["lt", "lte", "gt", "gte"]);

/**
 * Comparison-arm shape narrowed on the per-kind discriminator. The
 * schema's comparison arm declares `kind: ComparisonKind`, so a
 * direct `Extract<Predicate, { kind: K }>` (where K is one of the
 * six comparison kinds) resolves to `never` — the narrowing
 * tightens `kind` to the literal but preserves the schema's
 * operand types. This alias is what every comparison default
 * factory returns.
 */
type ComparisonArm<K extends ComparisonKind> = Extract<
	Predicate,
	{ kind: ComparisonKind }
> & { kind: K };

/**
 * Build the default comparison predicate for a kind. Picks the
 * first applicable property — for ordering operators, the first
 * ordered-typed property; otherwise any property — and seeds the
 * RHS with an empty literal so the user immediately sees the value
 * input.
 *
 * Returns the precise `ComparisonArm<K>` shape rather than
 * `Extract<Predicate, { kind: K }>` because the latter resolves to
 * `never` (the schema's comparison arm carries `kind:
 * ComparisonKind`, not the per-kind narrowed literal). The runtime
 * AST is identical.
 */
export function comparisonDefault<K extends ComparisonKind>(
	kind: K,
	ctx: PredicateEditContext,
): ComparisonArm<K> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((p) =>
		ORDERED_KINDS.has(kind) ? isOrdered(p) : true,
	);
	const propName = property?.name ?? "";
	const builder = KIND_BUILDERS[kind] as (
		l: Parameters<typeof eq>[0],
		r: Parameters<typeof eq>[1],
	) => ComparisonArm<K>;
	// Seed the value of the property's OWN type so the default lands
	// type-correct — a text `literal("")` opposite an ordered (`gt`/…)
	// or non-text (`eq`/…) property would be a soundness error.
	return builder(
		prop(ctx.currentCaseType, propName),
		seedLiteralForProperty(property),
	);
}

interface ComparisonCardProps {
	readonly value: Extract<
		Predicate,
		{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
	>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

/**
 * Comparison card body. The slots:
 *   - `left` — `ValueExpression`. The card EDITS the canonical
 *     `term(prop(...))` shape via `PropertyRefPicker`; non-Term,
 *     non-prop-Term, and prop-with-non-self-`via` shapes route
 *     through that picker's read-only badge with an explicit
 *     Replace affordance, so the authored expression round-trips
 *     without destruction.
 *   - operator — kind discriminator (eq / neq / gt / lt / lte / gte).
 *   - `right` — `ValueExpression`. The card mounts an
 *     `ExpressionPicker` shell at the slot, dispatching every
 *     ValueExpression kind (term / arith / if / count / coalesce /
 *     etc.) through the registry-driven per-arm cards. Authors swap
 *     kinds via the picker's "Change" menu; nested operands recurse
 *     through the same shell. The picker's own `CardShell` footer
 *     surfaces inline errors at the slot path.
 */
export function ComparisonCard({ value, onChange, path }: ComparisonCardProps) {
	// Left-side errors render via the picker's `invalid` prop +
	// the inline `<InlineError>` below — `PropertyRefPicker` doesn't
	// have a card-shell footer of its own, so the slot's errors
	// surface here directly. Right-side errors render via the
	// `ExpressionPicker` shell's `CardShell` footer at the matching
	// slot path; rendering them again here would double the
	// diagnostic row count for the same message.
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));
	const ctx = usePredicateEditContext();

	// The subject (left) drives what the value (right) may hold — the
	// right slot offers ONLY types compatible with the subject, so a
	// type mismatch is unauthorable. `useResolvedType` runs the same
	// checker `checkComparison` validates against, so the offered set
	// is exactly the accept set.
	const subjectType = useResolvedType(value.left);
	const objectConstraint = comparisonObjectConstraint(subjectType);

	const setLeft = (left: ValueExpression) => {
		const builder = KIND_BUILDERS[value.kind];
		// Cascade-reseed: a new subject can tighten the right slot's
		// accept-set. When the existing right resolves to a type the new
		// subject no longer accepts, reseed it (carrying the typed
		// content where the new type allows) in the SAME onChange so the
		// committed comparison is never transiently type-wrong.
		const accepts = compatibleTypesFor(resolveExpressionType(left, ctx));
		const rightType = resolveExpressionType(value.right, ctx);
		const right =
			rightType !== undefined && !accepts.has(rightType)
				? reseedValueForConstraint(value.right, accepts)
				: value.right;
		onChange(builder(left, right));
	};

	const setRight = (right: Parameters<typeof eq>[1]) => {
		const builder = KIND_BUILDERS[value.kind];
		onChange(builder(value.left, right));
	};

	return (
		<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto_1.6fr] gap-2 items-start">
			<div>
				{/* Ordering operators (`gt` / `gte` / `lt` / `lte`) only
				 *  compare ordered types, so the left picker narrows to
				 *  ordered properties for those kinds — picking the verb
				 *  first (the verb menu disables ordering for a non-ordered
				 *  subject), then the property, keeps each step valid. */}
				<PropertyRefPicker
					mode="left"
					value={value.left}
					onChange={setLeft}
					filter={ORDERED_KINDS.has(value.kind) ? isOrdered : undefined}
					invalid={leftErrors.length > 0}
					ariaLabel="Left operand"
				/>
				<InlineError errors={leftErrors} />
			</div>

			<PredicateVerbMenu value={value} onChange={onChange} />

			<div>
				{/* Right operand routes through `ExpressionPicker` so
				 *  every admissible ValueExpression kind (term, arith, if,
				 *  count, etc.) is editable at this slot via the registry-
				 *  driven dispatch. The `comparisonObjectConstraint` narrows
				 *  the offered kinds + value sources to those whose result
				 *  type is comparable with the subject, so the editor never
				 *  offers a type the checker would reject. The picker's own
				 *  `CardShell` footer surfaces inline errors at the slot
				 *  path, so no parallel `<InlineError>` is needed here. */}
				<ExpressionPicker
					value={value.right}
					onChange={setRight}
					path={appendSlot(path, "right")}
					constraint={objectConstraint}
					variant="nested"
				/>
			</div>
		</div>
	);
}
