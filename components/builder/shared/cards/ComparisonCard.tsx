// components/builder/shared/cards/ComparisonCard.tsx
//
// Renders the six comparison kinds (`eq` / `neq` / `gt` / `gte`
// / `lt` / `lte`) as a single card. Each shares the same
// `{ kind, left, right }` shape; the kind discriminator picks the
// operator. The schema entry's `defaultValue(ctx)` factory builds a
// kind-specific default predicate that the user can refine.
//
// UI shape: subject editor + operator, then the comparison value.
// A property subject stays compact; every other Expression
// remains editable through the same recursive expression editor.

"use client";
import type { ExpressionOfKind } from "@/lib/domain/expression";

import {
	comparisonObjectConstraint,
	comparisonSubjectConstraint,
	type Expression,
	type eq,
} from "@/lib/domain/expression";
import { CaseTypeValuePicker } from "../CaseTypeValuePicker";
import { staticSelectSubject } from "../choiceValueModel";
import {
	comparesCaseType,
	possibleRowCaseTypes,
	replaceComparisonSubject,
} from "../comparisonModel";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	useResolvedType,
} from "../editorContext";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { KIND_BUILDERS } from "./comparisonSeed";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

export { comparisonDefault, KIND_BUILDERS } from "./comparisonSeed";

interface ComparisonCardProps {
	readonly value: ExpressionOfKind<"eq" | "neq" | "gt" | "gte" | "lt" | "lte">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

/**
 * Comparison card body. The slots:
 *   - `left`: `Expression`. The recursive `ExpressionPicker`
 *     exposes every valid subject source and calculated expression.
 *     Its subject presentation keeps the dominant property case
 *     compact while preserving full editability for complex ASTs.
 *   - operator: kind discriminator (eq / neq / gt / lt / lte / gte).
 *   - `right`: `Expression`. The card mounts an
 *     `ExpressionPicker` shell at the slot, dispatching every
 *     Expression kind (term / arith / if / count / coalesce /
 *     etc.) through the registry-driven per-arm cards. Authors swap
 *     kinds via the picker's "Change" menu; nested operands recurse
 *     through the same shell. The picker's own `CardShell` footer
 *     surfaces inline errors at the slot path.
 */
export function ComparisonCard({ value, onChange, path }: ComparisonCardProps) {
	const ctx = usePredicateEditContext();

	// The subject (left) drives what the value (right) may hold, the
	// right slot offers ONLY types compatible with the subject, so a
	// type mismatch is unauthorable. `useResolvedType` runs the same
	// checker `checkComparison` validates against, so the offered set
	// is exactly the accept set.
	const subjectType = useResolvedType(value.left);
	const objectConstraint = comparisonObjectConstraint(value.kind, subjectType);

	const setLeft = (left: Expression) =>
		onChange(replaceComparisonSubject(value, left, ctx));

	const setRight = (right: Parameters<typeof eq>[1]) => {
		const builder = KIND_BUILDERS[value.kind];
		onChange(builder(value.left, right));
	};
	// A form answer from a select with written choices is compared with one
	// of its choices ("A choice of this question").
	const choiceSubject = staticSelectSubject(value.left, ctx.expressionContext);
	const leftPath = appendSlot(path, "left");
	const rightPath = appendSlot(path, "right");
	const rightErrors = useEditorErrorsAt(rightPath);
	// The subject's own choices are judged as this card would rebuild the
	// comparison, so "Case type" is judged with a case type as its value.
	const admitSubject = (left: Expression) =>
		ctx.admitExpressionChange?.(
			path,
			replaceComparisonSubject(value, left, ctx),
		) ?? { admitted: true as const };
	const caseTypeRight =
		comparesCaseType(value.left) &&
		value.right.kind === "term" &&
		(value.right.term.kind === "case-type" ||
			value.right.term.kind === "literal");
	const storedCaseType =
		value.right.kind === "term" && value.right.term.kind === "case-type"
			? value.right.term.caseType
			: value.right.kind === "term" &&
					value.right.term.kind === "literal" &&
					typeof value.right.term.value === "string" &&
					value.right.term.value !== ""
				? value.right.term.value
				: undefined;

	return (
		<div className="space-y-3">
			<div className="grid grid-cols-1 items-start gap-2 @sm:grid-cols-[minmax(0,1fr)_auto]">
				<ExpressionPicker
					value={value.left}
					onChange={setLeft}
					admitReplacement={admitSubject}
					path={leftPath}
					constraint={comparisonSubjectConstraint(value.kind)}
					presentation="subject"
					variant="nested"
				/>

				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>

			<div className="min-w-0">
				{/* Right operand routes through `ExpressionPicker` so
				 *  every admissible Expression kind (term, arith, if,
				 *  count, etc.) is editable at this slot via the registry-
				 *  driven dispatch. The `comparisonObjectConstraint` narrows
				 *  the offered kinds + value sources to those whose result
				 *  type is comparable with the subject, so the editor never
				 *  offers a type the checker would reject. The picker's own
				 *  `CardShell` footer surfaces inline errors at the slot
				 *  path, so no parallel `<InlineError>` is needed here. */}
				{caseTypeRight ? (
					<CaseTypeValuePicker
						value={storedCaseType}
						onChange={(caseType) =>
							setRight({
								kind: "term",
								term: { kind: "case-type", caseType },
							})
						}
						caseTypes={ctx.caseTypes.map((type) => type.name)}
						possible={possibleRowCaseTypes(ctx)}
						admit={(caseType) =>
							ctx.admitExpressionChange?.(rightPath, {
								kind: "term",
								term: { kind: "case-type", caseType },
							}) ?? { admitted: true }
						}
						invalid={rightErrors.length > 0}
					/>
				) : null}
				{caseTypeRight && rightErrors.length > 0 ? (
					<InlineError errors={rightErrors} />
				) : null}
				{caseTypeRight ? null : (
					<ExpressionPicker
						value={value.right}
						onChange={setRight}
						path={rightPath}
						constraint={objectConstraint}
						variant="nested"
						choiceSubject={choiceSubject}
					/>
				)}
			</div>
		</div>
	);
}
