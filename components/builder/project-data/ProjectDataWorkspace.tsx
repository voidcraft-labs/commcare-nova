/**
 * ProjectDataWorkspace — the URL-owned workspace for the Project's shared
 * data tables (`/build/{appId}/project-data[/{tableId}]`).
 *
 * It sits deliberately outside the structure tree. The tree represents the
 * runnable app — modules, case lists, forms — and a lookup table is none of
 * those: it belongs to the PROJECT, is shared by every app in it, and
 * outlives any one of them. Preview therefore has nothing to run from this
 * URL and leaves for the app home (`usePreviewModeTransition`).
 *
 * The shell is a fixed, non-scrolling identity strip over an independently
 * scrolling body — the same shape the case workspace's tabs and the App setup
 * sections use, so the configuration workspaces feel like one system. The
 * strip is where the sharing consequence is stated, and it is stated on every
 * screen rather than once at the door: an author who deep-links to a table
 * never passed the door.
 *
 * The open table's NAME titles the body, not the breadcrumb. A table name is
 * Project state the routing layer has no reader for, so a crumb carrying it
 * would have to resolve it from a second source and could drift; the
 * breadcrumb stops at "Project data" and stays the way back to the list.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerTable from "@iconify-icons/tabler/table";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	PROJECT_DATA_LABEL,
	PROJECT_DATA_SHARED_NOTICE,
} from "@/lib/routing/types";
import { ProjectDataTableListScreen } from "./ProjectDataTableListScreen";
import { ProjectDataTableScreen } from "./ProjectDataTableScreen";

export function ProjectDataWorkspace({ tableId }: { tableId?: LookupTableId }) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="relative z-raised shrink-0 border-b border-nova-border bg-pv-bg py-2.5">
				<ContentFrame width="5xl" className="px-3 @sm:px-6">
					<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
						<span className="flex min-w-0 shrink-0 items-center gap-2 text-[13px] font-medium text-nova-text">
							<Icon
								icon={tablerTable}
								width="16"
								height="16"
								className="shrink-0 text-nova-text-muted"
								aria-hidden="true"
							/>
							{PROJECT_DATA_LABEL}
						</span>
						{/* Not a dismissible banner and not a one-time notice: sharing is
						 *  a permanent property of every table on every screen here, so
						 *  it reads as a subtitle rather than an alert. */}
						<span className="min-w-0 text-[12px] leading-snug text-nova-text-secondary">
							{PROJECT_DATA_SHARED_NOTICE}
						</span>
					</div>
				</ContentFrame>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<ContentFrame width="5xl" className="px-3 py-6 @sm:px-6">
					{tableId === undefined ? (
						<ProjectDataTableListScreen />
					) : (
						<ProjectDataTableScreen />
					)}
				</ContentFrame>
			</div>
		</div>
	);
}
