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
import { useId, useRef } from "react";
import {
	type ColumnDisplayContext,
	projectColumnDisplay,
} from "@/components/builder/case-list-config/columnCellRenderer";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import type { Column } from "@/lib/domain";
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
	context: ColumnDisplayContext,
): boolean {
	const terms = filterText.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const displayedColumns = columns.map((column) =>
		projectColumnDisplay(column, row, context).text.toLocaleLowerCase(),
	);
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
	/** Rows surviving the filter — read out under the box only while
	 *  a filter is active, so the narrowing is never silent. */
	readonly resultCount?: number;
	/** A paged case list can only apply this CommCare-style client filter to
	 * the bounded rows on screen. Naming that scope prevents a zero result from
	 * pretending no matching case exists on another server page. */
	readonly scope?: "results" | "page";
}) {
	const id = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	return (
		<div>
			<label
				htmlFor={id}
				className="mb-1.5 block text-[13px] font-medium text-nova-text-secondary"
			>
				{scope === "page" ? "Filter this page" : "Filter results"}
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
					className="min-h-11 w-full rounded-lg border-pv-input-border bg-pv-surface pr-11 pl-9 text-[14px] text-nova-text focus-visible:border-nova-violet/40 focus-visible:ring-1 focus-visible:ring-nova-violet/30 dark:bg-pv-surface"
				/>
				{value !== "" && (
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							onChange("");
							requestAnimationFrame(() => inputRef.current?.focus());
						}}
						aria-label="Clear the filter"
						className="absolute inset-y-0 right-0 h-full w-11 rounded-lg text-nova-text-muted not-disabled:hover:bg-transparent not-disabled:hover:text-nova-text"
					>
						<Icon icon={tablerX} width="14" height="14" />
					</Button>
				)}
			</div>
			{value !== "" && resultCount !== undefined && resultCount > 0 && (
				<p className="mt-2 text-xs text-nova-text-secondary" role="status">
					{resultCount.toLocaleString()} {resultCount === 1 ? "case" : "cases"}{" "}
					{scope === "page" ? "on this page" : "shown"}
				</p>
			)}
		</div>
	);
}
