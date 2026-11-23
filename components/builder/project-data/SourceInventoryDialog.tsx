"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
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
import {
	cancelManagedInventoryAction,
	getManagedInventoryStatusAction,
	readManagedInventoryAction,
} from "@/lib/deployment/managedInventoryActions";
import { requiresLookupProjection } from "@/lib/lookup/source";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import { keptDateText } from "../keptListModel";

type SourceTable = Pick<
	LookupTableSnapshot,
	"id" | "projectId" | "name" | "hq" | "attributes" | "columns"
>;
type Status = Extract<
	Awaited<ReturnType<typeof getManagedInventoryStatusAction>>,
	{ ok: true }
>;
type Page = Extract<
	Awaited<ReturnType<typeof readManagedInventoryAction>>,
	{ ok: true }
>;
type Cursor = NonNullable<Page["next"]>;
const READABLE_ROW_BYTES = 64 * 1024;
const sourceRow = z.object({
	attributes: z.record(z.string(), z.string()),
	fields: z.record(
		z.string(),
		z.array(
			z.object({
				value: z.string(),
				properties: z.record(z.string(), z.string()),
			}),
		),
	),
});

function SourceRow({ table, page }: { table: SourceTable; page: Page }) {
	const item = page.item;
	if (!item) return <p>The completed inventory contains no rows.</p>;
	const full = item.byteOffset === 0 && item.byteLength === item.totalBytes;
	let row: z.infer<typeof sourceRow> | undefined;
	if (full) {
		try {
			row = sourceRow.safeParse(JSON.parse(item.part)).data;
		} catch {
			/* The exact source text stays readable. */
		}
	}
	return (
		<section aria-label="Source row" className="space-y-2">
			<h3 className="font-medium">
				Row {item.ordinal + 1} of {page.totalRows}
			</h3>
			{row ? (
				<dl className="space-y-2">
					{Object.entries(row.attributes).map(([name, text]) => (
						<div key={name}>
							<dt className="text-nova-text-muted">
								{table.attributes?.find((member) => member.wireName === name)
									?.label ?? name}
							</dt>
							<dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">
								{text === "" ? <i>Empty text</i> : text}
							</dd>
						</div>
					))}
					{Object.entries(row.fields).map(([name, values]) => {
						const column = table.columns.find(
							(column) => column.wireName === name,
						);
						return (
							<div key={name}>
								<dt className="text-nova-text-muted">
									{column?.label ?? name}
								</dt>
								<dd>
									{values.length === 0 ? (
										"Empty list"
									) : (
										<ol className="list-decimal space-y-1 ps-5">
											{values.map((value, index) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: an occurrence has a position within this immutable source generation.
												<li key={index}>
													<span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
														{value.value === "" ? (
															<i>Empty text</i>
														) : (
															value.value
														)}
													</span>
													{Object.entries(value.properties).map(
														([name, text]) => (
															<p
																key={name}
																className="text-nova-text-secondary [overflow-wrap:anywhere]"
															>
																{column?.properties?.find(
																	(member) => member.wireName === name,
																)?.label ?? name}{" "}
																·{" "}
																<span className="whitespace-pre-wrap">
																	{text === "" ? <i>Empty text</i> : text}
																</span>
															</p>
														),
													)}
												</li>
											))}
										</ol>
									)}
								</dd>
							</div>
						);
					})}
				</dl>
			) : (
				<>
					<p>
						Source text, bytes {item.byteOffset + 1} to{" "}
						{item.byteOffset + item.byteLength} of {item.totalBytes}
					</p>
					<pre
						dir="auto"
						className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-nova-border p-2 text-xs [overflow-wrap:anywhere]"
					>
						{item.part}
					</pre>
				</>
			)}
		</section>
	);
}

export function SourceInventoryDialog({
	table,
	refreshing,
	onClose,
}: {
	table: SourceTable;
	refreshing: boolean;
	onClose: () => void;
}) {
	const [status, setStatus] = useState<Status>();
	const [page, setPage] = useState<Page>();
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const [reload, setReload] = useState(0);
	const generation = useRef(0);
	const { projectId, id } = table;
	// biome-ignore lint/correctness/useExhaustiveDependencies: finishing a refresh or explicitly checking again re-reads the status for the same table.
	useEffect(() => {
		const owner = ++generation.current;
		setPending(true);
		setError("");
		const read = async () => {
			try {
				const answer = await getManagedInventoryStatusAction(projectId, id);
				if (owner !== generation.current) return;
				if (!answer.ok) {
					setStatus(undefined);
					setPage(undefined);
					setError(answer.message);
					return;
				}
				setStatus(answer);
				setPage((previous) =>
					previous?.generationId === answer.active?.generationId
						? previous
						: undefined,
				);
			} catch {
				if (owner === generation.current) {
					setStatus(undefined);
					setPage(undefined);
					setError(
						"Nova couldn't read the source inventory. You can check again.",
					);
				}
			} finally {
				if (owner === generation.current) setPending(false);
			}
		};
		void read();
		return () => {
			++generation.current;
		};
	}, [projectId, id, refreshing, reload]);
	const show = async (cursor: Cursor) => {
		const owner = ++generation.current;
		setPending(true);
		setError("");
		try {
			let answer = await readManagedInventoryAction(projectId, id, cursor);
			if (owner !== generation.current) return;
			// Only assemble a small row, and only within its exact immutable generation.
			if (
				answer.ok &&
				answer.item &&
				answer.item.byteOffset === 0 &&
				answer.item.totalBytes <= READABLE_ROW_BYTES
			) {
				const first = answer;
				const item = answer.item;
				let text = item.part;
				let bytes = item.byteLength;
				while (answer.ok && answer.next && bytes < item.totalBytes) {
					if (
						answer.next.generationId !== first.generationId ||
						answer.next.ordinal !== item.ordinal ||
						answer.next.byteOffset !== bytes
					)
						throw new Error("Source cursor changed");
					answer = await readManagedInventoryAction(projectId, id, answer.next);
					if (owner !== generation.current) return;
					if (!answer.ok) break;
					if (
						answer.generationId !== first.generationId ||
						answer.item?.rowId !== item.rowId ||
						answer.item.byteOffset !== bytes ||
						answer.item.totalBytes !== item.totalBytes ||
						!answer.item.byteLength ||
						bytes + answer.item.byteLength > item.totalBytes
					)
						throw new Error("Source row changed");
					text += answer.item.part;
					bytes += answer.item.byteLength;
				}
				if (answer.ok)
					answer = {
						...first,
						item: { ...item, part: text, byteLength: bytes },
						next: answer.next,
					};
			}
			if (!answer.ok) {
				setPage(undefined);
				setError(answer.message);
				return;
			}
			setPage(answer);
		} catch {
			if (owner === generation.current) {
				setPage(undefined);
				setError(
					"Nova couldn't read this part of the inventory. You can check the inventory and open the row again.",
				);
			}
		} finally {
			if (owner === generation.current) setPending(false);
		}
	};
	const cancel = async () => {
		if (!status?.staged) return;
		const owner = ++generation.current;
		setPending(true);
		setError("");
		try {
			const answer = await cancelManagedInventoryAction(
				projectId,
				id,
				status.staged.generationId,
			);
			if (owner !== generation.current) return;
			if (!answer.ok) {
				setError(answer.message);
				return;
			}
			setReload((value) => value + 1);
		} catch {
			if (owner === generation.current)
				setError(
					"Nova couldn't confirm the cancellation. You can check the refresh before trying again.",
				);
		} finally {
			if (owner === generation.current) setPending(false);
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
					<DialogTitle>Source inventory</DialogTitle>
					<DialogDescription>
						{table.name} in {table.hq?.domain}. This view shows the copy
						recorded from CommCare HQ.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-3">
					{status && (
						<div className="space-y-2">
							<p>
								{status.distribution === "assigned"
									? "Each worker sees the rows assigned to them."
									: "This table is shared with every worker."}
							</p>
							{status.active ? (
								<p>
									{status.active.totalRows}{" "}
									{status.active.totalRows === 1 ? "row" : "rows"} recorded on{" "}
									{keptDateText(status.active.recordedAt, new Date())}.
								</p>
							) : (
								<p>
									{requiresLookupProjection(table.hq)
										? "Nova has no completed paged inventory to show here yet. You can check source access or refresh from CommCare HQ on the table page."
										: "The table page shows the rows in the current copy."}
								</p>
							)}
							{status.staged && (
								<div className="space-y-1">
									<p role="status">
										Your refresh has read {status.staged.rowsRead}{" "}
										{status.staged.rowsRead === 1 ? "row" : "rows"}. The
										completed copy stays available.
									</p>
									<Button
										variant="outline"
										disabled={pending}
										onClick={() => void cancel()}
									>
										Cancel my refresh
									</Button>
								</div>
							)}
						</div>
					)}
					{page && <SourceRow table={table} page={page} />}
					<div className="flex flex-wrap gap-2">
						{!page && status?.active && status.active.totalRows > 0 && (
							<Button
								variant="outline"
								disabled={pending}
								onClick={() => {
									if (status.active)
										void show({
											generationId: status.active.generationId,
											ordinal: 0,
											byteOffset: 0,
										});
								}}
							>
								Read first row
							</Button>
						)}
						{page?.item && page.item.ordinal > 0 && (
							<Button
								variant="outline"
								disabled={pending}
								onClick={() => {
									if (page.item)
										void show({
											generationId: page.generationId,
											ordinal: page.item.ordinal - 1,
											byteOffset: 0,
										});
								}}
							>
								Previous row
							</Button>
						)}
						{page?.item && page.item.byteOffset > 0 && (
							<Button
								variant="outline"
								disabled={pending}
								onClick={() => {
									if (page.item)
										void show({
											generationId: page.generationId,
											ordinal: page.item.ordinal,
											byteOffset: 0,
										});
								}}
							>
								Start of row
							</Button>
						)}
						{page?.next && (
							<Button
								variant="outline"
								disabled={pending}
								onClick={() => {
									if (page.next) void show(page.next);
								}}
							>
								{page.next.ordinal === page.item?.ordinal
									? "Next part"
									: "Next row"}
							</Button>
						)}
					</div>
					{pending && <p role="status">Reading source inventory</p>}
					{error && (
						<p role="alert" className="text-nova-rose">
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={pending}
						onClick={() => setReload((value) => value + 1)}
					>
						Check inventory
					</Button>
					<Button onClick={onClose}>Close</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
