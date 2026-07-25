/**
 * One Project data table: its identity, what it holds, and its rows.
 *
 * The grid is a SCAN surface, not a spreadsheet. Cells are typed — a date
 * column needs `DatePicker`, a time column `TimeField` — and those are
 * popovers that cannot live inside a virtualized cell, nor can a 44px touch
 * target survive a dense one. So the grid reads and selects, one row opens in
 * the inspector rail where every control is correctly typed and full size,
 * and bulk change goes through CSV replacement. That split also makes the
 * unit of concurrency the ROW, which is exactly the unit `lib/lookup`'s row
 * API and its optimistic revisions already work in.
 *
 * The table's name titles this screen because the breadcrumb deliberately
 * stops at the workspace (see `ProjectDataWorkspace`).
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import { useNavigate } from "@/lib/routing/hooks";
import { ProjectDataFailure, ProjectDataLoading } from "./ProjectDataReadState";
import {
	COLUMN_TYPE_LABELS,
	cellText,
	filterRows,
	formatLookupBytes,
	formatLookupCount,
	ROWS_PER_PAGE,
	tableCapacity,
} from "./projectDataModel";
import { useProjectDataTable } from "./useProjectData";

export function ProjectDataTableScreen({
	tableId,
}: {
	tableId: LookupTableId;
}) {
	const { state, reload } = useProjectDataTable(tableId);
	const navigate = useNavigate();

	const backToList = (
		<Button
			type="button"
			variant="ghost"
			onClick={() => navigate.openProjectData()}
			className="-ml-2 min-h-11 gap-2 text-[13px] text-nova-text-muted hover:text-nova-text"
		>
			<Icon icon={tablerArrowLeft} width="16" height="16" aria-hidden="true" />
			All data tables
		</Button>
	);

	if (state.kind === "loading" || state.kind === "idle") {
		return (
			<section className="min-w-0">
				{backToList}
				<ProjectDataLoading label="Loading this table…" />
			</section>
		);
	}

	if (state.kind === "failed") {
		/* A table that has been deleted, and one that belongs to a project you
		 * cannot see, resolve identically by design — telling them apart would
		 * confirm that a resource exists somewhere you have no access to. The
		 * copy therefore describes the situation rather than guessing a cause. */
		const missing = state.failure.code === "not_found";
		return (
			<section className="min-w-0">
				{backToList}
				{missing ? (
					<div
						role="alert"
						className="mt-8 flex max-w-md flex-col items-start gap-3"
					>
						<span className="grid size-10 place-items-center rounded-xl bg-nova-amber/[0.12] text-nova-amber">
							<Icon
								icon={tablerAlertTriangle}
								width="18"
								height="18"
								aria-hidden="true"
							/>
						</span>
						<p className="font-medium text-nova-text">
							This table isn’t here anymore
						</p>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							It may have been deleted, or it may belong to a different project.
							Go back to see the tables this project has.
						</p>
					</div>
				) : (
					<ProjectDataFailure
						title="This table didn’t load"
						failure={state.failure}
						onRetry={() => void reload()}
					/>
				)}
			</section>
		);
	}

	const table = state.value;
	const capacity = tableCapacity(table);

	return (
		<section aria-labelledby="project-data-table-heading" className="min-w-0">
			{backToList}
			<h1
				id="project-data-table-heading"
				className="mt-2 font-display text-2xl font-semibold tracking-tight text-nova-text [overflow-wrap:anywhere]"
			>
				{table.name}
			</h1>
			<p className="mt-2 text-sm leading-relaxed text-nova-text-secondary">
				{formatLookupCount(table.columns.length, "column")} ·{" "}
				{formatLookupCount(table.rowCount, "row")} of{" "}
				{capacity.rowLimit.toLocaleString()} ·{" "}
				{formatLookupBytes(table.dataBytes)} of{" "}
				{formatLookupBytes(capacity.byteLimit)}
			</p>

			<TableGrid table={table} />
		</section>
	);
}

/**
 * The rows, as a real `<table>` in pages.
 *
 * Pages rather than a virtualized window, and that is a semantics decision
 * before it is a performance one. A table cap of 5,000 rows is far past what
 * belongs in the DOM at once, and the two ways out are virtualization or
 * paging: virtualization costs the native element (a CSS grid wearing ARIA
 * roles, with `aria-rowindex` bookkeeping that has to stay honest as the
 * window moves), while paging keeps `<table>`/`<th>`/`<td>` — real row and
 * column headers, real header association, and screen-reader table navigation
 * that works without a single role attribute. The running case list already
 * pages at 50 for the same reason, so the two surfaces behave alike.
 *
 * Finding a row is the search box, not scrolling: a lookup table is a list
 * you look things up in, so matching text across every column beats paging
 * through fifty pages hunting for one facility.
 */
function TableGrid({ table }: { table: LookupTableSnapshot }) {
	const searchId = useId();
	const searchHintId = useId();
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(0);

	const matches = useMemo(
		() => filterRows(table.rows, table.columns, query),
		[table.rows, table.columns, query],
	);

	/* A narrowed or refreshed result set can leave the reader past the end.
	 * Clamping during render (rather than in an effect) keeps the page shown
	 * and the page counted identical in the same commit — an effect would
	 * paint one frame of an empty page first. */
	const pageCount = Math.max(1, Math.ceil(matches.length / ROWS_PER_PAGE));
	const currentPage = Math.min(page, pageCount - 1);
	const start = currentPage * ROWS_PER_PAGE;
	const visible = matches.slice(start, start + ROWS_PER_PAGE);
	/* Off the WHOLE table, not the current match set: the hint is about the
	 * table being long, and it should not disappear the moment a query narrows
	 * the result to one page. */
	const multiPage = table.rows.length > ROWS_PER_PAGE;

	if (table.rows.length === 0) {
		return (
			<p className="mt-8 max-w-md text-sm leading-relaxed text-nova-text-secondary">
				This table has its columns but no rows yet. Add rows one at a time, or
				replace them all at once from a CSV.
			</p>
		);
	}

	return (
		<div className="mt-6 min-w-0">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0 grow basis-64">
					<Label htmlFor={searchId} className="text-[12px]">
						Find a row
					</Label>
					<Input
						id={searchId}
						type="search"
						value={query}
						placeholder="Search every column"
						autoComplete="off"
						data-1p-ignore
						aria-describedby={multiPage ? searchHintId : undefined}
						onChange={(event) => {
							setQuery(event.target.value);
							setPage(0);
						}}
						className="mt-1 h-11"
					/>
					{/* Said only once the table is actually long enough for it to
					 *  matter. A table that fits on one page needs no advice about
					 *  how to find a row in it. */}
					{multiPage && (
						<p
							id={searchHintId}
							className="mt-1.5 text-[12px] leading-snug text-nova-text-muted"
						>
							This table is longer than one page. Searching is faster than
							paging through it.
						</p>
					)}
				</div>
				<p
					role="status"
					className="min-h-11 content-center text-[13px] text-nova-text-secondary"
				>
					{query.trim() === ""
						? formatLookupCount(table.rows.length, "row")
						: `${formatLookupCount(matches.length, "row")} matching`}
				</p>
			</div>

			{matches.length === 0 ? (
				<p className="mt-6 text-sm leading-relaxed text-nova-text-secondary">
					No row in this table contains “{query.trim()}”.
				</p>
			) : (
				<>
					<div className="mt-3 overflow-x-auto rounded-xl border border-nova-border">
						<table className="w-full min-w-max border-collapse text-left">
							<caption className="sr-only">
								{table.name}: {formatLookupCount(matches.length, "row")},
								showing {start + 1} to {start + visible.length}
							</caption>
							<thead>
								<tr className="border-b border-nova-border bg-nova-elevated">
									{table.columns.map((column) => (
										<th
											key={column.id}
											scope="col"
											className="min-w-36 px-3 py-2.5 align-bottom font-medium"
										>
											<span className="block min-w-0 text-[13px] text-nova-text [overflow-wrap:anywhere]">
												{column.label}
											</span>
											<span className="block text-[12px] font-normal text-nova-text-muted">
												{COLUMN_TYPE_LABELS[column.dataType]}
											</span>
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{visible.map((row) => (
									<tr
										key={row.id}
										className="border-b border-nova-border last:border-b-0"
									>
										{table.columns.map((column) => {
											const text = cellText(row.values, column);
											return (
												<td
													key={column.id}
													className="min-w-36 px-3 py-2.5 align-top text-[13px] text-nova-text [overflow-wrap:anywhere]"
												>
													{text === undefined ? (
														/* A missing cell is not an empty one. The dash is
														 * decoration, so the accessible name says which. */
														<span className="text-nova-text-muted">
															<span aria-hidden="true">—</span>
															<span className="sr-only">No value</span>
														</span>
													) : (
														text
													)}
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</div>

					{pageCount > 1 && (
						<nav
							aria-label="Rows, by page"
							className="mt-3 flex flex-wrap items-center justify-between gap-2"
						>
							<Button
								type="button"
								variant="outline"
								className="min-h-11"
								disabled={currentPage === 0}
								onClick={() => setPage(currentPage - 1)}
							>
								<Icon
									icon={tablerChevronLeft}
									width="16"
									height="16"
									aria-hidden="true"
								/>
								Previous
							</Button>
							<p className="text-[13px] text-nova-text-secondary">
								Rows {start + 1}–{start + visible.length} of{" "}
								{matches.length.toLocaleString()}
							</p>
							<Button
								type="button"
								variant="outline"
								className="min-h-11"
								disabled={currentPage >= pageCount - 1}
								onClick={() => setPage(currentPage + 1)}
							>
								Next
								<Icon
									icon={tablerChevronRight}
									width="16"
									height="16"
									aria-hidden="true"
								/>
							</Button>
						</nav>
					)}
				</>
			)}
		</div>
	);
}
