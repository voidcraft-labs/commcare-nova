/**
 * Client island for the home app list — owns the active/deleted view
 * toggle and renders the corresponding card grid. Lists arrive as
 * props from the parent RSC; this component does no fetching.
 *
 * On a successful delete or restore, the underlying Server Action
 * calls `revalidatePath("/")` and the parent RSC re-fetches both
 * lists. React preserves this component's `view` state across that
 * re-render, so the user stays on whichever tab they were on.
 *
 * Per-card action state (idle → confirming → deleting / restoring →
 * unmount on success / error → idle) lives inside each card. This
 * file is deliberately small — view toggle plus a thin render branch.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArchive from "@iconify-icons/tabler/archive";
import { useState } from "react";
import { AppCard } from "@/components/ui/AppCard";
import { DeletedAppCard } from "@/components/ui/DeletedAppCard";
import type { AppSummary, DeletedAppSummary } from "@/lib/db/apps";
import { deleteApp, restoreApp } from "./app-actions";

interface AppListBodyProps {
	active: AppSummary[];
	deleted: DeletedAppSummary[];
	showReplay: boolean;
}

type View = "active" | "deleted";

export function AppListBody({ active, deleted, showReplay }: AppListBodyProps) {
	const [view, setView] = useState<View>("active");

	/* Tab strip is suppressed entirely when the user has nothing in the
	 * trash AND isn't currently viewing it — would otherwise be a
	 * degenerate one-pill switcher. Stays visible while the user is on
	 * the deleted view (even if a restore just emptied the count) so
	 * they always have a way back. */
	const tabsVisible = deleted.length > 0 || view === "deleted";

	return (
		<>
			{tabsVisible && (
				<Tabs view={view} onChange={setView} deletedCount={deleted.length} />
			)}

			{view === "active" ? (
				active.length === 0 ? (
					<p className="py-12 text-center text-sm text-nova-text-muted">
						No apps yet.
					</p>
				) : (
					<ul className="grid gap-3">
						{active.map((app, i) => (
							<li key={app.id}>
								<AppCard
									app={app}
									index={i}
									href={app.status === "error" ? undefined : `/build/${app.id}`}
									showReplay={showReplay}
									onDelete={deleteApp}
								/>
							</li>
						))}
					</ul>
				)
			) : deleted.length === 0 ? (
				<DeletedEmptyState />
			) : (
				<ul className="grid gap-3">
					{deleted.map((app, i) => (
						<li key={app.id}>
							<DeletedAppCard app={app} index={i} onRestore={restoreApp} />
						</li>
					))}
				</ul>
			)}
		</>
	);
}

// ── Tabs ───────────────────────────────────────────────────────────

interface TabsProps {
	view: View;
	onChange: (view: View) => void;
	deletedCount: number;
}

/**
 * Pill-style segmented control. Plain buttons — the toggle is local
 * UI state, no URL or navigation involved.
 */
function Tabs({ view, onChange, deletedCount }: TabsProps) {
	return (
		<div
			role="tablist"
			aria-label="Filter apps"
			className="mb-5 inline-flex rounded-lg border border-nova-border bg-nova-surface/40 p-0.5"
		>
			<TabButton
				active={view === "active"}
				onClick={() => onChange("active")}
				label="Active"
			/>
			<TabButton
				active={view === "deleted"}
				onClick={() => onChange("deleted")}
				label="Recently deleted"
				count={deletedCount}
			/>
		</div>
	);
}

interface TabButtonProps {
	active: boolean;
	onClick: () => void;
	label: string;
	count?: number;
}

function TabButton({ active, onClick, label, count }: TabButtonProps) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={`cursor-pointer rounded-md px-3 py-1 text-sm transition-colors ${
				active
					? "bg-nova-surface text-nova-text shadow-sm"
					: "text-nova-text-muted hover:text-nova-text"
			}`}
		>
			{label}
			{count !== undefined && count > 0 && (
				<span
					className={`ml-1.5 ${active ? "text-nova-text-muted" : "text-nova-text-muted/70"}`}
				>
					{count}
				</span>
			)}
		</button>
	);
}

// ── Empty state for the deleted view ───────────────────────────────

function DeletedEmptyState() {
	return (
		<div className="flex flex-col items-center gap-3 py-14 text-center">
			<Icon
				icon={tablerArchive}
				width="32"
				height="32"
				className="text-nova-text-muted/40"
			/>
			<p className="text-sm text-nova-text">Nothing in your trash</p>
			<p className="max-w-sm text-xs leading-relaxed text-nova-text-muted/70">
				Deleted apps stay here for 30 days before they&rsquo;re permanently
				removed by an automated cleanup. Anything restored within that window
				comes back exactly as it was.
			</p>
		</div>
	);
}
