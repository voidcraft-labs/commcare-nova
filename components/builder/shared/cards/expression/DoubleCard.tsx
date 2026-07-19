// components/builder/shared/cards/expression/DoubleCard.tsx
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
	doubleOperandConstraint,
	literal,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

/** `double` reads a text-shaped or already-numeric value — module-const
 *  for a stable identity across renders. */
const OPERAND_CONSTRAINT = doubleOperandConstraint();

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
			<div className="text-[13px] leading-relaxed text-nova-text-muted">
				Treat this value as a number
			</div>
			<div>
				<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
					Source value
				</div>
				<ExpressionPicker
					value={value.value}
					onChange={setOperand}
					path={appendSlot(path, "value")}
					constraint={OPERAND_CONSTRAINT}
					variant="nested"
				/>
			</div>
		</div>
	);
}
