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
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import type { LookupColumnId, LookupRowId } from "@/lib/domain/lookupIds";
import { requiresLookupProjection } from "@/lib/lookup/source";
import type { LookupRow, LookupTableSnapshot } from "@/lib/lookup/types";
import { COLUMN_GONE_IN_HQ } from "@/lib/publish/managedData";
import { useNavigate } from "@/lib/routing/hooks";
import { ManagedTableBanner } from "./ManagedTableBanner";
import { ProjectDataFailure, ProjectDataLoading } from "./ProjectDataReadState";
import { useProjectDataWorkspace } from "./ProjectDataWorkspaceLazyProvider";
import {
	COLUMN_TYPE_LABELS,
	cellText,
	formatLookupBytes,
	formatLookupCount,
} from "./projectDataModel";
import { TableActions } from "./TableActions";
import { TableSourceActions } from "./TableSourceActions";
import type { ProjectRowsWindow, ProjectTableWindow } from "./useProjectData";

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
				{table.rowCount === null ||
				table.dataBytes === null ||
				requiresLookupProjection(table.hq) ? (
					"Source inventory in CommCare HQ"
				) : (
					<>
						{formatLookupCount(table.rowCount, "row")} ·{" "}
						{formatLookupBytes(table.dataBytes)}
					</>
				)}
			</p>
			<p className="mt-1 text-[12px] text-nova-text-muted">
				Export tag:{" "}
				<code className="font-mono text-nova-text-secondary">{table.tag}</code>
			</p>

			{workspace !== null && (
				<ManagedTableBanner table={table} workspace={workspace} />
			)}
			{workspace !== null && (
				<TableSourceActions table={table} workspace={workspace} />
			)}
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
				key={JSON.stringify([table.projectId, table.id])}
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
				query={workspace?.query ?? ""}
				openRows={(window) => workspace?.openRows(window)}
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
		: `at position ${((row.sourceIndex ?? table.rows.indexOf(row)) + 1).toLocaleString("en-US")}`;
}

/** One revision-bound database window per page keeps native table navigation
 * and searches the complete table, including text in individual details. */
function TableGrid({
	table,
	selectedRowId,
	draftRowIds,
	query,
	openRows,
	onSelectRow,
	onSelectColumn,
}: {
	table: ProjectTableWindow;
	selectedRowId: LookupRowId | undefined;
	draftRowIds: ReadonlySet<LookupRowId>;
	query: string;
	openRows: (window: ProjectRowsWindow) => void;
	onSelectRow: (rowId: LookupRowId) => void;
	onSelectColumn: (columnId: LookupColumnId) => void;
}) {
	const searchId = useId();
	const searchHintId = useId();
	const [typed, setTyped] = useState(query);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		setTyped(query);
		return () => clearTimeout(timer.current);
	}, [query]);
	const changeQuery = (next: string) => {
		clearTimeout(timer.current);
		setTyped(next);
		timer.current = setTimeout(() => openRows({ query: next }), 180);
	};
	const start = table.rowOffset ?? 0;
	const visible = table.rows;
	const count = table.matchingRowCount ?? table.rowCount ?? 0;
	const paged = Boolean(table.nextRowCursor || table.previousRowCursor);
	const searchedFor = table.searchedFor ?? "";
	const searchPending =
		typed.trim() !== (table.outsideSearch ?? searchedFor).trim();
	const multiPage = table.rowCount !== null && table.rowCount > 25;

	return (
		<div className="mt-6 min-w-0">
			{table.rowCount !== null &&
				table.rowCount > 0 &&
				!table.rowsUnavailable && (
					<div className="flex flex-wrap items-end justify-between gap-3">
						<div className="min-w-0 grow basis-64">
							<Label htmlFor={searchId} className="text-[12px]">
								Find a row
							</Label>
							<Input
								id={searchId}
								type="search"
								maxLength={200}
								value={typed}
								placeholder="Search every column"
								autoComplete="off"
								data-1p-ignore
								aria-describedby={multiPage ? searchHintId : undefined}
								onChange={(event) => {
									changeQuery(event.target.value);
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
							{searchedFor.trim() === ""
								? formatLookupCount(table.rowCount, "row")
								: `${formatLookupCount(count, "row")} matching`}
						</p>
					</div>
				)}

			{table.outsideSearch && (
				<p role="status">
					This row is outside your search for “{table.outsideSearch}”.{" "}
					<Button
						variant="ghost-action"
						onClick={() => openRows({ query: table.outsideSearch })}
					>
						Return to search
					</Button>
				</p>
			)}
			{table.rowCount === null ||
			table.rowCount === 0 ||
			table.rowsUnavailable ? (
				<p className="mb-3 max-w-md text-sm leading-relaxed text-nova-text-secondary">
					{table.rowsUnavailable || requiresLookupProjection(table.hq)
						? "A connected Project editor can inspect this table’s source inventory. Preview uses the rows available to the worker."
						: table.hq?.managedBy === "commcare-hq"
							? "The current copy contains no rows."
							: "This table has no rows yet. You can add a row when you're ready."}
				</p>
			) : count === 0 ? (
				<p className="mt-6 text-sm leading-relaxed text-nova-text-secondary">
					No row in this table contains “{searchedFor.trim()}”.
				</p>
			) : null}

			<div className="mt-3 overflow-x-auto rounded-xl border border-nova-border">
				<table className="w-full min-w-max border-collapse text-left">
					<caption className="sr-only">
						{table.name}.{" "}
						{table.rowsUnavailable
							? "Source inventory requires access"
							: formatLookupCount(count, "row")}
						{visible.length > 0
							? `, showing ${start + 1} to ${start + visible.length}`
							: ""}
					</caption>
					<thead>
						<tr className="border-b border-nova-border bg-nova-elevated">
							{table.attributes?.map((member) => (
								<th
									scope="col"
									key={member.id}
									className="min-w-36 px-3 py-2 text-left"
								>
									{member.label}
								</th>
							))}
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
											{column.repeated
												? "Repeated text"
												: COLUMN_TYPE_LABELS[column.dataType]}
										</span>
										{table.hq?.goneColumnIds.includes(column.id) === true && (
											<Badge variant="amber" className="mt-1">
												{COLUMN_GONE_IN_HQ}
											</Badge>
										)}
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
								{row.fragmented && (
									<td
										colSpan={
											table.columns.length + (table.attributes?.length ?? 0)
										}
										className="px-3 py-2.5 text-nova-text-secondary"
									>
										Open this row to read its values in parts.
									</td>
								)}
								{!row.fragmented &&
									table.attributes?.map((member) => (
										<td
											key={member.id}
											className="whitespace-pre-wrap px-3 py-2.5"
										>
											{row.attributes?.[member.id] || "Empty text"}
										</td>
									))}
								{!row.fragmented &&
									table.columns.map((column) => {
										const list = row.occurrences?.[column.id];
										const text = column.repeated
											? list === undefined
												? undefined
												: list.length
													? list
															.map((item) => item.text || "Empty text")
															.join(" · ")
													: "Empty list"
											: cellText(row.values, column);
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
										disabled={searchPending}
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

			{paged && (
				<nav
					aria-label="Rows, by page"
					className="mt-3 flex flex-wrap items-center justify-between gap-2"
				>
					<Button
						type="button"
						variant="outline"
						className=""
						disabled={searchPending || !table.previousRowCursor}
						onClick={() =>
							openRows({ query: searchedFor, after: table.previousRowCursor })
						}
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
						{count.toLocaleString()}
					</p>
					<Button
						type="button"
						variant="outline"
						className=""
						disabled={searchPending || !table.nextRowCursor}
						onClick={() =>
							openRows({ query: searchedFor, after: table.nextRowCursor })
						}
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
