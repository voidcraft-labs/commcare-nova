"use client";

import type { Expression, ExpressionOfKind } from "@/lib/domain/expression";
import { numericConstraint } from "@/lib/domain/expression";
import { appendKindSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

interface GeneralValueCardProps<K extends "negate" | "here" | "value-list"> {
	readonly value: ExpressionOfKind<K>;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function NegateCard({
	value,
	onChange,
	path,
}: GeneralValueCardProps<"negate">) {
	return (
		<ExpressionPicker
			value={value.value}
			onChange={(next) => onChange({ ...value, value: next })}
			path={appendKindSlot(path, "negate", "value")}
			constraint={numericConstraint()}
			variant="nested"
		/>
	);
}

export function HereCard(_props: GeneralValueCardProps<"here">) {
	return (
		<p className="text-[13px] text-nova-text-muted">
			Uses the current worker's location.
		</p>
	);
}

export function ValueListCard({ value }: GeneralValueCardProps<"value-list">) {
	return (
		<p role="status" className="text-[13px] text-nova-text-muted">
			This saved list contains {value.items.length} values. List editing is not
			available here yet.
		</p>
	);
}
