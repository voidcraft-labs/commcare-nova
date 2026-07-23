"use client";

import { Input } from "@/components/shadcn/input";
import { asUuid } from "@/lib/domain";
import { idOf, type ValueExpression } from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import type { EditorPath } from "../../path";

export function idOfDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "id-of" }> {
	return idOf(asUuid("00000000-0000-4000-8000-000000000000"));
}

/**
 * `id-of` is a case-operation-local value. The operation editor owns its
 * picker; this generic expression surface only preserves imported values.
 */
export function IdOfCard({
	value,
}: {
	readonly value: Extract<ValueExpression, { kind: "id-of" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}) {
	return (
		<div className="space-y-1.5">
			<Input
				value={value.opUuid}
				readOnly
				aria-label="Referenced case operation"
			/>
			<p className="text-[13px] leading-relaxed text-nova-text-muted">
				Uses the case created by this earlier operation
			</p>
		</div>
	);
}
