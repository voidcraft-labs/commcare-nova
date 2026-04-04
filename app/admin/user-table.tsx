"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronUp from "@iconify-icons/tabler/chevron-up";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import type { AdminUserRow } from "@/lib/types/admin";
import { formatCurrency, formatRelativeDate } from "@/lib/utils/format";

// ── Column Definitions ───────────────────────────────────────────

const columns: ColumnDef<AdminUserRow>[] = [
	{
		accessorKey: "name",
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
	},
	{
		accessorKey: "email",
		header: "Email",
		cell: ({ getValue }) => (
			<span className="text-nova-text-secondary">{getValue<string>()}</span>
		),
	},
	{
		accessorKey: "role",
		header: "Role",
		cell: ({ getValue }) => {
			const role = getValue<"user" | "admin">();
			return (
				<Badge variant={role === "admin" ? "violet" : "muted"}>{role}</Badge>
			);
		},
	},
	{
		accessorKey: "app_count",
		header: "Apps",
		cell: ({ getValue }) => (
			<span className="tabular-nums">{getValue<number>()}</span>
		),
	},
	{
		accessorKey: "generations",
		header: "Generations",
		cell: ({ getValue }) => (
			<span className="tabular-nums">{getValue<number>()}</span>
		),
	},
	{
		accessorKey: "cost",
		header: "Spend",
		cell: ({ getValue }) => (
			<span className="tabular-nums">{formatCurrency(getValue<number>())}</span>
		),
	},
	{
		accessorKey: "last_active_at",
		header: "Last Active",
		cell: ({ getValue }) => formatRelativeDate(new Date(getValue<string>())),
		sortingFn: "datetime",
	},
];

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
 * and handles row click/keyboard navigation via useRouter.
 */
export function UserTable({ users }: { users: AdminUserRow[] }) {
	const router = useRouter();
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "last_active_at", desc: true },
	]);
	const [globalFilter, setGlobalFilter] = useState("");

	const table = useReactTable({
		data: users,
		columns,
		state: { sorting, globalFilter },
		onSortingChange: setSorting,
		onGlobalFilterChange: setGlobalFilter,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	});

	return (
		<div className="space-y-6">
			{/* Search */}
			<input
				type="text"
				value={globalFilter}
				onChange={(e) => setGlobalFilter(e.target.value)}
				placeholder="Search users..."
				aria-label="Search users"
				autoComplete="off"
				data-1p-ignore
				className="w-full px-4 py-2.5 text-sm bg-nova-deep border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)] transition-all"
			/>

			{/* Table */}
			<div className="rounded-xl border border-nova-border overflow-x-auto">
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
                      px-4 py-3 text-left text-xs font-display font-semibold uppercase tracking-wide
                      ${header.column.getIsSorted() ? "text-nova-violet-bright" : "text-nova-text-secondary"}
                      ${header.column.getCanSort() ? "cursor-pointer select-none hover:text-nova-text" : ""}
                    `}
									>
										<div className="flex items-center gap-1">
											{flexRender(
												header.column.columnDef.header,
												header.getContext(),
											)}
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
								onClick={() =>
									router.push(
										`/admin/users/${encodeURIComponent(row.original.email)}`,
									)
								}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										router.push(
											`/admin/users/${encodeURIComponent(row.original.email)}`,
										);
									}
								}}
								className="border-b border-nova-border/50 hover:bg-nova-surface/50 transition-colors cursor-pointer focus:outline-none focus:ring-1 focus:ring-nova-violet/50"
							>
								{row.getVisibleCells().map((cell) => (
									<td key={cell.id} className="px-4 py-3 text-sm">
										{flexRender(cell.column.columnDef.cell, cell.getContext())}
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
