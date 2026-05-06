// components/builder/case-list-config/cards/expression/DoubleCard.tsx
//
// Renders the `double` ValueExpression — forced numeric coercion via
// CSQL's `double(...)` value function. Single-slot: a
// `ValueExpression` operand resolving to a text-shaped or numeric
// type. The result type is always `decimal`.
//
// Type-checker rule (per `checkExpression`'s `case "double":`):
// operand must be text-shaped or numeric; geopoints / dates /
// datetimes / times are rejected because their wire-form numeric
// coercion is undefined. Errors land at `[..., "value"]`.

"use client";
import {
	double,
	literal,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

/** Default — `double(literal(""))`. The text-shaped seed lands clean
 *  through the type checker; authors who want to force a different
 *  shape edit through the operand picker. */
export function doubleDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "double" }> {
	return double(term(literal("")));
}

interface DoubleCardProps {
	readonly value: Extract<ValueExpression, { kind: "double" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function DoubleCard({ value, onChange, path }: DoubleCardProps) {
	// Operand errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at `[..., "value"]`; no parallel
	// `<InlineError>` is needed here.

	const setOperand = (next: ValueExpression) => {
		onChange(double(next));
	};

	return (
		<div className="space-y-2">
			<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
				Force a value to a numeric (decimal) type.
			</div>
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Source value
				</div>
				<ExpressionPicker
					value={value.value}
					onChange={setOperand}
					path={appendSlot(path, "value")}
					expectedType="decimal"
					variant="nested"
				/>
			</div>
		</div>
	);
}
