/**
 * Replace every row in a table from a CSV.
 *
 * The word the whole surface turns on is REPLACE. `replaceLookupRows` is a
 * full replacement, not a merge and not an append, so the confirmation says so
 * in the action's own label ("Replace 412 rows") rather than in a footnote
 * under a neutral "Import" button.
 *
 * The file is checked in the browser before it is sent — same parser, same
 * validator, same bytes as the server will run — so a mismatched heading or a
 * value that does not fit its column is named immediately instead of after an
 * upload. The server's pass under the table lock remains the authority.
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
import type { LookupFailure, LookupTableSnapshot } from "@/lib/lookup/types";
import { useProjectId } from "@/lib/session/hooks";
import {
	countLookupCsvRows,
	importLookupCsv,
	inspectLookupCsv,
} from "./lookupCsvClient";
import { formatLookupCount } from "./projectDataModel";

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
	const [bytes, setBytes] = useState<Uint8Array | null>(null);
	const [fileName, setFileName] = useState<string | null>(null);
	const [rowCount, setRowCount] = useState<number | null>(null);
	const [problem, setProblem] = useState<LookupFailure<string> | null>(null);
	const [working, setWorking] = useState(false);

	const reset = () => {
		setBytes(null);
		setFileName(null);
		setRowCount(null);
		setProblem(null);
		setWorking(false);
	};

	const choose = async (file: File | undefined) => {
		if (file === undefined) return;
		reset();
		setFileName(file.name);
		const buffer = new Uint8Array(await file.arrayBuffer());
		const refusal = inspectLookupCsv(buffer, table.columns);
		if (refusal !== null) {
			setProblem(refusal);
			return;
		}
		setBytes(buffer);
		setRowCount(countLookupCsvRows(buffer));
	};

	const headings = table.columns.map((column) => column.wireName).join(", ");

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					reset();
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Replace every row from a CSV</DialogTitle>
					<DialogDescription>
						This replaces all {formatLookupCount(table.rowCount, "row")} in “
						{table.name}” with the rows in your file. It is not a merge — rows
						that are not in the file are removed.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div>
						<Label htmlFor={fileId} className="text-[13px]">
							CSV file
						</Label>
						{/* A labelled file input, not a styled button hiding one: the
						 *  native control is already keyboard- and screen-reader-complete,
						 *  and it names the chosen file without extra bookkeeping. */}
						<input
							ref={inputRef}
							id={fileId}
							type="file"
							accept=".csv,text/csv"
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

					{problem !== null && (
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
								problem.totalDetailCount > problem.details.length && (
									<p className="text-[13px] text-nova-text-muted">
										…and{" "}
										{formatLookupCount(
											problem.totalDetailCount - problem.details.length,
											"more problem",
										)}
										.
									</p>
								)}
						</div>
					)}

					{bytes !== null && problem === null && (
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
							{fileName} — {formatLookupCount(rowCount ?? 0, "row")}, ready to
							replace what is there now.
						</p>
					)}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						className="min-h-11"
						onClick={() => {
							reset();
							onClose();
						}}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						className="min-h-11"
						disabled={bytes === null || working || projectId === undefined}
						onClick={async () => {
							if (bytes === null || projectId === undefined) return;
							setWorking(true);
							const result = await importLookupCsv({
								projectId,
								tableId: table.id,
								expectedTableRevision: table.tableRevision,
								bytes,
							});
							setWorking(false);
							if (!result.success) {
								/* A replacement NEVER retries on its own. "The table changed
								 * underneath" is exactly the case where resending would
								 * destroy the change, so the author re-checks against what
								 * the table now holds and decides again. */
								setProblem(
									result.code === "conflict"
										? {
												...result,
												message:
													"Someone changed this table while you were choosing a file. Close this, look at what it holds now, and import again if you still want to replace it.",
											}
										: result,
								);
								return;
							}
							await onImported();
							reset();
							onClose();
						}}
					>
						{working
							? "Replacing…"
							: rowCount === null
								? "Replace every row"
								: `Replace with ${formatLookupCount(rowCount, "row")}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
