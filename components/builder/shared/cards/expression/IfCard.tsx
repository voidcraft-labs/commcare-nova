// components/builder/shared/cards/expression/IfCard.tsx
//
// Renders the `if` ValueExpression — boolean-conditional value
// selection. Three slots:
//
//   - `cond` — a `Predicate` (cross-family reference). Routes
//     through `ChildPredicateEditor` so the full Predicate-side
//     editor is reachable inline. The CCHQ on-device wire form is
//     `if(cond, then, else)`; CSQL has no native `if` value
//     function and the wire emitter hoists `if` arms out of CSQL
//     fragments at the wire-emission boundary.
//
//   - `then` / `else` — `ValueExpression`s. Eager evaluation of both
//     branches at runtime. The type checker's `accumulateBranchType`
//     enforces branch-type agreement (then-type and else-type must
//     be compatible, modulo null-as-universal); errors land at
//     `[..., "if"]` (operator-level) and `[..., "if", "then" | "else"]`
//     (per-branch).
//
// Path encoding for `if`: the type checker emits at
// `[..., "if", "cond" | "then" | "else"]` — the kind segment
// disambiguates errors inside a nested `if` from siblings. Use
// `appendKindSlot(path, "if", slot)` for each child path.

"use client";
import {
	ANY_CONSTRAINT,
	ifExpr,
	literal,
	matchAll,
	type Predicate,
	type SlotConstraint,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useEditorErrorsAt } from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendKind, appendKindSlot, type EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";
import { ChildPredicateEditor } from "../ChildPredicateEditor";

/** Default `if` — `if(match-all, "", "")`. The condition seeds to
 *  match-all so the user immediately sees the predicate-editor card;
 *  branches seed to empty text literals. The type checker accepts
 *  the seed without a branch-mismatch error (both branches resolve
 *  to text). */
export function ifDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "if" }> {
	return ifExpr(matchAll(), term(literal("")), term(literal("")));
}

interface IfCardProps {
	readonly value: Extract<ValueExpression, { kind: "if" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	/** The `if`'s own result constraint propagates to BOTH branches —
	 *  whatever type the slot wants, each branch must produce. */
	readonly constraint?: SlotConstraint;
}

export function IfCard({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
}: IfCardProps) {
	// Operator-level errors land at `[..., "if"]` —
	// `accumulateBranchType` pushes the branch-type-mismatch message
	// there. The card surfaces those inline because nothing else
	// renders at the operator-level path: the parent
	// `ExpressionPicker` shell looks up errors at `path` (the kind-
	// boundary itself), not at `[..., "if"]`.
	//
	// Per-slot errors (cond / then / else) emit at `[..., "if",
	// "cond" | "then" | "else"]`; the matching child shells
	// (`ChildPredicateEditor` for cond, `ExpressionPicker` for the
	// branches) render those via their own `CardShell` footers, so
	// no parallel `<InlineError>` is needed for those slots here.
	const operatorErrors = useEditorErrorsAt(appendKind(path, "if"));

	const setCond = (next: Predicate) => {
		// Builders preserve the absent-not-undefined contract on
		// optional slots — `ifExpr` has no optional slots, so the
		// raw constructor is the right shape.
		onChange(ifExpr(next, value.then, value.else));
	};

	const setThen = (next: ValueExpression) => {
		onChange(ifExpr(value.cond, next, value.else));
	};

	const setElse = (next: ValueExpression) => {
		onChange(ifExpr(value.cond, value.then, next));
	};

	return (
		<div className="space-y-2">
			{operatorErrors.length > 0 && <InlineError errors={operatorErrors} />}

			<div>
				<div className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-1">
					When
				</div>
				<ChildPredicateEditor
					value={value.cond}
					onChange={setCond}
					path={appendKindSlot(path, "if", "cond")}
					variant="nested"
				/>
			</div>

			<div>
				<div className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-1">
					Then
				</div>
				<ExpressionPicker
					value={value.then}
					onChange={setThen}
					path={appendKindSlot(path, "if", "then")}
					constraint={constraint}
					variant="nested"
				/>
			</div>

			<div>
				<div className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-1">
					Else
				</div>
				<ExpressionPicker
					value={value.else}
					onChange={setElse}
					path={appendKindSlot(path, "if", "else")}
					constraint={constraint}
					variant="nested"
				/>
			</div>
		</div>
	);
}
