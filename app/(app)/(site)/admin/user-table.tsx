"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronUp from "@iconify-icons/tabler/chevron-up";
import {
	columnFilteringFeature,
	createColumnHelper,
	createFilteredRowModel,
	createSortedRowModel,
	globalFilteringFeature,
	rowSortingFeature,
	type SortingState,
	sortFns,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import Image from "next/image";
import { useState } from "react";
import { Badge } from "@/components/shadcn/badge";
import { Input } from "@/components/shadcn/input";
import { RelativeTime } from "@/components/ui/RelativeTime";
import type { AdminUserRow } from "@/lib/admin/types";
import { useExternalNavigate } from "@/lib/routing/hooks";
import { formatCurrency } from "@/lib/utils/format";

// ── Table Features ───────────────────────────────────────────────

// The full built-in sortFns registry keeps `sortFn: "auto"` resolving per
// column data type (text/alphanumeric/datetime), matching v8's behavior;
// without a registry every auto column would fall back to basic sorting.
const features = tableFeatures({
	rowSortingFeature,
	columnFilteringFeature,
	globalFilteringFeature,
	sortedRowModel: createSortedRowModel(),
	filteredRowModel: createFilteredRowModel(),
	sortFns,
});

const columnHelper = createColumnHelper<typeof features, AdminUserRow>();

// ── Column Definitions ───────────────────────────────────────────

const columns = columnHelper.columns([
	columnHelper.accessor("name", {
		header: "User",
		cell: ({ row }) => (
			<div className="flex items-center gap-2.5">
				{row.original.image ? (
					<Image
						src={row.original.image}
						alt=""
						width={24}
						height={24}
						className="w-6 h-6 rounded-full border border-nova-border"
					/>
				) : (
					<div className="w-6 h-6 rounded-full bg-nova-surface border border-nova-border flex items-center justify-center text-[10px] text-nova-text-secondary">
						{row.original.name.charAt(0).toUpperCase()}
					</div>
				)}
				<span className="font-medium">{row.original.name}</span>
			</div>
		),
	}),
	columnHelper.accessor("email", {
		header: "Email",
		cell: ({ getValue }) => (
			<span className="text-nova-text-secondary">{getValue()}</span>
		),
	}),
	columnHelper.accessor("role", {
		header: "Role",
		cell: ({ getValue }) => {
			const role = getValue();
			return (
				<Badge variant={role === "admin" ? "violet" : "muted"}>
					{role === "admin" ? "Admin" : "User"}
				</Badge>
			);
		},
	}),
	columnHelper.accessor("app_count", {
		header: "Apps",
		cell: ({ getValue }) => <span className="tabular-nums">{getValue()}</span>,
	}),
	columnHelper.accessor("generations", {
		header: "Generations",
		cell: ({ getValue }) => <span className="tabular-nums">{getValue()}</span>,
	}),
	// Sort on `credits_remaining`: the figure an admin scans to find
	// low-balance users, while the cell renders the full standing.
	columnHelper.accessor("credits_remaining", {
		header: "Credits",
		cell: ({ row }) => <CreditsCell user={row.original} />,
	}),
	columnHelper.accessor("credits_used_lifetime", {
		header: "Lifetime credits",
		cell: ({ getValue }) => (
			<span className="tabular-nums">{getValue().toLocaleString()}</span>
		),
	}),
	// This month's true dollar cost: tracked for tuning + backstop, no
	// longer the user-facing gate (the credit columns are the gate now).
	columnHelper.accessor("cost", {
		header: "Cost this month",
		cell: ({ getValue }) => (
			<span className="tabular-nums">{formatCurrency(getValue())}</span>
		),
	}),
	columnHelper.accessor("cost_lifetime", {
		header: "Lifetime cost",
		cell: ({ getValue }) => (
			<span className="tabular-nums">{formatCurrency(getValue())}</span>
		),
	}),
	columnHelper.accessor("last_active_at", {
		header: "Last active",
		cell: ({ getValue }) => (
			<RelativeTime
				date={new Date(getValue())}
				className="first-letter:uppercase"
			/>
		),
		sortFn: "datetime",
	}),
]);

// ── Credits Cell ─────────────────────────────────────────────────

/**
 * Renders a user's current-period credit standing in one compact line.
 *
 * `credits_remaining` is the load-bearing number: the figure an admin scans
 * to spot who's running low, so it leads with `font-semibold`. The
 * `used / total` context follows in a muted token, kept inline (not stacked)
 * so the cell stays single-line and the row height matches its siblings.
 *
 * The denominator is the EFFECTIVE monthly total, derived as
 * `credits_used + credits_remaining`: deliberately NOT a bare per-month
 * allowance. Once an admin grants bonus credits, `remaining = allowance + bonus
 * − used`, so a bare allowance would no longer reconcile with the bold remaining
 * and the bonus would be invisible on the row. The row doesn't carry `bonus`,
 * but `used + remaining === allowance + bonus` by definition, so
 * `used + remaining` recovers the effective allowance+bonus and keeps the muted
 * context consistent with the bold remaining for granted and ungranted users
 * alike.
 *
 * Emphasis is carried by weight, not colour: success/warning hues are reserved
 * for real semantic states, and "low balance" is surfaced by sorting on this
 * column, not by tinting the number.
 */
function CreditsCell({ user }: { user: AdminUserRow }) {
	// Effective monthly total = allowance + bonus, recovered from the two
	// figures the row carries (a bonus grant inflates `credits_remaining`).
	const total = user.credits_used + user.credits_remaining;
	return (
		<span className="flex items-baseline gap-1.5 tabular-nums whitespace-nowrap">
			<span className="font-semibold">
				{user.credits_remaining.toLocaleString()}
			</span>
			<span className="text-xs text-nova-text-muted">
				{user.credits_used.toLocaleString()} / {total.toLocaleString()} used
			</span>
		</span>
	);
}

// ── Sort Indicator ───────────────────────────────────────────────

function SortIndicator({ direction }: { direction: false | "asc" | "desc" }) {
	if (direction === "asc")
		return (
			<Icon
				icon={tablerChevronUp}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
		);
	if (direction === "desc")
		return (
			<Icon
				icon={tablerChevronDown}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
		);
	return (
		<Icon
			icon={tablerArrowsSort}
			width="14"
			height="14"
			className="opacity-30"
		/>
	);
}

// ── User Table ───────────────────────────────────────────────────

/**
 * Interactive admin user table with sorting, filtering, and row navigation.
 *
 * Client component because it manages table state (sorting, search filter)
 * and handles row click/keyboard navigation via useExternalNavigate.
 */
export function UserTable({ users }: { users: AdminUserRow[] }) {
	const navigate = useExternalNavigate();
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "last_active_at", desc: true },
	]);
	const [globalFilter, setGlobalFilter] = useState("");

	const table = useTable({
		features,
		data: users,
		columns,
		state: { sorting, globalFilter },
		onSortingChange: setSorting,
		onGlobalFilterChange: setGlobalFilter,
	});

	return (
		<div className="space-y-6">
			{/* Search */}
			<Input
				type="text"
				value={globalFilter}
				onChange={(e) => setGlobalFilter(e.target.value)}
				placeholder="Search users"
				aria-label="Search users"
				autoComplete="off"
				data-1p-ignore
			/>

			{/* Table */}
			<div className="rounded-lg border border-nova-border overflow-x-auto">
				<table className="w-full">
					<thead>
						{table.getHeaderGroups().map((headerGroup) => (
							<tr
								key={headerGroup.id}
								className="border-b border-nova-border bg-nova-deep/50"
							>
								{headerGroup.headers.map((header) => (
									<th
										scope="col"
										key={header.id}
										onClick={header.column.getToggleSortingHandler()}
										className={`
                      px-4 py-3 text-left text-xs font-medium
                      ${header.column.getIsSorted() ? "text-nova-violet-bright" : "text-nova-text-secondary"}
                      ${header.column.getCanSort() ? "cursor-pointer select-none hover:text-nova-text" : ""}
                    `}
									>
										<div className="flex items-center gap-1">
											<table.FlexRender header={header} />
											{header.column.getCanSort() && (
												<SortIndicator
													direction={header.column.getIsSorted()}
												/>
											)}
										</div>
									</th>
								))}
							</tr>
						))}
					</thead>
					<tbody>
						{table.getRowModel().rows.map((row) => (
							<tr
								key={row.id}
								tabIndex={0}
								aria-label={`View ${row.original.name}'s profile`}
								onClick={() => navigate.push(`/admin/users/${row.original.id}`)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										navigate.push(`/admin/users/${row.original.id}`);
									}
								}}
								className="nova-focusable-inset border-b border-nova-border/50 hover:bg-nova-surface/50 transition-colors cursor-pointer"
							>
								{row.getAllCells().map((cell) => (
									<td key={cell.id} className="px-4 py-3 text-sm">
										<table.FlexRender cell={cell} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>

				{table.getRowModel().rows.length === 0 && (
					<div className="text-center py-12 text-nova-text-secondary">
						{globalFilter ? "No users match your search" : "No users found"}
					</div>
				)}
			</div>
		</div>
	);
}
