/**
 * Client island for the home app list: owns the active/deleted view
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
 * file is deliberately small: view toggle plus a thin render branch.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArchive from "@iconify-icons/tabler/archive";
import { useMemo, useState } from "react";
import {
	TabsList,
	Tabs as TabsRoot,
	TabsTrigger,
} from "@/components/shadcn/tabs";
import { AppCard, type AppProjectMoveTarget } from "@/components/ui/AppCard";
import { DeletedAppCard } from "@/components/ui/DeletedAppCard";
import type { AppSummary, DeletedAppSummary } from "@/lib/db/apps";
import { deleteApp, moveApp, restoreApp } from "./app-actions";

interface AppListBodyProps {
	active: AppSummary[];
	deleted: DeletedAppSummary[];
	/** Whether this member may soft-delete and restore Project apps. */
	canDeleteApp: boolean;
	/** Whether this member governs app placement in the active Project. */
	canMoveApp: boolean;
	/** The other Projects they may move an app into. */
	moveTargets: AppProjectMoveTarget[];
	/** Error apps whose durable build state the build page can reopen. */
	resumableErrorAppIds: string[];
}

type View = "active" | "deleted";

export function AppListBody({
	active,
	deleted,
	canDeleteApp,
	canMoveApp,
	moveTargets,
	resumableErrorAppIds,
}: AppListBodyProps) {
	const [view, setView] = useState<View>("active");

	/* Stable across renders so an open popover is not torn down mid-interaction
	 * by a fresh prop identity. */
	const projectMove = useMemo(
		() =>
			canMoveApp
				? ({
						targets: moveTargets,
						onMove: moveApp,
					} as const)
				: undefined,
		[canMoveApp, moveTargets],
	);
	const resumableErrors = useMemo(
		() => new Set(resumableErrorAppIds),
		[resumableErrorAppIds],
	);

	/* Tab strip is suppressed entirely when the user has nothing in the
	 * trash AND isn't currently viewing it: would otherwise be a
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
							<li key={app.id} className="min-w-0">
								<AppCard
									app={app}
									index={i}
									{...(app.status !== "error" || resumableErrors.has(app.id)
										? { href: `/build/${app.id}` }
										: {})}
									onDelete={canDeleteApp ? deleteApp : undefined}
									projectMove={projectMove}
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
						<li key={app.id} className="min-w-0">
							<DeletedAppCard
								app={app}
								index={i}
								onRestore={canDeleteApp ? restoreApp : undefined}
							/>
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
 * The filter strip, built from the shared Tabs primitive. The toggle is local
 * UI state, so it drives `value` / `onValueChange` rather than the URL.
 */
function Tabs({ view, onChange, deletedCount }: TabsProps) {
	return (
		/* The shared primitive, not a hand-rolled strip. Drawn by hand this was a
		 * pill inside a pill: the selected segment carried the standalone 18px
		 * radius while its container carried 12px, so the child was ROUNDER than
		 * the box holding it. A segmented control's inner radius is derived
		 * (container minus its inset), not a rung of the scale, and the primitive
		 * is where that arithmetic already lives. */
		<TabsRoot
			value={view}
			onValueChange={(value) => onChange(value as View)}
			className="mb-5"
		>
			<TabsList aria-label="Filter apps">
				<TabsTrigger value="active" className="px-3">
					Active
				</TabsTrigger>
				<TabsTrigger value="deleted" className="px-3">
					Recently deleted
					{deletedCount > 0 && (
						/* A real space, not a gap: `ml-1.5` alone leaves the text layer
						 * reading "Recently deleted2", which is what an accessible name
						 * and any text assertion actually see. */
						<>
							{" "}
							<span className="text-nova-text-muted">{deletedCount}</span>
						</>
					)}
				</TabsTrigger>
			</TabsList>
		</TabsRoot>
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
				className="text-nova-text-muted"
			/>
			<p className="text-sm text-nova-text">Nothing in your trash</p>
			<p className="max-w-sm text-xs leading-relaxed text-nova-text-muted">
				Deleted apps stay here for 30 days before they're permanently removed by
				an automated cleanup. Anything restored within that window comes back
				exactly as it was.
			</p>
		</div>
	);
}
