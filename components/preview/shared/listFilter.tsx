// components/preview/shared/listFilter.tsx
//
// The case list's own filter box: the same quick narrowing CommCare
// gives every case list: type a few letters and the rows narrow to
// the ones containing them, case-insensitively, across every field of
// the list; each typed word has to match somewhere in the row. A device
// matches every field's text, so the box also matches each field hidden
// from Results and each carrier of the list's order plan. It runs
// entirely client-side over the rows already on screen: the
// authored search fields query the case store, this narrows what
// came back. (CommCare's engine implements the same contract in
// commcare-core's entity filterer: per-term, case-folded, substring,
// all terms required.)

"use client";
import { Icon } from "@iconify/react/offline";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerX from "@iconify-icons/tabler/x";
import { useId, useRef } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import type { CaseListOrderPlan, Column } from "@/lib/domain";
import {
	type ColumnDisplayContext,
	projectColumnDisplay,
} from "@/lib/preview/columnDisplay";
import { caseRowDisplayValue } from "@/lib/preview/engine/caseDataBindingClient";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { useWorkerMessage } from "./WorkerText";

/**
 * Does this row survive the filter text? Every whitespace-separated
 * term must appear (case-insensitively) somewhere in the row: in a
 * shown column's rendered text, and with the list's order plan, in each
 * hidden field's text (the raw property value, or a hidden calculated
 * column's value) and each carrier's raw value. That is what a device's
 * search matches (commcare-core `util/EntitySortUtil.sortEntities`): a
 * hidden field's template holds the raw value, and so does the field HQ
 * appends for a carrier. Empty / all-space filter keeps every row.
 */
export function rowMatchesFilterText(
	columns: readonly Column[],
	row: CaseRowWithCalculated,
	filterText: string,
	context: ColumnDisplayContext,
	plan?: CaseListOrderPlan,
): boolean {
	const terms = filterText.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const displayedColumns = [
		...columns.map((column) => projectColumnDisplay(column, row, context).text),
		...(plan?.fields ?? []).flatMap((field) => {
			if (!field.hidden) return [];
			const { column } = field;
			return [
				column.kind === "calculated"
					? projectColumnDisplay(column, row, context).text
					: caseRowDisplayValue(row, column.field),
			];
		}),
		...(plan?.carriers ?? []).map((carrier) =>
			caseRowDisplayValue(row, carrier.property),
		),
	].map((text) => text.toLocaleLowerCase());
	return terms.every((term) =>
		displayedColumns.some((displayed) => displayed.includes(term)),
	);
}

/**
 * The filter box itself. Fully controlled; the clear affordance only
 * appears once there's something to clear.
 */
export function ListFilterBox({
	value,
	onChange,
	resultCount,
	scope = "results",
}: {
	readonly value: string;
	readonly onChange: (next: string) => void;
	/** Rows surviving the filter: read out under the box only while
	 *  a filter is active, so the narrowing is never silent. */
	readonly resultCount?: number;
	/** A paged case list can only apply this CommCare-style client filter to
	 * the bounded rows on screen. Naming that scope prevents a zero result from
	 * pretending no matching case exists on another server page. */
	readonly scope?: "results" | "page";
}) {
	const message = useWorkerMessage();
	const id = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	return (
		<div>
			<label
				htmlFor={id}
				className="mb-1.5 block text-[13px] font-medium text-nova-text-secondary"
			>
				{message(scope === "page" ? "filterPage" : "filterResults")}
			</label>
			<div className="relative">
				<Icon
					icon={tablerSearch}
					width="16"
					height="16"
					className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-nova-text-muted"
				/>
				<Input
					ref={inputRef}
					id={id}
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					autoComplete="off"
					data-1p-ignore
					className="nova-focusable min-h-11 w-full rounded-lg border-pv-input-border bg-pv-surface pr-11 pl-9 text-[14px] text-nova-text dark:bg-pv-surface"
				/>
				{value !== "" && (
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							onChange("");
							requestAnimationFrame(() => inputRef.current?.focus());
						}}
						aria-label={message("clearFilter")}
						className="absolute inset-y-0 right-0 h-full w-11 rounded-lg text-nova-text-muted not-disabled:hover:bg-transparent"
					>
						<Icon icon={tablerX} width="14" height="14" />
					</Button>
				)}
			</div>
			{value !== "" && resultCount !== undefined && resultCount > 0 && (
				<p className="mt-2 text-xs text-nova-text-secondary" role="status">
					{message(scope === "page" ? "onThisPage" : "countShown", {
						count: message(
							resultCount === 1 ? "caseCountOne" : "caseCountMany",
							{ count: resultCount.toLocaleString() },
						),
					})}
				</p>
			)}
		</div>
	);
}
