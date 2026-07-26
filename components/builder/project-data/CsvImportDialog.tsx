/**
 * Replace every row in a table from one atomically checked CSV selection.
 *
 * A replacement is destructive and never retries itself. If any Project,
 * schema, or row generation changes after the file check, the author reviews
 * that same file against the fresh table and confirms again.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerFileSpreadsheet from "@iconify-icons/tabler/file-spreadsheet";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Label } from "@/components/shadcn/label";
import { getLookupTableAction } from "@/lib/lookup/actions";
import type { LookupFailure, LookupTableSnapshot } from "@/lib/lookup/types";
import { useProjectId } from "@/lib/session/hooks";
import {
	buildLookupCsvSelection,
	currentLookupCsvTable,
	type LookupCsvSelection,
	lookupCsvSelectionIsCurrent,
	shouldCommitLookupCsvRead,
} from "./csvImportModel";
import { importLookupCsv } from "./lookupCsvClient";
import { formatLookupCount } from "./projectDataModel";

type FileState =
	| { readonly kind: "none" }
	| {
			readonly kind: "reading";
			readonly generation: number;
			readonly name: string;
	  }
	| {
			readonly kind: "failed";
			readonly generation: number;
			readonly name: string;
			readonly problem: LookupFailure<string>;
	  }
	| { readonly kind: "ready"; readonly selection: LookupCsvSelection };

export function CsvImportDialog({
	open,
	table,
	onClose,
	onImported,
}: {
	open: boolean;
	table: LookupTableSnapshot;
	onClose: () => void;
	onImported: () => Promise<void>;
}) {
	const fileId = useId();
	const projectId = useProjectId();
	const inputRef = useRef<HTMLInputElement>(null);
	const generation = useRef(0);
	const [fileState, setFileState] = useState<FileState>({ kind: "none" });
	const [problem, setProblem] = useState<LookupFailure<string> | null>(null);
	const [reviewRequired, setReviewRequired] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [working, setWorking] = useState(false);
	const [reviewedTable, setReviewedTable] =
		useState<LookupTableSnapshot | null>(null);
	const busy = working || reviewing;
	const currentTable = currentLookupCsvTable(table, reviewedTable, projectId);

	const reset = () => {
		generation.current += 1;
		setFileState({ kind: "none" });
		setProblem(null);
		setReviewRequired(false);
		setReviewing(false);
		setReviewedTable(null);
		if (inputRef.current !== null) inputRef.current.value = "";
	};

	const close = () => {
		if (busy) return;
		reset();
		onClose();
	};

	const choose = async (file: File | undefined) => {
		if (file === undefined || busy) return;
		/* The File object is the durable selection; the native input value is
		 * only an event source. Clear it immediately so choosing the exact same
		 * path after a read/parse failure fires `change` again in every browser. */
		if (inputRef.current !== null) inputRef.current.value = "";
		generation.current += 1;
		const requestGeneration = generation.current;
		const projectAtChoice = projectId;
		const tableAtChoice = currentTable;
		setProblem(null);
		setReviewRequired(false);
		setFileState({
			kind: "reading",
			generation: requestGeneration,
			name: file.name,
		});
		if (projectAtChoice === undefined) {
			setFileState({
				kind: "failed",
				generation: requestGeneration,
				name: file.name,
				problem: {
					success: false,
					code: "not_found",
					message:
						"This project is still loading. Wait a moment, then choose the file again.",
				},
			});
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await file.arrayBuffer());
		} catch {
			if (!shouldCommitLookupCsvRead(requestGeneration, generation.current)) {
				return;
			}
			setFileState({
				kind: "failed",
				generation: requestGeneration,
				name: file.name,
				problem: {
					success: false,
					code: "invalid_csv",
					message:
						"That file could not be read. Choose it again, or try another CSV.",
				},
			});
			return;
		}
		if (!shouldCommitLookupCsvRead(requestGeneration, generation.current)) {
			return;
		}
		const result = buildLookupCsvSelection({
			generation: requestGeneration,
			projectId: projectAtChoice,
			table: tableAtChoice,
			file,
			bytes,
		});
		setFileState(
			result.ok
				? { kind: "ready", selection: result.selection }
				: {
						kind: "failed",
						generation: requestGeneration,
						name: file.name,
						problem: result.failure,
					},
		);
	};

	const selection =
		fileState.kind === "ready" ? fileState.selection : undefined;
	const current =
		selection !== undefined &&
		!reviewRequired &&
		lookupCsvSelectionIsCurrent(selection, projectId, currentTable);
	const displayedProblem =
		problem ?? (fileState.kind === "failed" ? fileState.problem : null);
	const headings = currentTable.columns
		.map((column) => column.wireName)
		.join(", ");

	const reviewAgainstLatest = async () => {
		if (selection === undefined || projectId === undefined) return;
		if (
			selection.projectId !== projectId ||
			selection.tableId !== currentTable.id
		) {
			setProblem({
				success: false,
				code: "not_found",
				message:
					"This file was checked for a different project or table. Close this dialog and open the CSV import again in the table you want to replace.",
			});
			return;
		}
		setReviewing(true);
		setProblem(null);
		let latest = currentTable;
		/* A server conflict proves the rendered prop is stale even if realtime
		 * has not delivered a new manifest yet. Read the exact current table
		 * directly; asking the parent hook to reload could replace the whole
		 * screen with an error and unmount the dialog holding these bytes. */
		if (reviewRequired) {
			try {
				const fresh = await getLookupTableAction(
					selection.projectId,
					selection.tableId,
				);
				if (
					!shouldCommitLookupCsvRead(selection.generation, generation.current)
				) {
					return;
				}
				if (!fresh.success) {
					setProblem(fresh);
					return;
				}
				latest = fresh.value;
				setReviewedTable(fresh.value);
			} catch {
				setProblem({
					success: false,
					code: "internal_error",
					message:
						"Nova could not load the latest table. Check your connection and try again; nothing was replaced.",
				});
				return;
			} finally {
				setReviewing(false);
			}
		}
		const result = buildLookupCsvSelection({
			generation: selection.generation,
			projectId,
			table: latest,
			file: selection.file,
			bytes: selection.bytes,
		});
		if (result.ok) {
			setFileState({ kind: "ready", selection: result.selection });
			setReviewRequired(false);
			setProblem(null);
		} else {
			/* The checked bytes remain the draft. A new schema can make them
			 * invalid without granting permission to forget the file; another
			 * table change may make those same bytes reviewable again. */
			setProblem(result.failure);
			setReviewRequired(true);
		}
		setReviewing(false);
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !next && close()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Replace every row from a CSV</DialogTitle>
					<DialogDescription>
						This replaces all {formatLookupCount(currentTable.rowCount, "row")}{" "}
						in “{currentTable.name}” with the rows in your file. It is not a
						merge — rows that are not in the file are removed.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div>
						<Label htmlFor={fileId} className="text-[13px]">
							CSV file
						</Label>
						<input
							ref={inputRef}
							id={fileId}
							type="file"
							accept=".csv,text/csv"
							disabled={busy}
							autoComplete="off"
							data-1p-ignore
							onChange={(event) => void choose(event.target.files?.[0])}
							className="mt-1 block w-full text-[13px] text-nova-text-secondary file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-lg file:border file:border-nova-border file:bg-nova-elevated file:px-3 file:text-[13px] file:text-nova-text hover:file:bg-white/[0.05]"
						/>
					</div>

					<p className="text-[12px] leading-snug text-nova-text-muted">
						The first line must be exactly these headings, in any order:{" "}
						<span className="[overflow-wrap:anywhere]">{headings}</span>
					</p>

					{fileState.kind === "reading" && (
						<p role="status" className="text-[13px] text-nova-text-secondary">
							Checking {fileState.name}…
						</p>
					)}

					{selection !== undefined && !current && (
						<div
							role="alert"
							className="rounded-lg border border-nova-amber/30 bg-nova-amber/[0.08] p-3"
						>
							<p className="text-[13px] leading-relaxed text-nova-text-secondary">
								This table changed after “{selection.fileName}” was checked.
								Review the same file against the latest columns and{" "}
								{formatLookupCount(currentTable.rowCount, "row")} before
								replacing anything.
							</p>
							<Button
								type="button"
								variant="outline"
								className="mt-2 min-h-11"
								disabled={busy}
								onClick={() => void reviewAgainstLatest()}
							>
								{reviewing
									? "Loading latest table…"
									: "Review file against latest table"}
							</Button>
						</div>
					)}

					{displayedProblem !== null && (
						<ProblemDetails problem={displayedProblem} />
					)}

					{selection !== undefined && current && displayedProblem === null && (
						<p
							role="status"
							className="flex items-center gap-2 text-[13px] text-nova-text-secondary"
						>
							<Icon
								icon={tablerFileSpreadsheet}
								width="16"
								height="16"
								className="shrink-0 text-nova-text-muted"
								aria-hidden="true"
							/>
							{selection.fileName} —{" "}
							{formatLookupCount(selection.rowCount, "row")}, checked against
							the current table and ready to replace{" "}
							{formatLookupCount(selection.replacedRowCount, "row")}.
						</p>
					)}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						className="min-h-11"
						disabled={busy}
						onClick={close}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						className="min-h-11"
						disabled={
							selection === undefined ||
							!current ||
							busy ||
							projectId === undefined
						}
						onClick={async () => {
							if (
								selection === undefined ||
								projectId === undefined ||
								!lookupCsvSelectionIsCurrent(selection, projectId, currentTable)
							) {
								return;
							}
							setWorking(true);
							setProblem(null);
							let result: Awaited<ReturnType<typeof importLookupCsv>>;
							try {
								result = await importLookupCsv({
									projectId: selection.projectId,
									tableId: selection.tableId,
									expectedTableRevision: selection.tableRevision,
									bytes: selection.bytes,
								});
							} catch {
								setProblem({
									success: false,
									code: "internal_error",
									message:
										"Nova could not upload this CSV. Check your connection and try again. Nothing was replaced.",
								});
								setWorking(false);
								return;
							}
							if (!result.success) {
								if (result.code === "conflict") {
									setReviewRequired(true);
								}
								setProblem(
									result.code === "conflict"
										? {
												...result,
												message:
													"Someone changed this table before the replacement landed. Nothing was replaced. Review this file against the latest table before trying again.",
											}
										: result,
								);
								setWorking(false);
								return;
							}
							try {
								await onImported();
								setWorking(false);
								reset();
								onClose();
							} catch {
								setProblem({
									success: false,
									code: "internal_error",
									message:
										"The rows were replaced, but Nova could not refresh the table. Reload the page to see the latest rows.",
								});
								setWorking(false);
							}
						}}
					>
						{working
							? "Replacing…"
							: selection === undefined
								? "Replace every row"
								: `Replace with ${formatLookupCount(selection.rowCount, "row")}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ProblemDetails({ problem }: { problem: LookupFailure<string> }) {
	const shownDetailCount = Math.min(8, problem.details?.length ?? 0);
	return (
		<div
			role="alert"
			className="space-y-1 rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3"
		>
			<p className="text-[13px] font-medium text-nova-text">
				{problem.message}
			</p>
			{problem.details !== undefined && problem.details.length > 0 && (
				<ul className="space-y-1 text-[13px] leading-relaxed text-nova-text-secondary">
					{problem.details.slice(0, 8).map((detail) => (
						<li
							key={`${detail.code}:${detail.row ?? ""}:${detail.column ?? ""}:${detail.message}`}
							className="[overflow-wrap:anywhere]"
						>
							{detail.row === undefined
								? detail.message
								: `Line ${detail.row}: ${detail.message}`}
						</li>
					))}
				</ul>
			)}
			{problem.totalDetailCount !== undefined &&
				problem.details !== undefined &&
				problem.totalDetailCount > shownDetailCount && (
					<p className="text-[13px] text-nova-text-muted">
						…and{" "}
						{formatLookupCount(
							problem.totalDetailCount - shownDetailCount,
							"more problem",
						)}
						.
					</p>
				)}
		</div>
	);
}
