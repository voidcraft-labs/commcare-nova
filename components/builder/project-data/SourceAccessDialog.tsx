"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import {
	attestSourceWorkbookAction,
	inspectInlineSourceRowAction,
	inspectManagedLookupWorkerAction,
	readSourceWorkbookReceiptAction,
} from "@/lib/deployment/managedInventoryActions";
import type { SourceWorkbookReceipt } from "@/lib/deployment/managedLookupObservation";
import type { LookupTableSnapshot } from "@/lib/lookup/types";

type Inspection = Extract<
	Awaited<ReturnType<typeof inspectManagedLookupWorkerAction>>,
	{ ok: true }
>["inspection"];

export function SourceAccessDialog({
	table,
	onClose,
}: {
	table: LookupTableSnapshot;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [receipt, setReceipt] = useState<SourceWorkbookReceipt | null>(null);
	const [inspection, setInspection] = useState<Inspection | null>(null);
	const [page, setPage] = useState<
		| Extract<
				Awaited<ReturnType<typeof inspectInlineSourceRowAction>>,
				{ ok: true }
		  >["page"]
		| null
	>(null);
	const version = useRef(0);
	const projectId = table.projectId,
		id = table.id;
	useEffect(() => {
		const token = ++version.current;
		const load = async () => {
			try {
				const result = await readSourceWorkbookReceiptAction(projectId, id);
				if (token !== version.current) return;
				if (result.ok) setReceipt(result.receipt);
				else setError(result.message);
			} catch {
				if (token === version.current)
					setError(
						"Nova couldn't read the last workbook check. You can reopen this table to try again.",
					);
			}
		};
		void load();
		return () => {
			++version.current;
		};
	}, [projectId, id]);
	const run = async (mode: "worker" | "workbook") => {
		const token = ++version.current;
		setPending(true);
		setError("");
		setInspection(null);
		try {
			if (mode === "worker") {
				const result = await inspectManagedLookupWorkerAction(
					projectId,
					id,
					name,
				);
				if (token !== version.current) return;
				if (result.ok) setInspection(result.inspection);
				else setError(result.message);
			} else if (file) {
				const form = new FormData();
				form.set("workbook", file);
				const result = await attestSourceWorkbookAction(projectId, id, form);
				if (token !== version.current) return;
				if (result.ok) setReceipt(result.receipt);
				else setError(result.message);
			}
		} catch {
			if (token === version.current)
				setError(
					"Nova couldn't finish this check. You can reconnect to the project space and try again.",
				);
		} finally {
			if (token === version.current) setPending(false);
		}
	};
	const showRow = async (ordinal: number) => {
		const token = ++version.current;
		setPending(true);
		setError("");
		setInspection(null);
		try {
			const result = await inspectInlineSourceRowAction(
				projectId,
				id,
				ordinal,
				page?.revision,
			);
			if (token !== version.current) return;
			if (result.ok) setPage(result.page);
			else {
				setPage(null);
				setError(result.message);
			}
		} catch {
			if (token === version.current) {
				setPage(null);
				setError(
					"Nova couldn't verify this source row. You can refresh the source and try again.",
				);
			}
		} finally {
			if (token === version.current) setPending(false);
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Check source access</DialogTitle>
					<DialogDescription>
						{table.name} in {table.hq?.domain}
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-5">
					<section className="space-y-2">
						<h3 className="font-medium">Worker access</h3>
						<label className="text-sm" htmlFor="lookup-worker-name">
							Mobile worker username
						</label>
						<Input
							id="lookup-worker-name"
							value={name}
							disabled={pending}
							onChange={(event) => {
								setName(event.target.value);
								setInspection(null);
							}}
						/>
						<p className="text-sm text-nova-text-secondary">
							You can leave this blank to check your connected account. Each
							check reads the current rows for that account.
						</p>
						<Button
							variant="outline"
							disabled={pending}
							onClick={() => void run("worker")}
						>
							Check worker data
						</Button>
						{inspection && (
							<div role="status" className="space-y-1">
								<p>
									{inspection.worker} could read {inspection.rows}{" "}
									{inspection.rows === 1 ? "row" : "rows"} at{" "}
									{new Date(inspection.observedAt).toLocaleString()}.
								</p>
								{inspection.sample.map((row, index) => (
									<details key={`${inspection.observedAt}-${String(index)}`}>
										<summary>Row {index + 1}</summary>
										<dl className="space-y-1 ps-3">
											{Object.entries(row.attributes).map(([key, value]) => (
												<div key={key}>
													<dt>{key}</dt>
													<dd>{value}</dd>
												</div>
											))}
											{row.fields.map((field, i) => (
												<div key={`${field.name}-${String(i)}`}>
													<dt>{field.name}</dt>
													<dd className="whitespace-pre-wrap">
														{field.text || <i>Empty text</i>}
														{Object.entries(field.properties).map(([k, v]) => (
															<p key={k}>
																{k} · {v}
															</p>
														))}
													</dd>
												</div>
											))}
										</dl>
									</details>
								))}
							</div>
						)}
					</section>
					<section className="space-y-2">
						{table.hq?.source?.inventory === "complete" &&
							table.hq.source.distribution === "assigned" &&
							!table.hq.source.storage && (
								<div className="space-y-2 pb-4">
									<h3 className="font-medium">Source inventory</h3>
									<p className="text-sm">
										An editor can inspect the source independently of who
										receives each row.
									</p>
									<Button
										variant="outline"
										disabled={pending}
										onClick={() => void showRow(0)}
									>
										Check first row
									</Button>
									{page && (
										<>
											<p>
												{page.total === 0
													? "The source inventory is empty."
													: `Row ${page.ordinal + 1} of ${page.total}`}
											</p>
											{page.text && (
												<pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">
													{page.text}
												</pre>
											)}
											{page.ordinal + 1 < page.total && (
												<Button
													variant="outline"
													disabled={pending}
													onClick={() => void showRow(page.ordinal + 1)}
												>
													Next source row
												</Button>
											)}
										</>
									)}
								</div>
							)}
						<h3 className="font-medium">Assignment workbook</h3>
						<p className="text-sm text-nova-text-secondary">
							Choose the workbook downloaded for this table alone. Nova checks
							its rows, indexes and named workers, groups and places against the
							source project space.
						</p>
						<label htmlFor="source-workbook" className="text-sm">
							Selected-table workbook (.xlsx, up to 768 KiB)
						</label>
						<Input
							id="source-workbook"
							type="file"
							accept=".xlsx"
							disabled={pending}
							onChange={(e) => setFile(e.target.files?.[0] ?? null)}
						/>
						<Button
							variant="outline"
							disabled={!file || pending}
							onClick={() => void run("workbook")}
						>
							Check and record workbook
						</Button>
						{receipt && (
							<p role="status" className="text-sm">
								Workbook checked {new Date(receipt.observedAt).toLocaleString()}
								. It recorded {receipt.rows} rows, {receipt.assignedRows} with
								named access, and {receipt.indexedFields.length} indexed
								columns. Access can change in the project space after this
								check.
							</p>
						)}
					</section>
					{pending && <p role="status">Checking the source</p>}
					{error && <p role="alert">{error}</p>}
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
