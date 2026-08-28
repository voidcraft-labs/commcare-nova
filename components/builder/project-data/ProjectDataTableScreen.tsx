/**
 * One Project data table: its identity, what it holds, and its rows.
 *
 * The grid is a SCAN surface, not a spreadsheet. Cells are typed, a date
 * column needs `DatePicker`, a time column `TimeField`, and those are
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
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import type { LookupColumnId, LookupRowId } from "@/lib/domain/lookupIds";
import type { LookupRow, LookupTableSnapshot } from "@/lib/lookup/types";
import { useNavigate } from "@/lib/routing/hooks";
import { ProjectDataFailure, ProjectDataLoading } from "./ProjectDataReadState";
import { useProjectDataWorkspace } from "./ProjectDataWorkspaceLazyProvider";
import {
	COLUMN_TYPE_LABELS,
	cellText,
	filterRows,
	formatLookupBytes,
	formatLookupCount,
	ROWS_PER_PAGE,
	tableCapacity,
} from "./projectDataModel";
import { TableActions } from "./TableActions";

export function ProjectDataTableScreen() {
	const workspace = useProjectDataWorkspace();
	const navigate = useNavigate();
	/* The controller owns the read AND the open table's identity, it derives
	 * both from the URL, so the canvas and the rail share one fetch and one
	 * selection. Taking a `tableId` prop here would be a second source for the
	 * same fact. The fallback keeps this screen renderable in isolation. */
	const state = workspace?.table ?? { kind: "idle" as const };
	const reload = workspace?.reload ?? (async () => {});

	const backToList = (
		<Button
			type="button"
			variant="ghost"
			onClick={() => navigate.openProjectData()}
			data-project-data-focus-fallback
			className="-ml-2 gap-2"
		>
			<Icon icon={tablerArrowLeft} width="16" height="16" aria-hidden="true" />
			All data tables
		</Button>
	);

	if (state.kind === "loading" || state.kind === "idle") {
		return (
			<section data-project-data-table-screen className="min-w-0">
				{backToList}
				<ProjectDataLoading label="Loading this table…" />
			</section>
		);
	}

	if (state.kind === "failed") {
		/* A table that has been deleted, and one that belongs to a project you
		 * cannot see, resolve identically by design: telling them apart would
		 * confirm that a resource exists somewhere you have no access to. The
		 * copy therefore describes the situation rather than guessing a cause. */
		const missing = state.failure.code === "not_found";
		return (
			<section data-project-data-table-screen className="min-w-0">
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
							This table isn't here anymore
						</p>
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							It may have been deleted, or it may belong to a different project.
							Go back to see the tables this Project has.
						</p>
						{workspace !== null && workspace.pendingDraftCount > 0 && (
							<Button
								type="button"
								variant="outline"
								className=""
								onClick={workspace.openPendingDraft}
							>
								Review{" "}
								{workspace.pendingDraftCount === 1
									? "the recovered row work"
									: `${workspace.pendingDraftCount} recovered row items`}
							</Button>
						)}
					</div>
				) : (
					<ProjectDataFailure
						title="This table didn't load"
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
		<section
			data-project-data-table-screen
			aria-labelledby="project-data-table-heading"
			className="min-w-0"
		>
			{backToList}
			<h1
				id="project-data-table-heading"
				className="mt-2 font-display text-2xl font-semibold tracking-tighter text-nova-text [overflow-wrap:anywhere]"
			>
				{table.name}
			</h1>
			<p className="mt-2 text-sm leading-relaxed text-nova-text-secondary">
				{formatLookupCount(table.columns.length, "column")} ·{" "}
				{table.rowCount.toLocaleString()} of{" "}
				{formatLookupCount(capacity.rowLimit, "row")} ·{" "}
				{formatLookupBytes(table.dataBytes)} of{" "}
				{formatLookupBytes(capacity.byteLimit)}
			</p>
			<p className="mt-1 text-[12px] text-nova-text-muted">
				Export tag:{" "}
				<code className="font-mono text-nova-text-secondary">{table.tag}</code>
			</p>

			{workspace !== null && (
				<TableActions table={table} workspace={workspace} />
			)}
			{workspace !== null && workspace.pendingDraftCount > 0 && (
				<div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-nova-amber/25 bg-nova-amber/[0.06] px-3 py-2">
					<p className="grow text-[12px] leading-snug text-nova-text-secondary">
						{workspace.pendingDraftCount === 1
							? "One retained row draft or decision is kept in this table."
							: `${workspace.pendingDraftCount} retained row drafts or decisions are kept in this table.`}
					</p>
					<Button
						type="button"
						variant="ghost"
						className=""
						onClick={workspace.openPendingDraft}
					>
						Review row work
					</Button>
				</div>
			)}
			<TableGrid
				table={table}
				selectedRowId={
					workspace?.selection?.kind === "row"
						? workspace.selection.rowId
						: undefined
				}
				draftRowIds={
					new Set(
						table.rows
							.filter((row) => workspace?.rowEditFor(row.id) !== undefined)
							.map((row) => row.id),
					)
				}
				revealRowId={
					workspace?.selection?.kind === "row" &&
					workspace.selection.reveal === true
						? workspace.selection.rowId
						: undefined
				}
				onSelectRow={(rowId) => workspace?.select({ kind: "row", rowId })}
				onSelectColumn={(columnId) =>
					workspace?.select({ kind: "column", columnId })
				}
			/>
		</section>
	);
}

/**
 * How a row is named to a screen reader on its Open control.
 *
 * The first column's value, because that is what a person calls the row, a
 * row number would be honest but useless, and the stored id means nothing to
 * anyone. Falls back to the position when the first cell is empty.
 */
function rowLabel(table: LookupTableSnapshot, row: LookupRow): string {
	const first = table.columns[0];
	const text = first === undefined ? undefined : cellText(row.values, first);
	return text !== undefined && text.trim() !== ""
		? text
		: `at position ${(table.rows.indexOf(row) + 1).toLocaleString("en-US")}`;
}

/**
 * The rows, as a real `<table>` in pages.
 *
 * Pages rather than a virtualized window, and that is a semantics decision
 * before it is a performance one. A table cap of 5,000 rows is far past what
 * belongs in the DOM at once, and the two ways out are virtualization or
 * paging: virtualization costs the native element (a CSS grid wearing ARIA
 * roles, with `aria-rowindex` bookkeeping that has to stay honest as the
 * window moves), while paging keeps `<table>`/`<th>`/`<td>`, real row and
 * column headers, real header association, and screen-reader table navigation
 * that works without a single role attribute. The running case list already
 * pages at 50 for the same reason, so the two surfaces behave alike.
 *
 * Finding a row is the search box, not scrolling: a lookup table is a list
 * you look things up in, so matching text across every column beats paging
 * through fifty pages hunting for one facility.
 */
function TableGrid({
	table,
	selectedRowId,
	draftRowIds,
	revealRowId,
	onSelectRow,
	onSelectColumn,
}: {
	table: LookupTableSnapshot;
	selectedRowId: LookupRowId | undefined;
	draftRowIds: ReadonlySet<LookupRowId>;
	revealRowId: LookupRowId | undefined;
	onSelectRow: (rowId: LookupRowId) => void;
	onSelectColumn: (columnId: LookupColumnId) => void;
}) {
	const searchId = useId();
	const searchHintId = useId();
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(0);
	const lastRevealedRow = useRef<LookupRowId | undefined>(undefined);

	/* A newly created row is appended and selected by the controller. Reveal
	 * that exact receipt instead of merely saying it exists somewhere beyond
	 * the current search/page. Existing selections are not repeatedly pulled
	 * back into view on ordinary realtime refreshes. */
	useEffect(() => {
		if (revealRowId === undefined || lastRevealedRow.current === revealRowId) {
			return;
		}
		const index = table.rows.findIndex((row) => row.id === revealRowId);
		if (index < 0) return;
		lastRevealedRow.current = revealRowId;
		setQuery("");
		setPage(Math.floor(index / ROWS_PER_PAGE));
	}, [revealRowId, table.rows]);

	const matches = useMemo(
		() => filterRows(table.rows, table.columns, query),
		[table.rows, table.columns, query],
	);

	/* A narrowed or refreshed result set can leave the reader past the end.
	 * Clamping during render (rather than in an effect) keeps the page shown
	 * and the page counted identical in the same commit: an effect would
	 * paint one frame of an empty page first. */
	const pageCount = Math.max(1, Math.ceil(matches.length / ROWS_PER_PAGE));
	const currentPage = Math.min(page, pageCount - 1);
	const start = currentPage * ROWS_PER_PAGE;
	const visible = matches.slice(start, start + ROWS_PER_PAGE);
	/* Off the WHOLE table, not the current match set: the hint is about the
	 * table being long, and it should not disappear the moment a query narrows
	 * the result to one page. */
	const multiPage = table.rows.length > ROWS_PER_PAGE;

	return (
		<div className="mt-6 min-w-0">
			{table.rows.length > 0 && (
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
			)}

			{table.rows.length === 0 ? (
				<p className="mb-3 max-w-md text-sm leading-relaxed text-nova-text-secondary">
					This table has its columns but no rows yet. Add rows one at a time, or
					replace them all at once from a CSV. Column settings remain available
					below.
				</p>
			) : matches.length === 0 ? (
				<p className="mt-6 text-sm leading-relaxed text-nova-text-secondary">
					No row in this table contains “{query.trim()}”.
				</p>
			) : null}

			<div className="mt-3 overflow-x-auto rounded-xl border border-nova-border">
				<table className="w-full min-w-max border-collapse text-left">
					<caption className="sr-only">
						{table.name}: {formatLookupCount(matches.length, "row")}
						{visible.length > 0
							? `, showing ${start + 1} to ${start + visible.length}`
							: ""}
					</caption>
					<thead>
						<tr className="border-b border-nova-border bg-nova-elevated">
							{table.columns.map((column) => (
								<th
									key={column.id}
									scope="col"
									className="min-w-36 p-0 align-bottom font-medium"
								>
									{/* The header IS the way to a column's settings, so it is
									 *  a real button rather than a header with a hidden gear:
									 *  one obvious target, keyboard-reachable in the tab
									 *  order the table already establishes. */}
									<Button
										type="button"
										variant="ghost"
										data-project-data-column-open={column.id}
										onClick={() => onSelectColumn(column.id)}
										className="h-auto min-h-11 w-full flex-col items-start gap-0 rounded-none px-3 py-2.5 text-left hover:bg-white/[0.05]"
									>
										<span className="block min-w-0 text-[13px] text-nova-text [overflow-wrap:anywhere]">
											{column.label}
										</span>
										<span className="block text-[12px] font-normal text-nova-text-muted">
											{COLUMN_TYPE_LABELS[column.dataType]}
										</span>
									</Button>
								</th>
							))}
							<th scope="col" className="w-px px-3 py-2.5">
								<span className="sr-only">Open row</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((row) => (
							<tr
								key={row.id}
								aria-selected={row.id === selectedRowId}
								className={`border-b border-nova-border last:border-b-0 ${
									row.id === selectedRowId
										? "bg-nova-violet/[0.10] shadow-[inset_2px_0_0_0_var(--nova-violet)]"
										: ""
								}`}
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
													<span aria-hidden="true">–</span>
													<span className="sr-only">No value</span>
												</span>
											) : (
												text
											)}
										</td>
									);
								})}
								<td className="w-px px-3 py-2.5 align-top">
									{draftRowIds.has(row.id) && (
										<span className="mr-1 inline-flex rounded-full bg-nova-amber/[0.12] px-2 py-1 text-[11px] font-medium text-nova-amber">
											Unsaved
										</span>
									)}
									{/* One control per row rather than a clickable row: a
									 *  row of selectable text should stay selectable, and a
									 *  whole-row button would swallow every drag. */}
									<Button
										type="button"
										variant="ghost"
										data-project-data-row-open={row.id}
										onClick={() => onSelectRow(row.id)}
										className="whitespace-nowrap text-[13px] text-nova-violet-bright"
									>
										Open
										<span className="sr-only"> row {rowLabel(table, row)}</span>
									</Button>
								</td>
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
						className=""
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
						className=""
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
		</div>
	);
}
