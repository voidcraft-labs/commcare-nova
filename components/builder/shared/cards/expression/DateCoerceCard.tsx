// components/builder/shared/cards/expression/DateCoerceCard.tsx
//
// Renders the two single-slot date / datetime coercion expressions:
//
//   - `date-coerce` — text → typed date via CommCare's wire
//     `date(...)` value function.
//   - `datetime-coerce` — text → typed datetime via CommCare's wire
//     `datetime(...)` value function.
//
// Both share an identical `{ value: ValueExpression }` operand shape;
// the `ExpressionPicker` shell's kind-replace menu treats them as a
// structural-twin pair (`preservedExpressionSwap`) so toggling
// between them preserves the operand verbatim.
//
// Type-checker rule (per `checkExpression`'s `case "date-coerce" |
// "datetime-coerce":`): the operand must be text-shaped (`text` /
// `single_select` / `multi_select`). The `_any` sentinel bypasses
// the check uniformly. Errors land at `[..., "value"]`; the editor
// captures them inline next to the operand picker.

"use client";
import {
	dateCoerce,
	datetimeCoerce,
	literal,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

/** Default `date-coerce` — `date-coerce(literal(""))`. The empty
 *  literal lets the user immediately see the operand picker; the
 *  type checker surfaces "requires text-shaped" only when the
 *  operand resolves to a non-text type. */
export function dateCoerceDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "date-coerce" }> {
	return dateCoerce(term(literal("")));
}

/** Default `datetime-coerce` — same shape as `dateCoerce`. */
export function datetimeCoerceDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "datetime-coerce" }> {
	return datetimeCoerce(term(literal("")));
}

interface DateCoerceCardProps {
	readonly value: Extract<
		ValueExpression,
		{ kind: "date-coerce" | "datetime-coerce" }
	>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function DateCoerceCard({ value, onChange, path }: DateCoerceCardProps) {
	// Operand errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at `[..., "value"]`; no parallel
	// `<InlineError>` is needed here.

	const setOperand = (next: ValueExpression) => {
		// Kind-preserving build — the card serves both arms; the
		// builder selection follows the source's `kind` so the
		// operator survives the operand edit. Kind swap goes through
		// the parent shell's "Change" menu (which routes through
		// `preservedExpressionSwap` for the structural-twin pair).
		const builder = value.kind === "date-coerce" ? dateCoerce : datetimeCoerce;
		onChange(builder(next));
	};

	const description =
		value.kind === "date-coerce"
			? "Coerce a text value to a typed date."
			: "Coerce a text value to a typed datetime.";

	return (
		<div className="space-y-2">
			<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
				{description}
			</div>
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Source value (text-shaped)
				</div>
				<ExpressionPicker
					value={value.value}
					onChange={setOperand}
					path={appendSlot(path, "value")}
					expectedType="text"
					variant="nested"
				/>
			</div>
		</div>
	);
}
