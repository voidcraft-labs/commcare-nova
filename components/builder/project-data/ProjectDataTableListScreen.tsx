/**
 * The Project data workspace's landing screen: every data table in the
 * Project, with what each one holds.
 *
 * A row states the table's name, the tag apps and exports address it by, and
 * its size in both units that can stop a write: rows and stored bytes:
 * because the two caps bind independently and a surface that shows only one
 * leaves an author guessing which limit refused them.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { CreateTableDialog } from "./CreateTableDialog";
import { ProjectDataFailure, ProjectDataLoading } from "./ProjectDataReadState";
import { useProjectDataWorkspace } from "./ProjectDataWorkspaceLazyProvider";
import {
	formatLookupBytes,
	formatLookupCount,
	type RetainedRowRecovery,
} from "./projectDataModel";

export function ProjectDataTableListScreen() {
	const workspace = useProjectDataWorkspace();
	const state = workspace?.manifest ?? { kind: "idle" as const };
	const reload = workspace?.reloadManifest ?? (async () => {});
	const retainedRows = workspace?.retainedRows ?? [];
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const [creating, setCreating] = useState(false);

	return (
		<section aria-labelledby="project-data-tables-heading" className="min-w-0">
			<h1
				id="project-data-tables-heading"
				className="font-display text-2xl font-semibold tracking-tighter text-nova-text"
			>
				Data tables
			</h1>
			<p className="mt-2 max-w-2xl text-sm leading-relaxed text-pretty text-nova-text-secondary">
				A data table holds a list you reuse across forms: facilities, districts,
				products, anything a question should offer as choices instead of asking
				someone to type. Point a question at a column here and everyone
				answering that question sees the same list.
			</p>

			{canEdit && (
				<Button
					type="button"
					variant="outline"
					className="mt-4 gap-2"
					onClick={() => setCreating(true)}
				>
					<Icon icon={tablerPlus} width="16" height="16" aria-hidden="true" />
					New data table
				</Button>
			)}

			{creating && (
				<CreateTableDialog
					open
					onClose={() => setCreating(false)}
					onCreated={reload}
				/>
			)}

			{retainedRows.length > 0 && workspace !== null && (
				<section
					aria-labelledby="project-data-recovery-heading"
					className="mt-6 rounded-xl border border-nova-amber/30 bg-nova-amber/[0.06] p-4"
				>
					<h2
						id="project-data-recovery-heading"
						className="text-sm font-semibold text-nova-text"
					>
						Row work to review
					</h2>
					<p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-nova-text-secondary">
						Nova kept this work when you closed Properties, changed tables, or
						lost access to the original table. It stays in this builder tab
						until you save it or explicitly discard its local copy.
					</p>
					<ul className="mt-3 space-y-2">
						{retainedRows.map((retained, index) => {
							const status = retainedRowStatus(retained);
							return (
								<li
									key={`${retained.tableId}:${retained.rowId}`}
									className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-2.5"
								>
									<span className="min-w-0">
										<span className="block text-[13px] font-medium text-nova-text [overflow-wrap:anywhere]">
											{retained.tableName}
										</span>
										<span className="mt-0.5 block text-[12px] leading-snug text-nova-text-secondary">
											{status}
										</span>
									</span>
									<Button
										type="button"
										variant="outline"
										className="shrink-0"
										onClick={() => workspace.openRetainedRow(retained)}
									>
										Review
										<span className="sr-only">
											{" "}
											{status.toLocaleLowerCase()} in {retained.tableName}, item{" "}
											{index + 1}
										</span>
									</Button>
								</li>
							);
						})}
					</ul>
				</section>
			)}

			{state.kind === "loading" || state.kind === "idle" ? (
				<ProjectDataLoading label="Loading this Project's data tables…" />
			) : state.kind === "failed" ? (
				<ProjectDataFailure
					title="These tables didn't load"
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
							: "Nobody has added a shared list to this Project yet."}
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
									{/* `whitespace-normal` is what makes the wrapping real. The
									    row is drawn as a Button and the button base sets
									    `whitespace-nowrap`, which pins the line and leaves
									    `[overflow-wrap:anywhere]` with nothing to do: a long
									    authored table name then ran straight off the card,
									    cut mid-word with no ellipsis, over its own chevron.
									    An authored name is content, so it wraps. */}
									<span className="min-w-0 whitespace-normal text-sm font-medium text-nova-text [overflow-wrap:anywhere]">
										{table.name}
									</span>
									<span className="min-w-0 whitespace-normal text-[12px] leading-snug text-nova-text-secondary [overflow-wrap:anywhere]">
										{formatLookupCount(table.columnCount, "column")} ·{" "}
										{formatLookupCount(table.rowCount, "row")} ·{" "}
										{formatLookupBytes(table.dataBytes)}
									</span>
									<span className="min-w-0 text-[12px] leading-snug text-nova-text-muted [overflow-wrap:anywhere]">
										Export tag: <code className="font-mono">{table.tag}</code>
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

function retainedRowStatus(retained: RetainedRowRecovery): string {
	switch (retained.state) {
		case "draft":
			return "Unsaved row changes";
		case "save-conflict":
			return "A save needs your decision";
		case "delete-conflict":
			return "A delete needs your decision";
		case "table-unavailable":
			return "Original table unavailable. Copy or discard this local row";
	}
}
