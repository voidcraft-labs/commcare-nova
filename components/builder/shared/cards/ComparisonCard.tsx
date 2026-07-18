// components/builder/shared/cards/ComparisonCard.tsx
//
// Renders the six comparison kinds (`eq` / `neq` / `gt` / `gte`
// / `lt` / `lte`) as a single card. Each shares the same
// `{ kind, left, right }` shape; the kind discriminator picks the
// operator. The schema entry's `defaultValue(ctx)` factory builds a
// kind-specific default predicate that the user can refine.
//
// UI shape: subject editor + operator, then the comparison value.
// A property subject stays compact; every other ValueExpression
// remains editable through the same recursive expression editor.

"use client";
import {
	comparisonObjectConstraint,
	comparisonSubjectConstraint,
	type eq,
	type Predicate,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { usePredicateEditContext, useResolvedType } from "../editorContext";
import { appendSlot, type EditorPath } from "../path";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { KIND_BUILDERS } from "./comparisonSeed";
import { PredicateVerbMenu } from "./PredicateVerbMenu";
import { reseedValueForConstraint, resolveExpressionType } from "./reseed";

export { comparisonDefault, KIND_BUILDERS } from "./comparisonSeed";

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
 *   - `left` — `ValueExpression`. The recursive `ExpressionPicker`
 *     exposes every valid subject source and calculated expression.
 *     Its subject presentation keeps the dominant property case
 *     compact while preserving full editability for complex ASTs.
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
	const ctx = usePredicateEditContext();

	// The subject (left) drives what the value (right) may hold — the
	// right slot offers ONLY types compatible with the subject, so a
	// type mismatch is unauthorable. `useResolvedType` runs the same
	// checker `checkComparison` validates against, so the offered set
	// is exactly the accept set.
	const subjectType = useResolvedType(value.left);
	const objectConstraint = comparisonObjectConstraint(value.kind, subjectType);

	const setLeft = (left: ValueExpression) => {
		const builder = KIND_BUILDERS[value.kind];
		// Cascade-reseed: a new subject can tighten the right slot's
		// accept-set. When the existing right resolves to a type the new
		// subject no longer accepts, reseed it (carrying the typed
		// content where the new type allows) in the SAME onChange so the
		// committed comparison is never transiently type-wrong.
		const accepts = comparisonObjectConstraint(
			value.kind,
			resolveExpressionType(left, ctx),
		).accepts;
		if (accepts === "any") {
			onChange(builder(left, value.right));
			return;
		}
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
		<div className="space-y-3">
			<div className="grid grid-cols-1 items-start gap-2 @sm:grid-cols-[minmax(0,1fr)_auto]">
				<ExpressionPicker
					value={value.left}
					onChange={setLeft}
					path={appendSlot(path, "left")}
					constraint={comparisonSubjectConstraint(value.kind)}
					presentation="subject"
					variant="nested"
				/>

				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>

			<div className="min-w-0">
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
