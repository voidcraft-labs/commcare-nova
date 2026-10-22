// components/builder/shared/cards/expression/DateCoerceCard.tsx
//
// Renders the two single-slot date / datetime coercion expressions:
//
//   - `date-coerce`: text → typed date (Postgres `::date`, CSQL
//     `date(...)`, on-device `date(...)`).
//   - `datetime-coerce`: text → typed datetime (Postgres
//     `::timestamptz`, CSQL `datetime(...)`; on-device this ALSO
//     emits `date(...)`: the one parse-coercion that evaluator has,
//     whose String arm preserves time-of-day).
//
// Both share an identical `{ value: Expression }` operand shape;
// the `ExpressionPicker` shell's kind-replace menu treats them as a
// structural-twin pair (`preservedExpressionSwap`) so toggling
// between them preserves the operand verbatim.
//
// Type-checker rule (per `checkExpression`'s `case "date-coerce" |
// "datetime-coerce":`): the operand must be text-shaped (`text` /
// `single_select` / `multi_select`), already date-shaped (`date` /
// `datetime`: identity / widening coercion), or a number of days since
// 1 January 1970 (`int` / `decimal`, part 06 §3.5). Where the number may
// stand depends on the slot: a CSQL date needs whole days
// (`epoch-days-not-whole`) and a device drops a fraction of a day
// (`epoch-fraction-on-device`). Those are whole-rule verdicts, so the
// operand picker offers every number and the admission refuses the rest.
// Errors land at `[..., "value"]`; the editor captures them inline next to
// the operand picker.

"use client";
import type { ExpressionOfKind } from "@/lib/domain/expression";

import {
	coerceOperandConstraint,
	dateCoerce,
	datetimeCoerce,
	type Expression,
	literal,
	term,
} from "@/lib/domain/expression";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

/** Both coercion operators read a text-shaped, date-shaped or numeric
 * operand: module-const for a stable identity across renders. */
const OPERAND_CONSTRAINT = coerceOperandConstraint();

/** What a number means to both coercions (part 06 §3.5). */
export const EPOCH_DAYS_HINT = "A number counts days from 1 January 1970.";

/** Default `date-coerce`: `date-coerce(literal(""))`. The empty
 *  literal lets the user immediately see the operand picker; the
 *  type checker surfaces the operand-shape error only when the
 *  operand resolves to an incompatible type. */
export function dateCoerceDefault(
	_ctx: ExpressionEditContext,
): ExpressionOfKind<"date-coerce"> {
	return dateCoerce(term(literal("")));
}

/** Default `datetime-coerce`: same shape as `dateCoerce`. */
export function datetimeCoerceDefault(
	_ctx: ExpressionEditContext,
): ExpressionOfKind<"datetime-coerce"> {
	return datetimeCoerce(term(literal("")));
}

interface DateCoerceCardProps {
	readonly value: ExpressionOfKind<"date-coerce" | "datetime-coerce">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function DateCoerceCard({ value, onChange, path }: DateCoerceCardProps) {
	// Operand errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at `[..., "value"]`; no parallel
	// `<InlineError>` is needed here.

	const setOperand = (next: Expression) => {
		// Kind-preserving build: the card serves both arms; the
		// builder selection follows the source's `kind` so the
		// operator survives the operand edit. Kind swap goes through
		// the parent shell's "Change" menu (which routes through
		// `preservedExpressionSwap` for the structural-twin pair).
		const builder = value.kind === "date-coerce" ? dateCoerce : datetimeCoerce;
		onChange(builder(next));
	};

	return (
		<div>
			<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
				{value.kind === "date-coerce"
					? "Value to read as a date"
					: "Value to read as a date and time"}
			</div>
			<ExpressionPicker
				value={value.value}
				onChange={setOperand}
				path={appendSlot(path, "value")}
				constraint={OPERAND_CONSTRAINT}
				variant="nested"
			/>
			<p className="mt-1.5 text-[12px] leading-4 text-nova-text-muted">
				{EPOCH_DAYS_HINT}
			</p>
		</div>
	);
}
