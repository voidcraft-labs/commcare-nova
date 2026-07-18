// components/builder/shared/cards/expression/UnwrapListCard.tsx
//
// Renders the `unwrap-list` ValueExpression as an editable calculated
// value. Its inner expression must resolve to text (the stored JSON list),
// so the recursive picker receives the checker's text-shaped constraint.
// `unwrap-list` produces a `_sequence` resolved type that no scalar
// value slot consumes — the only consuming surface is the CSQL wire
// emitter via `selected-any(prop, unwrap-list(...))` at the wire-
// emission boundary. The Postgres compiler defensive-throws on this
// arm because no Postgres-side AST consumer accepts a sequence.
//
"use client";
import { canonicalCasePropertyName, isTextShaped } from "@/lib/domain";
import {
	prop,
	term,
	textShapedConstraint,
	unwrapList,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

const LIST_SOURCE_CONSTRAINT = textShapedConstraint();

/** Default `unwrap-list` — `unwrap-list(prop(currentCaseType,
 *  firstTextProperty))`. The default seeds against the first text-
 *  shaped property on the current case type so the type checker
 *  accepts the seed without an "unwrap-list requires a text-shaped
 *  operand" error. The shared `isTextShaped` helper (in
 *  `lib/domain/casePropertyTypes.ts`) consolidates the
 *  `data_type ?? "text"` fallback every consumer applies. The kind
 *  isn't authored from the kind picker (the `applicable` predicate
 *  gates it on `expectedType === "_sequence"`, which no scalar slot
 *  supplies) — the default factory exists for round-trip
 *  preservation symmetry, not for active authoring. */
export function unwrapListDefault(
	ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "unwrap-list" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find(isTextShaped);
	const propName = canonicalCasePropertyName(property?.name ?? "");
	return unwrapList(term(prop(ctx.currentCaseType, propName)));
}

interface UnwrapListCardProps {
	readonly value: Extract<ValueExpression, { kind: "unwrap-list" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

/**
 * Editable list source. The outer result remains a sequence and is offered
 * only where the parent SlotConstraint accepts one; the inner picker admits
 * only text-shaped values, exactly matching `checkExpression`.
 */
export function UnwrapListCard({ value, onChange, path }: UnwrapListCardProps) {
	return (
		<div className="space-y-1.5">
			<div className="text-[13px] font-medium text-nova-text-secondary">
				Read the saved list from
			</div>
			<ExpressionPicker
				value={value.value}
				onChange={(next) => onChange(unwrapList(next))}
				path={appendSlot(path, "value")}
				constraint={LIST_SOURCE_CONSTRAINT}
				variant="nested"
			/>
			<p className="text-[13px] leading-relaxed text-nova-text-muted">
				Use this when a text value stores several selections as a list
			</p>
		</div>
	);
}
