"use client";

import type { Expression, ExpressionOfKind } from "@/lib/domain/expression";
import { numericConstraint } from "@/lib/domain/expression";
import { appendKindSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";
import { expressionFocusTitle } from "../../RuleFocusContext";

interface GeneralValueCardProps<
	K extends "negate" | "here" | "case-list-search-text" | "value-list",
> {
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
			Where the worker is when the case list shows.
		</p>
	);
}

export function CaseListSearchTextCard(
	_props: GeneralValueCardProps<"case-list-search-text">,
) {
	return (
		<p className="text-[13px] text-nova-text-muted">
			What the worker typed into the case list's search box, blank when they
			typed nothing.
		</p>
	);
}

/** A list a value is compared with, held for an imported search
 * (`unwrap-list`). No step authors one, so the card is display
 * only: it shows the items and re-emits the list unchanged. */
export function ValueListCard({ value }: GeneralValueCardProps<"value-list">) {
	return (
		<div className="space-y-1.5">
			<div className="text-[13px] font-medium text-nova-text-secondary">
				Any of these values
			</div>
			<ul className="flex flex-wrap gap-1.5">
				{value.items.map((item, index) => (
					<li
						// Display-only and never reordered: the position is the identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: a read-only list
						key={index}
						className="inline-flex min-h-8 items-center rounded-lg border border-white/[0.06] bg-nova-deep/40 px-2.5 text-sm text-nova-text"
					>
						{valueListItemLabel(item)}
					</li>
				))}
			</ul>
			<p className="text-[12px] leading-4 text-nova-text-muted">
				This list came with the app and is kept as it is. To edit its values,
				you can change the condition to “Is any of”.
			</p>
		</div>
	);
}

/** How a display-only list item reads: a fixed value as written, anything
 * else by what it is. */
export function valueListItemLabel(item: Expression): string {
	if (item.kind === "term" && item.term.kind === "literal")
		return item.term.value === null ? "No value" : String(item.term.value);
	return expressionFocusTitle(item);
}
