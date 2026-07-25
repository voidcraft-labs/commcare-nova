/**
 * What an author sees when a write could not be applied safely.
 *
 * It lives on the CONTROLLER's conflict rather than inside the row's own
 * inspector, because the most important case — a co-member deleted the row you
 * were editing — is exactly the one that removes the row from the table and
 * would unmount a body keyed to it. This surface outlives that.
 *
 * It branches on what was attempted, and the branch is load-bearing:
 *
 *   - a refused SAVE asks which set of values wins, and shows both;
 *   - a refused DELETE asks whether the row should still go. Offering the save
 *     question's "keep mine" here would quietly re-save a row the author asked
 *     to remove, using values they never typed.
 *
 * Nothing is discarded by rendering this. Whichever action is taken, the author
 * chose it with both versions in front of them.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import type { LookupColumn } from "@/lib/lookup/types";
import type {
	ProjectDataRowConflict,
	ProjectDataWorkspace,
} from "./ProjectDataWorkspaceProvider";
import { cellText } from "./projectDataModel";

export function RowConflictBody({
	conflict,
	columns,
	workspace,
}: {
	conflict: ProjectDataRowConflict;
	columns: readonly LookupColumn[];
	workspace: ProjectDataWorkspace;
}) {
	const [working, setWorking] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const gone = conflict.verdict.kind === "gone";
	const deleting = conflict.attempted === "delete";

	const reason = gone
		? deleting
			? "Someone else already deleted this row."
			: "Someone deleted this row while you were editing it."
		: conflict.verdict.kind === "ask" &&
				conflict.verdict.reason === "columns-changed"
			? "Someone changed this table’s columns while you were working, so these values may not mean the same thing anymore."
			: deleting
				? "Someone else changed this row while you were deleting it."
				: "Someone else saved this row while you were editing it.";

	const finish = async (run: () => Promise<unknown>) => {
		setWorking(true);
		setFailure(null);
		await run();
		setWorking(false);
	};

	return (
		<div className="space-y-4">
			<div
				role="alert"
				className="flex gap-2 rounded-lg border border-nova-amber/30 bg-nova-amber/[0.08] p-3"
			>
				<Icon
					icon={tablerAlertTriangle}
					width="16"
					height="16"
					className="mt-0.5 shrink-0 text-nova-amber"
					aria-hidden="true"
				/>
				<div className="min-w-0 space-y-1">
					<p className="text-[13px] font-medium text-nova-text">
						{deleting ? "This row wasn’t deleted" : "This row wasn’t saved"}
					</p>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{reason}{" "}
						{deleting
							? "Nothing has been removed."
							: "Nothing you typed has been lost."}
					</p>
				</div>
			</div>

			{!gone && (
				<dl className="space-y-3">
					{columns.map((column) => {
						const mine = cellText(conflict.draft, column);
						const theirs =
							conflict.current === undefined
								? undefined
								: cellText(conflict.current, column);
						if (mine === theirs) return null;
						return (
							<div key={column.id} className="min-w-0">
								<dt className="text-[13px] font-medium text-nova-text [overflow-wrap:anywhere]">
									{column.label}
								</dt>
								<dd className="mt-1 space-y-1 text-[13px]">
									<p className="text-nova-text-secondary [overflow-wrap:anywhere]">
										<span className="text-nova-text-muted">
											{deleting ? "What you saw: " : "Yours: "}
										</span>
										{mine ?? "No value"}
									</p>
									<p className="text-nova-text-secondary [overflow-wrap:anywhere]">
										<span className="text-nova-text-muted">
											{deleting ? "What it says now: " : "Already saved: "}
										</span>
										{theirs ?? "No value"}
									</p>
								</dd>
							</div>
						);
					})}
				</dl>
			)}

			{failure !== null && (
				<p role="alert" className="text-[13px] leading-relaxed text-nova-rose">
					{failure}
				</p>
			)}

			<div className="flex flex-wrap gap-2">
				{deleting && !gone && (
					<Button
						type="button"
						variant="destructive"
						className="min-h-11"
						disabled={working}
						onClick={() =>
							void finish(async () => {
								/* Clearing FIRST means the retry's own refusal replaces this
								 * conflict rather than being swallowed by the one on screen. */
								workspace.setRowConflict(null);
								const outcome = await workspace.deleteRow(conflict.rowId);
								if (outcome.kind === "failed") {
									setFailure(outcome.failure.message);
								} else if (outcome.kind === "conflict") {
									workspace.setRowConflict(outcome.conflict);
								}
							})
						}
					>
						Delete it anyway
					</Button>
				)}
				{!deleting && !gone && (
					<Button
						type="button"
						variant="default"
						className="min-h-11"
						disabled={working}
						onClick={() =>
							void finish(async () => {
								workspace.setRowConflict(null);
								const outcome = await workspace.saveRow(
									conflict.rowId,
									conflict.draft,
								);
								if (outcome.kind === "failed") {
									setFailure(outcome.failure.message);
								} else if (outcome.kind === "conflict") {
									workspace.setRowConflict(outcome.conflict);
								}
							})
						}
					>
						Keep mine
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					className="min-h-11"
					disabled={working}
					onClick={() =>
						void finish(async () => {
							workspace.setRowConflict(null);
							await workspace.reload();
						})
					}
				>
					{gone
						? "Close"
						: deleting
							? "Keep the row"
							: "Keep the saved version"}
				</Button>
			</div>
		</div>
	);
}
