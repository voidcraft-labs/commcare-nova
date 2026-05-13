// components/builder/case-list-config/cards/column/CalculatedColumnCard.tsx
//
// Renders the `calculated` Column kind — an author-defined
// `ValueExpression` that yields a derived per-row value
// (e.g. "days since last visit", "concatenated full name").
// Calculated columns have NO `field` slot; the expression is the
// source. The wire emitter lowers the expression into a Postgres
// expression / on-device XPath fragment.
//
// Slots:
//   - `header` — column display label.
//   - `expression` — a `ValueExpression` AST edited through the
//     shared `ExpressionCardEditor`. Cross-family recursion (`if.cond`
//     / `count.where` carrying Predicate operands) flows naturally
//     through that editor's existing context plumbing.
//
// Header + expression are the only authored fields. The card mounts
// inside `ColumnEditor`'s kind-dispatch alongside the other column
// cards, so the surrounding `CardShell` chrome (icon / kind label /
// kind-replace menu) is identical to every other kind's card.

"use client";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import type { Column } from "@/lib/domain";
import { calculatedColumn } from "@/lib/domain";
import type { ValueExpression } from "@/lib/domain/predicate";
import type { ColumnEditContext } from "../../columnEditorSchemas";

interface CalculatedColumnCardProps {
	readonly value: Extract<Column, { kind: "calculated" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

/**
 * Calculated column card. Routes every mutation through
 * `calculatedColumn` so the constructed shape always matches the
 * schema. Mounts the shared `ExpressionCardEditor` for the
 * expression slot — the same editor surface every other
 * ValueExpression authoring site uses, so a calc-column's
 * expression UI is identical to (e.g.) a search-input's default
 * value editor.
 */
export function CalculatedColumnCard({
	value,
	onChange,
	ctx,
}: CalculatedColumnCardProps) {
	const setHeader = (next: string) =>
		onChange(
			calculatedColumn(value.uuid, next, value.expression, slotsFrom(value)),
		);
	const setExpression = (next: ValueExpression) =>
		onChange(
			calculatedColumn(value.uuid, value.header, next, slotsFrom(value)),
		);

	return (
		<div className="space-y-2">
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Header
				</div>
				<BlurCommitTextInput
					value={value.header}
					onCommit={setHeader}
					placeholder="Column heading"
					ariaLabel="Column header"
				/>
			</div>
			<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2 space-y-1.5">
				<div className="text-[10px] uppercase tracking-widest text-nova-text-muted/60">
					Expression
				</div>
				<ExpressionCardEditor
					value={value.expression}
					onChange={setExpression}
					caseTypes={ctx.caseTypes}
					currentCaseType={ctx.currentCaseType}
				/>
			</div>
		</div>
	);
}

/** Re-extract the column's optional common slots so each builder call
 *  threads through them verbatim. The schema's strip-mode parse omits
 *  absent keys; the builder's `slots` object preserves whichever slots
 *  the value already carries (sort, visibleInList, visibleInDetail). */
function slotsFrom(value: Extract<Column, { kind: "calculated" }>): {
	sort?: typeof value.sort;
	visibleInList?: typeof value.visibleInList;
	visibleInDetail?: typeof value.visibleInDetail;
} {
	return {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
	};
}
