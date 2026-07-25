/**
 * The Project data workspace's landing screen: every data table in the
 * Project, with what each one holds.
 *
 * A row states the table's name, the tag apps and exports address it by, and
 * its size in both units that can stop a write — rows and stored bytes —
 * because the two caps bind independently and a surface that shows only one
 * leaves an author guessing which limit refused them.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerDatabase from "@iconify-icons/tabler/database";
import { Button } from "@/components/shadcn/button";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { ProjectDataFailure, ProjectDataLoading } from "./ProjectDataReadState";
import { formatCount, formatStorageSize } from "./projectDataModel";
import { useProjectDataManifest } from "./useProjectData";

export function ProjectDataTableListScreen() {
	const { state, reload } = useProjectDataManifest();
	const navigate = useNavigate();
	const canEdit = useCanEdit();

	return (
		<section aria-labelledby="project-data-tables-heading" className="min-w-0">
			<h1
				id="project-data-tables-heading"
				className="font-display text-2xl font-semibold tracking-tight text-nova-text"
			>
				Data tables
			</h1>
			<p className="mt-2 max-w-2xl text-sm leading-relaxed text-pretty text-nova-text-secondary">
				A data table holds a list you reuse across forms — facilities,
				districts, products, anything a question should offer as choices instead
				of asking someone to type. Point a question at a column here and
				everyone answering that question sees the same list.
			</p>

			{state.kind === "loading" || state.kind === "idle" ? (
				<ProjectDataLoading label="Loading this project’s data tables…" />
			) : state.kind === "failed" ? (
				<ProjectDataFailure
					title="These tables didn’t load"
					failure={state.failure}
					onRetry={() => void reload()}
				/>
			) : state.value.tables.length === 0 ? (
				<div className="mt-10 flex max-w-md flex-col items-start gap-3">
					<span className="grid size-10 place-items-center rounded-xl bg-nova-violet/[0.09] text-nova-violet-bright">
						<Icon
							icon={tablerDatabase}
							width="18"
							height="18"
							aria-hidden="true"
						/>
					</span>
					<p className="font-medium text-nova-text">No data tables yet</p>
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{canEdit
							? "Create one when you have a list that more than one question, or more than one app, should share."
							: "Nobody has added a shared list to this project yet."}
					</p>
				</div>
			) : (
				<ul className="mt-6 space-y-2">
					{state.value.tables.map((table) => (
						<li key={table.id}>
							<Button
								type="button"
								variant="ghost"
								onClick={() => navigate.openProjectData(table.id)}
								className="h-auto min-h-16 w-full justify-between gap-3 rounded-xl border border-nova-border bg-nova-elevated px-4 py-3 text-left hover:bg-white/[0.05]"
							>
								<span className="flex min-w-0 flex-col gap-1">
									<span className="min-w-0 text-sm font-medium text-nova-text [overflow-wrap:anywhere]">
										{table.name}
									</span>
									<span className="min-w-0 text-[12px] leading-snug text-nova-text-secondary [overflow-wrap:anywhere]">
										{formatCount(table.columnCount, "column")} ·{" "}
										{formatCount(table.rowCount, "row")} ·{" "}
										{formatStorageSize(table.dataBytes)}
									</span>
								</span>
								<Icon
									icon={tablerChevronRight}
									width="16"
									height="16"
									className="shrink-0 text-nova-text-muted"
									aria-hidden="true"
								/>
							</Button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
