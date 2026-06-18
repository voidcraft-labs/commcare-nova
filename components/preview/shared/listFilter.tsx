// components/preview/shared/listFilter.tsx
//
// The case list's own filter box — the same quick narrowing CommCare
// gives every case list: type a few letters and the rows narrow to
// the ones containing them, case-insensitively, across every visible
// column; each typed word has to match somewhere in the row. It runs
// entirely client-side over the rows already on screen — the
// authored search fields query the case store, this narrows what
// came back. (CommCare's engine implements the same contract in
// commcare-core's entity filterer: per-term, case-folded, substring,
// all terms required.)

"use client";
import { Icon } from "@iconify/react/offline";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerX from "@iconify-icons/tabler/x";
import { useId } from "react";
import type { Column } from "@/lib/domain";
import { evaluateColumnValue } from "@/lib/preview/engine/caseDataBindingClient";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";

/**
 * Does this row survive the filter text? Every whitespace-separated
 * term must appear (case-insensitively) somewhere in some visible
 * column's rendered text. Empty / all-space filter keeps every row.
 */
export function rowMatchesFilterText(
	columns: readonly Column[],
	row: CaseRowWithCalculated,
	filterText: string,
): boolean {
	const terms = filterText.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	return terms.every((term) =>
		columns.some((col) =>
			evaluateColumnValue(col, row).toLowerCase().includes(term),
		),
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
}: {
	readonly value: string;
	readonly onChange: (next: string) => void;
	/** Rows surviving the filter — read out under the box only while
	 *  a filter is active, so the narrowing is never silent. */
	readonly resultCount?: number;
}) {
	const id = useId();
	return (
		<div className="relative">
			<label htmlFor={id} className="sr-only">
				Filter the list
			</label>
			<Icon
				icon={tablerSearch}
				width="15"
				height="15"
				className="absolute left-3 top-1/2 -translate-y-1/2 text-nova-text-muted pointer-events-none"
			/>
			<input
				id={id}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="Filter the list…"
				autoComplete="off"
				data-1p-ignore
				className="w-full min-h-11 pl-9 pr-11 text-[13px] rounded-lg border border-pv-input-border bg-pv-surface text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors"
			/>
			{value !== "" && (
				<button
					type="button"
					onClick={() => onChange("")}
					aria-label="Clear the filter"
					className="absolute right-0 top-0 bottom-0 w-11 grid place-items-center text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
				>
					<Icon icon={tablerX} width="14" height="14" />
				</button>
			)}
			{value !== "" && resultCount !== undefined && (
				<p className="mt-1.5 text-[11px] text-nova-text-muted" role="status">
					{resultCount === 0
						? "Nothing on this page matches the filter."
						: `Narrowed to ${resultCount} ${resultCount === 1 ? "case" : "cases"}.`}
				</p>
			)}
		</div>
	);
}
